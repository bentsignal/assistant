import { EventEmitter } from "node:events"
import { randomBytes } from "node:crypto"
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { CORE_DIR, loadConfig, paths, resolveEarsCommand, saveConfigPatch, type BrainHarness, type VeraConfig } from "./config.ts"
import { findBargeIn, gate, stripWakeWord, type GateResult } from "./gate.ts"
import { Inbox, oneLine, truncate } from "./inbox.ts"
import { SystemPrompt } from "./prompt.ts"
import { Jobs, type Job } from "./jobs.ts"
import { T3, T3Watcher, isBusy } from "./t3.ts"
import { createMouth, type ChimeKind, type Mouth } from "./mouth.ts"
import { Ears, type EarsMessage } from "./ears.ts"
import { AppMouth, type AppEvent, type AppLink, type CoreCommand, type HudState, type SpeechItem } from "./app.ts"
import { createBrain, type Brain, type TurnResult } from "./brain/index.ts"

export type Status = HudState

export interface Card {
  id: string
  title: string
  markdown: string
  at: number
  open: boolean
}

export interface Line {
  who: "shawn" | "vera"
  text: string
  at: number
}

export interface TurnRecord {
  id: number
  text: string
  via: string
  brain: string
  startedAt: number
  /** ms from the turn being sent to the brain until its first `speak` call. */
  firstSpeakMs?: number
  /** When Shawn stopped speaking (final.end), for heard turns. */
  heardEndAt?: number
  /** ms from the end of Shawn's speech to Vera's first audio. */
  endToAudioMs?: number
  durationMs?: number
  spoken: string[]
  /** Tool names the brain called, in order. */
  tools: string[]
  output: string
  ok?: boolean
  error?: string
  interrupted?: boolean
  /** Shawn talked over this turn's speech (or stopped it): further speech is dropped. */
  muted?: boolean
}

export interface UtteranceInput {
  text: string
  start?: number
  /** When the speech ended (epoch ms), for latency. */
  end?: number
  direct?: boolean
  source?: "ears" | "app" | "panel" | "api"
  /** Heard while Vera was playing (App duplex): an in-conversation turn. */
  duringPlayback?: boolean
}

/** What Vera was saying when Shawn talked over her, for the next turn's note. */
interface Interruption {
  at: number
  said: string[]
  cut?: { text: string; playedMs: number }
  unsaid: string[]
}

export interface VeraOptions {
  /** "stdio": headless sidecar of the App (it owns audio). "standalone": v1, spawns Ears and Mouth itself. */
  mode?: "standalone" | "stdio"
  link?: AppLink
}

/** Epoch ms look like this; anything smaller is some other clock. */
const EPOCH_MS = 1e12

/**
 * Vera's conversation loop: gate -> brain turn -> tools -> speech, with the
 * inbox, jobs, T3 watches and the HUD around it.
 *
 * Turn policy: one brain turn at a time. Utterances that pass the gate while
 * a turn is in flight are QUEUED and sent together as the next turn (Shawn
 * often adds a thought while Vera is thinking; dropping it would be worse).
 * "Vera, stop" / "never mind" is never queued: it stops speech, interrupts
 * the turn, and clears the queue.
 */
export class Vera extends EventEmitter {
  config: VeraConfig
  readonly mode: "standalone" | "stdio"
  readonly token = randomBytes(16).toString("hex")
  /** Port the HTTP server ended up on (MCP tool calls come back through it). */
  port: number
  inbox: Inbox
  prompt: SystemPrompt
  jobs: Jobs
  t3: T3
  watcher: T3Watcher
  mouth!: Mouth
  mouthName = ""
  ears: Ears | null = null
  earsState: "none" | "starting" | "ready" | "error" = "none"
  brain: Brain | null = null
  readonly link: AppLink | null
  private appMouth: AppMouth | null = null

