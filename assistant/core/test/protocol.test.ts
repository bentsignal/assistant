/**
 * The App ⇄ Core stdio protocol, end to end: a fake App spawns Core (with
 * --stdio, as assistant.exe does) with the scripted brain and plays app events.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { FakeApp, sleep, testConfig, type Cmd } from "../scripts/fake-app.ts"

const isHud = (state: string) => (c: Cmd) => c.cmd === "hud" && c.state === state
const isCmd = (name: string) => (c: Cmd) => c.cmd === name
const spoken = (cmds: Cmd[]) => cmds.flatMap((c) => (c.cmd === "speak" ? [c.text] : []))

test("stdout carries only protocol JSON, and startup sends the HUD and badge", async () => {
  const app = await FakeApp.start({ config: testConfig() })
  try {
    app.send({ type: "ready", mic: "Test mic", engine: "parakeet_unified_en" })
    await app.waitFor(isCmd("badge"))
    for (let i = 0; i < 50 && !/Assistant core up/.test(app.stderr); i++) await sleep(100)
    assert.equal(app.cmds[0].cmd, "hud")
    assert.equal((app.cmds[0] as any).state, "idle")
    // FakeApp throws on any non-JSON stdout line; make sure logs went to stderr.
    assert.match(app.stderr, /Assistant core up/)
  } finally {
    assert.equal(await app.stop(), 0)
  }
})

test("wake word -> thinking -> speak -> playback -> follow-up without the wake word -> idle", async () => {
  const app = await FakeApp.start({
    config: testConfig(),
    script: [
      { match: "two plus two", steps: [{ tool: "speak", args: { text: "Four." } }] },
      { match: "three plus three", steps: [{ tool: "speak", args: { text: "Six." } }] },
    ],
  })
  try {
    const m0 = app.mark
    app.send({ type: "speech_start", t: Date.now() })
    app.send({ type: "partial", text: "Vera, what's", t: Date.now() })
    // The wake word in a partial already shows the HUD listening.
    await app.waitFor(isHud("listening"), 3000, m0)
    await sleep(100)
    app.send({ type: "final", text: "Vera, what's two plus two?", start: Date.now() - 900, end: Date.now(), during_playback: false })
    const speak = await app.waitFor(isCmd("speak"), 5000, m0)
    assert.equal((speak as any).text, "Four.")
    assert.match((speak as any).speak_id, /^s\d+$/)
    await app.waitFor(isHud("speaking"), 3000, m0)
    // Playback finishes -> follow-up window: listening.
    const afterSpeak = app.mark
    await app.waitFor(isHud("listening"), 3000, afterSpeak)
    assert.deepEqual(app.huds(m0), ["listening", "thinking", "speaking", "listening"])

    // A follow-up inside the window needs no wake word.
    const m1 = app.mark
    await app.say("And three plus three?")
    const s2 = await app.waitFor(isCmd("speak"), 5000, m1)
    assert.equal((s2 as any).text, "Six.")
    await app.waitFor(isHud("listening"), 3000, app.mark)

    // After the window (1.5 s in tests) the HUD goes idle, and speech without "Vera" is ignored.
    await app.waitFor(isHud("idle"), 4000, app.mark)
    const m2 = app.mark
    await app.say("What's four plus four?")
    await sleep(600)
    assert.deepEqual(spoken(app.since(m2)), [])
    const st = await app.state()
    assert.deepEqual(
      st.turns.map((t: any) => t.via),
      ["wake", "followup"],
    )
  } finally {
    await app.stop()
  }
})

test("several speak calls go out one at a time, each after the previous finished", async () => {
  const app = await FakeApp.start({
    config: testConfig(),
    script: [{ match: "story", steps: [1, 2, 3].map((n) => ({ tool: "speak", args: { text: `Sentence ${n}.` } })) }],
  })
  try {
    await app.say("Vera, tell me a story.")
    await app.waitFor((c) => c.cmd === "speak" && c.text === "Sentence 3.", 8000)
    const events = app.cmds.filter((c) => c.cmd === "speak")
    assert.equal(events.length, 3)
    // While the stretch lasts the HUD stays "speaking" (no flicker between sentences).
    await app.waitFor(isHud("listening"), 5000, app.cmds.indexOf(events[2]))
    const huds = app.huds()
    assert.equal(huds.filter((h) => h === "speaking").length, 1)
  } finally {
    await app.stop()
  }
})

test("barge-in mid-speech: the rest of the turn is dropped, the brain is told, and the next final needs no wake word", async () => {
  const app = await FakeApp.start({
    config: testConfig(),
    msPerChar: 40,
    script: [
      {
        match: "history of bread",
        steps: [
          { tool: "speak", args: { text: "Bread goes back at least fourteen thousand years, to the Natufians." } },
          { tool: "speak", args: { text: "Then the Egyptians worked out leavening." } },
          { sleep: 1500 },
          { tool: "speak", args: { text: "And that's only the beginning." } },
        ],
      },
      { match: "talked over you", steps: [{ tool: "speak", args: { text: "About a week." } }] },
    ],
  })
  try {
    await app.say("Vera, tell me the history of bread.")
    const first = await app.waitFor(isCmd("speak"))
    await app.waitFor(isHud("speaking"))
    await sleep(700)
    const m = app.mark
    const cutId = app.bargeIn()
    assert.equal(cutId, (first as any).speak_id)
    await app.waitFor(isHud("listening"), 2000, m)
    // Nothing more from that turn, even the sentence the brain says after the barge-in.
    await sleep(1800)
    assert.deepEqual(spoken(app.since(m)), [])
    // His reply, heard during playback: an in-conversation turn, no wake word.
    await app.say("Actually, how long does a starter take?", { skipStart: true, duringPlayback: true })
    const reply = await app.waitFor(isCmd("speak"), 5000, m)
    assert.equal((reply as any).text, "About a week.")
    const told = app.brainLog().at(-1)!
    assert.match(told, /talked over you/)
    assert.match(told, /cut off after "Bread goes/)
    assert.match(told, /Never said: "Then the Egyptians worked out leavening\."/)
    assert.match(told, /Shawn: Actually, how long does a starter take\?/)
    const st = await app.state()
    const [t1, t2] = st.turns
    assert.equal(t1.muted, true)
    assert.equal(t1.interrupted, true)
    assert.equal(t2.via, "barge-in")
  } finally {
    await app.stop()
  }
})

for (const phrase of ["Stop.", "Never mind.", "Be quiet."]) {
  test(`barge-in then "${phrase}" ends the turn without a reply`, async () => {
    const app = await FakeApp.start({
      config: testConfig(),
      msPerChar: 40,
      script: [
        { match: "weather", steps: [{ tool: "speak", args: { text: "It's going to be a long, grey, drizzly day with a cold wind." } }, { sleep: 800 }, { tool: "speak", args: { text: "Bring a coat." } }] },
      ],
    })
    try {
      await app.say("Vera, what's the weather like?")
      await app.waitFor(isHud("speaking"))
      await sleep(400)
      const m = app.mark
      app.bargeIn()
      await sleep(200)
      await app.say(phrase, { skipStart: true, duringPlayback: true })
      await sleep(1500)
      assert.deepEqual(spoken(app.since(m)), [])
      assert.equal(app.brainLog().length, 1, "stop never reaches the brain")
      // No follow-up window after a stop: back to idle.
      await app.waitFor(isHud("idle"), 3000, m)
    } finally {
      await app.stop()
    }
  })
}

test("tray Stop talking stops speech and drops the rest of the turn", async () => {
  const app = await FakeApp.start({
    config: testConfig(),
    msPerChar: 40,
    script: [{ match: "recipe", steps: [{ tool: "speak", args: { text: "First, warm the milk until it's just steaming." } }, { tool: "speak", args: { text: "Then whisk in the eggs." } }] }],
  })
  try {
    await app.say("Vera, read me the recipe.")
    await app.waitFor(isHud("speaking"))
    const m = app.mark
    app.send({ type: "ui", action: "stop_talking" })
    await app.waitFor(isCmd("stop_speaking"), 2000, m)
    await sleep(800)
    assert.deepEqual(spoken(app.since(m)), [])
  } finally {
    await app.stop()
  }
})

test("set_volume: 'you're way too loud' changes Vera's own volume, not the computer's", async () => {
  const app = await FakeApp.start({
    config: testConfig(),
    script: [
      { match: "too loud", steps: [{ tool: "set_volume", args: { relative: "quieter", a_lot: true } }, { tool: "speak", args: { text: "Better?" } }] },
      { match: "half", steps: [{ tool: "set_volume", args: { level: 0.5 } }] },
    ],
  })
  try {
    app.send({ type: "ready", volume: 0.5 })
    await sleep(100)
    await app.say("Vera, you're way too loud, turn yourself down.")
    const vol = await app.waitFor(isCmd("set_volume"))
    assert.equal((vol as any).level, 0.2, "0.5 minus a big step (0.3, 12 dB)")
    const speak = await app.waitFor(isCmd("speak"))
    assert.ok(app.cmds.indexOf(vol) < app.cmds.indexOf(speak), "volume changes before she answers")
    await app.waitFor(isHud("listening"), 3000, app.cmds.indexOf(speak))
    const m = app.mark
    await app.say("Go to half volume.")
    assert.equal(((await app.waitFor(isCmd("set_volume"), 5000, m)) as any).level, 0.5)
    // No job (ask_codex or anything else) was started to touch system volume.
    const st = await app.state()
    assert.deepEqual(st.jobs, [])
    assert.equal(st.volume, 0.5)
  } finally {
    await app.stop()
  }
})

test("volume steps on the App's scale: default 0.7, 0.15 a step, 0.3 a big one, within [0.1, 1]", async () => {
  const app = await FakeApp.start({
    config: testConfig(),
    script: [
      { match: "much louder", steps: [{ tool: "set_volume", args: { relative: "louder", a_lot: true } }] },
      { match: "louder", steps: [{ tool: "set_volume", args: { relative: "louder" } }] },
      { match: "way too loud", steps: [{ tool: "set_volume", args: { relative: "quieter", a_lot: true } }] },
      { match: "quieter", steps: [{ tool: "set_volume", args: { relative: "quieter" } }] },
      { match: "thirty", steps: [{ tool: "set_volume", args: { level: 30 } }] },
    ],
  })
  const levels: number[] = []
  const turn = async (text: string) => {
    const m = app.mark
    await app.api("/api/utterance", { text, direct: true, wait: true })
    levels.push(((await app.waitFor(isCmd("set_volume"), 3000, m)) as any).level)
  }
  try {
    // No `ready` volume yet: Core starts from the default.
    await turn("A bit quieter.")
    await turn("Much louder.")
    await turn("Louder.")
    await turn("Louder.")
    assert.deepEqual(levels, [0.55, 0.85, 1, 1])
    // The App's level (here from settings) is where the next step starts.
    app.send({ type: "ui", action: "settings_changed", volume: 0.3 })
    await sleep(100)
    await turn("You're way too loud.")
    await turn("Quieter.")
    await turn("Set yourself to thirty.")
    assert.deepEqual(levels.slice(4), [0.1, 0.1, 0.3])
  } finally {
    await app.stop()
  }
})

test("playback failed ends that item and the next one is sent; the turn goes on", async () => {
  const app = await FakeApp.start({
    config: testConfig(),
    autoPlay: false,
    script: [{ match: "two things", steps: [{ tool: "speak", args: { text: "First." } }, { tool: "speak", args: { text: "Second." } }] }],
  })
  try {
    await app.say("Vera, tell me two things.")
    const first = (await app.waitFor(isCmd("speak"))) as any
    assert.equal(first.text, "First.")
    // The voice service couldn't say it (the App plays its own error chime).
    app.send({ type: "playback", speak_id: first.speak_id, state: "failed" })
    const second = (await app.waitFor((c) => c.cmd === "speak" && c.text === "Second.", 3000)) as any
    assert.equal(app.since(0).filter(isCmd("stop_speaking")).length, 0, "not treated as an interruption")
    app.send({ type: "playback", speak_id: second.speak_id, state: "started" })
    await app.waitFor(isHud("speaking"))
    app.send({ type: "playback", speak_id: second.speak_id, state: "finished" })
    await app.waitFor(isHud("listening"), 3000, app.cmds.indexOf(second))
    const st = await app.state()
    assert.deepEqual(st.turns[0].spoken, ["First.", "Second."])
    assert.equal(st.turns[0].muted, undefined)
  } finally {
    await app.stop()
  }
})

test("show opens a card, hide closes it, and card_closed from the App is respected", async () => {
  const app = await FakeApp.start({
    config: testConfig(),
    script: [
      { match: "shopping list", steps: [{ tool: "show", args: { title: "Pancakes", markdown: "- flour\n- eggs\n- milk" } }, { tool: "speak", args: { text: "It's on screen." } }] },
      { match: "close that", steps: [{ tool: "hide", args: {} }] },
      { match: "timer card", steps: [{ tool: "show", args: { title: "Timer", markdown: "10 min" } }] },
    ],
  })
  try {
    await app.say("Vera, show me a shopping list for pancakes.")
    const show = await app.waitFor(isCmd("show"))
    assert.deepEqual({ ...show, at: 0 }, { cmd: "show", card_id: "c1", title: "Pancakes", markdown: "- flour\n- eggs\n- milk", at: 0 })
    await app.waitFor(isHud("listening"), 4000, app.cmds.indexOf(show))
    await app.say("Okay, close that.")
    const hide = await app.waitFor(isCmd("hide"))
    assert.equal((hide as any).card_id, "c1")
    // The App closed a card itself: Core doesn't try to close it again.
    await sleep(200)
    await app.say("Vera, put up a timer card.")
    const show2 = await app.waitFor((c) => c.cmd === "show" && c.card_id === "c2")
    app.send({ type: "ui", action: "card_closed", card_id: "c2" })
    await sleep(200)
    const st = await app.state()
    assert.deepEqual(
      st.cards.map((c: any) => [c.id, c.open]),
      [
        ["c2", false],
        ["c1", false],
      ],
    )
    assert.ok(show2)
  } finally {
    await app.stop()
  }
})

test("a background job shows 'working', then chimes and badges when it's done, without speaking", async () => {
  const config = testConfig()
  ;(config.jobs as any).claude.command[2] = "3000"
  const app = await FakeApp.start({
    config,
    script: [{ match: "ask claude", steps: [{ tool: "ask_claude", args: { task: "count the TODOs" } }, { tool: "speak", args: { text: "On it." } }] }],
  })
  try {
    await app.say("Vera, ask Claude to count the TODOs.")
    await app.waitFor(isCmd("speak"))
    // Speech ends, the follow-up window closes, and the job is still running (fake job: 3 s).
    await app.waitFor(isHud("working"), 5000)
    const m = app.mark
    const chime = await app.waitFor(isCmd("chime"), 5000, m)
    assert.equal((chime as any).kind, "notify")
    const badge = await app.waitFor(isCmd("badge"), 3000, m)
    assert.equal((badge as any).count, 1)
    await app.waitFor(isHud("idle"), 3000, m)
    assert.deepEqual(spoken(app.since(m)), [], "no unprompted talking")
    // The inbox digest rides on the next turn.
    await app.say("Vera, what's new?")
    await app.waitFor(isCmd("speak"), 5000, m)
    assert.match(app.brainLog().at(-1)!, /Fake result for: count the TODOs/)
  } finally {
    await app.stop()
  }
})

test("an inbox chime waits while Shawn is mid-sentence", async () => {
  const app = await FakeApp.start({ config: testConfig() })
  try {
    app.send({ type: "speech_start", t: Date.now() })
    await sleep(100)
    const m = app.mark
    await app.api("/api/notify", { title: "Test", summary: "x" })
    await sleep(300)
    assert.equal(app.since(m).filter(isCmd("chime")).length, 0)
    app.send({ type: "speech_cancel", reason: "noise" })
    const chime = await app.waitFor(isCmd("chime"), 2000, m)
    assert.equal((chime as any).kind, "notify")
  } finally {
    await app.stop()
  }
})

test("bare wake word chimes and opens the window; mic mute ignores speech", async () => {
  const app = await FakeApp.start({ config: testConfig(), script: [{ match: "time", steps: [{ tool: "speak", args: { text: "Noon." } }] }] })
  try {
    await app.say("Vera?")
    const chime = await app.waitFor(isCmd("chime"))
    assert.equal((chime as any).kind, "listening")
    await app.waitFor(isHud("listening"))
    const m = app.mark
    await app.say("What time is it?")
    await app.waitFor(isCmd("speak"), 5000, m)
    await app.waitFor(isHud("idle"), 6000, app.mark)

    app.send({ type: "ui", action: "mute" })
    await sleep(100)
    const m2 = app.mark
    await app.say("Vera, what time is it?")
    await sleep(500)
    assert.deepEqual(spoken(app.since(m2)), [])
    app.send({ type: "ui", action: "unmute" })
  } finally {
    await app.stop()
  }
})

test("POST /api/utterance works as a debug hook", async () => {
  const app = await FakeApp.start({ config: testConfig(), script: [{ match: "ping", steps: [{ tool: "speak", args: { text: "Pong." } }] }] })
  try {
    const r = await app.api("/api/utterance", { text: "ping", direct: true, wait: true })
    assert.equal(r.gate.action, "turn")
    assert.deepEqual(r.turn.spoken, ["Pong."])
    await app.waitFor((c) => c.cmd === "speak" && c.text === "Pong.")
  } finally {
    await app.stop()
  }
})

test("a new turn while the last one is still answering: the stale reply never plays, the new one does", async () => {
  const app = await FakeApp.start({
    config: testConfig(),
    autoPlay: false,
    script: [
      { match: "alps", steps: [{ sleep: 600 }, { tool: "speak", args: { text: "The Alps are in Europe." } }] },
      { match: "andes", steps: [{ tool: "speak", args: { text: "The Andes are in South America." } }] },
    ],
  })
  try {
    await app.say("Vera, tell me about the Alps.")
    await sleep(150)
    // He asks again before the first answer: the first turn is superseded.
    await app.say("Vera, actually tell me about the Andes.")
    const reply = (await app.waitFor((c) => c.cmd === "speak" && /Andes/.test(c.text), 5000)) as any
    await sleep(900) // past when the first turn would have spoken
    assert.deepEqual(spoken(app.since(0)), ["The Andes are in South America."], "the Alps reply is never sent")
    const msgs = app.brainLog()
    assert.match(msgs.at(-1)!, /before you finished answering/)
    app.send({ type: "playback", speak_id: reply.speak_id, state: "started" })
    app.send({ type: "playback", speak_id: reply.speak_id, state: "finished" })
  } finally {
    await app.stop()
  }
})

test("a reply still playing from an earlier turn is cut when a new turn begins", async () => {
  const app = await FakeApp.start({
    config: testConfig(),
    autoPlay: false,
    script: [
      { match: "long", steps: [{ tool: "speak", args: { text: "A long answer that is still playing." } }, { tool: "speak", args: { text: "And more of it." } }] },
      { match: "time", steps: [{ tool: "speak", args: { text: "Noon." } }] },
    ],
  })
  try {
    await app.say("Vera, give me a long answer.")
    const first = (await app.waitFor(isCmd("speak"))) as any
    app.send({ type: "playback", speak_id: first.speak_id, state: "started" })
    await app.waitFor(isHud("speaking"))
    await sleep(300) // the first turn is done; its speech plays on
    const m = app.mark
    await app.say("Vera, what time is it?")
    await app.waitFor(isCmd("stop_speaking"), 3000, m)
    const noon = (await app.waitFor((c) => c.cmd === "speak" && c.text === "Noon.", 3000, m)) as any
    assert.ok(app.cmds.indexOf(noon) > app.since(0).findIndex(isCmd("stop_speaking")))
    app.send({ type: "playback", speak_id: first.speak_id, state: "interrupted" }) // the App's late end
    await sleep(200)
    assert.deepEqual(spoken(app.since(m)), ["Noon."], "'And more of it.' never goes out")
  } finally {
    await app.stop()
  }
})

test("a brain error and a brain that never answers both reach the App as errors, and the next turn works", async () => {
  const app = await FakeApp.start({
    config: testConfig({ brain: { harness: "script", firstSpeakTimeoutSeconds: 1.5, turnTimeoutSeconds: 20 } }),
    script: [
      // First: a restarted brain's recap repeats the earlier lines.
      { match: "hello", steps: [{ tool: "speak", args: { text: "Hi." } }] },
      { match: "break", steps: [{ fail: "the model is overloaded" }] },
      { match: "hang", steps: [{ hang: true }] },
      { match: "deaf", steps: [{ hang: "deaf" }] },
    ],
  })
  try {
    let m = app.mark
    await app.say("Vera, break please.")
    const err = (await app.waitFor(isCmd("error"), 3000, m)) as any
    assert.equal(err.what, "brain")
    assert.match(err.message, /overloaded/)
    await app.waitFor(isHud("idle"), 4000, m)

    m = app.mark
    await app.say("Vera, hang on.")
    const timeout = (await app.waitFor(isCmd("error"), 5000, m)) as any
    assert.equal(timeout.what, "brain_timeout")
    await app.waitFor(isHud("idle"), 4000, m)

    m = app.mark
    await app.say("Vera, deaf one.")
    await app.waitFor(isCmd("error"), 5000, m)
    // A brain that ignores the interrupt is closed after 5 s; the turn ends.
    await app.waitFor(isHud("idle"), 9000, m)

    m = app.mark
    await app.say("Vera, hello.")
    const hi = (await app.waitFor(isCmd("speak"), 5000, m)) as any
    assert.equal(hi.text, "Hi.")
  } finally {
    await app.stop()
  }
})

test("'Vera, call yourself Nova': saved, the App is told, Nova wakes her and Vera doesn't, and the brain gets the new name", async () => {
  const app = await FakeApp.start({
    config: testConfig(),
    script: [
      // First: the restarted brain's recap repeats the earlier lines.
      { match: "what time", steps: [{ tool: "speak", args: { text: "Noon." } }] },
      { match: "call yourself", steps: [{ tool: "set_name", args: { name: "Nova" } }, { tool: "speak", args: { text: "Okay, I'm Nova." } }] },
    ],
  })
  try {
    await app.say("Vera, call yourself Nova.")
    const named = (await app.waitFor(isCmd("name"), 5000)) as any
    assert.equal(named.name, "Nova")
    await app.waitFor((c) => c.cmd === "speak" && c.text === "Okay, I'm Nova.", 5000)
    const cfg = JSON.parse(readFileSync(join(app.home, "config.json"), "utf8"))
    assert.equal(cfg.assistant.name, "Nova")
    await app.waitFor(isHud("idle"), 5000, app.mark)
    let m = app.mark
    await app.say("Vera, what time is it?")
    await sleep(800)
    assert.deepEqual(spoken(app.since(m)), [], "the old name no longer wakes her")
    m = app.mark
    await app.say("Nova, what time is it?")
    await app.waitFor((c) => c.cmd === "speak" && c.text === "Noon.", 5000, m)
    // The brain restarted with the prompt in her new name.
    assert.match(readFileSync(join(app.home, "brain", "script-brain.prompt.md"), "utf8"), /^You are Nova, /)
  } finally {
    await app.stop()
  }
})
