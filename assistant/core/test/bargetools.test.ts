/**
 * Talking over her never aborts a running tool, from any server: Core
 * tracks every tool call in the brain's stream (`tool` .. `tool_done`), a
 * barge-in during one stops only her speech, and his words go into the
 * running turn (Claude, `Brain.steer`) or wait for the tools (Codex).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ClaudeBrain } from "../src/brain/claude.ts"
import { CORE_DIR } from "../src/config.ts"
import { FakeApp, sleep, testConfig, type Cmd } from "../scripts/fake-app.ts"

const speaks = (cmds: Cmd[]) => cmds.filter((c) => c.cmd === "speak").map((c) => c.text as string)
const DENIAL = /doesn't want to proceed/

/** Her own stdio server `slowbox` (scripts/slow-mcp.mjs): slow_word takes `ms`. */
function slowServer(home: string, ms: number): string {
  const log = join(home, "slow-mcp.log")
  const server = { command: process.execPath, args: [join(CORE_DIR, "scripts", "slow-mcp.mjs"), "persimmon", String(ms)], env: { SLOW_MCP_LOG: log } }
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcpServers: { slowbox: server } }, null, 2))
  return log
}
const slowLog = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "")
const told = (home: string) =>
  readFileSync(join(home, "brain", "script-brain.log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { text: string; steered?: boolean })

const SLOW = { mcp: { server: "slowbox", tool: "slow_word" } }

/** Talks over her line while slow_word runs, twice, then waits for `answer`. */
async function talkOverTwice(app: FakeApp, answer: string) {
  app.send({ type: "ready", mic: "m" })
  const m = app.mark
  await app.say("Hey Vera, get me the slow word.")
  await app.waitFor((c) => c.cmd === "speak", 5000, m)
  for (let i = 0; i < 60 && !/brain tool mcp__slowbox__slow_word/.test(app.stderr); i++) await sleep(50)
  await sleep(300) // the tool is running and her line is playing
  app.bargeIn()
  await app.say("and also tell me the time", { duringPlayback: true, skipStart: true })
  await sleep(400)
  app.bargeIn() // nothing of hers is playing now: he just talks again
  await app.say("and the date too", { duringPlayback: true, skipStart: true })
  await app.waitFor((c) => c.cmd === "speak" && c.text === answer, 20_000, m)
  return m
}

test("Claude-style brain: barge-in during her own MCP server's slow tool lets it finish and his words go into the same turn", async () => {
  const script = [
    { match: "talked over you|went on", steps: [{ tool: "speak", args: { text: "Persimmon, and it's late on the twenty-sixth." } }] },
    {
      match: "slow word",
      steps: [{ tool: "speak", args: { text: "Looking that up now, it takes a few seconds." } }, SLOW, { tool: "speak", args: { text: "The word is persimmon." } }],
    },
  ]
  const app = await FakeApp.start({ config: testConfig(), script, msPerChar: 60 })
  try {
    const log = slowServer(app.home, 3000)
    const m = await talkOverTwice(app, "Persimmon, and it's late on the twenty-sixth.")
    assert.match(slowLog(log), /finished 2/, "the tool ran to the end")
    assert.doesNotMatch(slowLog(log), /cancelled/)
    assert.match(app.stderr, /talked over while mcp__slowbox__slow_word runs; her speech stops, the tools go on/)
    assert.match(app.stderr, /his words go into the running turn \(mcp__slowbox__slow_word still running\): and also tell me the time/)
    assert.match(app.stderr, /his words go into the running turn[^\n]*: and the date too/)
    assert.match(app.stderr, /brain tool mcp__slowbox__slow_word \(script_1\) -> The slow word is persimmon\./)
    assert.doesNotMatch(app.stderr, /interrupting the brain|stopping the brain now|the brain stops once it returns/)
    assert.doesNotMatch(app.stderr, DENIAL)
    assert.ok(!speaks(app.since(m)).includes("The word is persimmon."), "her answer covers both, once")
    const msgs = told(app.home)
    assert.equal(msgs.filter((x) => !x.steered).length, 1, "one turn: the brain was never stopped and restarted")
    const steered = msgs.filter((x) => x.steered)
    assert.equal(steered.length, 2)
    assert.match(steered[0].text, /talked over you while mcp__slowbox__slow_word was still running/)
    assert.match(steered[0].text, /answer his earlier request \("get me the slow word\."\)/)
    assert.match(steered[0].text, /Shawn: and also tell me the time/)
    assert.match(steered[1].text, /Shawn: and the date too/)
  } finally {
    await app.stop()
  }
})

test("Codex-style brain (can't steer): the brain stops only once her MCP tool returns, and the next message carries its result and both requests", async () => {
  const script = {
    steer: false,
    rules: [
      { match: "While he was talking", steps: [{ tool: "speak", args: { text: "Got all of it." } }] },
      {
        match: "slow word",
        steps: [{ tool: "speak", args: { text: "Looking that up now, it takes a few seconds." } }, SLOW, { tool: "speak", args: { text: "The word is persimmon." } }],
      },
    ],
  }
  const app = await FakeApp.start({ config: testConfig(), script, msPerChar: 60 })
  try {
    const log = slowServer(app.home, 3000)
    const m = await talkOverTwice(app, "Got all of it.")
    assert.match(slowLog(log), /finished 2/)
    assert.doesNotMatch(slowLog(log), /cancelled/)
    assert.match(app.stderr, /mcp__slowbox__slow_word still running, so the brain stops once it returns/)
    assert.doesNotMatch(app.stderr, DENIAL)
    assert.ok(!speaks(app.since(m)).includes("The word is persimmon."))
    const next = told(app.home).at(-1)!.text
    assert.match(next, /mcp__slowbox__slow_word finished and returned: "The slow word is persimmon\."/)
    assert.match(next, /previous request \("get me the slow word\."\)/)
    assert.match(next, /tell me the time/)
    assert.match(next, /the date too/)
  } finally {
    await app.stop()
  }
})

test("a running tool is never timed out: her patience counts from when it returned", async () => {
  const script = [{ match: "slow word", steps: [SLOW, { tool: "speak", args: { text: "It's persimmon." } }] }]
  const app = await FakeApp.start({ config: testConfig({ brain: { harness: "script", firstSpeakTimeoutSeconds: 1 } }), script })
  try {
    const log = slowServer(app.home, 2500)
    app.send({ type: "ready", mic: "m" })
    const m = app.mark
    await app.say("Hey Vera, get me the slow word.")
    await app.waitFor((c) => c.cmd === "speak" && c.text === "It's persimmon.", 10_000, m)
    assert.match(slowLog(log), /finished 2/)
    assert.doesNotMatch(app.stderr, /interrupting the brain/)
  } finally {
    await app.stop()
  }
})

test("Claude adapter: tool_use and tool_result are tool and tool_done; a steered message keeps the turn open until the model has taken it", async () => {
  const writes: string[] = []
  const logs: string[] = []
  const b = new ClaudeBrain({ systemPrompt: "", mcp: { command: "", args: [], env: {} }, cwd: ".", stateDir: ".", log: (l) => logs.push(l) })
  ;(b as any).ready = Promise.resolve()
  ;(b as any).child = { stdin: { write: (l: string) => writes.push(l) } }
  const events: string[] = []
  b.on("tool", (t) => events.push(`tool ${t.id} ${t.name}`))
  b.on("tool_done", (t) => events.push(`done ${t.id} ${t.result}`))
  let resolved = false
  const turn = b.turn("get the slow word").then((r) => ((resolved = true), r))
  await sleep(0)
  const line = (o: object) => (b as any).onLine(JSON.stringify(o))
  line({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "get the slow word" }] } })
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1", name: "mcp__slowbox__slow_word", input: {} }] } })
  assert.equal(b.steer("and the time"), true)
  line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "The slow word is persimmon." }] }] } })
  // The harness answered without taking his words: they start one more harness turn.
  line({ type: "assistant", message: { content: [{ type: "text", text: "Persimmon." }] } })
  line({ type: "result", is_error: false, result: "Persimmon." })
  await sleep(10)
  assert.equal(resolved, false, "the turn waits for the steered message")
  line({ type: "user", isReplay: true, message: { content: [{ type: "text", text: "and the time" }] } })
  line({ type: "assistant", message: { content: [{ type: "text", text: " It's late." }] } })
  line({ type: "result", is_error: false, result: "It's late." })
  const r = await turn
  assert.deepEqual(events, ["tool toolu_1 mcp__slowbox__slow_word", "done toolu_1 The slow word is persimmon."])
  assert.equal(r.ok, true)
  assert.equal(r.text, "Persimmon. It's late.")
  assert.equal(writes.length, 2)
  assert.match(writes[1], /and the time/)
  assert.ok(!writes.some((w) => /interrupt/.test(w)), "no interrupt was ever sent")
})
