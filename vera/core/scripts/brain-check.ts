/**
 * A few real brain turns through the fake App, checking which tools the
 * brain picks (Vera's own volume vs the computer's) and how much it says.
 * Background jobs use the fake agent, so nothing on the computer changes.
 *
 *   pnpm tsx scripts/brain-check.ts [--brain codex] [--only <text>]
 */
import { join } from "node:path"
import { CORE_DIR, FakeApp, sleep } from "./fake-app.ts"

const bi = process.argv.indexOf("--brain")
const harness = bi > 0 ? process.argv[bi + 1] : "claude-code"
const fake = [process.execPath, join(CORE_DIR, "scripts", "fake-job.mjs"), "500"]

const cases: { say: string; want: (tools: string[], spoken: string) => string | null }[] = [
  { say: "Vera, you're way too loud, turn yourself down.", want: (t) => (t.includes("set_volume") && !t.some((x) => x.startsWith("ask_")) ? null : "expected set_volume only") },
  { say: "Vera, can you speak up a bit?", want: (t) => (t.includes("set_volume") && !t.some((x) => x.startsWith("ask_")) ? null : "expected set_volume only") },
  { say: "Vera, turn it down a little.", want: (t) => (t.includes("set_volume") && !t.some((x) => x.startsWith("ask_")) ? null : "expected set_volume only") },
  { say: "Vera, turn the computer's volume down to twenty percent.", want: (t) => (t.includes("ask_codex") && !t.includes("set_volume") ? null : "expected ask_codex, not set_volume") },
  { say: "Vera, what's a good substitute for buttermilk?", want: (_t, s) => (words(s) <= 30 ? null : `too long (${words(s)} words)`) },
  { say: "Vera, tell me about the history of sourdough.", want: (_t, s) => (words(s) <= 35 ? null : `too long (${words(s)} words)`) },
  { say: "Vera, ask Claude to count the TODO comments in the vera folder.", want: (t, s) => (t.includes("ask_claude") && words(s) <= 6 ? null : `expected ask_claude and a brief ack, said "${s}"`) },
]

function words(s: string) {
  return s.split(/\s+/).filter(Boolean).length
}

async function main() {
  const app = await FakeApp.start({
    config: {
      brain: { harness },
      wake: { followUpSeconds: 2 },
      jobs: { defaultCwd: CORE_DIR, claude: { command: fake }, codex: { command: fake }, grok: { command: fake } },
      t3: { pollSeconds: 3600 },
    },
    msPerChar: 5,
  })
  app.send({ type: "ready", volume: 0.5 })
  let failed = 0
  const only = process.argv.indexOf("--only")
  for (const c of only > 0 ? cases.filter((x) => x.say.includes(process.argv[only + 1])) : cases) {
    const m = app.mark
    const r = await app.api("/api/utterance", { text: c.say, wait: true })
    await sleep(300)
    const tools: string[] = r.turn?.tools ?? []
    const spoken = (r.turn?.spoken ?? []).join(" ")
    const vols = app.since(m).filter((x) => x.cmd === "set_volume").map((x: any) => x.level)
    const err = c.want(tools, spoken)
    if (err) failed++
    console.log(`${err ? "FAIL" : "ok  "} ${c.say}\n     tools: ${tools.join(", ") || "-"}${vols.length ? ` (volume -> ${vols.join(", ")})` : ""}; ${r.turn?.firstSpeakMs ?? "-"} ms; said: "${spoken}"${err ? `\n     ${err}` : ""}`)
  }
  await app.stop()
  console.log(failed ? `${failed} failed` : "all passed")
  process.exitCode = failed ? 1 : 0
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
