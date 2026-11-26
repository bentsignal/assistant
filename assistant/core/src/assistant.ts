import { randomBytes } from "node:crypto"
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { BUNDLED, CORE_DIR, DEFAULT_NAME, loadConfig, paths, personasOf, saveConfigPatch, validName, type BrainHarness, type AssistantConfig, type Persona } from "./config.ts"
import { gate, stripWakeWord, type GateResult } from "./gate.ts"
import { Inbox, oneLine, truncate } from "./inbox.ts"
import { SystemPrompt, renderPrompt } from "./prompt.ts"
import { SkillStore } from "./skills.ts"
import { McpStore, brainServers, type ResolvedServer } from "./mcp/config.ts"
import { patchFor, SETTINGS } from "./settings.ts"
import { Jobs, type Job } from "./jobs.ts"
import { T3, T3Watcher, isBusy, watchNotice } from "./t3.ts"
import { CommandRuns } from "./commands.ts"
import { ACK_AFTER_MS, ackNote, acksFor, endsSilently, pickAck, slowTool, stripOpeningAck } from "./ack.ts"
import { AppMouth, type AppEvent, type AppLink, type ChimeKind, type CoreCommand, type HudState, type SpeechItem } from "./app.ts"
import { createBrain, type Brain, type TurnResult } from "./brain/index.ts"
import { continues, joinTurns, resumeNote, type Resumable } from "./turns.ts"

export type Status = HudState

export interface Card {
  id: string
  title: string
  markdown: string
  at: number
  open: boolean
}

export interface Line {
  who: "shawn" | "assistant"
  text: string
  at: number
  /** Which of her names said it. */
  persona?: string
}

export interface TurnRecord {
  id: number
  text: string
  via: string
  /** The persona he was talking to: the reply is in its voice. */
  persona?: string
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
  /** What Core said for her while she worked ("One sec."), and why (`ack.ts`). */
  ack?: string
  ackWhy?: string
  /** The brain has done something this turn (spoken or called a tool). */
  acted?: boolean
  /** She's been told about the acknowledgement. */
  ackNoted?: boolean
}

export interface UtteranceInput {
  text: string
  start?: number
  /** When the speech ended (epoch ms), for latency. */
  end?: number
  direct?: boolean
  source?: "app" | "api"
  /** Heard while Vera was playing: an in-conversation turn. */
  duringPlayback?: boolean
}

/** What Vera was saying when Shawn talked over her, for the next turn's note. */
interface Interruption {
  at: number
  said: string[]
  cut?: { text: string; playedMs: number }
  unsaid: string[]
}

/** Epoch ms look like this; anything smaller is some other clock. */
const EPOCH_MS = 1e12
/** An open utterance with no new words (no partial) for this long, and no final, is over. */
const SPEECH_SILENCE_MS = 60_000

/**
 * Vera's volume is the App's 0-1 level, where level v is 40 × (v − 1) dB
 * (1 is the voice service's own level, 0 is silent). A relative step is
 * 0.15 (6 dB), a big one 0.3 (12 dB), and stays within [0.1, 1].
 */
const VOLUME_STEP = 0.15
const VOLUME_BIG_STEP = 0.3
const VOLUME_MIN_STEPPED = 0.1

/**
 * Vera's conversation loop: gate -> brain turn -> tools -> speech, with the
 * inbox, jobs, T3 watches and the HUD around it. The App (over `link`) owns
 * the microphone, playback, the HUD, cards and the tray.
 *
 * Turn policy: one brain turn at a time. Utterances that pass the gate while
 * a turn is in flight are QUEUED and sent together as the next turn (Shawn
 * often adds a thought while Vera is thinking; dropping it would be worse).
 * "Vera, stop" / "never mind" is never queued: it stops speech, interrupts
 * the turn, and clears the queue.
 */
export class Assistant {
  config: AssistantConfig
  readonly token = randomBytes(16).toString("hex")
  /** Port the HTTP server ended up on (MCP tool calls come back through it). */
  port: number
  inbox: Inbox
  prompt: SystemPrompt
  skills: SkillStore
  /** Her own MCP servers (~/.assistant/mcp.json). */
  mcp: McpStore
  /** Each of her servers' state as the brain last reported it (or why it was left out). */
  mcpState = new Map<string, { status: string; error?: string }>()
  /** Problems with her servers she hasn't told Shawn about yet (said once each). */
  private mcpPending = new Map<string, string>()
  private mcpSaid = new Set<string>()
  jobs: Jobs
  t3: T3
  watcher: T3Watcher
  /** run_command's programs, owned by Core (they outlive any turn; `commands.ts`). */
  commands: CommandRuns
  /** Speech through the App: one `speak` at a time, `playback` events back. */
  readonly mouth: AppMouth
  brain: Brain | null = null
  readonly link: AppLink

  cards: Card[] = []
  lines: Line[] = []
  turns: TurnRecord[] = []
  lastHeard = ""
  partial = ""
  followUpUntil = 0
  /** The name he last used (follow-ups keep it): who answers, in whose voice. */
  activePersona = ""
  /** Vera's own output level (0-1, see VOLUME_STEP). The App applies and persists it. */
  volume: number
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
  /** Barge-in happened; the next final is Shawn's reply. */
  private interruption: Interruption | null = null
  private bargePending = false
  private bargeTimer: NodeJS.Timeout | null = null
  private speechByTurn = new Map<number, SpeechItem[]>()
  private syncJobs = new Set<string>()
  private turnWaiters = new Map<number, (t: TurnRecord) => void>()
  private followUpTimer: NodeJS.Timeout | null = null
  /** She was asked to stop listening (`stop_listening`): when, once her words are out. */
  private offRequested: number | null = null
  /** Ends an utterance whose final never came (the App always sends one; this is the backstop). */
  private speechTimer: NodeJS.Timeout | null = null
  /** The last turn was cut short because Shawn spoke again: the next turn's message says so. */
  private superseded: string | null = null
  /** His next words continue this turn (he went on before she'd answered; `turns.ts`). */
  private resumable: Resumable | null = null
  private logFile: string
  private ackTimer: NodeJS.Timeout | null = null
  private ackSeq = 0
  /** Core tools the brain is running now (speak aside): his talking waits for them instead of cancelling them. */
  private toolsInFlight = new Map<number, string>()
  private toolCallSeq = 0
  /** The brain is to be interrupted once its running tools have returned (why). */
  private interruptWhenIdle: string | null = null
  /** What tools returned while he was talking over her: the next turn's message says so. */
  private heldResults: { tool: string; result: string }[] = []

