import { test } from "node:test"
import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join } from "node:path"
import { DEFAULT_CONFIG, resolveConfig } from "../src/config.ts"
import { packageFor } from "../src/models.ts"
import { resolveFfplay } from "../src/player.ts"

test("config merges over defaults and expands ~", () => {
  const c = resolveConfig({ voice: "bf_emma", player: { warm: 1 }, modelsDir: "~/.vera/m", speed: undefined })
  assert.equal(c.voice, "bf_emma")
  assert.equal(c.speed, DEFAULT_CONFIG.speed)
  assert.equal(c.player.warm, 1)
  assert.equal(c.modelsDir, homedir() + "/.vera/m")
  assert.equal(resolveConfig().modelsDir, join(homedir(), ".vera", "models"))
  assert.equal(resolveConfig().voice, "af_heart")
  assert.equal(resolveConfig().preset, "vera")
})

test("unknown voices fail with the list of voices", () => {
  assert.throws(() => packageFor("kokoro", "nobody"), /Unknown Kokoro voice/)
  assert.equal(packageFor("kokoro", "af_heart").name, "kokoro-multi-lang-v1_0")
  assert.equal(packageFor("piper", "en_GB-alba-medium").name, "vits-piper-en_GB-alba-medium")
})

test("ffplay resolves to a real executable, not a scoop shim", { skip: process.platform !== "win32" }, () => {
  const p = resolveFfplay()
  assert.doesNotMatch(p, /[\\/]shims[\\/]/i)
})
