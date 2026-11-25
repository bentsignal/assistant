/**
 * Latency bench: utterance in -> first `speak` tool call, per brain setting.
 * Drives a running daemon (pnpm dev) over HTTP. The first turn after a switch
 * pays for the harness starting and is reported separately as "cold".
 *
 *   pnpm bench                       # default matrix
 *   pnpm bench claude-code:sonnet:low codex:gpt-6.2-sol:low
 *
 * Use a mouth stub and a scratch VERA_HOME for the daemon you bench.
 */
const URL = process.env.VERA_URL ?? "http://127.0.0.1:7313"
const QUESTIONS = [
  "Vera, how many teaspoons are in a tablespoon?",
  "Vera, what's a good substitute for buttermilk?",
  "Vera, how long should I rest a steak?",
  "Vera, what's fifteen percent of eighty?",
]
const DEFAULT = ["claude-code:haiku:low", "claude-code:sonnet:low", "claude-code:opus:low", "codex:gpt-6.2-sol:low", "codex:gpt-6-luna:low"]

async function post(path: string, body: unknown) {
  const res = await fetch(URL + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return res.json() as Promise<any>
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN
}

const specs = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT
const rows: string[] = []
for (const spec of specs) {
  const [harness, model, effort] = spec.split(":")
  await post("/api/brain", { harness, model, effort })
  const first: number[] = []
  const totals: number[] = []
  let cold = NaN
  let missed = 0
  for (const [i, q] of QUESTIONS.entries()) {
    const r = await post("/api/utterance", { text: q, wait: true })
    const t = r.turn
    if (t?.firstSpeakMs == null) missed++
    else if (i === 0) cold = t.firstSpeakMs
    else first.push(t.firstSpeakMs)
    if (i > 0 && t?.durationMs != null) totals.push(t.durationMs)
    console.log(`${spec}  #${i}  first speak ${t?.firstSpeakMs ?? "none"} ms  turn ${t?.durationMs} ms  said: ${JSON.stringify(t?.spoken?.[0] ?? t?.error ?? "")}`)
  }
  rows.push(
    `| ${spec} | ${isNaN(cold) ? "-" : cold} | ${median(first)} | ${first.length ? Math.min(...first) : "-"}–${first.length ? Math.max(...first) : "-"} | ${median(totals)} | ${missed} |`,
  )
}
console.log("\n| brain | cold first speak (ms) | warm median (ms) | warm range | warm turn median (ms) | turns with no speak |")
console.log("|---|---|---|---|---|---|")
console.log(rows.join("\n"))