  constructor(link: AppLink) {
    this.link = link
    this.config = loadConfig()
    this.port = this.config.port
    this.logFile = join(paths.logs, `core-${new Date().toISOString().slice(0, 10)}.log`)
    this.mouth = new AppMouth(link, (l) => this.log(l))
    const state = this.loadState()
    this.volume = state.volume ?? this.config.voice.defaultVolume
    // Whoever he was talking to keeps answering across restarts and new sessions.
    this.activePersona = state.persona ?? ""
    this.inbox = new Inbox(paths.inbox)
    this.prompt = new SystemPrompt(paths.systemPrompt, paths.promptHistory)
    const upgrade = this.prompt.upgradeSeed(previousSeeds(), readFileSync(paths.seedPrompt, "utf8"))
    if (upgrade === "upgraded") this.log("system prompt: upgraded the stock prompt to the current one (revert_system_prompt undoes it)")
    if (upgrade === "custom") this.log("system prompt: customised, left as is (prompts/system.md has the current stock prompt)")
    this.skills = new SkillStore(paths.skills)
    for (const s of this.skills.seed()) this.log(`skills: seeded ${s}`)
    this.skills.onChange(() => {
      this.brainDirty = true
      this.log("skills changed; brain restarts before the next turn")
    })
    this.mcp = new McpStore(paths.mcp)
    this.mcp.check()
    this.mcp.onChange(() => {
      this.brainDirty = true
      this.mcpSaid.clear()
      this.log("mcp.json changed; brain restarts before the next turn")
    })
    this.jobs = new Jobs(paths.jobs, () => this.config.jobs)
    this.commands = new CommandRuns((run, text) => {
      const ok = run.result && run.result.code === 0 && !run.result.timedOut
      this.notify({ kind: "job", title: `Command "${truncate(run.line, 60)}" ${ok ? "finished" : "failed"}`, summary: text, ref: run.id })
    })
    this.t3 = new T3(paths.home, () => this.config.t3)
    this.watcher = new T3Watcher(
      this.t3,
      paths.watches,
      (e) => this.notify(watchNotice(e)),
      () => this.changed(),
      (line) => this.log(line),
    )
    this.inbox.onChange(() => this.changed())
    this.prompt.onChange(() => {
      this.brainDirty = true
      this.log("system prompt changed; brain restarts before the next turn")
    })
    this.prompt.watch()
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
  }

  private send(cmd: CoreCommand) {
    if (cmd.cmd !== "hud" && cmd.cmd !== "badge") this.log(`-> app ${truncate(JSON.stringify(cmd), 300)}`)
    this.link.send(cmd)
  }

  async start(): Promise<void> {
    this.mouth.on("start", () => this.onSpeechStart())
    this.mouth.on("end", () => this.onSpeechEnd())
    this.mouth.on("stuck", (item: SpeechItem) =>
      this.alert("speech", `the App never ${item.state === "sent" ? "started" : "finished"} a line; it was skipped`),
    )
    // Events the App sent while Core was starting were buffered; they arrive now.
    this.link.on("event", (ev: AppEvent) => this.onAppEvent(ev))
    this.syncHud(true)
    this.syncBadge()
    this.watcher.start(this.config.t3.pollSeconds * 1000)
    this.warmAcks()
    // Warm the brain so the first turn doesn't pay for process start.
    this.ensureBrain().catch((err) => this.log(`brain failed to start: ${err.message}`))
  }

  // ---- the App --------------------------------------------------------------

