import { test } from "node:test"
import assert from "node:assert/strict"
import { DEFAULT_CONFIG, earsCandidates, merge, resolveEarsCommand } from "../src/config.ts"
import { existsSync } from "node:fs"
import { sep } from "node:path"

const ears = (over: object) => merge(DEFAULT_CONFIG.ears, over)

test("ears: null and [] mean no microphone", () => {
  assert.equal(resolveEarsCommand(ears({ command: null })).argv, null)
  assert.equal(resolveEarsCommand(ears({ command: [] })).argv, null)
})

test("ears: an explicit argv is used as is", () => {
  assert.deepEqual(resolveEarsCommand(ears({ command: ["node", "fake-ears.mjs"] })).argv, ["node", "fake-ears.mjs"])
})

test("ears: auto finds the repo's hex.exe or says how to build it", () => {
  const r = resolveEarsCommand(ears({ command: "auto", args: ["--device", "Headset"] }))
  const built = earsCandidates().find((p) => existsSync(p))
  if (built) assert.deepEqual(r.argv, [built, "ears", "--device", "Headset"])
  else {
    assert.equal(r.argv, null)
    assert.match(r.note, /vera-ears-build\.sh/)
  }
  assert.ok(earsCandidates()[0].split(sep).join("/").includes("/target/release/hex"))
})