  cards: Card[] = []
  lines: Line[] = []
  turns: TurnRecord[] = []
  lastHeard = ""
  partial = ""
  followUpUntil = 0
  /** Vera's own output gain (0-1). The App applies and persists it. */
  volume = 0.35
  /** Microphone muted from the tray: nothing heard counts. */
  micMuted = false
  hud: HudState = "idle"
  private badgeCount = -1
  private cardSeq = 0
  private turnSeq = 0
  private current: TurnRecord | null = null
  private queue: UtteranceInput[] = []
  private brainDirty = false
  /** Recent lines to replay into a brain that starts a fresh conversation. */
  private recapNext = false
  private resumeTimer: NodeJS.Timeout | null = null
  /** Why Ears are paused right now ("speaking", "chime"); resumed after a tail once empty. */
  private earsHolds = new Set<string>()
  /** Start of the current or last deaf stretch, and when it ended (0 while deaf). */
  private deafFrom = 0
  private deafUntil = 0
  /** Speech started and the final or cancel hasn't come yet. */
  private inSpeech = false
  /** When the current utterance started (local clock), and whether it's addressed to Vera. */
  private speechStartedAt = 0
  private speechEngaged = false
  private deferredChimes: ChimeKind[] = []
  /** Last time Vera spoke, woke, or took a turn (warm wake words). */
  private lastActiveAt = 0
  /** Turn waiting for its first audio, to measure end-of-speech -> audio. */
  private awaitingAudio: TurnRecord | null = null
  /** What Vera is saying in the current speaking stretch (v1 barge-in echo check). */
  private speakingText = ""
  /** Barge-in happened; the next final is Shawn's reply. */
  private interruption: Interruption | null = null
  private bargePending = false
  private speechByTurn = new Map<number, SpeechItem[]>()
  private syncJobs = new Set<string>()
  private turnWaiters = new Map<number, (t: TurnRecord) => void>()
  private followUpTimer: NodeJS.Timeout | null = null
  private logFile: string

  constructor(opts: VeraOptions = {}) {
    super()
    this.mode = opts.mode ?? "standalone"
    this.link = opts.link ?? null
    this.config = loadConfig()
    this.port = this.config.port
    this.logFile = join(paths.logs, `core-${new Date().toISOString().slice(0, 10)}.log`)
    this.volume = this.loadState().volume ?? this.config.voice.defaultVolume
    this.inbox = new Inbox(paths.inbox)
    this.prompt = new SystemPrompt(paths.systemPrompt, paths.promptHistory)
    const upgrade = this.prompt.upgradeSeed(previousSeeds(), readFileSync(paths.seedPrompt, "utf8"))
    if (upgrade === "upgraded") this.log("system prompt: upgraded the stock prompt to the current one (revert_system_prompt undoes it)")
    if (upgrade === "custom") this.log("system prompt: customised, left as is (prompts/system.md has the current stock prompt)")
    this.jobs = new Jobs(paths.jobs, () => this.config.jobs)
    this.t3 = new T3(paths.home, this.config.t3.cli)
    this.watcher = new T3Watcher(
      this.t3,
      paths.watches,
      (e) => {
        const what = e.kind === "waiting" ? "needs your input" : e.kind === "failed" ? "failed" : "finished"
        this.notify({ kind: "t3", title: `T3 "${e.watch.title}" ${what}`, summary: e.message || e.status, ref: e.watch.threadId })
      },
      () => this.changed(),
    )
    this.inbox.onChange(() => this.changed())
    this.prompt.onChange(() => {
      this.brainDirty = true
      this.log("system prompt changed; brain restarts before the next turn")
    })
    this.jobs.on((job, ev) => {
      if (ev === "end") setTimeout(() => this.jobEnded(job), 50)
      this.changed()
    })
  }

  log(line: string) {
    const stamped = `${new Date().toISOString()} ${line}`
    process.stderr.write(stamped + "\n")
    try {
      appendFileSync(this.logFile, stamped + "\n")
    } catch {}
    this.emit("log", stamped)
  }

  private send(cmd: CoreCommand) {
    if (!this.link) return
    if (cmd.cmd !== "hud" && cmd.cmd !== "badge") this.log(`-> app ${truncate(JSON.stringify(cmd), 300)}`)
    this.link.send(cmd)
  }

  async start(): Promise<void> {
    if (this.mode === "stdio") {
      if (!this.link) throw new Error("stdio mode needs an App link")
      const m = new AppMouth(this.link, (l) => this.log(l))
      this.appMouth = m
      this.mouth = m
      this.mouthName = "app"
      m.on("start", (item: SpeechItem) => this.onSpeechStart(item))
      m.on("end", () => this.onSpeechEnd())
      this.link.on("event", (ev: AppEvent) => this.onAppEvent(ev))
      this.syncHud(true)
      this.syncBadge()
    } else {
      const { mouth, name } = await createMouth(this.config.mouth)
      this.mouth = mouth
      this.mouthName = name
      this.log(`mouth: ${name}`)
      mouth.on("start", () => this.onSpeechStart())
      mouth.on("end", () => this.onSpeechEnd())
      const ears = resolveEarsCommand(this.config.ears)
      this.log(ears.note)
      if (ears.argv) this.startEars(ears.argv)
    }
    this.watcher.start(this.config.t3.pollSeconds * 1000)
    // Warm the brain so the first turn doesn't pay for process start.
    this.ensureBrain().catch((err) => this.log(`brain failed to start: ${err.message}`))
  }

  // ---- the App (stdio mode) -------------------------------------------------

