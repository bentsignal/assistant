/**
 * A fake Vera App: spawns Core in `--stdio` mode (hidden, the way vera.exe
 * does), plays scripted app events, and records every core command. Used by
 * test/protocol.test.ts, and runnable by hand against a real brain:
 *
 *   pnpm fake-app                      # scripted brain: quick protocol demo
 *   pnpm fake-app --real               # claude-code sonnet/low, a few real turns
 *   pnpm fake-app --real --brain codex
 *
 * Playback is simulated: a `speak` gets `playback started` after `startMs`
 * and `finished` after `msPerChar` per character, unless the test barges in.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { AppEvent, CoreCommand } from "../src/app.ts"

export const CORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

export type Cmd = CoreCommand & { at: number }

export interface FakeAppOptions {
  /** config.json for the throwaway VERA_HOME (merged over Core's defaults). */
  config?: Record<string, unknown>
  /** Rules for the scripted brain (src/brain/script.ts). */
  script?: unknown[]
  /** Reuse a home folder instead of a fresh temp one. */
  home?: string
  /** Simulated playback timing. */
  startMs?: number
  msPerChar?: number
  /** Send `playback` events automatically (default true). */
  autoPlay?: boolean
  /** Echo Core's stderr (default: only with VERA_DEBUG). */
  echo?: boolean
}

export class FakeApp {
  child!: ChildProcess
  home: string
  cmds: Cmd[] = []
  stderr = ""
  /** speak_id -> text, for the ones currently "playing". */
  playing = new Map<string, { text: string; timers: NodeJS.Timeout[] }>()
  private waiters: { pred: (c: Cmd) => boolean; from: number; resolve: (c: Cmd) => void }[] = []
  private exited: Promise<number | null>
  readonly t0 = Date.now()

