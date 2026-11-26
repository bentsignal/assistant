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

test("stop phrases used after a barge-in", () => {
  for (const p of ["Stop.", "Never mind.", "Be quiet.", "Okay, stop.", "That's enough.", "Shh.", "Wait.", "Hold on."]) {
    assert.equal(isStopPhrase(p), true, p)
  }
  assert.equal(isStopPhrase("Wait, what about tomorrow?"), false)
})

test("another name: its exact word wakes anywhere, a near miss only first or last, Vera's list only for Vera", () => {
  const nova = { name: "Nova" }
  assert.deepEqual(stripWakeWord("Nova, what time is it?", nova), { found: true, text: "what time is it?" })
  assert.deepEqual(stripWakeWord("Hey Nova what's new", nova), { found: true, text: "what's new" })
  assert.deepEqual(stripWakeWord("what's the weather, Nova?", nova), { found: true, text: "what's the weather" })
  // One letter off, first or last: a likely mishearing.
  assert.equal(stripWakeWord("Noba, set a timer", nova).found, true)
  assert.equal(stripWakeWord("set a timer, Nopa", nova).found, true)
  // ...but not in the middle, and never a common word.
  assert.equal(stripWakeWord("the noba thing again", nova).found, false)
  assert.equal(stripWakeWord("now what", nova).found, false)
  // Vera no longer wakes her, nor do Vera's tuned mishearings.
  assert.equal(stripWakeWord("Vera, what time is it?", nova).found, false)
  assert.equal(stripWakeWord("Variable, what time is it?", nova).found, false)
  assert.equal(stripWakeWord("Hey there, what's up?", { ...nova, recentlyActive: true }).found, false)
  // A short name matches exactly only.
  assert.equal(stripWakeWord("Max, lights", { name: "Max" }).found, true)
  assert.equal(stripWakeWord("Mix, lights", { name: "Max" }).found, false)
  // Common words one letter off a name never wake her.
  assert.equal(stripWakeWord("Same, what time is it?", { name: "Sage" }).found, false)
  // Vera keeps today's behavior.
  assert.equal(stripWakeWord("Variable, what time is it?", { name: "Vera" }).found, true)
  assert.equal(gate({ text: "Nova, stop" }, closed, now, nova).action, "stop")
})

test("personas: any name wakes her and says which; Vera's mishearings stay Vera's; no cross-matches", () => {
  const names = ["Vera", "Alfred", "Jarvis", "Optimus", "Buzz", "Saul", "Tony"]
  const opts = { names }
  assert.deepEqual(stripWakeWord("Hey Alfred, what's for dinner?", opts), { found: true, name: "Alfred", text: "what's for dinner?", explicit: true })
  assert.deepEqual(stripWakeWord("what time is it, Jarvis?", opts), { found: true, name: "Jarvis", text: "what time is it", explicit: true })
  assert.deepEqual(stripWakeWord("Vara, set a timer", opts), { found: true, name: "Vera", text: "set a timer" })
  assert.deepEqual(stripWakeWord("Variable, what time is it?", opts), { found: true, soft: true, name: "Vera", text: "what time is it?" })
  assert.equal(stripWakeWord("Alfread, the news", opts).name, "Alfred", "a near miss names its persona")
  for (const t of ["it's tiny", "bless my soul", "fettuccine alfredo", "the onions are very hot"]) {
    assert.equal(stripWakeWord(t, opts).found, false, t)
  }
  const g = gate({ text: "Hey Jarvis, say hello" }, { followUpUntil: 0 }, now, opts)
  assert.deepEqual(g, { action: "turn", text: "say hello", via: "wake", persona: "Jarvis" })
  const f = gate({ text: "and the weather", start: now }, { followUpUntil: now + 1000 }, now, opts)
  assert.equal((f as any).persona, undefined, "a follow-up names nobody (the last persona answers)")
  // Mishearings wake her but name nobody: whoever answered last keeps answering.
  for (const t of ["Vara, set a timer", "Variable, what time is it?", "Alfread, the news"]) {
    const w = gate({ text: t }, { followUpUntil: 0 }, now, opts)
    assert.equal(w.action, "turn", t)
    assert.equal((w as any).persona, undefined, t)
  }
  const warm = gate({ text: "Hey there, what's next?" }, { followUpUntil: 0 }, now, { ...opts, recentlyActive: true })
  assert.equal(warm.action, "turn")
  assert.equal((warm as any).persona, undefined)
  assert.equal((gate({ text: "okay Optimus, report" }, { followUpUntil: 0 }, now, opts) as any).persona, "Optimus")
})
