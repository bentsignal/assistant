/**
 * Harness acknowledgements (ack.ts): the pure rules, then end to end with
 * the scripted brain behind a fake App.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { acksFor, endsSilently, pickAck, slowTool, stripOpeningAck } from "../src/ack.ts"
import { FakeApp, sleep, testConfig, type Cmd } from "../scripts/fake-app.ts"

test("turns that end silently get no acknowledgement", () => {
  for (const t of ["thanks", "Thank you so much.", "okay", "OK, cool.", "got it", "never mind", "Thanks, Vera."]) assert.ok(endsSilently(t), t)
  for (const t of ["what's running on Winserve?", "okay, check my threads", "thanks, now start a thread"]) assert.ok(!endsSilently(t), t)
})

test("each persona acknowledges in character, rotating; custom ones win", () => {
  assert.ok(acksFor({ name: "Vera" }).includes("One sec."))
  assert.ok(acksFor({ name: "Alfred" }).every((a) => /sir/.test(a) || /moment/i.test(a)))
  assert.ok(acksFor({ name: "Tony" }).some((a) => /gimme|lemme|hold on/i.test(a)))
  assert.deepEqual(acksFor({ name: "Nova" }), ["One sec.", "Checking.", "Give me a second."])
  assert.deepEqual(acksFor({ name: "Vera", acks: ["Mm, one tick."] } as any), ["Mm, one tick."])
  assert.notEqual(pickAck({ name: "Vera" }, 0), pickAck({ name: "Vera" }, 1))
})

test("her own opening acknowledgement is dropped after Core's", () => {
  assert.equal(stripOpeningAck("Checking. It finished."), "It finished.")
  assert.equal(stripOpeningAck("One moment, sir."), "")
  assert.equal(stripOpeningAck("Let me check. Hang on. Two are running."), "Two are running.")
  assert.equal(stripOpeningAck("Two threads are running."), "Two threads are running.")
  assert.equal(stripOpeningAck("On it, I'll ping you."), "On it, I'll ping you.")
})

test("instant tools don't call for one; slow ones (hers too) do", () => {
  assert.ok(!slowTool("speak"))
  assert.ok(!slowTool("mcp__assistant__set_volume"))
  assert.ok(slowTool("t3_read_thread"))
  assert.ok(slowTool("mcp__assistant__t3_send"))
  assert.ok(slowTool("mcp__github__search"))
})

const speaks = (cmds: Cmd[]) => cmds.filter((c) => c.cmd === "speak").map((c) => c.text as string)
const ackConfig = () => testConfig({ turn: { acknowledgeMs: 500, silenceAckMs: 1200 } })

test("by default Core never acknowledges: her prompt decides", async () => {
  const script = [
    { match: "summarize", steps: [{ tool: "ask_claude", args: { task: "summarize the repo" } }, { sleep: 1500 }, { tool: "speak", args: { text: "It's a voice assistant." } }] },
  ]
  const app = await FakeApp.start({ config: testConfig({}), script })
  try {
    app.send({ type: "ready", mic: "m" })
    const m = app.mark
    await app.say("Hey Vera, summarize the repo.")
    await app.waitFor((c) => c.cmd === "speak" && /voice assistant/.test(c.text as string), 10_000, m)
    assert.deepEqual(speaks(app.since(m)), ["It's a voice assistant."])
    assert.doesNotMatch(app.stderr, /acknowledged "/)
  } finally {
    await app.stop()
  }
})

test("by default a slow plain answer gets none either", async () => {
  const script = [{ match: "slow question", steps: [{ sleep: 2000 }, { tool: "speak", args: { text: "Here it is." } }] }]
  const app = await FakeApp.start({ config: testConfig({}), script })
  try {
    app.send({ type: "ready", mic: "m" })
    const m = app.mark
    await app.say("Hey Vera, slow question.")
    await app.waitFor((c) => c.cmd === "speak" && c.text === "Here it is.", 10_000, m)
    assert.deepEqual(speaks(app.since(m)), ["Here it is."])
    assert.doesNotMatch(app.stderr, /acknowledged "/)
  } finally {
    await app.stop()
  }
})

test("turned on, a quick first tool she answers right after gets none", async () => {
  const script = [{ match: "status", steps: [{ tool: "ask_claude", args: { task: "status" } }, { sleep: 150 }, { tool: "speak", args: { text: "All good." } }] }]
  const app = await FakeApp.start({ config: testConfig({ turn: { acknowledgeMs: 1500 } }), script })
  try {
    app.send({ type: "ready", mic: "m" })
    const m = app.mark
    await app.say("Hey Vera, what's the status?")
    await app.waitFor((c) => c.cmd === "speak" && c.text === "All good.", 10_000, m)
    await sleep(1800)
    assert.deepEqual(speaks(app.since(m)), ["All good."])
  } finally {
    await app.stop()
  }
})

test("turned on, a slow first tool gets one while it runs; her own 'checking' is then dropped and she's told", async () => {
  const script = [
    {
      match: "summarize",
      steps: [{ tool: "ask_claude", args: { task: "summarize the repo" } }, { sleep: 1500 }, { tool: "speak", args: { text: "Checking. It's a voice assistant." } }],
    },
  ]
  const app = await FakeApp.start({ config: testConfig({ turn: { acknowledgeMs: 500 } }), script })
  try {
    app.send({ type: "ready", mic: "m" })
    const m = app.mark
    await app.say("Hey Vera, summarize the repo.")
    await app.waitFor((c) => c.cmd === "speak" && /voice assistant/.test(c.text as string), 10_000, m)
    const said = speaks(app.since(m))
    assert.equal(said.length, 2, `got ${JSON.stringify(said)}`)
    assert.ok(["One sec.", "Checking.", "On it.", "Give me a second."].includes(said[0]), said[0])
    assert.equal(said[1], "It's a voice assistant.")
    // The acknowledgement went out while the tool ran.
    assert.ok(app.stderr.includes(`acknowledged "${said[0]}" (during ask_claude`), "acknowledged during the tool")
    for (let i = 0; i < 30 && !/turn \d+ done/.test(app.stderr); i++) await sleep(100)
    const state = await app.state()
    const turn = (state.turns ?? []).at(-1)
    if (turn?.output !== undefined) assert.match(turn.output, /Core already said/)
  } finally {
    await app.stop()
  }
})

test("silence past the threshold gets one; a quick answer and a 'thanks' get none", async () => {
  const script = [
    { match: "slow question", steps: [{ sleep: 2200 }, { tool: "speak", args: { text: "Here it is." } }] },
    { match: "quick question", steps: [{ tool: "speak", args: { text: "Yes." } }] },
    { match: "thanks", steps: [{ sleep: 2000 }] },
  ]
  const app = await FakeApp.start({ config: ackConfig(), script })
  try {
    app.send({ type: "ready", mic: "m" })
    let m = app.mark
    await app.say("Hey Vera, slow question.")
    await app.waitFor((c) => c.cmd === "speak" && c.text === "Here it is.", 10_000, m)
    let said = speaks(app.since(m))
    assert.equal(said.length, 2, JSON.stringify(said))
    assert.match(app.stderr, /acknowledged "[^"]+" \(silence/)
    await sleep(1500)

    m = app.mark
    await app.say("Hey Vera, quick question.")
    await app.waitFor((c) => c.cmd === "speak" && c.text === "Yes.", 10_000, m)
    await sleep(1600)
    assert.deepEqual(speaks(app.since(m)), ["Yes."])

    m = app.mark
    await app.say("Hey Vera, thanks.")
    await sleep(2800)
    assert.deepEqual(speaks(app.since(m)), [])
  } finally {
    await app.stop()
  }
})

test("barge-in stops an acknowledgement like any line", async () => {
  const script = [{ match: "long job", steps: [{ sleep: 1400 }, { hang: true }] }]
  const app = await FakeApp.start({ config: ackConfig(), script, msPerChar: 200 })
  try {
    app.send({ type: "ready", mic: "m" })
    const m = app.mark
    await app.say("Hey Vera, start the long job.")
    const ack = await app.waitFor((c) => c.cmd === "speak", 5000, m)
    await app.waitFor((c) => c.cmd === "hud" && c.state === "speaking", 3000, m).catch(() => {})
    await sleep(150)
    const cut = app.bargeIn()
    assert.equal(cut, (ack as any).speak_id)
    await sleep(300)
    assert.match(app.stderr, new RegExp(`barge-in \\(barge_in\\) on ${(ack as any).speak_id}`))
  } finally {
    await app.stop()
  }
})