  private onAppEvent(ev: AppEvent) {
    if (ev.type !== "partial") this.log(`<- app ${truncate(JSON.stringify(ev), 300)}`)
    switch (ev.type) {
      case "ready":
        this.log(`app ready: mic ${ev.mic ?? "?"}, engine ${ev.engine ?? "?"}, volume ${ev.volume ?? "?"}`)
        if (typeof ev.volume === "number") this.adoptVolume(ev.volume)
        this.syncHud(true)
        this.syncBadge(true)
        break
      case "speech_start":
        this.speechStarted(this.appTime(ev.t))
        break
      case "partial":
        if (!this.inSpeech) this.speechStarted(this.appTime(ev.t))
        else this.armSpeechTimer()
        this.partial = ev.text
        if (!this.speechEngaged && !this.micMuted && this.wakeIn(ev.text)) this.speechEngaged = true
        break
      case "final": {
        const start = this.appTime(ev.start) ?? (this.inSpeech ? this.speechStartedAt : Date.now())
        const end = this.appTime(ev.end) ?? Date.now()
        // He keeps the floor until his words are decided on: a line from
        // before them is dropped (a new turn) or plays (ignored), never
        // started first.
        this.speechEnded(false)
        if (this.micMuted) {
          this.log(`ignored (microphone muted): ${ev.text}`)
          this.mouth.floor(false)
          break
        }
        if (ev.during_playback && this.mouth.speaking) this.bargeIn(undefined, "final during playback")
        this.log(`heard: "${ev.text}"${ev.during_playback ? " (during playback)" : ""}`)
        // utterance() decides synchronously (it awaits nothing before it returns).
        void this.utterance({ text: ev.text, start, end, source: "app", duringPlayback: !!ev.during_playback })
        this.mouth.floor(false)
        break
      }
      case "speech_cancel":
        this.speechEnded()
        if (this.resumable) {
          // Nothing usable after all: her held answer plays.
          this.log(`turn ${this.resumable.turnId}: he didn't go on after all${this.mouth.holding ? "; her answer plays" : ""}`)
          this.resumable = null
          this.mouth.release()
        }
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
        this.mouth.onPlayback(ev.speak_id, ev.state)
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
        // Listening is off (the tray, `assistant listen off`, or she asked):
        // she's completely off. What she was saying and the turn behind it stop.
        this.micMuted = true
        this.offRequested = null
        this.speechEnded()
        this.resumable = null
        this.mouth.release()
        this.stop("listening off")
        break
      case "unmute":
        this.micMuted = false
        break
      case "settings_changed": {
        const before = this.name
        const personasBefore = JSON.stringify(this.personas)
        this.config = loadConfig()
        if (typeof ev.volume === "number") this.adoptVolume(ev.volume)
        this.log("settings changed; config reloaded")
        if (this.name !== before || JSON.stringify(this.personas) !== personasBefore) this.renamed(before)
        break
      }
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

  /**
   * He started talking (`onset`: when his voice began, by the App's clock).
   * It's to her when the window was open as he began, not when the App got
   * round to saying so: a soft start through a gated headset is announced
   * a moment late.
   */
  private speechStarted(onset?: number) {
    this.inSpeech = true
    // Shawn has the floor: nothing of hers starts until his words are in.
    if (!this.micMuted) {
      if (this.mouth.pendingStart && !this.mouth.floorHeld) this.log("speech: he's talking; her next line waits")
      this.mouth.floor(true)
    }
    this.speechStartedAt = Date.now()
    const began = Math.min(onset ?? Date.now(), Date.now())
    this.speechEngaged = !this.micMuted && (this.bargePending || this.followUpUntil >= began || this.mouth.speaking)
    this.partial = "…"
    this.holdForResume()
    this.armSpeechTimer()
  }

  /**
   * The safety net for a final that never comes. While he talks the App
   * keeps sending partials, and each one pushes it back: listening never
   * ends on a timer while his words are still arriving (a 65 s monologue
   * was cut at 60 s on 2026-11-26 and then ignored).
   */
  private armSpeechTimer() {
    if (this.speechTimer) clearTimeout(this.speechTimer)
    const startedAt = this.speechStartedAt
    this.speechTimer = setTimeout(() => {
      if (!this.inSpeech || this.speechStartedAt !== startedAt) return
      this.log(`speech: no words for ${SPEECH_SILENCE_MS / 1000} s and no final; treating the utterance as over`)
      this.speechEnded()
      this.changed()
    }, SPEECH_SILENCE_MS)
    this.speechTimer.unref()
  }

  /**
   * He started talking again soon after his last turn, before any of her
   * answer played: he hadn't finished. Hold her answer back until his words
   * are in; they and that turn become one (`utterance`).
   */
  private holdForResume() {
    if (this.micMuted || this.mouth.speaking || this.resumable) return
    const rec = this.turns[this.turns.length - 1]
    const mergeMs = (this.config.turn?.mergeSeconds ?? 12) * 1000
    if (!rec || rec.muted || !rec.heardEndAt || Date.now() - rec.heardEndAt > mergeMs) return
    if (rec.via === "direct" || this.hasPlayed(rec.id)) return
    // Done and said nothing: nothing to hold or redo.
    if (rec.durationMs !== undefined && !this.mouth.pendingStart) return
    this.resumable = { turnId: rec.id, text: rec.text, why: "thinking", at: Date.now() }
    this.speechEngaged = true
    this.mouth.hold()
    this.log(`turn ${rec.id}: he's talking again before she answered; holding her answer`)
  }

  /** Whether any of that turn's speech has started playing. */
  private hasPlayed(turnId: number): boolean {
    return (this.speechByTurn.get(turnId) ?? []).some((i) => i.startedAt !== undefined)
  }

  /** His utterance is over; `giveFloor` false when the caller gives it back once his words are decided on. */
  private speechEnded(giveFloor = true) {
    if (this.speechTimer) clearTimeout(this.speechTimer)
    this.speechTimer = null
    this.inSpeech = false
    this.speechEngaged = false
    this.partial = ""
    if (giveFloor) this.mouth.floor(false)
    this.flushChimes()
  }

  private wakeIn(text: string): boolean {
    const m = stripWakeWord(text, {
      names: this.personas.map((p) => p.name),
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
    const m = this.mouth
    const playing = m.playing
    const item = (speakId && m.get(speakId)) || playing
    const turnId = item?.turnId
    this.log(`barge-in (${why}) on ${speakId ?? playing?.id ?? "nothing playing"}`)
    this.bargePending = true
    // If no final ever comes, stop showing "listening" once the window would have closed.
    if (this.bargeTimer) clearTimeout(this.bargeTimer)
    this.bargeTimer = setTimeout(() => {
      this.bargePending = false
      this.changed()
    }, Math.max(20, this.config.wake.followUpSeconds) * 1000 + 50)
    this.bargeTimer.unref()
    this.speechEngaged = this.inSpeech || this.speechEngaged
    this.followUpUntil = Date.now() + Math.max(20, this.config.wake.followUpSeconds) * 1000
    m.cut(false) // usually already done: the App's `playback interrupted` tends to come first
    if (turnId !== undefined) {
      const rec = this.turns.find((t) => t.id === turnId)
      if (rec) rec.muted = true
      const items = this.speechByTurn.get(turnId) ?? []
      // She'd only just begun: he was still going, not answering her.
      const firstAudio = Math.min(...items.map((i) => i.startedAt ?? Infinity))
      const graceMs = (this.config.turn?.bargeMergeSeconds ?? 2) * 1000
      if (rec && rec.via !== "direct" && Number.isFinite(firstAudio) && Date.now() - firstAudio <= graceMs) {
        this.resumable = { turnId, text: rec.text, why: "barge", at: Date.now() }
        this.log(`turn ${turnId}: barged in ${Date.now() - firstAudio} ms into her answer; his next words join that turn`)
      }
      const cutItem = items.find((i) => i.state === "cut")
      this.interruption = {
        at: Date.now(),
        said: items.filter((i) => i.state === "done").map((i) => i.text),
        cut: cutItem ? { text: cutItem.text, playedMs: (cutItem.endedAt ?? Date.now()) - (cutItem.startedAt ?? Date.now()) } : undefined,
        unsaid: items.filter((i) => i.state === "dropped" || i.state === "queued").map((i) => i.text),
      }
      if (this.current?.id === turnId) {
        this.current.muted = true
        this.interruptBrain("barge-in")
      }
    }
    this.changed()
  }

  // ---- brain ----------------------------------------------------------------

  private mcpLaunch(harness: BrainHarness) {
    // An installed Core is bundled (scripts/bundle.mjs): the server is dist/mcp-server.mjs
    // beside it. From the repo, node --import tsx runs the TypeScript server in one process
    // (tsx's CLI would add a second).
    const tsx = pathToFileURL(join(CORE_DIR, "node_modules", "tsx", "dist", "loader.mjs")).href
    const args = BUNDLED
      ? [join(CORE_DIR, "dist", "mcp-server.mjs")]
      : ["--import", tsx, join(CORE_DIR, "src", "mcp", "server.ts")]
    return {
      command: process.execPath,
      args,
      env: { ASSISTANT_URL: `http://127.0.0.1:${this.port}`, ASSISTANT_TOKEN: this.token, ASSISTANT_BRAIN: harness, ASSISTANT_NAME: this.name },
    }
  }

  async ensureBrain(): Promise<Brain> {
    this.skills.check() // a setup job writes its skill file itself
    this.mcp.check() // so does a job, or Shawn by hand
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
    const servers = this.ownServers(harness)
    const brain = createBrain(harness, {
      model: settings.model,
      effort: settings.effort,
      systemPrompt: renderPrompt(this.prompt.read(), this.name, this.personas, this.skills.render()),
      mcp: this.mcpLaunch(harness),
      servers,
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
    brain.on("tool", (t: { name?: string }) => {
      // Her own servers' tools don't come through Core: note them in the log.
      if (t?.name?.startsWith("mcp__") && !t.name.startsWith("mcp__assistant__")) this.log(`brain tool ${t.name}`)
      // Any MCP tool (hers or Core's) is an action; the harness's own (ToolSearch and such) aren't.
      if (this.brain === brain && t?.name?.startsWith("mcp__")) this.beforeTool(t.name)
    })
    brain.on("mcp", (states: { name: string; status: string; error?: string }[]) => {
      for (const st of states) {
        this.mcpState.set(st.name, { status: st.status, ...(st.error ? { error: st.error } : {}) })
        if (/^(failed|needs-auth|missing)$/.test(st.status)) this.mcpProblem(st.name, st.error ? `failed to start: ${st.error}` : `is ${st.status}`)
      }
    })
    this.brain = brain
    this.log(`brain: ${brain.label}`)
    await brain.start()
    this.changed()
    return brain
  }

  /** Her enabled, usable servers for this harness; the rest are logged and told once. */
  private ownServers(harness: BrainHarness): Record<string, ResolvedServer> {
    const { servers, skipped } = brainServers(this.mcp.read())
    this.mcpState.clear()
    for (const sk of skipped) {
      this.mcpState.set(sk.name, { status: "skipped", error: sk.reason })
      this.mcpProblem(sk.name, `was left out: ${sk.reason}`)
    }
    if (harness === "codex") {
      for (const [name, s] of Object.entries(servers)) {
        if (s.type !== "sse") continue
        delete servers[name]
        this.mcpState.set(name, { status: "skipped", error: "Codex can't use SSE servers" })
        this.mcpProblem(name, "was left out: Codex can't use SSE servers (switch to Claude, or use its HTTP url)")
      }
    }
    for (const name of Object.keys(servers)) this.mcpState.set(name, { status: "starting" })
    if (Object.keys(servers).length) this.log(`mcp: her servers ${Object.keys(servers).join(", ")}`)
    return servers
  }

  /** One of her servers can't be used: logged, and said once in the next turn. */
  mcpProblem(name: string, what: string) {
    const key = `${name}: ${what}`
    this.log(`mcp: ${key}`)
    if (this.mcpSaid.has(key)) return
    this.mcpPending.set(name, what)
  }

  /** Restart the brain before the next turn (a config change that the brain reads at start). */
  restartBrainSoon(why: string) {
    this.brainDirty = true
    this.log(`${why}; brain restarts before the next turn`)
  }

  private takeMcpNote(): string | null {
    if (!this.mcpPending.size) return null
    const bits = [...this.mcpPending].map(([n, w]) => `${n} ${w}`)
    for (const [n, w] of this.mcpPending) this.mcpSaid.add(`${n}: ${w}`)
    this.mcpPending.clear()
    return `[Your MCP servers: ${bits.join("; ")}. Everything else works. Tell Shawn once, in one short sentence, then answer him; mcp_list and mcp_test help if he wants it fixed.]`
  }

  // ---- utterances and turns -------------------------------------------------

  /** Feed one utterance (heard, typed, or injected). */
  async utterance(input: UtteranceInput): Promise<GateResult & { turnId?: number }> {
    const now = Date.now()
    // While Vera is talking (or was just talked over) the window is open; it opens fully when she stops.
    const resume = this.resumable
    this.resumable = null
    const open = this.mouth.speaking || input.duringPlayback || this.bargePending || !!resume
    const followUpUntil = open ? Number.MAX_SAFE_INTEGER : this.followUpUntil
    const g = gate(input, { followUpUntil }, now, {
      names: this.personas.map((p) => p.name),
      extra: this.config.wake.words,
      maxLeadingWords: this.config.wake.maxLeadingWords,
      soft: this.config.wake.soft,
      recentlyActive: now - this.lastActiveAt < this.config.wake.warmSeconds * 1000,
    })
    const wasBarge = this.bargePending
    this.bargePending = false
    this.lastHeard = input.text
    // Only a name said as itself switches who answers; follow-ups, mishearings
    // ("Vara", "Hey there,"), timeouts and new sessions keep the last one.
    if (g.action !== "ignore" && g.persona) this.switchPersona(g.persona, "named")
    if (resume && continues(resume, g, now) && g.action === "turn") return this.resumeTurn(resume, g.text, input)
    // Not a continuation: whatever happens next, her held answer isn't held any more.
    if (resume) queueMicrotask(() => this.mouth.release())
    switch (g.action) {
      case "ignore":
        this.log(`ignored (${g.reason}): ${input.text}`)
        this.changed()
        return g
      case "wake":
        this.lastActiveAt = now
        this.openFollowUp()
        this.chime("listening")
        this.changed()
        return g
      case "stop":
        this.stop(`heard "${input.text}"`)
        return g
      case "turn": {
        this.lines.push({ who: "shawn", text: g.text, at: now })
        this.trimLines()
        if (this.current) {
          // Shawn spoke again before Vera answered: what she was going to
          // say is stale. Cut it, stop the brain, and answer this instead
          // (the new turn starts as soon as the old one winds down).
          this.queue.push({ ...input, text: g.text })
          this.supersede(this.current, g.text)
          this.changed()
          return g
        }
        const rec = this.beginTurn(g.text, wasBarge ? "barge-in" : g.via, input.end)
        return { ...g, turnId: rec.id }
      }
    }
  }

  /** His words `text` finish the turn `resume` names: one message, her answer to the first part dropped. */
  private resumeTurn(resume: Resumable, text: string, input: UtteranceInput): GateResult & { turnId?: number } {
    const whole = joinTurns(resume.text, text)
    this.lines.push({ who: "shawn", text, at: Date.now() })
    this.trimLines()
    const first = this.turns.find((t) => t.id === resume.turnId)
    if (first) first.muted = true
    this.log(`turn ${resume.turnId} continued (${resume.why}): ${truncate(whole, 160)}`)
    const note = resumeNote(resume.why)
    if (this.current) {
      // Still thinking: cut it; the queue starts the whole message once it winds down.
      this.queue.push({ ...input, text: whole })
      this.supersede(this.current, whole, note)
      this.changed()
      return { action: "turn", text: whole, via: "followup" }
    }
    const { cut, dropped } = this.mouth.cut(true)
    if (cut || dropped.length) this.log(`turn ${resume.turnId}: dropped its held answer (${[cut, ...dropped].filter(Boolean).length} line(s))`)
    this.superseded = note
    const rec = this.beginTurn(whole, "resumed", input.end)
    return { action: "turn", text: whole, via: "followup", turnId: rec.id }
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
      persona: this.persona.name,
      brain: "",
      startedAt: Date.now(),
      heardEndAt,
      spoken: [],
      tools: [],
      output: "",
    }
    this.lastActiveAt = Date.now()
    this.current = rec
    // His own words keep the conversation open: what he says next, within
    // the follow-up window of where he stopped, is to her too (he goes on
    // after a pause, or she answered with nothing to say).
    this.followUpUntil = Math.max(this.followUpUntil, (heardEndAt ?? Date.now()) + this.config.wake.followUpSeconds * 1000)
    // Nothing from an earlier turn plays after this one began.
    const stale = this.mouth.dropStale(rec.id)
    if (stale.length) this.log(`turn ${rec.id}: dropped ${stale.length} stale line(s): ${stale.map((i) => `${i.id} "${truncate(i.text, 60)}"`).join(", ")}`)
    this.turns.push(rec)
    if (this.turns.length > 50) this.turns.shift()
    this.changed()
    this.armAck(rec)
    void this.runTurn(rec)
    return rec
  }

  // ---- his talking never breaks running work -------------------------------

  /**
   * Stops the brain's turn, unless a tool it called is still running: then
   * the tool finishes (its process, its T3 call, its job), its result
   * reaches the brain, and the turn is stopped right after. His words wait
   * in the queue meanwhile and become the next message, as they would have.
   */
  private interruptBrain(why: string) {
    if (this.toolsInFlight.size) {
      if (!this.interruptWhenIdle) {
        this.log(`turn ${this.current?.id ?? "-"}: ${why}; ${[...this.toolsInFlight.values()].join(", ")} still running, so the brain stops once it returns`)
      }
      this.interruptWhenIdle = why
      return
    }
    void this.brain?.interrupt()
  }

  /** A Core tool started (from runTool); returns its call id for `toolEnded`. */
  toolStarted(name: string): number {
    const id = ++this.toolCallSeq
    // ask_* jobs run on their own and report through the inbox: stopping the turn costs them nothing.
    if (name !== "speak" && !/^ask_/.test(name)) this.toolsInFlight.set(id, name)
    return id
  }

  /**
   * A Core tool's result was sent back to the brain. If his talking is
   * waiting on it, the brain stops shortly after (once it has the result),
   * and the next turn's message carries what the tool returned.
   */
  toolEnded(id: number, result: string) {
    const name = this.toolsInFlight.get(id)
    if (!name) return
    this.toolsInFlight.delete(id)
    if (!this.interruptWhenIdle) return
    this.heldResults.push({ tool: name, result })
    if (this.toolsInFlight.size) return
    const turn = this.current
    setTimeout(() => {
      // Another tool may have started meanwhile: wait for that one too.
      if (this.toolsInFlight.size || !this.interruptWhenIdle || this.current !== turn) return
      this.log(`turn ${turn?.id ?? "-"}: ${name} returned; stopping the brain now (${this.interruptWhenIdle})`)
      this.interruptWhenIdle = null
      void this.brain?.interrupt()
    }, 300).unref()
  }

  /** Whether a Core tool (other than speak) is running for the brain now. */
  get toolRunning(): boolean {
    return this.toolsInFlight.size > 0
  }

  private takeHeldResults(): string | null {
    const held = this.heldResults.splice(0)
    if (!held.length) return null
    return `[While he was talking, ${held.map((h) => `${h.tool} finished and returned: "${truncate(oneLine(h.result), 600)}"`).join("; ")}. That work is done; don't run it again unless he asks.]`
  }

  // ---- acknowledgements (ack.ts) -------------------------------------------

  /** The dead-air clock on silence alone (`turn.silenceAckMs`, off by default). */
  private armAck(rec: TurnRecord) {
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = null
    const after = this.config.turn?.silenceAckMs ?? 0
    if (!after || endsSilently(rec.text)) return
    const now = Date.now()
    const end = rec.heardEndAt && rec.heardEndAt <= now && now - rec.heardEndAt < 10_000 ? rec.heardEndAt : now
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null
      if (this.current === rec) this.acknowledge(rec, "silence")
    }, Math.max(0, end + after - now))
    this.ackTimer.unref()
  }

  /**
   * The brain is calling `tool` (through Core, or one of her own MCP
   * servers): if it's the turn's first action and a slow tool, Core
   * acknowledges once it has run `turn.acknowledgeMs` with her still silent
   * (a quick tool she answers right after gets none).
   */
  beforeTool(tool: string) {
    const rec = this.current
    if (!rec || rec.acted) return
    rec.acted = true
    const after = this.config.turn?.acknowledgeMs ?? ACK_AFTER_MS
    if (!after || !slowTool(tool)) return
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null
      if (this.current === rec) this.acknowledge(rec, `during ${tool.replace(/^mcp__assistant__/, "")}`)
    }, after)
    this.ackTimer.unref()
  }

  /** Says a short acknowledgement for `rec` in its persona's voice, once, if it's still owed one. */
  private acknowledge(rec: TurnRecord, why: string) {
    if (rec.ack || rec.muted || rec.firstSpeakMs !== undefined || rec.durationMs !== undefined || endsSilently(rec.text)) return
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = null
    const persona = (rec.persona && this.findPersona(rec.persona)) || this.persona
    const text = pickAck(persona, this.ackSeq++)
    rec.ack = text
    rec.ackWhy = why
    this.log(`turn ${rec.id}: acknowledged "${text}" (${why}, ${Date.now() - (rec.heardEndAt ?? rec.startedAt)} ms after he stopped)`)
    if (rec.heardEndAt) this.awaitingAudio = rec
    const item = this.mouth.say(text, rec.id, persona.voice)
    const list = this.speechByTurn.get(rec.id) ?? []
    list.push(item)
    this.speechByTurn.set(rec.id, list)
    this.changed()
  }

  /** Once per turn, after Core acknowledged: the note a tool result carries so she doesn't acknowledge again. */
  takeAckNote(): string {
    const rec = this.current
    if (!rec?.ack || rec.ackNoted) return ""
    rec.ackNoted = true
    return "\n" + ackNote(rec.ack)
  }

  /**
   * Has the voice service keep every persona's acknowledgements rendered,
   * so they play at once. Retried while the service is starting.
   */
  warmAcks(tries = 20) {
    const items = this.personas.flatMap((p) => acksFor(p).map((text) => ({ text, voice: this.voiceOverride ?? p.voice })))
    fetch(`http://127.0.0.1:${this.voicePort}/v1/speech/warm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(4000),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        this.log(`acknowledgements: ${JSON.stringify(await r.json())} warming in the voice service`)
      })
      .catch((err) => {
        if (tries > 1) setTimeout(() => this.warmAcks(tries - 1), 15_000).unref()
        else this.log(`acknowledgements not warmed (voice service: ${(err as Error).message}); they render on first use`)
      })
  }

  private async runTurn(rec: TurnRecord) {
    let result: TurnResult
    let timedOut: string | null = null
    try {
      const brain = await this.ensureBrain()
      rec.brain = brain.label
      const msg = this.composeTurn(rec.text, rec.persona)
      rec.startedAt = Date.now() // measure from hand-off, not from brain start
      this.log(`turn ${rec.id} -> ${brain.label}: ${truncate(oneLine(msg), 1200)}`)
      result = await this.withDeadline(rec, brain, brain.turn(msg), (why) => (timedOut = why))
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
    // A timeout was already reported the moment it hit.
    if (!timedOut && !result.ok && !result.interrupted) this.alert("brain", result.error ?? "the brain failed")
    this.current = null
    this.interruptWhenIdle = null
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = null
    // A turn that ended without a word from her (a tool, nothing to say):
    // he's still talking with her, so the window opens as it does when she
    // finishes speaking.
    if (!rec.spoken.length && !rec.muted && !this.micMuted && !this.mouth.speaking && !this.mouth.pendingStart) this.openFollowUp()
    this.turnWaiters.get(rec.id)?.(rec)
    this.turnWaiters.delete(rec.id)
    this.changed()
    if (this.queue.length) {
      const q = this.queue.splice(0)
      this.beginTurn(q.map((u) => u.text).join(" … "), "queued", q[q.length - 1].end)
    }
  }

  private composeTurn(text: string, persona?: string): string {
    const parts: string[] = []
    if (this.recapNext) {
      this.recapNext = false
      const recent = this.lines.slice(-9, -1)
      if (recent.length) {
        parts.push(
          "[You just took over this conversation from another session. Recent lines, for context:]\n" +
            recent.map((l) => `${l.who === "shawn" ? "Shawn" : (l.persona ?? this.name)}: ${truncate(oneLine(l.text), 300)}`).join("\n"),
        )
      }
    }
    const note = this.takeInterruptionNote()
    if (note) parts.push(note)
    if (this.superseded) {
      parts.push(this.superseded)
      this.superseded = null
    }
    const held = this.takeHeldResults()
    if (held) parts.push(held)
    const digest = this.inbox.takeDigest()
    if (digest) parts.push(digest)
    const mcpNote = this.takeMcpNote()
    if (mcpNote) parts.push(mcpNote)
    const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    if (persona) parts.push(`[Shawn is talking to ${persona}]`)
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

  /**
   * Shawn spoke again while `rec` was still running: its speech (playing or
   * queued) is cut, anything it says from now on is dropped, and the brain
   * is interrupted so his new words are answered next.
   */
  private supersede(rec: TurnRecord, text: string, note?: string) {
    this.log(`turn ${rec.id} superseded by: ${truncate(text, 120)}`)
    rec.muted = true
    const { cut, dropped } = this.mouth.cut(true)
    if (cut || dropped.length) this.log(`turn ${rec.id}: cut ${[cut, ...dropped].filter(Boolean).map((i) => i!.id).join(", ")}`)
    this.superseded = note ?? "[He said this before you finished answering his previous message; that answer was cut off. Answer this now.]"
    this.interruptBrain("superseded")
  }

  /**
   * Races a brain turn against Vera's patience: no `speak` within
   * `firstSpeakTimeoutSeconds`, or no end within `turnTimeoutSeconds`,
   * interrupts the brain; one that still doesn't stop is closed (it
   * restarts before the next turn). Never a turn that never ends.
   */
  private withDeadline(rec: TurnRecord, brain: Brain, turn: Promise<TurnResult>, onTimeout: (why: string) => void): Promise<TurnResult> {
    const firstMs = (this.config.brain.firstSpeakTimeoutSeconds ?? 45) * 1000
    const totalMs = (this.config.brain.turnTimeoutSeconds ?? 150) * 1000
    return new Promise<TurnResult>((resolve) => {
      let settled = false
      let forced: NodeJS.Timeout | null = null
      const finish = (r: TurnResult) => {
        if (settled) return
        settled = true
        clearInterval(watch)
        if (forced) clearTimeout(forced)
        resolve(r)
      }
      const watch = setInterval(() => {
        const waited = Date.now() - rec.startedAt
        let why: string | null = null
        if (rec.firstSpeakMs === undefined && !rec.muted && waited >= firstMs) why = `no answer after ${Math.round(waited / 1000)} s`
        else if (waited >= totalMs) why = `the turn ran ${Math.round(waited / 1000)} s`
        if (!why || forced) return
        this.log(`turn ${rec.id}: ${why}; interrupting the brain`)
        onTimeout(why)
        this.alert("brain_timeout", `Vera's brain didn't answer: ${why}`)
        rec.muted = true
        void brain.interrupt()
        forced = setTimeout(() => {
          this.log(`turn ${rec.id}: the brain didn't stop; restarting it`)
          this.brainDirty = true
          void brain.close().catch(() => {})
          finish({ ok: false, text: rec.output, error: why!, interrupted: true })
        }, 5_000)
      }, 250)
      turn.then(finish, (err) => finish({ ok: false, text: "", error: (err as Error).message }))
    })
  }

  /** Something failed: the App chimes, flashes the HUD, and shows it in Settings and the tray. */
  alert(what: string, message: string) {
    this.send({ cmd: "error", what, message: truncate(message, 300) })
  }

  /** Her first name (`personas[0]`, default Vera): what the App and the prompt's `{{name}}` call her. */
  get name(): string {
    return this.personas[0]?.name ?? validName(this.config.assistant?.name) ?? DEFAULT_NAME
  }

  /** Her names, each with its voice and manner (`assistant.personas`). */
  get personas(): Persona[] {
    return personasOf(this.config)
  }

  /** The persona answering now: the name he last used (the first one until then). */
  get persona(): Persona {
    const all = this.personas
    return all.find((p) => p.name.toLowerCase() === this.activePersona.toLowerCase()) ?? all[0]
  }

  /** That persona's own voice, if there is such a persona. */
  findPersonaVoice(name: string): string | undefined {
    return this.findPersona(name)?.voice
  }

  private findPersona(name: string): Persona | undefined {
    const key = name.trim().toLowerCase()
    return this.personas.find((p) => p.name.toLowerCase() === key)
  }

  /** Saves her personas (`assistant.name` follows the first), tells the App, restarts the brain before the next turn. */
  private savePersonas(list: Persona[], from = this.name) {
    this.config = saveConfigPatch({ assistant: { name: list[0].name, personas: list } })
    this.send({ cmd: "name", name: list[0].name })
    this.renamed(from)
  }

  /**
   * "Vera, call yourself Nova" renames the persona he's talking to (`from`
   * names another one). The wake word changes at once; the App applies it
   * (speech to text, the tray, Settings); the brain restarts before the
   * next turn with the prompt in the new name.
   */
  setName(name: string, from?: string): { from: string; to: string } {
    const to = validName(name)
    if (!to) throw new Error(`"${name}" can't be a name: one word of letters, 2 to 20 of them`)
    const old = from ? this.findPersona(from) : this.persona
    if (!old) throw new Error(`no persona called "${from}"; have ${this.personas.map((p) => p.name).join(", ")}`)
    if (to === old.name) return { from: old.name, to }
    const clash = this.findPersona(to)
    if (clash && clash.name !== old.name) throw new Error(`there's already a persona called ${clash.name}`)
    const list = this.personas.map((p) => (p.name === old.name ? { ...p, name: to } : p))
    if (this.activePersona.toLowerCase() === old.name.toLowerCase()) {
      this.activePersona = to
      this.saveState()
    }
    this.savePersonas(list)
    return { from: old.name, to }
  }

  /** "Add a persona called Max with the Optimus voice." */
  addPersona(name: string, voice: string, style?: string): Persona {
    const n = validName(name)
    if (!n) throw new Error(`"${name}" can't be a name: one word of letters, 2 to 20 of them`)
    if (this.findPersona(n)) throw new Error(`there's already a persona called ${n}`)
    const p: Persona = { name: n, voice, ...(style?.trim() ? { style: style.trim() } : {}) }
    this.savePersonas([...this.personas, p])
    return p
  }

  /** "Remove Buzz." The last persona stays. */
  removePersona(name: string): Persona {
    const p = this.findPersona(name)
    if (!p) throw new Error(`no persona called "${name}"; have ${this.personas.map((x) => x.name).join(", ")}`)
    const list = this.personas.filter((x) => x.name !== p.name)
    if (!list.length) throw new Error("that's her only name; rename it instead")
    if (this.activePersona.toLowerCase() === p.name.toLowerCase()) {
      this.activePersona = list[0].name
      this.saveState()
    }
    this.savePersonas(list)
    return p
  }

  /** "Make Jarvis use the Eli voice." */
  setPersonaVoice(name: string, voice: string): Persona {
    const p = this.findPersona(name)
    if (!p) throw new Error(`no persona called "${name}"; have ${this.personas.map((x) => x.name).join(", ")}`)
    this.savePersonas(this.personas.map((x) => (x.name === p.name ? { ...x, voice } : x)))
    return { ...p, voice }
  }

  /** The name changed: the brain restarts before the next turn, with the prompt and tools in it. */
  private renamed(from: string) {
    this.log(`name: ${from} -> ${this.name}`)
    this.brainDirty = true
    this.warmAcks(3)
    this.changed()
  }

  /** "Vera, stop" / tray Stop talking: silence, interrupt, forget the queue. */
  stop(reason = "stop") {
    this.log(`stop (${reason})`)
    this.queue = []
    this.bargePending = false
    this.resumable = null
    this.interruption = null
    this.superseded = null
    if (this.current) this.current.muted = true
    this.mouth.stop()
    this.followUpUntil = 0
    void this.brain?.interrupt()
    this.changed()
  }

  /** Bare wake word, or Vera stopped speaking: the next utterance needs no wake word. */
  openFollowUp(seconds = this.config.wake.followUpSeconds) {
    this.followUpUntil = Date.now() + seconds * 1000
    if (this.followUpTimer) clearTimeout(this.followUpTimer)
    this.followUpTimer = setTimeout(() => this.changed(), seconds * 1000 + 20)
    this.followUpTimer.unref()
    this.changed()
  }

  // ---- speech ---------------------------------------------------------------

  /** The speak tool. Returns false when the turn was talked over (nothing is said). */
  say(text: string, opts: { fromBrain?: boolean } = {}): boolean | "skipped" {
    const rec = this.current
    if (rec?.muted) {
      this.log(`not spoken (turn ${rec.id} was interrupted): ${text}`)
      return false
    }
    if (rec && opts.fromBrain) {
      rec.acted = true
      if (rec.ack && rec.firstSpeakMs === undefined) {
        // Core already acknowledged: her own opening "checking" would double it.
        const rest = stripOpeningAck(text)
        if (rest !== text.trim()) this.log(`turn ${rec.id}: dropped her own acknowledgement after Core's: "${truncate(text, 80)}"`)
        if (!rest) return "skipped"
        text = rest
      }
    }
    if (rec) {
      if (rec.firstSpeakMs === undefined) {
        rec.firstSpeakMs = Date.now() - rec.startedAt
        if (rec.heardEndAt) this.awaitingAudio = rec
      }
      rec.spoken.push(text)
    }
    const persona = (rec?.persona && this.findPersona(rec.persona)) || this.persona
    this.lines.push({ who: "assistant", text, at: Date.now(), persona: persona.name })
    this.trimLines()
    this.changed()
    const item = this.mouth.say(text, rec?.id, persona.voice)
    if (rec) {
      const list = this.speechByTurn.get(rec.id) ?? []
      list.push(item)
      this.speechByTurn.set(rec.id, list)
      if (this.speechByTurn.size > 20) this.speechByTurn.delete(this.speechByTurn.keys().next().value!)
    }
    return true
  }

  private onSpeechStart() {
    const rec = this.awaitingAudio
    if (rec?.heardEndAt) {
      rec.endToAudioMs = Date.now() - rec.heardEndAt
      this.log(`turn ${rec.id}: end of speech -> first audio ${rec.endToAudioMs} ms`)
    }
    this.awaitingAudio = null
    this.changed()
  }

  private onSpeechEnd() {
    this.lastActiveAt = Date.now()
    // Talked over: the barge-in window is already open; otherwise the follow-up opens now.
    if (!this.bargePending) this.openFollowUp()
    this.changed()
  }

  /** Play a chime (the App plays it). An inbox ping while Shawn is mid-sentence waits until he's done. */
  chime(kind: ChimeKind): void {
    if (kind === "notify" && this.inSpeech) {
      if (!this.deferredChimes.includes(kind)) this.deferredChimes.push(kind)
      this.log("chime notify waits until Shawn finishes speaking")
      return
    }
    if (kind === "notify") this.log("chime notify")
    this.mouth.chime(kind)
  }

  private flushChimes() {
    for (const kind of this.deferredChimes.splice(0)) this.chime(kind)
  }

  // ---- volume ---------------------------------------------------------------

  /**
   * Makes `name` the persona answering from now on (a name he said, or his
   * request through `switch_persona`), including the rest of a turn in progress.
   */
  switchPersona(name: string, why: string): Persona {
    const p = this.findPersona(name)
    if (!p) throw new Error(`no persona called "${name}"; have ${this.personas.map((x) => x.name).join(", ")}`)
    if (p.name !== this.activePersona) {
      this.log(`persona: ${this.activePersona || "(first)"} -> ${p.name} (${why})`)
      this.activePersona = p.name
      this.saveState()
    }
    if (this.current) this.current.persona = p.name
    return p
  }

  private loadState(): { volume?: number; persona?: string } {
    try {
      return JSON.parse(readFileSync(paths.state, "utf8"))
    } catch {
      return {}
    }
  }

  private saveState() {
    try {
      writeFileSync(
        paths.state,
        JSON.stringify({ ...this.loadState(), volume: this.volume, persona: this.activePersona || undefined }, null, 2) + "\n",
      )
    } catch {}
  }

  /** The App reported its volume (it owns it): remember it, don't echo it back. */
  private adoptVolume(level: number) {
    this.volume = round2(clamp01(level))
    this.saveState()
  }

  /** Vera's own output volume. Never the computer's. */
  setVolume(change: { level?: number; relative?: "quieter" | "louder"; a_lot?: boolean }): { from: number; to: number } {
    const from = this.volume
    let to: number
    if (typeof change.level === "number" && Number.isFinite(change.level)) {
      to = clamp01(change.level > 1 ? change.level / 100 : change.level) // "set it to 30" means 30%
    } else if (change.relative === "quieter" || change.relative === "louder") {
      const step = change.a_lot ? VOLUME_BIG_STEP : VOLUME_STEP
      // Within [0.1, 1], and never the wrong way (quieter from below 0.1 stays put).
      to =
        change.relative === "quieter"
          ? Math.min(from, Math.max(VOLUME_MIN_STEPPED, from - step))
          : Math.max(from, Math.min(1, from + step))
    } else throw new Error("give level (0-1) or relative: quieter | louder")
    to = round2(to)
    this.volume = to
    this.saveState()
    this.send({ cmd: "set_volume", level: to })
    this.changed()
    return { from, to }
  }

  // ---- background work ------------------------------------------------------

  notify(item: { kind: "job" | "t3" | "system"; title: string; summary: string; ref?: string }) {
    this.inbox.add(item)
    this.log(`inbox: ${item.title}${item.ref ? ` [${item.ref}]` : ""}`)
    this.chime("notify")
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

  /** The voice service's port (the App's `app.voiceService.port`). */
  get voicePort(): number {
    return loadConfig().app?.voiceService?.port ?? 7314
  }

  /** The voice override (`app.voice`): every persona speaks in it while set. */
  get voiceOverride(): string | undefined {
    return loadConfig().app?.voice ?? undefined
  }

  /** The voice she speaks in now: the override, else the active persona's. */
  get currentVoice(): string | undefined {
    return this.voiceOverride ?? this.persona.voice
  }

  /**
   * "Vera, switch to Eli": saves the override `app.voice` (null clears it:
   * each persona's own voice again) and tells the App, which uses it from
   * the next line (this turn's next `speak` included).
   */
  setVoice(id: string | null) {
    this.config = saveConfigPatch({ app: { voice: id } })
    this.log(`voice override: ${id ?? "none (each persona's own)"}`)
    this.send({ cmd: "voice", voice: id })
    this.warmAcks(3)
  }

  setBrain(harness: BrainHarness, model?: string, effort?: string): string {
    const patch: any = { brain: { harness } }
    if (model || effort) patch.brain[harness] = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
    this.config = saveConfigPatch(patch)
    this.brainDirty = true
    const s = this.config.brain[harness]
    return `${harness} ${s.model ?? "default"}/${s.effort ?? "default"}`
  }

  /**
   * Saves one allowlisted key (src/settings.ts checked it) and applies it
   * where Core can: Core reads most keys live from `this.config`; a brain
   * key restarts the brain before the next turn; the T3 poll restarts.
   */
  setConfigKey(key: string, value: unknown) {
    this.config = saveConfigPatch(patchFor(key, value))
    this.log(`config: ${key} = ${JSON.stringify(value)}`)
    if (key.startsWith("brain.") && SETTINGS[key]?.applies === "brain") this.restartBrainSoon(`config ${key} changed`)
    if (key === "t3.pollSeconds") this.watcher.start(this.config.t3.pollSeconds * 1000)
    if (key === "t3.cliPath") this.t3.locate(true)
  }

  // ---- state: HUD, badge, snapshot ------------------------------------------

  status(): HudState {
    const now = Date.now()
    if (this.mouth.speaking) return "speaking"
    // Listening off: she's off, whatever was winding down.
    if (this.micMuted) return this.backgroundBusy() ? "working" : "idle"
    // Shawn is talking to Vera (after the wake word, in the window, or over her).
    if (this.bargePending || (this.inSpeech && this.speechEngaged)) return "listening"
    if (this.current || this.queue.length || this.mouth.pendingStart) return "thinking"
    if (this.followUpUntil > now) return "listening"
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

  /** GET /api/state (debug and tests). */
  snapshot() {
    const lastSaid = [...this.lines].reverse().find((l) => l.who === "assistant")?.text ?? ""
    return {
      status: this.status(),
      hud: this.hud,
      volume: this.volume,
      micMuted: this.micMuted,
      badge: this.inbox.unread().length,
      brain: this.brain?.label ?? `${this.config.brain.harness} (starting)`,
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

  /**
   * Shawn asked her to stop listening. She finishes what she's saying (the
   * goodbye), then the App turns Listening off, as the tray would; only the
   * tray turns it back on.
   */
  stopListening() {
    this.log("stop listening: asked by voice; off once she's done speaking")
    this.offRequested = Date.now()
    this.changed()
  }

  private maybeTurnOff() {
    if (this.offRequested === null || this.micMuted) return
    const quiet = !this.mouth.speaking && !this.mouth.pendingStart && !this.current && !this.queue.length
    // Her words never coming (a stuck line) doesn't keep her on for long.
    if (!quiet && Date.now() - this.offRequested < 30_000) {
      if (!this.offTimer) {
        this.offTimer = setTimeout(() => {
          this.offTimer = null
          this.changed()
        }, 1000)
        this.offTimer.unref()
      }
      return
    }
    this.offRequested = null
    this.log("stop listening: turning Listening off")
    this.send({ cmd: "listening", on: false })
  }

  private offTimer: NodeJS.Timeout | null = null
  private changeTimer: NodeJS.Timeout | null = null
  changed() {
    this.maybeTurnOff()
    // The HUD and badge follow state at once, and the HUD is checked again
    // shortly after, for state that settles right after a change.
    this.syncHud()
    this.syncBadge()
    if (this.changeTimer) return
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      this.syncHud()
    }, 30)
  }

  private trimLines() {
    if (this.lines.length > 100) this.lines.splice(0, this.lines.length - 100)
  }

  async close() {
    this.watcher.stop()
    this.prompt.unwatch()
    this.jobs.shutdown()
    this.mouth.close()
    await this.brain?.close().catch(() => {})
  }
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
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

/** Earlier stock prompts (prompts/previous/*.md), so an unedited copy in ~/.assistant is upgraded. */
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
