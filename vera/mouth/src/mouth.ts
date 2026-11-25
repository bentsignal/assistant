import { renderChime, type ChimeKind } from "./chimes.ts"
import { resolveConfig, type MouthConfig } from "./config.ts"
import { concat, resolveEffects, VoiceFx, type EffectsConfig } from "./dsp/effects.ts"
import { TtsEngine } from "./engine.ts"
import { ensureModel, isInstalled, packageFor } from "./models.ts"
import { PlayerPool, type Playback } from "./player.ts"
import { normalizeForSpeech } from "./text/normalize.ts"
import { splitForSpeech, type Chunk } from "./text/split.ts"
import { join } from "node:path"

/** The contract Core codes against (see VERA.md). */
export interface Mouth {
  /** Speak text. Synthesizes sentence by sentence and starts playing the first sentence as soon as it's ready. Resolves when playback ends or is stopped. */
  speak(text: string): Promise<void>
  /** Stop playback immediately and drop anything queued. */
  stop(): void
  readonly speaking: boolean
  on(event: "start" | "end", cb: () => void): () => void
  /** Short non-speech earcons. "notify" is the inbox ping. */
  chime(kind: "notify" | "listening" | "done" | "error"): Promise<void>
  close(): Promise<void>
}

export interface SpeakTiming {
  /** speak() call to the first PCM handed to the player (the player adds ~50 ms). */
  firstAudioMs: number
  /** Synthesis time per chunk. */
  synthMs: number[]
  /** Seconds of audio produced, including pauses and the reverb tail. */
  audioSeconds: number
  chunks: string[]
  /** True when stop() cut it short. */
  stopped: boolean
}

/** Mouth plus extras for tools and tests. */
export interface VeraMouth extends Mouth {
  readonly config: MouthConfig
  readonly sampleRate: number
  /** Timing of the most recent speak(). */
  readonly lastTiming: SpeakTiming | undefined
  /** Synthesize and process without playing. */
  render(text: string): Promise<Float32Array>
  /** The exact chunks speak() would synthesize. */
  plan(text: string): Chunk[]
}

interface Job {
  text: string
  requestedAt: number
  resolve: () => void
  reject: (e: unknown) => void
  settled: boolean
}

/** Silence after the reverb tail so the player exits only once the sound has really stopped. */
const END_PAD_MS = 120

class MouthImpl implements VeraMouth {
  readonly config: MouthConfig
  readonly sampleRate: number
  lastTiming: SpeakTiming | undefined
  private engine: TtsEngine
  private pool: PlayerPool
  private effects: EffectsConfig
  private listeners = { start: new Set<() => void>(), end: new Set<() => void>() }
  private _speaking = false
  private queue: Job[] = []
  private running = false
  private current: { cancelled: boolean; playback?: Playback } | undefined
  private closed = false
  private chimeCache = new Map<ChimeKind, Float32Array>()

  constructor(config: MouthConfig, engine: TtsEngine, effects: EffectsConfig) {
    this.config = config
    this.engine = engine
    this.effects = effects
    this.sampleRate = engine.sampleRate
    this.pool = new PlayerPool(engine.sampleRate, { command: config.player.command, warm: config.player.warm, volume: config.volume })
  }

  get speaking(): boolean {
    return this._speaking
  }

  on(event: "start" | "end", cb: () => void): () => void {
    const set = this.listeners[event]
    if (!set) throw new Error(`Unknown event "${event}"`)
    set.add(cb)
    return () => set.delete(cb)
  }

  private setSpeaking(v: boolean): void {
    if (this._speaking === v) return
    this._speaking = v
    for (const cb of this.listeners[v ? "start" : "end"]) {
      try {
        cb()
      } catch (e) {
        this.config.log(`[mouth] ${v ? "start" : "end"} listener threw: ${String(e)}`)
      }
    }
  }

  plan(text: string): Chunk[] {
    return splitForSpeech(normalizeForSpeech(text))
  }

