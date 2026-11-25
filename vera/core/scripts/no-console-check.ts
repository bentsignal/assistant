/**
 * Verifies that Core and everything it starts never shows a window: runs
 * Core under a fake App (spawned hidden, as vera.exe does) while
 * watch-windows.ps1 reports every top-level window that becomes visible,
 * and drives every kind of child process Core makes: the claude brain (and
 * the Vera MCP server it spawns with node), claude/codex/grok jobs, the T3
 * CLI, and taskkill (cancelling a job). Uses real CLIs with tiny prompts.
 *
 *   pnpm tsx scripts/no-console-check.ts [--control] [--skip-jobs]
 *
 * --control first opens one console window on purpose, to prove the
 * watcher sees them.
 */
import { spawn } from "node:child_process"
import { join } from "node:path"
import { CORE_DIR, FakeApp, sleep, type Cmd } from "./fake-app.ts"

const control = process.argv.includes("--control")
const skipJobs = process.argv.includes("--skip-jobs")
const SECONDS = 240

const windows: any[] = []
const watcher = spawn(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(CORE_DIR, "scripts", "watch-windows.ps1"), "-Seconds", String(SECONDS)],
  { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
)
let ready!: () => void
const watching = new Promise<void>((r) => (ready = r))
let wbuf = ""
watcher.stdout.setEncoding("utf8").on("data", (d: string) => {
  wbuf += d
  let i: number
  while ((i = wbuf.indexOf("\n")) >= 0) {
    const line = wbuf.slice(0, i).trim()
    wbuf = wbuf.slice(i + 1)
    if (!line) continue
    const o = JSON.parse(line)
    if (o.watching) ready()
    else {
      windows.push(o)
      console.log(`  window shown: ${line}`)
    }
  }
})
watcher.stderr.setEncoding("utf8").on("data", (d: string) => process.stderr.write(d))

const SUSPECT = /^(node|claude|codex|grok|cmd|conhost|openconsole|windowsterminal|powershell|pwsh|taskkill|t3|t3 code|electron)$/i
const CONSOLE_CLASS = /ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS|PseudoConsoleWindow/

async function main() {
  await watching
  console.log("watcher running")
  if (control) {
    const t = Date.now()
    spawn("cmd.exe", ['/d /c start "vera-control" cmd /c "timeout /t 2 >nul"'], { stdio: "ignore", windowsVerbatimArguments: true })
    await sleep(3500)
    const seen = windows.filter((w) => w.t >= t && CONSOLE_CLASS.test(w.class))
    console.log(seen.length ? `control: the watcher saw the console window (${seen[0].class})` : "control: NOT SEEN, the watcher is blind")
    if (!seen.length) process.exitCode = 2
    if (process.argv.includes("--control-only")) {
      watcher.kill()
      return
    }
  }
  const started = Date.now()
  const tiny = "Reply with just the word ok. Don't use any tools."
  const app = await FakeApp.start({
    echo: false,
    config: {
      brain: { harness: "script", "claude-code": { model: "haiku", effort: "low" } },
      wake: { followUpSeconds: 2 },
      jobs: { defaultCwd: CORE_DIR, waitTimeoutSeconds: 120, claude: { model: "haiku", effort: "low" }, codex: { effort: "low" } },
      t3: { pollSeconds: 3600 },
    },
    script: [
      {
        match: "run the jobs",
        steps: [
          { tool: "ask_claude", args: { task: tiny, wait: true } },
          { tool: "ask_grok", args: { task: tiny, wait: true } },
          { tool: "ask_codex", args: { task: tiny, wait: true } },
          { tool: "speak", args: { text: "Jobs done." } },
        ],
      },
      {
        match: "cancel one",
        steps: [{ tool: "ask_claude", args: { task: "Count from one to two hundred, one number per line, slowly." } }, { sleep: 2500 }, { tool: "job_status", args: {} }],
      },
      { match: "kill it", steps: [{ tool: "cancel_job", args: { id: skipJobs ? "j1" : "j4" } }] },
      { match: "t3", steps: [{ tool: "t3_list_projects", args: {} }, { tool: "t3_list_threads", args: { limit: 2 } }] },
      { match: "switch", steps: [{ tool: "set_brain", args: { harness: "claude-code", model: "haiku", effort: "low" } }, { tool: "speak", args: { text: "Switching." } }] },
    ],
  })
  const turn = async (text: string, timeoutMs = 180_000) => {
    const m = app.mark
    console.log(`turn: ${text}`)
    await app.api("/api/utterance", { text, direct: true, wait: true }).catch((e) => console.log(`  ${e.message}`))
    await app.waitFor((c: Cmd) => c.cmd === "hud" && (c.state === "listening" || c.state === "idle" || c.state === "working"), timeoutMs, m).catch(() => {})
    const st = await app.state()
    const t = st.turns.at(-1)
    console.log(`  tools: ${(t?.tools ?? []).join(", ")}; said: ${(t?.spoken ?? []).join(" ") || "-"}`)
  }
  if (!skipJobs) await turn("run the jobs")
  await turn("cancel one")
  await turn("kill it")
  await turn("t3")
  await turn("switch")
  await turn("Vera, say hello in two words.")
  const st = await app.state()
  console.log("jobs:", st.jobs.map((j: any) => `${j.id} ${j.agent} ${j.status}${j.error ? " (" + j.error.slice(0, 80) + ")" : ""}`).join("; "))
  await app.stop()
  await sleep(1500)
  watcher.kill()
  const during = windows.filter((w) => w.t >= started)
  const bad = during.filter((w) => CONSOLE_CLASS.test(w.class) || SUSPECT.test(w.process))
  console.log(`\n${during.length} window(s) shown during the run; ${bad.length} from a console or one of Core's children.`)
  for (const w of bad) console.log(`  BAD: ${JSON.stringify(w)}`)
  if (bad.length) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  watcher.kill()
  process.exit(1)
})
