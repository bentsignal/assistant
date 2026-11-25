import { EventEmitter } from "node:events"
import { randomBytes } from "node:crypto"
import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { CORE_DIR, loadConfig, paths, resolveEarsCommand, saveConfigPatch, type BrainHarness, type VeraConfig } from "./config.ts"
import { findBargeIn, gate, type GateResult } from "./gate.ts"
import { Inbox, oneLine, truncate } from "./inbox.ts"
import { SystemPrompt } from "./prompt.ts"
import { Jobs, type Job } from "./jobs.ts"
import { T3, T3Watcher } from "./t3.ts"
import { createMouth, type ChimeKind, type Mouth } from "./mouth.ts"
import { Ears, type EarsMessage } from "./ears.ts"
import { createBrain, type Brain, type TurnResult } from "./brain/index.ts"

export type Status = "idle" | "listening" | "thinking" | "speaking"

export interface Card {
  id: number
  title: string
  markdown: string
  at: number
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
  /** When Shawn stopped speaking (Ears' final.end), for heard turns. */
  heardEndAt?: number
  /** ms from the end of Shawn's speech to Vera's first audio going to the player. */
  endToAudioMs?: number
  durationMs?: number
  spoken: string[]
  output: string
  ok?: boolean
  error?: string
  interrupted?: boolean
}

export interface UtteranceInput {
  text: string
  start?: number
  /** When the speech ended (epoch ms), for latency. */
  end?: number
  direct?: boolean
  source?: "ears" | "panel" | "api"
}

/**
 * Vera's conversation loop: gate -> brain turn -> tools -> Mouth, with the
 * inbox, jobs, T3 watches and the panel state around it.
 *
 * Turn policy: one brain turn at a time. Utterances that pass the gate while
 * a turn is in flight are QUEUED and sent together as the next turn (Shawn
 * often adds a thought while Vera is thinking; dropping it would be worse).
 * "Vera, stop" / "never mind" is never queued: it stops speech, interrupts
 * the turn, and clears the queue.
 */
export class Vera extends EventEmitter {
  config: VeraConfig
  readonly token = randomBytes(16).toString("hex")
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

  cards: Card[] = []
  lines: Line[] = []
  turns: TurnRecord[] = []
  lastHeard = ""
  partial = ""
  followUpUntil = 0
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
  /** Ears announced speech_start and the final or cancel hasn't come yet. */
  private earsInSpeech = false
  private deferredChimes: ChimeKind[] = []
  /** Last time Vera spoke, woke, or took a turn (warm wake words). */
  private lastActiveAt = 0
  /** Turn waiting for its first audio, to measure end-of-speech -> audio. */
  private awaitingAudio: TurnRecord | null = null
  /** What Vera is saying in the current speaking stretch (barge-in echo check). */
  private speakingText = ""
  private syncJobs = new Set<string>()
  private turnWaiters = new Map<number, (t: TurnRecord) => void>()
  private logFile: string

  constructor() {
    super()
    this.config = loadConfig()
    this.logFile = join(paths.logs, `vera-${new Date().toISOString().slice(0, 10)}.log`)
    this.inbox = new Inbox(paths.inbox)
    this.prompt = new SystemPrompt(paths.systemPrompt, paths.promptHistory)
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
    console.log(stamped)
    try {
      appendFileSync(this.logFile, stamped + "\n")
    } catch {}
    this.emit("log", stamped)
  }

