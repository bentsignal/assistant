import { EventEmitter } from "node:events"
import type { Readable, Writable } from "node:stream"
import { onLines } from "./proc.ts"

/**
 * The App ⇄ Core stdio protocol (DESIGN.md): JSON lines, app events on stdin,
 * core commands on stdout. Nothing else may ever be written to stdout; logs
 * go to stderr.
 */
export type HudState = "idle" | "listening" | "thinking" | "speaking" | "working"
/** `failed`: the voice service couldn't synthesize it (the App plays its own error chime). */
export type PlaybackState = "started" | "finished" | "interrupted" | "failed"
export type ChimeKind = "notify" | "listening" | "done" | "error"
export type UiAction = "stop_talking" | "mute" | "unmute" | "settings_changed" | "card_closed"

export type AppEvent =
  | { type: "ready"; mic?: string; engine?: string; volume?: number }
  | { type: "speech_start"; t?: number }
  | { type: "partial"; text: string; t?: number }
  | { type: "final"; text: string; start?: number; end?: number; during_playback?: boolean }
  | { type: "speech_cancel"; reason?: string; t?: number }
  | { type: "barge_in"; speak_id?: string }
  | { type: "playback"; speak_id: string; state: PlaybackState }
  | { type: "ui"; action: UiAction; card_id?: string; volume?: number }

export type CoreCommand =
  /** `voice`: the speaking persona's voice (the App's `app.voice` override beats it). */
  | { cmd: "speak"; speak_id: string; text: string; voice?: string }
  | { cmd: "stop_speaking" }
  | { cmd: "hud"; state: HudState }
  | { cmd: "chime"; kind: ChimeKind }
  | { cmd: "show"; card_id: string; title: string; markdown: string }
  | { cmd: "hide"; card_id: string }
  | { cmd: "set_volume"; level: number }
  | { cmd: "badge"; count: number }
  /** Something failed on Core's side; the App chimes, flashes the HUD, and says so in Settings and the tray. */
  | { cmd: "error"; what: "brain" | "brain_timeout" | string; message: string }
  /** Her name changed (saved as `assistant.name`); the App applies it everywhere. */
  | { cmd: "name"; name: string }
  /**
   * The voice override changed (saved as `app.voice`): every line uses it
   * from the next `speak`; null clears it (each persona's own voice again).
   */
  | { cmd: "voice"; voice: string | null }

const EVENT_TYPES = new Set(["ready", "speech_start", "partial", "final", "speech_cancel", "barge_in", "playback", "ui"])

/** Reads app events from a stream and writes core commands to another. Emits "event" and "close". */
export class AppLink extends EventEmitter {
  closed = false
  /** Events that arrived before anyone listened (Core is still starting). */
  private early: AppEvent[] = []

  constructor(
    input: Readable,
    private output: Writable,
    private log: (line: string) => void = () => {},
  ) {
    super()
    onLines(input, (line) => {
      let ev: any
      try {
        ev = JSON.parse(line)
      } catch {
        this.log(`app: not JSON: ${line.slice(0, 200)}`)
        return
      }
      if (!ev || typeof ev !== "object" || !EVENT_TYPES.has(ev.type)) {
        this.log(`app: unknown event ${line.slice(0, 200)}`)
        return
      }
      if (this.listenerCount("event") === 0) this.early.push(ev as AppEvent)
      else this.emit("event", ev as AppEvent)
    })
    this.on("newListener", (name) => {
      if (name !== "event" || !this.early.length) return
      const early = this.early.splice(0)
      setImmediate(() => early.forEach((e) => this.emit("event", e)))
    })
    input.on("end", () => this.close())
    input.on("close", () => this.close())
    output.on("error", () => this.close())
  }

  send(cmd: CoreCommand) {
    if (this.closed) return
    this.output.write(JSON.stringify(cmd) + "\n")
    this.emit("sent", cmd)
  }

  private close() {
    if (this.closed) return
    this.closed = true
    this.emit("close")
  }
}

export type SpeechState = "queued" | "sent" | "playing" | "done" | "cut" | "dropped" | "failed"

/** One `speak` command and what became of it. */
export interface SpeechItem {
  id: string
  text: string
  turnId?: number
  /** The speaking persona's voice, sent with the line. */
  voice?: string
  state: SpeechState
  sentAt?: number
  startedAt?: number
  endedAt?: number
  done: Promise<SpeechItem>
}

interface Internal extends SpeechItem {
  resolve: (i: SpeechItem) => void
  timer?: NodeJS.Timeout
}

/**
 * How long a line may take to play once started: twice its expected length
 * (Vera speaks about 14 characters a second) plus room for a slow stream.
 * The App gives up a little sooner (its own deadline), so its end usually
 * comes first; this is the backstop that keeps Core from ever waiting on a
 * line that will never end.
 */
export function playDeadlineMs(text: string): number {
  return Math.min(190_000, 8_000 + text.length * 160)
}

