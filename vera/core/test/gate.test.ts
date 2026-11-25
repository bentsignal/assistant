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