  async start(): Promise<void> {
    const { mouth, name } = await createMouth(this.config.mouth)
    this.mouth = mouth
    this.mouthName = name
    this.log(`mouth: ${name}`)
    mouth.on("start", () => this.onSpeechStart())
    mouth.on("end", () => this.onSpeechEnd())

    const ears = resolveEarsCommand(this.config.ears)
    this.log(ears.note)
    if (ears.argv) this.startEars(ears.argv)
    this.watcher.start(this.config.t3.pollSeconds * 1000)
    // Warm the brain so the first turn doesn't pay for process start.
    this.ensureBrain().catch((err) => this.log(`brain failed to start: ${err.message}`))
  }

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
          this.earsInSpeech = true
          if (!this.isDeaf(m.t)) this.partial = "…"
          break
        case "partial":
          if (this.bargeInHeard(m.text)) break
          if (!this.isDeaf(m.t)) this.partial = m.text
          break
        case "final":
          this.earsInSpeech = false
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
          this.earsInSpeech = false
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
    const tsxCli = join(CORE_DIR, "node_modules", "tsx", "dist", "cli.mjs")
    return {
      command: process.execPath,
      args: [tsxCli, join(CORE_DIR, "src", "mcp", "server.ts")],
      env: { VERA_URL: `http://127.0.0.1:${this.config.port}`, VERA_TOKEN: this.token, VERA_BRAIN: harness },
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
    // While Vera is talking the follow-up window is open (it opens fully when she stops).
    const followUpUntil = this.mouth?.speaking ? Number.MAX_SAFE_INTEGER : this.followUpUntil
    const g = gate(input, { followUpUntil }, now, {
      extra: this.config.wake.words,
      maxLeadingWords: this.config.wake.maxLeadingWords,
      soft: this.config.wake.soft,
      recentlyActive: now - this.lastActiveAt < this.config.wake.warmSeconds * 1000,
    })
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
        const rec = this.beginTurn(g.text, g.via, input.end)
        return { ...g, turnId: rec.id }
      }
    }
  }

  get currentTurnId(): number | null {
    return this.current?.id ?? null
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
      this.log(`turn ${rec.id} -> ${brain.label}: ${rec.text}`)
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
      `turn ${rec.id} done in ${rec.durationMs} ms (first speak ${rec.firstSpeakMs ?? "-"} ms)${result.error ? " error: " + result.error : ""}`,
    )
    if (!result.ok && !result.interrupted) {
      void this.chime("error")
      this.addCard("Brain error", "```\n" + (result.error ?? "unknown") + "\n```")
    }
    this.current = null
    this.turnWaiters.get(rec.id)?.(rec)
    this.turnWaiters.delete(rec.id)
    this.changed()
    if (this.queue.length) {
      const q = this.queue.splice(0)
      this.beginTurn(q.map((u) => u.text).join(" … "), "queued")
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
    const digest = this.inbox.takeDigest()
    if (digest) parts.push(digest)
    const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    parts.push(`[${time}] Shawn: ${text}`)
    return parts.join("\n\n")
  }

  /** "Vera, stop": silence, interrupt, forget the queue. */
  stop(reason = "stop") {
    this.log(`stop (${reason})`)
    this.queue = []
    this.mouth?.stop()
    this.followUpUntil = 0
    void this.brain?.interrupt()
    this.changed()
  }

  /** Talk button / bare wake word: next utterance needs no wake word. */
  openFollowUp(seconds = this.config.wake.followUpSeconds) {
    this.followUpUntil = Date.now() + seconds * 1000
    if (!this.earsHolds.size && !this.resumeTimer) this.ears?.resume()
    this.changed()
    setTimeout(() => this.changed(), seconds * 1000 + 50).unref()
  }

  // ---- mouth and half-duplex ------------------------------------------------

  say(text: string) {
    const rec = this.current
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
    this.mouth.speak(text).catch((err) => this.log(`mouth failed: ${err.message}`))
  }

  private onSpeechStart() {
    const rec = this.awaitingAudio
    if (rec?.heardEndAt) {
      rec.endToAudioMs = Date.now() - rec.heardEndAt
      this.log(`turn ${rec.id}: end of speech -> first audio ${rec.endToAudioMs} ms`)
    }
    this.awaitingAudio = null
    // Barge-in keeps Ears listening (only for "Vera, stop"); otherwise they're paused.
    this.holdEars("speaking", !this.config.ears.bargeIn)
    this.changed()
  }

  private onSpeechEnd() {
    this.lastActiveAt = Date.now()
    this.releaseEars("speaking", this.config.ears.tailMs, () => {
      this.speakingText = ""
      this.openFollowUp()
    })
    this.changed()
  }

  /**
   * Half-duplex. Each reason pauses Ears (or with `pause` false, only marks
   * the time as deaf so finals from it are dropped); the last release resumes
   * them after `tailMs`, then runs `then`.
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

  /** While Vera talks with barge-in on: did Shawn say "Vera, stop"? Stops her if so. */
  private bargeInHeard(text: string): boolean {
    if (!this.config.ears.bargeIn || !this.earsHolds.has("speaking")) return false
    const hit = findBargeIn(text, this.speakingText, this.config.wake.words)
    if (!hit) return false
    this.stop(`barge-in, heard "${text}"`)
    return true
  }

  /**
   * Play a chime with Ears paused around it, so it isn't heard as speech. An
   * inbox ping while Shawn is mid-sentence waits until he's done (pausing
   * would throw his sentence away).
   */
  async chime(kind: ChimeKind): Promise<void> {
    if (kind === "notify" && this.earsInSpeech && !this.isDeaf(Date.now())) {
      if (!this.deferredChimes.includes(kind)) this.deferredChimes.push(kind)
      this.log("chime notify waits until Shawn finishes speaking")
      return
    }
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

  addCard(title: string, markdown: string): Card {
    const card = { id: ++this.cardSeq, title, markdown, at: Date.now() }
    this.cards.unshift(card)
    if (this.cards.length > 30) this.cards.pop()
    this.changed()
    return card
  }

  setBrain(harness: BrainHarness, model?: string, effort?: string): string {
    const patch: any = { brain: { harness } }
    if (model || effort) patch.brain[harness] = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    this.config = saveConfigPatch(patch)
    this.brainDirty = true
    const s = this.config.brain[harness]
    return `${harness} ${s.model ?? "default"}/${s.effort ?? "default"}`
  }

  // ---- state for the panel --------------------------------------------------

  status(): Status {
    if (this.mouth?.speaking) return "speaking"
    if (this.current) return "thinking"
    if (this.followUpUntil > Date.now() || (this.partial && this.ears && !this.ears.isPaused)) return "listening"
    return "idle"
  }

  snapshot() {
    const lastSaid = [...this.lines].reverse().find((l) => l.who === "vera")?.text ?? ""
    return {
      status: this.status(),
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
      turns: this.turns
        .slice(-8)
        .map((t) => ({ id: t.id, text: t.text, brain: t.brain, firstSpeakMs: t.firstSpeakMs, endToAudioMs: t.endToAudioMs, durationMs: t.durationMs, ok: t.ok })),
    }
  }

  private changeTimer: NodeJS.Timeout | null = null
  changed() {
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
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