export interface AppMouthOptions {
  /** No `started` this long after sending: give up on the item. */
  startTimeoutMs?: number
  /** Silence between items shorter than this stays one speaking stretch (no follow-up flicker). */
  graceMs?: number
}

/**
 * Mouth over the App: `speak` commands out, `playback` events in.
 *
 * Items are sent one at a time: the next `speak` goes out only when the App
 * reports the previous one finished, so Core never depends on the App
 * queueing, and a cut never leaves later sentences buffered in the App.
 * "start"/"end" frame a speaking stretch (first `started` to the last
 * item's end), with a short grace so two speak calls in a row are one
 * stretch. Any `interrupted` Core didn't ask for (barge-in, the App's own
 * stop) ends the stretch and drops what's queued: the App stopped Vera for a
 * reason, and sending the next sentence would talk over Shawn. A `failed`
 * item just ends (the voice service couldn't say it), and the next is sent.
 */
export class AppMouth {
  speaking = false
  private ev = new EventEmitter()
  private queue: Internal[] = []
  private current: Internal | null = null
  private items = new Map<string, Internal>()
  private seq = 0
  private endTimer: NodeJS.Timeout | null = null
  private stopping = false
  /** Nothing new goes to the App until `release()` (Shawn went on talking before she began). */
  private held = false
  private startTimeoutMs: number
  private graceMs: number

  constructor(
    private link: AppLink,
    private log: (line: string) => void = () => {},
    opts: AppMouthOptions = {},
  ) {
    this.startTimeoutMs = opts.startTimeoutMs ?? 35_000
    this.graceMs = opts.graceMs ?? 200
  }

  on(event: "start" | "end" | "cut" | "stuck", cb: (...a: any[]) => void): () => void {
    this.ev.on(event, cb)
    return () => this.ev.off(event, cb)
  }

  private emit(event: "start" | "end" | "cut" | "stuck", arg?: unknown) {
    this.ev.emit(event, arg)
  }

  /** Queue a sentence. Its `done` resolves when it was played, cut, dropped, or failed. */
  say(text: string, turnId?: number, voice?: string): SpeechItem {
    let resolve!: (i: SpeechItem) => void
    const done = new Promise<SpeechItem>((r) => (resolve = r))
    const item: Internal = { id: `s${++this.seq}`, text, turnId, ...(voice ? { voice } : {}), state: "queued", done, resolve }
    this.items.set(item.id, item)
    if (this.items.size > 200) this.items.delete(this.items.keys().next().value!)
    this.queue.push(item)
    this.pump()
    return item
  }

  get(id: string): SpeechItem | undefined {
    return this.items.get(id)
  }

  /** The item the App is playing (or was last sent). */
  get playing(): SpeechItem | null {
    return this.current
  }

  /** Something is sent or queued but not playing yet (the voice is warming up). */
  get pendingStart(): boolean {
    return !this.speaking && (!!this.current || this.queue.length > 0)
  }

  /** Items not yet played. */
  get pending(): SpeechItem[] {
    return [...this.queue]
  }

  /** Whether lines are being held back (`hold()`). */
  get holding(): boolean {
    return this.held
  }

  /**
   * Holds her lines back while Shawn is still talking: nothing new is sent,
   * and a line sent but not yet playing is taken back (stopped in the App,
   * queued again under a new id). Something already playing goes on (a
   * barge-in stops that). `release()` or `cut()` ends the hold.
   */
  hold() {
    if (this.held) return
    this.held = true
    const cur = this.current
    if (!cur || cur.state !== "sent") return
    if (cur.timer) clearTimeout(cur.timer)
    this.stopping = true
    this.link.send({ cmd: "stop_speaking" })
    this.stopping = false
    this.items.delete(cur.id)
    cur.id = `s${++this.seq}`
    this.items.set(cur.id, cur)
    cur.state = "queued"
    this.current = null
    this.queue.unshift(cur)
    this.log(`speech: held back ${cur.id} "${cur.text.length > 60 ? cur.text.slice(0, 60) + "…" : cur.text}" while Shawn talks`)
  }

  /** Lets held lines play. */
  release() {
    if (!this.held) return
    this.held = false
    this.pump()
  }

  private pump() {
    if (this.held || this.current || !this.queue.length) return
    const item = this.queue.shift()!
    this.current = item
    item.state = "sent"
    item.sentAt = Date.now()
    item.timer = setTimeout(() => {
      if (item.state !== "sent") return
      this.log(`speech ${item.id}: no playback started after ${this.startTimeoutMs} ms; skipping it`)
      this.giveUp(item)
    }, this.startTimeoutMs)
    const cmd: CoreCommand = { cmd: "speak", speak_id: item.id, text: item.text, ...(item.voice ? { voice: item.voice } : {}) }
    this.log(`-> app ${JSON.stringify({ ...cmd, text: item.text.length > 80 ? item.text.slice(0, 80) + "…" : item.text })}`)
    this.link.send(cmd)
  }