  private onAppEvent(ev: AppEvent) {
    if (ev.type !== "partial") this.log(`<- app ${truncate(JSON.stringify(ev), 300)}`)
    switch (ev.type) {
      case "ready":
        this.log(`app ready: mic ${ev.mic ?? "?"}, engine ${ev.engine ?? "?"}`)
        if (typeof ev.volume === "number") this.adoptVolume(ev.volume)
        this.syncHud(true)
        this.syncBadge(true)
        break
      case "speech_start":
        this.speechStarted()
        break
      case "partial":
        if (!this.inSpeech) this.speechStarted()
        this.partial = ev.text
        if (!this.speechEngaged && !this.micMuted && this.wakeIn(ev.text)) this.speechEngaged = true
        break
      case "final": {
        const start = this.appTime(ev.start) ?? (this.inSpeech ? this.speechStartedAt : Date.now())
        const end = this.appTime(ev.end) ?? Date.now()
        this.speechEnded()
        if (this.micMuted) {
          this.log(`ignored (microphone muted): ${ev.text}`)
          break
        }
        if (ev.during_playback && this.mouth.speaking) this.bargeIn(undefined, "final during playback")
        this.log(`heard: "${ev.text}"${ev.during_playback ? " (during playback)" : ""}`)
        void this.utterance({ text: ev.text, start, end, source: "app", duringPlayback: !!ev.during_playback })
        break
      }
      case "speech_cancel":
        this.speechEnded()
        if (this.bargePending) {
          // Talked over Vera, then nothing usable: keep listening a normal follow-up window.
          this.bargePending = false
          this.openFollowUp()
        }
        break
      case "barge_in":
        this.bargeIn(ev.speak_id, "barge_in")
        break
      case "playback":
        this.appMouth?.onPlayback(ev.speak_id, ev.state)
        break
      case "ui":
        this.onUi(ev)
        break
    }
    this.changed()
  }

  private onUi(ev: Extract<AppEvent, { type: "ui" }>) {
    switch (ev.action) {
      case "stop_talking":
        this.stop("tray: stop talking")
        break
      case "mute":
        this.micMuted = true
        this.followUpUntil = 0
        this.speechEnded()
        break
      case "unmute":
        this.micMuted = false
        break
      case "settings_changed":
        this.config = loadConfig()
        if (typeof ev.volume === "number") this.adoptVolume(ev.volume)
        this.log("settings changed; config reloaded")
        break
      case "card_closed":
        for (const c of this.cards) if (c.open && (!ev.card_id || c.id === ev.card_id)) c.open = false
        break
    }
  }

  /** App timestamps are epoch ms; anything else is ignored in favour of our own clock. */
  private appTime(t: unknown): number | undefined {
    return typeof t === "number" && t > EPOCH_MS ? t : undefined
  }

  private speechStarted() {
    this.inSpeech = true
    this.speechStartedAt = Date.now()
    this.speechEngaged = !this.micMuted && (this.bargePending || this.followUpUntil > Date.now() || this.mouth?.speaking)
    this.partial = "…"
  }

  private speechEnded() {
    this.inSpeech = false
    this.speechEngaged = false
    this.partial = ""
    this.flushChimes()
  }

  private wakeIn(text: string): boolean {
    const m = stripWakeWord(text, {
      extra: this.config.wake.words,
      maxLeadingWords: this.config.wake.maxLeadingWords,
      soft: this.config.wake.soft,
      recentlyActive: Date.now() - this.lastActiveAt < this.config.wake.warmSeconds * 1000,
    })
    return m.found
  }

  /**
   * Shawn talked over Vera. The App has already stopped playback. Cut the
   * rest of this turn's speech, interrupt the brain, and treat what he says
   * next as part of the conversation.
   */
  private bargeIn(speakId: string | undefined, why: string) {
    const m = this.appMouth
    if (!m) return
    const playing = m.playing
    const item = (speakId && m.get(speakId)) || playing
    const turnId = item?.turnId
    this.log(`barge-in (${why}) on ${speakId ?? playing?.id ?? "nothing playing"}`)
    this.bargePending = true
    this.speechEngaged = this.inSpeech || this.speechEngaged
    this.followUpUntil = Date.now() + Math.max(20, this.config.wake.followUpSeconds) * 1000
    m.cut(false) // usually already done: the App's `playback interrupted` tends to come first
    if (turnId !== undefined) {
      const rec = this.turns.find((t) => t.id === turnId)
      if (rec) rec.muted = true
      const items = this.speechByTurn.get(turnId) ?? []
      const cutItem = items.find((i) => i.state === "cut")
      this.interruption = {
        at: Date.now(),
        said: items.filter((i) => i.state === "done").map((i) => i.text),
        cut: cutItem ? { text: cutItem.text, playedMs: (cutItem.endedAt ?? Date.now()) - (cutItem.startedAt ?? Date.now()) } : undefined,
        unsaid: items.filter((i) => i.state === "dropped" || i.state === "queued").map((i) => i.text),
      }
      if (this.current?.id === turnId) {
        this.current.muted = true
        void this.brain?.interrupt()
      }
    }
    this.changed()
  }