  speak(text: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("mouth is closed"))
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ text, requestedAt: performance.now(), resolve, reject, settled: false })
      void this.pump()
    })
  }

  private settle(job: Job, err?: unknown): void {
    if (job.settled) return
    job.settled = true
    if (err === undefined) job.resolve()
    else job.reject(err)
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length && !this.closed) {
        const job = this.queue.shift()!
        try {
          await this.play(job)
          this.settle(job)
        } catch (e) {
          this.settle(job, e)
        }
        // Back-to-back utterances stay one continuous "speaking" stretch.
        if (!this.queue.length) this.setSpeaking(false)
      }
    } finally {
      this.running = false
      this.setSpeaking(false)
    }
  }

  private async play(job: Job): Promise<void> {
    const chunks = this.plan(job.text)
    const ctx: { cancelled: boolean; playback?: Playback } = { cancelled: false }
    this.current = ctx
    const timing: SpeakTiming = { firstAudioMs: -1, synthMs: [], audioSeconds: 0, chunks: chunks.map((c) => c.text), stopped: false }
    this.lastTiming = timing
    if (!chunks.length) return
    const fx = new VoiceFx(this.effects, this.sampleRate, this.engine.pitchHz)
    const pb = this.pool.take()
    ctx.playback = pb
    let samplesOut = 0
    const write = (y: Float32Array): void => {
      if (!y.length) return
      pb.write(y)
      samplesOut += y.length
      if (timing.firstAudioMs < 0) {
        timing.firstAudioMs = performance.now() - job.requestedAt
        this.setSpeaking(true)
      }
    }
    try {
      let t = performance.now()
      let next: Promise<Float32Array> = this.engine.synthesize(chunks[0].text)
      for (let i = 0; i < chunks.length; i++) {
        const raw = await next
        timing.synthMs.push(performance.now() - t)
        if (ctx.cancelled) break
        // Start the next chunk now; it synthesizes on a native thread while this one is processed and played.
        if (i + 1 < chunks.length) {
          t = performance.now()
          next = this.engine.synthesize(chunks[i + 1].text)
          next.catch(() => undefined)
        }
        write(fx.sentence(raw))
        if (chunks[i].pauseMs) write(fx.silence(chunks[i].pauseMs))
        if (!pb.alive) throw new Error(`ffplay exited early${pb.stderr ? `: ${pb.stderr.trim()}` : ""}`)
      }
      if (!ctx.cancelled && samplesOut > 0) {
        write(fx.tail())
        write(new Float32Array(Math.round((END_PAD_MS * this.sampleRate) / 1000)))
      }
      pb.end()
      await pb.done
      if (pb.error) throw pb.error
    } catch (e) {
      pb.kill()
      if (/ENOENT/.test(String(e)) || /spawn/.test(String(e))) {
        throw new Error(`Could not start ffplay. Install ffmpeg (scoop install ffmpeg) or set player.command. (${String(e)})`)
      }
      throw e
    } finally {
      timing.audioSeconds = samplesOut / this.sampleRate
      timing.stopped = ctx.cancelled
      if (this.current === ctx) this.current = undefined
    }
  }

  stop(): void {
    const queued = this.queue.splice(0)
    for (const j of queued) this.settle(j)
    if (this.current) {
      this.current.cancelled = true
      this.current.playback?.kill()
    }
    this.setSpeaking(false)
  }

  async render(text: string): Promise<Float32Array> {
    const chunks = this.plan(text)
    if (!chunks.length) return new Float32Array(0)
    const fx = new VoiceFx(this.effects, this.sampleRate, this.engine.pitchHz)
    const parts: Float32Array[] = []
    for (const c of chunks) {
      parts.push(fx.sentence(await this.engine.synthesize(c.text)))
      if (c.pauseMs) parts.push(fx.silence(c.pauseMs))
    }
    parts.push(fx.tail())
    return concat(parts)
  }

  renderChime(kind: ChimeKind): Float32Array {
    let x = this.chimeCache.get(kind)
    if (!x) {
      x = renderChime(kind, this.sampleRate, this.config.chimeVolume)
      this.chimeCache.set(kind, x)
    }
    return x
  }

  async chime(kind: ChimeKind): Promise<void> {
    if (this.closed) throw new Error("mouth is closed")
    if (!["notify", "listening", "done", "error"].includes(kind)) throw new Error(`Unknown chime "${kind}"`)
    const pb = this.pool.take()
    pb.write(this.renderChime(kind))
    pb.end()
    await pb.done
    if (pb.error) throw new Error(`Could not start ffplay: ${pb.error.message}`)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stop()
    this.pool.close()
  }
}

/** Create Vera's mouth: loads (and if needed downloads) the voice, warms the player. */
export async function createMouth(config: Partial<MouthConfig> = {}): Promise<VeraMouth> {
  const cfg = resolveConfig(config)
  const effects = resolveEffects(cfg.preset, cfg.effects)
  const pkg = packageFor(cfg.engine, cfg.voice)
  if (!isInstalled(cfg.modelsDir, pkg)) {
    if (!cfg.autoDownload) throw new Error(`Voice model ${pkg.name} is not installed in ${cfg.modelsDir}. Run: pnpm --filter @vera/mouth setup`)
    await ensureModel(cfg.modelsDir, pkg, { log: cfg.log })
  }
  const engine = await TtsEngine.load({
    engine: cfg.engine,
    voice: cfg.voice,
    modelDir: join(cfg.modelsDir, pkg.name),
    pkg,
    numThreads: cfg.numThreads,
    speed: cfg.speed,
  })
  return new MouthImpl(cfg, engine, effects)
}

export type { ChimeKind }
