import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_CONFIG, merge } from "../src/config.ts"

test("defaults: Vera's volume starts at the App's default level, 0.7", () => {
  assert.equal(DEFAULT_CONFIG.voice.defaultVolume, 0.7)
})

test("defaults have no v1 standalone keys", () => {
  for (const key of ["ears", "mouth", "panel"]) assert.equal(key in DEFAULT_CONFIG, false, key)
})

test("merge: objects merge, arrays and values replace, unknown keys stay", () => {
  const got = merge(DEFAULT_CONFIG, { wake: { followUpSeconds: 3, words: ["vee"] }, app: { volume: 0.4 } }) as any
  assert.equal(got.wake.followUpSeconds, 3)
  assert.deepEqual(got.wake.words, ["vee"])
  assert.equal(got.wake.soft, DEFAULT_CONFIG.wake.soft)
  assert.equal(got.app.volume, 0.4)
  assert.equal(got.voice.defaultVolume, 0.7)
})

test("personas: wake settings are kept and cleaned; defaults are hey <name>, on, no name alone", async () => {
  const { personasOf, wakePhrasesOf, isEnabled, validPhrase } = await import("../src/config.ts")
  const { renamedPersona } = await import("../src/assistant.ts")
  const old = personasOf({ assistant: { name: "Vera", personas: [{ name: "Vera", voice: "isla" }, { name: "Tony", voice: "tony" }] } } as any)
  // An install from before wake phrases: every persona moves to "hey <name>", name alone off.
  assert.deepEqual(old.map((p) => [wakePhrasesOf(p), isEnabled(p), !!p.bareName]), [[["hey Vera"], true, false], [["hey Tony"], true, false]])
  const list = personasOf({ assistant: { name: "Vera", personas: [{ name: "Vera", voice: "isla", bareName: true }, { name: "Tony", voice: "tony", enabled: false, wakePhrases: ["hey Tony", "  yo,  Tony! ", "hey Tony", 3, ""] }] } } as any)
  assert.equal(list[0].bareName, true)
  assert.equal(isEnabled(list[1]), false)
  assert.deepEqual(list[1].wakePhrases, ["hey Tony", "yo Tony"])
  assert.equal(validPhrase("one two three four five six"), null)
  assert.deepEqual(renamedPersona(list[1], "Rex").wakePhrases, ["hey Rex", "yo Rex"])
  assert.equal(renamedPersona(list[0], "Nova").wakePhrases, undefined, "default phrases follow the name by themselves")
})