  // ---- Ears (standalone mode) -----------------------------------------------

  private startEars(argv: string[]) {
    const ears = new Ears(argv, this.config.ears.cwd)
    this.ears = ears
    this.earsState = "starting"
    ears.on("message", (m: EarsMessage) => {
      switch (m.type) {
        case "ready":
          this.earsState = "ready"
          this.log(`ears ready: ${m.engine ?? "?"} ${m.model ?? ""}${m.device ? ` on "${m.device}"` : ""}${m.backend ? ` (${m.backend})` : ""}`)
          break
        case "speech_start":
          this.inSpeech = true
          if (!this.isDeaf(m.t)) this.partial = "…"
          break
        case "partial":
          if (this.bargeInHeard(m.text)) break
          if (!this.isDeaf(m.t)) this.partial = m.text
          break
        case "final":
          this.inSpeech = false
          this.partial = ""
          if (this.bargeInHeard(m.text)) {
            this.flushChimes()
            break
          }
          this.log(`heard: "${m.text}"${m.latency_ms ? ` (+${m.latency_ms} ms)` : ""}`)
          void this.utterance({ text: m.text, start: m.start, end: m.end, source: "ears" })
          this.flushChimes()
          break
        case "speech_cancel":
          this.inSpeech = false
          this.partial = ""
          this.flushChimes()
          break
        case "paused":
        case "resumed":
          break
        case "error":
          this.earsState = "error"
          this.log(`ears error: ${m.message}`)
          break
      }
      this.changed()
    })
    ears.start()
  }

  // ---- brain ----------------------------------------------------------------

  private mcpLaunch(harness: BrainHarness) {
    // node --import tsx runs the TypeScript server in one process (tsx's CLI would add a second).
    const tsx = pathToFileURL(join(CORE_DIR, "node_modules", "tsx", "dist", "loader.mjs")).href
    return {
      command: process.execPath,
      args: ["--import", tsx, join(CORE_DIR, "src", "mcp", "server.ts")],
      env: { VERA_URL: `http://127.0.0.1:${this.port}`, VERA_TOKEN: this.token, VERA_BRAIN: harness },
    }
  }

  async ensureBrain(): Promise<Brain> {
    if (this.brain && !this.brainDirty) return this.brain
    const old = this.brain
    const harness = this.config.brain.harness
    const settings = this.config.brain[harness] ?? {}
    const sameHarness = old?.harness === harness
    if (old) {
      this.brain = null
      await old.close()
    }
    this.brainDirty = false
    const brain = createBrain(harness, {
      model: settings.model,
      effort: settings.effort,
      systemPrompt: this.prompt.read(),
      mcp: this.mcpLaunch(harness),
      cwd: paths.brainDir,
      stateDir: paths.brainDir,
      log: (l) => this.log(l),
      // Same harness, new process (prompt edit): keep the conversation when the adapter can resume.
      resume: sameHarness ? old?.sessionId : undefined,
    })
    if (old && !(sameHarness && brain.sessionId && brain.sessionId === old.sessionId)) this.recapNext = true
    brain.on("text", (chunk: string) => {
      if (this.current) this.current.output += chunk
      this.changed()
    })
    brain.on("exit", () => {
      if (this.brain === brain && harness !== "claude-code") this.recapNext = true
    })
    this.brain = brain
    this.log(`brain: ${brain.label}`)
    await brain.start()
    this.changed()
    return brain
  }

  // ---- utterances and turns -------------------------------------------------

  /** Feed one utterance (heard, typed, or injected). */
  async utterance(input: UtteranceInput): Promise<GateResult & { turnId?: number }> {
    const now = Date.now()
    // Belt and braces for half-duplex: drop speech that began while Vera was talking or chiming.
    if (input.source === "ears" && input.start && this.isDeaf(input.start, input.end)) {
      this.log(`dropped (heard while speaking): ${input.text}`)
      return { action: "ignore", reason: "heard while speaking" }
    }
    // While Vera is talking (or was just talked over) the window is open; it opens fully when she stops.
    const open = this.mouth?.speaking || input.duringPlayback || this.bargePending
    const followUpUntil = open ? Number.MAX_SAFE_INTEGER : this.followUpUntil
    const g = gate(input, { followUpUntil }, now, {
      extra: this.config.wake.words,
      maxLeadingWords: this.config.wake.maxLeadingWords,
      soft: this.config.wake.soft,
      recentlyActive: now - this.lastActiveAt < this.config.wake.warmSeconds * 1000,
    })
    const wasBarge = this.bargePending
    if (g.action !== "ignore") this.bargePending = false
    this.lastHeard = input.text
    this.emit("heard", { text: input.text, gate: g })
    switch (g.action) {
      case "ignore":
        this.log(`ignored (${g.reason}): ${input.text}`)
        this.changed()
        return g
      case "wake":
        this.lastActiveAt = now
        this.openFollowUp()
        void this.chime("listening")
        this.changed()
        return g
      case "stop":
        this.stop(`heard "${input.text}"`)
        return g
      case "turn": {
        this.lines.push({ who: "shawn", text: g.text, at: now })
        this.trimLines()
        if (this.current) {
          this.queue.push({ ...input, text: g.text })
          this.log(`queued while thinking: ${g.text}`)
          this.changed()
          return g
        }
        const rec = this.beginTurn(g.text, wasBarge ? "barge-in" : g.via, input.end)
        return { ...g, turnId: rec.id }
      }
    }
  }

