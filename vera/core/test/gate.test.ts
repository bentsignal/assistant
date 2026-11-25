import { test } from "node:test"
import assert from "node:assert/strict"
import { gate, isStopPhrase, isWakeWord, stripWakeWord } from "../src/gate.ts"

const closed = { followUpUntil: 0 }
const now = 1_000_000

test("wake word variants match, common words don't", () => {
  for (const w of ["Vera", "vera,", "Vara", "vira", "Bera", "Veera", "Viera", "Verra", "Verah", "Vera's", "VERA!"]) {
    assert.ok(isWakeWord(w), w)
  }
  for (const w of ["very", "were", "era", "veranda", "for", "verb", "bear", "where", "vary"]) {
    assert.ok(!isWakeWord(w), w)
  }
  assert.ok(isWakeWord("vela", ["vela"]), "extra words from config")
})

test("leading wake word and fillers are stripped", () => {
  assert.deepEqual(stripWakeWord("Vera, what time is it?"), { found: true, text: "what time is it?" })
  assert.deepEqual(stripWakeWord("Hey Vera what's new"), { found: true, text: "what's new" })
  assert.deepEqual(stripWakeWord("okay, vara: set a timer"), { found: true, text: "set a timer" })
  assert.deepEqual(stripWakeWord("what's the weather, Vera?"), { found: true, text: "what's the weather" })
  // In the middle: keep the sentence as said
  assert.deepEqual(stripWakeWord("can you tell Vera's thread to stop"), { found: true, text: "can you tell Vera's thread to stop" })
  assert.equal(stripWakeWord("the onions are very hot").found, false)
})

test("gate: no wake word and no window is ignored", () => {
  assert.equal(gate({ text: "pass me the salt" }, closed, now).action, "ignore")
  assert.equal(gate({ text: "   " }, closed, now).action, "ignore")
})

test("gate: wake word starts a turn", () => {
  assert.deepEqual(gate({ text: "Vera, how long do I boil eggs?" }, closed, now), {
    action: "turn",
    text: "how long do I boil eggs?",
    via: "wake",
  })
})

test("gate: follow-up window uses the speech start time", () => {
  const open = { followUpUntil: now + 5000 }
  assert.deepEqual(gate({ text: "and for soft boiled?" }, open, now), { action: "turn", text: "and for soft boiled?", via: "followup" })
  // Speech that started inside the window still counts even if it was transcribed after it closed.
  assert.equal(gate({ text: "and for soft boiled?", start: now + 4000 }, open, now + 9000).action, "turn")
  assert.equal(gate({ text: "and for soft boiled?", start: now + 6000 }, open, now + 9000).action, "ignore")
})

test("gate: direct bypasses the wake word", () => {
  assert.deepEqual(gate({ text: "list my projects", direct: true }, closed, now), { action: "turn", text: "list my projects", via: "direct" })
})

test("gate: bare wake word just wakes", () => {
  assert.equal(gate({ text: "Vera." }, closed, now).action, "wake")
  assert.equal(gate({ text: "hey vera" }, closed, now).action, "wake")
})

test("gate: stop phrases", () => {
  for (const t of ["Vera, stop.", "Vera never mind", "Vera, stop talking", "hey Vera, cancel that", "Vera, okay stop"]) {
    assert.equal(gate({ text: t }, closed, now).action, "stop", t)
  }
  assert.equal(gate({ text: "never mind", direct: true }, closed, now).action, "stop")
  assert.equal(gate({ text: "never mind" }, { followUpUntil: now + 1000 }, now).action, "stop")
  // Not a stop: a real request that mentions stopping
  assert.equal(gate({ text: "Vera, stop the codex job" }, closed, now).action, "turn")
  assert.ok(isStopPhrase("Stop please"))
  assert.ok(!isStopPhrase("stop the timer"))
})

test("soft wake words: misheard Vera counts only as a leading vocative", () => {
  for (const t of ["Variable, what time is it?", "Mirror, set a timer for ten minutes.", "Sarah, what's new?", "Okay Sarah, what's new?"]) {
    const g = gate({ text: t }, closed, now)
    assert.equal(g.action, "turn", t)
  }
  assert.deepEqual(gate({ text: "Variable, what time is it?" }, closed, now), { action: "turn", text: "what time is it?", via: "wake" })
  assert.equal(gate({ text: "Sarah?" }, closed, now).action, "wake")
  for (const t of ["Variable names should be short.", "I told Sarah about it.", "Mirror the window on the left", "the mirror is foggy"]) {
    assert.equal(gate({ text: t }, closed, now).action, "ignore", t)
  }
  assert.equal(gate({ text: "Sarah, what's new?" }, closed, now, { soft: false }).action, "ignore")
})

test("warm wake words: greetings misheard for Hey Vera need a recent interaction", () => {
  for (const t of ["Hey there, what time is it?", "Okay there, what's new?", "Hey girl, set a timer."]) {
    assert.equal(gate({ text: t }, closed, now).action, "ignore", t)
    assert.equal(gate({ text: t }, closed, now, { recentlyActive: true }).action, "turn", t)
  }
  assert.deepEqual(gate({ text: "Hey there, what time is it?" }, closed, now, { recentlyActive: true }), {
    action: "turn",
    text: "what time is it?",
    via: "wake",
  })
  // Not as a vocative: still ignored.
  assert.equal(gate({ text: "hey there is a problem" }, closed, now, { recentlyActive: true }).action, "ignore")
})

test("hangers-on after the wake word are dropped", () => {
  assert.deepEqual(gate({ text: "Vera of what time is it?" }, closed, now), { action: "turn", text: "what time is it?", via: "wake" })
  assert.deepEqual(gate({ text: "Vera, uh, set a timer" }, closed, now), { action: "turn", text: "set a timer", via: "wake" })
})

test("barge-in: wake word + stop that Vera isn't saying", async () => {
  const { findBargeIn } = await import("../src/gate.ts")
  assert.equal(findBargeIn("Vera, stop.", "It's eleven forty two."), "vera stop")
  assert.equal(findBargeIn("eleven forty Vera stop two", "It's eleven forty two."), "vera stop")
  assert.equal(findBargeIn("Hey Vera, be quiet", "The pasta needs ten more minutes."), "vera be quiet")
  assert.equal(findBargeIn("Vera okay stop", "Sure."), "vera stop")
  // Her own words don't stop her.
  assert.equal(findBargeIn("Tell Vera to stop the timer", "I'll tell Vera to stop the timer."), null)
  assert.equal(findBargeIn("it's eleven forty two", "It's eleven forty two."), null)
  assert.equal(findBargeIn("stop", "Okay."), null, "needs the wake word")
  assert.equal(findBargeIn("Sarah, stop", "Okay."), null, "soft wake words don't barge in")
})