  private constructor(private opts: FakeAppOptions) {
    this.home = opts.home ?? mkdtempSync(join(tmpdir(), "vera-fake-app-"))
    mkdirSync(join(this.home, "brain"), { recursive: true })
    writeFileSync(join(this.home, "config.json"), JSON.stringify(opts.config ?? {}, null, 2))
    if (opts.script) writeFileSync(join(this.home, "brain", "script-brain.json"), JSON.stringify(opts.script, null, 2))
    const tsx = pathToFileURL(join(CORE_DIR, "node_modules", "tsx", "dist", "loader.mjs")).href
    // Exactly what vera.exe runs (see README "Spawning Core from the App").
    this.child = spawn(process.execPath, ["--import", tsx, join(CORE_DIR, "src", "main.ts"), "--stdio"], {
      cwd: CORE_DIR,
      env: { ...process.env, VERA_HOME: this.home, VERA_PORT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    let buf = ""
    this.child.stdout!.setEncoding("utf8").on("data", (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) this.onLine(line)
      }
    })
    let ebuf = ""
    this.child.stderr!.setEncoding("utf8").on("data", (d: string) => {
      this.stderr += d
      if (this.stderr.length > 2_000_000) this.stderr = this.stderr.slice(-1_000_000)
      ebuf += d
      let i: number
      while ((i = ebuf.indexOf("\n")) >= 0) {
        const line = ebuf.slice(0, i)
        ebuf = ebuf.slice(i + 1)
        if (opts.echo ?? !!process.env.VERA_DEBUG) process.stderr.write(`  core| ${line}\n`)
      }
    })
    this.exited = new Promise((r) => this.child.on("exit", (code) => r(code)))
  }

  static async start(opts: FakeAppOptions = {}): Promise<FakeApp> {
    const app = new FakeApp(opts)
    // Core is up once it has written its runtime file and sent its first HUD state.
    await app.waitFor((c) => c.cmd === "hud", 20_000)
    return app
  }

  private onLine(line: string) {
    let cmd: Cmd
    try {
      cmd = { ...JSON.parse(line), at: Date.now() - this.t0 }
    } catch {
      throw new Error(`Core wrote a non-JSON line to stdout: ${line}`)
    }
    this.cmds.push(cmd)
    if (this.opts.echo ?? !!process.env.VERA_DEBUG) process.stderr.write(`  app<- ${line}\n`)
    if (cmd.cmd === "speak" && (this.opts.autoPlay ?? true)) this.play(cmd.speak_id, cmd.text)
    if (cmd.cmd === "stop_speaking") for (const id of [...this.playing.keys()]) this.endPlayback(id, "interrupted")
    const idx = this.cmds.length - 1
    for (const w of [...this.waiters]) {
      if (idx >= w.from && w.pred(cmd)) {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        w.resolve(cmd)
      }
    }
  }

  send(ev: AppEvent) {
    if (this.opts.echo ?? !!process.env.VERA_DEBUG) process.stderr.write(`  app-> ${JSON.stringify(ev)}\n`)
    this.child.stdin!.write(JSON.stringify(ev) + "\n")
  }

  /** Simulated playback of one speak command. */
  play(id: string, text: string) {
    const startMs = this.opts.startMs ?? 80
    const len = Math.max(150, text.length * (this.opts.msPerChar ?? 12))
    const timers = [
      setTimeout(() => this.send({ type: "playback", speak_id: id, state: "started" }), startMs),
      setTimeout(() => this.endPlayback(id, "finished"), startMs + len),
    ]
    this.playing.set(id, { text, timers })
  }

  endPlayback(id: string, state: "finished" | "interrupted") {
    const p = this.playing.get(id)
    if (!p) return
    p.timers.forEach(clearTimeout)
    this.playing.delete(id)
    this.send({ type: "playback", speak_id: id, state })
  }

  /** Shawn talks over Vera: the App stops playback, then tells Core. */
  bargeIn(): string | undefined {
    const id = [...this.playing.keys()][0]
    this.send({ type: "speech_start", t: Date.now() })
    if (id) {
      this.endPlayback(id, "interrupted")
      this.send({ type: "barge_in", speak_id: id })
    }
    return id
  }

  /** Shawn says something: speech_start, a partial, then the final. */
  async say(text: string, opts: { duringPlayback?: boolean; skipStart?: boolean; ms?: number } = {}) {
    const start = Date.now()
    if (!opts.skipStart) this.send({ type: "speech_start", t: start })
    this.send({ type: "partial", text: text.split(" ").slice(0, 2).join(" "), t: start + 100 })
    await sleep(opts.ms ?? 150)
    this.send({ type: "final", text, start, end: Date.now(), during_playback: !!opts.duringPlayback })
  }

  /** Resolves with the first command (from index `from`) matching. */
  waitFor(pred: (c: Cmd) => boolean, timeoutMs = 10_000, from = 0): Promise<Cmd> {
    const hit = this.cmds.slice(from).find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const w = { pred, from, resolve: (c: Cmd) => (clearTimeout(t), resolve(c)) }
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        reject(new Error(`timed out waiting for a command; got:\n${this.cmds.slice(from).map((c) => JSON.stringify(c)).join("\n")}`))
      }, timeoutMs)
      this.waiters.push(w)
    })
  }

  /** Commands since `from` (an index into cmds). */
  since(from: number): Cmd[] {
    return this.cmds.slice(from)
  }

  get mark(): number {
    return this.cmds.length
  }

  /** The HUD states sent since `from`, in order. */
  huds(from = 0): string[] {
    return this.cmds.slice(from).flatMap((c) => (c.cmd === "hud" ? [c.state] : []))
  }

  /** POST to Core's debug hook. */
  async api(path: string, body: unknown = {}): Promise<any> {
    const rt = JSON.parse(readFileSync(join(this.home, "core-runtime.json"), "utf8"))
    const res = await fetch(`${rt.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    return res.json()
  }

  async state(): Promise<any> {
    const rt = JSON.parse(readFileSync(join(this.home, "core-runtime.json"), "utf8"))
    return (await fetch(`${rt.url}/api/state`)).json()
  }

  /** What the scripted brain was told, one entry per turn. */
  brainLog(): string[] {
    const f = join(this.home, "brain", "script-brain.log.jsonl")
    if (!existsSync(f)) return []
    return readFileSync(f, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l).text)
  }

  /** Close stdin (how the App asks Core to quit) and wait for the exit. */
  async stop(keepHome = false): Promise<number | null> {
    for (const p of this.playing.values()) p.timers.forEach(clearTimeout)
    this.child.stdin!.end()
    const code = await Promise.race([this.exited, sleep(8000).then(() => "timeout" as const)])
    if (code === "timeout") {
      this.child.kill()
      throw new Error("Core didn't exit within 8 s of stdin closing")
    }
    if (!keepHome && !this.opts.home) rmSync(this.home, { recursive: true, force: true })
    return code
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Base config for protocol tests: scripted brain, short follow-up, fake job agent, no T3 polling. */
export function testConfig(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    brain: { harness: "script" },
    wake: { followUpSeconds: 1.5 },
    jobs: { defaultCwd: CORE_DIR, claude: { command: [process.execPath, join(CORE_DIR, "scripts", "fake-job.mjs"), "1200"] } },
    t3: { pollSeconds: 3600 },
    ...over,
  }
}

// ---- CLI ----------------------------------------------------------------------

async function demo(real: boolean, brain: string) {
  const config = real
    ? { brain: { harness: brain }, wake: { followUpSeconds: 6 }, t3: { pollSeconds: 3600 } }
    : testConfig()
  const script = [
    { match: "too loud", steps: [{ tool: "set_volume", args: { relative: "quieter", a_lot: true } }, { tool: "speak", args: { text: "Better?" } }] },
    { match: "shopping list", steps: [{ tool: "show", args: { title: "Pancakes", markdown: "- flour\n- eggs\n- milk" } }, { tool: "speak", args: { text: "It's on screen." } }] },
    { match: "close that", steps: [{ tool: "hide", args: {} }] },
  ]
  const app = await FakeApp.start({ config, script, echo: true, msPerChar: 45 })
  app.send({ type: "ready", mic: "fake mic", engine: "fake", volume: 0.5 })
  const turn = async (text: string, waitMs = 30_000) => {
    const m = app.mark
    console.log(`\n>>> ${text}`)
    await app.say(text)
    // A turn is over when the HUD settles back to listening or idle after thinking.
    await app.waitFor((c) => c.cmd === "hud" && c.state === "thinking", 5000, m).catch(() => null)
    await app.waitFor((c) => c.cmd === "hud" && (c.state === "listening" || c.state === "idle"), waitMs, app.mark)
    const got = app.since(m).filter((c) => c.cmd !== "hud" && c.cmd !== "badge")
    console.log(`<<< ${got.map((c) => JSON.stringify(c)).join("\n    ") || "(nothing)"}`)
    return got
  }
  await turn("Vera, you're way too loud, turn yourself down.")
  await turn("Vera, show me a quick shopping list for pancakes.")
  await sleep(1000)
  await turn("Okay, close that.")
  if (real) {
    const m = app.mark
    console.log("\n>>> Vera, tell me a bit about the history of sourdough bread.  (barging in after 1.5 s of speech)")
    await app.say("Vera, tell me a bit about the history of sourdough bread.")
    await app.waitFor((c) => c.cmd === "speak", 30_000, m)
    await sleep(1500)
    app.bargeIn()
    await sleep(600)
    await app.say("Actually, just tell me how long the starter takes.", { skipStart: true, duringPlayback: true })
    await app.waitFor((c) => c.cmd === "speak", 30_000, app.mark)
    await sleep(4000)
    console.log(`<<< ${app.since(m).filter((c) => c.cmd !== "hud" && c.cmd !== "badge").map((c) => JSON.stringify(c)).join("\n    ")}`)
  }
  const st = await app.state()
  console.log("\nturns:", JSON.stringify(st.turns.map((t: any) => ({ text: t.text, via: t.via, tools: t.tools, firstSpeakMs: t.firstSpeakMs })), null, 1))
  await app.stop()
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const real = process.argv.includes("--real")
  const bi = process.argv.indexOf("--brain")
  demo(real, bi > 0 ? process.argv[bi + 1] : "claude-code").catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