  get currentTurnId(): number | null {
    return this.current?.id ?? null
  }

  get currentTurn(): TurnRecord | null {
    return this.current
  }

  /** Resolves when the given turn ends. */
  waitTurn(id: number): Promise<TurnRecord> {
    const done = this.turns.find((t) => t.id === id && t.durationMs !== undefined)
    if (done) return Promise.resolve(done)
    return new Promise((resolve) => this.turnWaiters.set(id, resolve))
  }

  private beginTurn(text: string, via: string, heardEndAt?: number): TurnRecord {
    const rec: TurnRecord = {
      id: ++this.turnSeq,
      text,
      via,
      brain: "",
      startedAt: Date.now(),
      heardEndAt,
      spoken: [],
      tools: [],
      output: "",
    }
    this.lastActiveAt = Date.now()
    this.current = rec
    this.followUpUntil = 0
    this.turns.push(rec)
    if (this.turns.length > 50) this.turns.shift()
    this.changed()
    void this.runTurn(rec)
    return rec
  }

  private async runTurn(rec: TurnRecord) {
    let result: TurnResult
    try {
      const brain = await this.ensureBrain()
      rec.brain = brain.label
      const msg = this.composeTurn(rec.text)
      rec.startedAt = Date.now() // measure from hand-off, not from brain start
      this.log(`turn ${rec.id} -> ${brain.label}: ${truncate(oneLine(msg), 400)}`)
      result = await brain.turn(msg)
    } catch (err) {
      result = { ok: false, text: "", error: (err as Error).message }
    }
    rec.durationMs = Date.now() - rec.startedAt
    rec.ok = result.ok
    rec.error = result.error
    rec.interrupted = result.interrupted
    if (!rec.output && result.text) rec.output = result.text
    this.log(
      `turn ${rec.id} done in ${rec.durationMs} ms (first speak ${rec.firstSpeakMs ?? "-"} ms; tools ${rec.tools.join(", ") || "none"})${result.error ? " error: " + result.error : ""}`,
    )
    if (!result.ok && !result.interrupted) {
      void this.chime("error")
      if (this.mode === "standalone") this.addCard("Brain error", "```\n" + (result.error ?? "unknown") + "\n```")
    }
    this.current = null
    this.turnWaiters.get(rec.id)?.(rec)
    this.turnWaiters.delete(rec.id)
    this.changed()
    if (this.queue.length) {
      const q = this.queue.splice(0)
      this.beginTurn(q.map((u) => u.text).join(" … "), "queued", q[q.length - 1].end)
    }
  }

  private composeTurn(text: string): string {
    const parts: string[] = []
    if (this.recapNext) {
      this.recapNext = false
      const recent = this.lines.slice(-9, -1)
      if (recent.length) {
        parts.push(
          "[You just took over this conversation from another session. Recent lines, for context:]\n" +
            recent.map((l) => `${l.who === "shawn" ? "Shawn" : "Vera"}: ${truncate(oneLine(l.text), 300)}`).join("\n"),
        )
      }
    }
    const note = this.takeInterruptionNote()
    if (note) parts.push(note)
    const digest = this.inbox.takeDigest()
    if (digest) parts.push(digest)
    const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    parts.push(`[${time}] Shawn: ${text}`)
    return parts.join("\n\n")
  }

  /** "[Shawn talked over you ...]" for the turn after a barge-in, once, if recent. */
  private takeInterruptionNote(): string | null {
    const i = this.interruption
    this.interruption = null
    if (!i || Date.now() - i.at > 60_000) return null
    const bits: string[] = []
    if (i.said.length) bits.push(`He heard: "${truncate(i.said.join(" "), 300)}".`)
    if (i.cut) bits.push(`You were cut off ${heardPrefix(i.cut.text, i.cut.playedMs)}.`)
    if (i.unsaid.length) bits.push(`Never said: "${truncate(i.unsaid.join(" "), 200)}".`)
    return `[Shawn talked over you and you stopped. ${bits.join(" ")} Answer what he says now; don't repeat yourself unless he asks.]`
  }

