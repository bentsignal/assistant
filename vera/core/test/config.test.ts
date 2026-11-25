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