  /** A `playback` event from the App. */
  onPlayback(id: string, state: PlaybackState) {
    const item = this.items.get(id)
    if (!item) return this.log(`playback ${state} for unknown ${id}`)
    if (state === "started") {
      if (item.state !== "sent") return
      item.state = "playing"
      item.startedAt = Date.now()
      if (item.timer) clearTimeout(item.timer)
      const deadline = playDeadlineMs(item.text)
      item.timer = setTimeout(() => {
        if (item.state !== "playing") return
        this.log(`speech ${item.id}: no playback end after ${deadline} ms; stopping it`)
        this.giveUp(item)
      }, deadline)
      if (this.endTimer) {
        clearTimeout(this.endTimer)
        this.endTimer = null
      }
      if (!this.speaking) {
        this.speaking = true
        this.emit("start", item)
      }
      return
    }
    if (item.state !== "sent" && item.state !== "playing") return
    if (state === "finished") return this.end(item, "done")
    if (state === "failed") {
      this.log(`speech ${item.id}: the App couldn't play it; going on`)
      return this.end(item, "failed")
    }
    // interrupted
    if (this.stopping) return this.end(item, "cut")
    this.log(`speech ${item.id} interrupted by the App`)
    this.cut(false)
  }

  /** A line that never started or never ended: stop it in the App (so nothing plays late), then go on. */
  private giveUp(item: Internal) {
    if (this.current === item) {
      this.stopping = true
      this.link.send({ cmd: "stop_speaking" })
      this.stopping = false
    }
    this.emit("stuck", item)
    this.end(item, "failed")
  }

  private end(item: Internal, state: SpeechState) {
    if (item.timer) clearTimeout(item.timer)
    item.state = state
    item.endedAt = Date.now()
    item.resolve(item)
    if (this.current === item) this.current = null
    this.pump()
    if (!this.current && !this.queue.length) this.finishStretch()
  }

  private finishStretch(immediate = false) {
    if (!this.speaking) return
    if (this.endTimer) clearTimeout(this.endTimer)
    const done = () => {
      this.endTimer = null
      if (this.current || this.queue.length || !this.speaking) return
      this.speaking = false
      this.emit("end")
    }
    if (immediate) done()
    else this.endTimer = setTimeout(done, this.graceMs)
  }

  /**
   * Stop now: what's playing is cut, what's queued is dropped. Returns what
   * was cut and dropped (for telling the brain). `notify` false when the App
   * already stopped playback (barge-in), so no `stop_speaking` is needed;
   * it's sent anyway when anything was still queued or sent.
   */
  cut(notify = true): { cut: SpeechItem | null; dropped: SpeechItem[] } {
    this.held = false
    const cur = this.current
    const dropped = this.queue.splice(0)
    if (notify && cur) {
      this.stopping = true
      this.link.send({ cmd: "stop_speaking" })
      this.stopping = false
    }
    for (const d of dropped) {
      d.state = "dropped"
      d.endedAt = Date.now()
      d.resolve(d)
    }
    if (cur) {
      if (cur.timer) clearTimeout(cur.timer)
      cur.state = cur.state === "playing" ? "cut" : "dropped"
      cur.endedAt = Date.now()
      this.current = null
      cur.resolve(cur)
    }
    if (cur || dropped.length) this.emit("cut", { cut: cur, dropped })
    this.finishStretch(true)
    return { cut: cur?.state === "cut" ? cur : null, dropped: cur?.state === "dropped" ? [cur, ...dropped] : dropped }
  }

  stop() {
    this.cut(true)
  }

  /**
   * A new turn began: every line from earlier turns (playing or queued) is
   * stale, so it's cut and dropped. Shawn never hears an old reply after
   * his new question. Returns what was dropped.
   */
  dropStale(turnId: number): SpeechItem[] {
    const stale = (i: Internal) => i.turnId !== turnId
    const dropped = this.queue.filter(stale)
    this.queue = this.queue.filter((i) => !stale(i))
    for (const d of dropped) {
      d.state = "dropped"
      d.endedAt = Date.now()
      d.resolve(d)
    }
    const cur = this.current
    if (cur && stale(cur)) {
      this.stopping = true
      this.link.send({ cmd: "stop_speaking" })
      this.stopping = false
      if (cur.timer) clearTimeout(cur.timer)
      cur.state = cur.state === "playing" ? "cut" : "dropped"
      cur.endedAt = Date.now()
      this.current = null
      cur.resolve(cur)
      dropped.unshift(cur)
    }
    if (!dropped.length) return dropped
    this.emit("cut", { cut: cur && stale(cur) ? cur : null, dropped })
    this.pump()
    if (!this.current && !this.queue.length) this.finishStretch(true)
    return dropped
  }

  chime(kind: ChimeKind) {
    this.link.send({ cmd: "chime", kind })
  }

  close() {
    this.cut(false)
  }
}