  /** "Vera, stop" / tray Stop talking: silence, interrupt, forget the queue. */
  stop(reason = "stop") {
    this.log(`stop (${reason})`)
    this.queue = []
    this.bargePending = false
    this.interruption = null
    if (this.current) this.current.muted = true
    this.mouth?.stop()
    this.followUpUntil = 0
    void this.brain?.interrupt()
    this.changed()
  }

  /** Talk button / bare wake word: next utterance needs no wake word. */
  openFollowUp(seconds = this.config.wake.followUpSeconds) {
    this.followUpUntil = Date.now() + seconds * 1000
    if (!this.earsHolds.size && !this.resumeTimer) this.ears?.resume()
    if (this.followUpTimer) clearTimeout(this.followUpTimer)
    this.followUpTimer = setTimeout(() => this.changed(), seconds * 1000 + 20)
    this.followUpTimer.unref()
    this.changed()
  }

  // ---- speech ---------------------------------------------------------------

  /** The speak tool. Returns false when the turn was talked over (nothing is said). */
  say(text: string): boolean {
    const rec = this.current
    if (rec?.muted) {
      this.log(`not spoken (turn ${rec.id} was interrupted): ${text}`)
      return false
    }
    if (rec) {
      if (rec.firstSpeakMs === undefined) {
        rec.firstSpeakMs = Date.now() - rec.startedAt
        if (rec.heardEndAt) this.awaitingAudio = rec
      }
      rec.spoken.push(text)
    }
    this.speakingText += " " + text
    this.lines.push({ who: "vera", text, at: Date.now() })
    this.trimLines()
    this.emit("said", text)
    this.changed()
    if (this.appMouth) {
      const item = this.appMouth.say(text, rec?.id)
      if (rec) {
        const list = this.speechByTurn.get(rec.id) ?? []
        list.push(item)
        this.speechByTurn.set(rec.id, list)
        if (this.speechByTurn.size > 20) this.speechByTurn.delete(this.speechByTurn.keys().next().value!)
      }
    } else {
      this.mouth.speak(text).catch((err) => this.log(`mouth failed: ${err.message}`))
    }
    return true
  }

  private onSpeechStart(_item?: SpeechItem) {
    const rec = this.awaitingAudio
    if (rec?.heardEndAt) {
      rec.endToAudioMs = Date.now() - rec.heardEndAt
      this.log(`turn ${rec.id}: end of speech -> first audio ${rec.endToAudioMs} ms`)
    }
    this.awaitingAudio = null
    // Standalone barge-in keeps Ears listening (only for "Vera, stop"); otherwise they're paused.
    if (this.mode === "standalone") this.holdEars("speaking", !this.config.ears.bargeIn)
    this.changed()
  }

  private onSpeechEnd() {
    this.lastActiveAt = Date.now()
    if (this.mode === "stdio") {
      this.speakingText = ""
      // Talked over: the barge-in window is already open; otherwise the follow-up opens now.
      if (!this.bargePending) this.openFollowUp()
    } else {
      this.releaseEars("speaking", this.config.ears.tailMs, () => {
        this.speakingText = ""
        this.openFollowUp()
      })
    }
    this.changed()
  }

  /**
   * Half-duplex (standalone). Each reason pauses Ears (or with `pause` false,
   * only marks the time as deaf so finals from it are dropped); the last
   * release resumes them after `tailMs`, then runs `then`.
   */
  private holdEars(reason: string, pause = true) {
    if (!this.earsHolds.size && !this.resumeTimer) this.deafFrom = Date.now()
    this.deafUntil = 0
    this.earsHolds.add(reason)
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    this.resumeTimer = null
    if (pause) this.ears?.pause()
  }

  private releaseEars(reason: string, tailMs: number, then?: () => void) {
    this.earsHolds.delete(reason)
    if (this.earsHolds.size) return
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null
      if (this.earsHolds.size) return
      this.deafUntil = Date.now()
      if (this.ears && !this.ears.isPaused && this.config.ears.bargeIn) {
        // Listened through Vera's speech: drop whatever echo utterance is open so the next one starts clean.
        this.ears.pause()
      }
      this.ears?.resume()
      then?.()
      this.changed()
    }, tailMs)
  }

  /**
   * Speech from `t` (to `end`) overlaps a deaf stretch: Vera talking or
   * chiming, plus the tail. With barge-in, Ears keep listening, so a
   * transcript that began just before Vera started is her echo too.
   */
  private isDeaf(t: number, end = t): boolean {
    if (!this.deafFrom || end < this.deafFrom) return false
    return this.earsHolds.size > 0 || !!this.resumeTimer || t <= this.deafUntil
  }

  /** Standalone, while Vera talks with barge-in on: did Shawn say "Vera, stop"? Stops her if so. */
  private bargeInHeard(text: string): boolean {
    if (!this.config.ears.bargeIn || !this.earsHolds.has("speaking")) return false
    const hit = findBargeIn(text, this.speakingText, this.config.wake.words)
    if (!hit) return false
    this.stop(`barge-in, heard "${text}"`)
    return true
  }

  /**
   * Play a chime. Standalone pauses Ears around it so it isn't heard as
   * speech. An inbox ping while Shawn is mid-sentence waits until he's done.
   */
  async chime(kind: ChimeKind): Promise<void> {
    if (kind === "notify" && this.inSpeech && (this.mode === "stdio" || !this.isDeaf(Date.now()))) {
      if (!this.deferredChimes.includes(kind)) this.deferredChimes.push(kind)
      this.log("chime notify waits until Shawn finishes speaking")
      return
    }
    if (this.mode === "stdio") return this.mouth?.chime(kind)
    this.holdEars("chime")
    try {
      await this.mouth.chime(kind)
    } catch (err) {
      this.log(`chime failed: ${(err as Error).message}`)
    } finally {
      this.releaseEars("chime", this.config.ears.chimeTailMs)
    }
  }

  private flushChimes() {
    for (const kind of this.deferredChimes.splice(0)) void this.chime(kind)
  }

  // ---- volume ---------------------------------------------------------------

  private loadState(): { volume?: number } {
    try {
      return JSON.parse(readFileSync(paths.state, "utf8"))
    } catch {
      return {}
    }
  }

  private saveState() {
    try {
      writeFileSync(paths.state, JSON.stringify({ ...this.loadState(), volume: this.volume }, null, 2) + "\n")
    } catch {}
  }

  /** The App reported its volume (it owns it): remember it, don't echo it back. */
  private adoptVolume(level: number) {
    this.volume = clamp01(level)
    this.saveState()
  }

  /** Vera's own output volume. Never the computer's. */
  setVolume(change: { level?: number; relative?: "quieter" | "louder"; a_lot?: boolean }): { from: number; to: number } {
    const from = this.volume
    let to: number
    if (typeof change.level === "number" && Number.isFinite(change.level)) {
      to = change.level > 1 ? change.level / 100 : change.level // "set it to 30" means 30%
    } else if (change.relative === "quieter" || change.relative === "louder") {
      const f = change.a_lot ? 2 : 1.4
      to = change.relative === "quieter" ? from / f : from * f
      to = Math.max(0.05, to)
    } else throw new Error("give level (0-1) or relative: quieter | louder")
    to = Math.round(clamp01(to) * 100) / 100
    this.volume = to
    this.saveState()
    this.send({ cmd: "set_volume", level: to })
    this.changed()
    return { from, to }
  }

  // ---- background work ------------------------------------------------------

  notify(item: { kind: "job" | "t3" | "system"; title: string; summary: string; ref?: string }) {
    this.inbox.add(item)
    this.log(`inbox: ${item.title}`)
    if (this.mouth) void this.chime("notify")
  }

  markJobSync(id: string) {
    this.syncJobs.add(id)
  }

  private jobEnded(job: Job) {
    if (this.syncJobs.has(job.id)) return // the brain already got the answer in the tool result
    if (job.status === "cancelled") return
    const ok = job.status === "done"
    this.notify({
      kind: "job",
      title: `${job.agent} job ${job.id} ${ok ? "finished" : "failed"}`,
      summary: ok ? (job.result ?? "(no output)") : (job.error ?? "failed"),
      ref: job.id,
    })
  }

  /** Background work Vera started that's still going: jobs, and T3 threads she watches. */
  backgroundBusy(): boolean {
    if (this.jobs.list(50).some((j) => j.status === "running" && !this.syncJobs.has(j.id))) return true
    for (const w of this.watcher.watches.values()) if (isBusy(w.lastStatus) || w.expectRun) return true
    return false
  }

  // ---- cards ----------------------------------------------------------------

  addCard(title: string, markdown: string): Card {
    const card: Card = { id: `c${++this.cardSeq}`, title, markdown: truncate(markdown, 6000), at: Date.now(), open: true }
    this.cards.unshift(card)
    if (this.cards.length > 30) this.cards.pop()
    this.send({ cmd: "show", card_id: card.id, title: card.title, markdown: card.markdown })
    this.changed()
    return card
  }

  /** Close one card, or every open one. Returns the ids closed. */
  hideCard(id?: string): string[] {
    const want = id ? (id.startsWith("c") ? id : `c${id}`) : null
    const closing = this.cards.filter((c) => c.open && (!want || c.id === want))
    for (const c of closing) {
      c.open = false
      this.send({ cmd: "hide", card_id: c.id })
    }
    this.changed()
    return closing.map((c) => c.id)
  }

  setBrain(harness: BrainHarness, model?: string, effort?: string): string {
    const patch: any = { brain: { harness } }
    if (model || effort) patch.brain[harness] = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    this.config = saveConfigPatch(patch)
    this.brainDirty = true
    const s = this.config.brain[harness]
    return `${harness} ${s.model ?? "default"}/${s.effort ?? "default"}`
  }

  // ---- state: HUD, badge, panel ---------------------------------------------

  status(): HudState {
    const now = Date.now()
    if (this.mouth?.speaking) return "speaking"
    if (this.micMuted) return this.current ? "thinking" : this.backgroundBusy() ? "working" : "idle"
    // Shawn is talking to Vera (after the wake word, in the window, or over her).
    if (this.bargePending || (this.inSpeech && this.speechEngaged)) return "listening"
    if (this.current || this.queue.length || this.appMouth?.pendingStart) return "thinking"
    if (this.followUpUntil > now) return "listening"
    if (this.mode === "standalone" && this.partial && this.ears && !this.ears.isPaused) return "listening"
    if (this.backgroundBusy()) return "working"
    return "idle"
  }

  private syncHud(force = false) {
    const s = this.status()
    if (s === this.hud && !force) return
    this.hud = s
    this.send({ cmd: "hud", state: s })
  }

  private syncBadge(force = false) {
    const n = this.inbox.unread().length
    if (n === this.badgeCount && !force) return
    this.badgeCount = n
    this.send({ cmd: "badge", count: n })
  }

  snapshot() {
    const lastSaid = [...this.lines].reverse().find((l) => l.who === "vera")?.text ?? ""
    return {
      mode: this.mode,
      status: this.status(),
      hud: this.hud,
      volume: this.volume,
      micMuted: this.micMuted,
      badge: this.inbox.unread().length,
      brain: this.brain?.label ?? `${this.config.brain.harness} (starting)`,
      mouth: this.mouthName,
      ears: this.earsState,
      lastHeard: this.lastHeard,
      partial: this.partial,
      lastSaid,
      followUpUntil: this.followUpUntil,
      queue: this.queue.map((q) => q.text),
      current: this.current && { id: this.current.id, text: this.current.text, output: truncate(this.current.output, 2000) },
      cards: this.cards.slice(0, 12),
      jobs: this.jobs.list(12).map((j) => ({
        id: j.id,
        agent: j.agent,
        task: truncate(oneLine(j.task), 160),
        status: j.status,
        startedAt: j.startedAt,
        endedAt: j.endedAt,
        progress: j.progress && truncate(oneLine(j.progress), 160),
        result: j.result && truncate(j.result, 600),
        error: j.error && truncate(j.error, 300),
      })),
      inbox: [...this.inbox.items].reverse().slice(0, 20),
      watches: [...this.watcher.watches.values()],
      lines: this.lines.slice(-12),
      turns: this.turns.slice(-8).map((t) => ({
        id: t.id,
        text: t.text,
        via: t.via,
        brain: t.brain,
        tools: t.tools,
        spoken: t.spoken,
        firstSpeakMs: t.firstSpeakMs,
        endToAudioMs: t.endToAudioMs,
        durationMs: t.durationMs,
        ok: t.ok,
        interrupted: t.interrupted,
        muted: t.muted,
      })),
    }
  }

  private changeTimer: NodeJS.Timeout | null = null
  changed() {
    if (this.link) {
      // The HUD and badge follow state at once; the panel snapshot is debounced.
      this.syncHud()
      this.syncBadge()
    }
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      if (this.link) this.syncHud()
      this.emit("state", this.snapshot())
    }, 30)
  }

  private trimLines() {
    if (this.lines.length > 100) this.lines.splice(0, this.lines.length - 100)
  }

  async close() {
    this.watcher.stop()
    this.jobs.shutdown()
    await Promise.allSettled([this.brain?.close(), this.ears?.close(), this.mouth?.close()])
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** Roughly what Shawn heard of a sentence cut after `playedMs` (speech runs about 15 characters a second). */
export function heardPrefix(text: string, playedMs: number): string {
  const chars = Math.round((playedMs / 1000) * 15)
  if (chars >= text.length) return `at the end of "${text}"`
  if (chars < 8) return `right at the start of "${truncate(text, 200)}"`
  const cut = text.lastIndexOf(" ", chars)
  const heard = text.slice(0, cut > 0 ? cut : chars)
  return `after "${heard}…" (of "${truncate(text, 200)}")`
}

/** Earlier stock prompts (prompts/previous/*.md), so an unedited copy in ~/.vera is upgraded. */
function previousSeeds(): string[] {
  const dir = join(CORE_DIR, "prompts", "previous")
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(join(dir, f), "utf8"))
  } catch {
    return []
  }
}
