import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SystemPrompt } from "../src/prompt.ts"

function setup(text = "Be brief.\n") {
  const dir = mkdtempSync(join(tmpdir(), "vera-prompt-"))
  const file = join(dir, "system-prompt.md")
  writeFileSync(file, text)
  return { dir, prompt: new SystemPrompt(file, join(dir, "prompt-history")) }
}

test("every edit backs up the previous text", () => {
  const { dir, prompt } = setup()
  prompt.edit({ append: "Call him chef." })
  assert.equal(prompt.read(), "Be brief.\n\nCall him chef.\n")
  prompt.edit({ find: "Be brief.", replace: "Be very brief." })
  assert.equal(prompt.read(), "Be very brief.\n\nCall him chef.\n")
  prompt.edit({ content: "New prompt.\n" })
  assert.equal(prompt.read(), "New prompt.\n")
  assert.equal(readdirSync(join(dir, "prompt-history")).length, 3)
  assert.equal(prompt.history().length, 3)
})

test("revert walks back one edit at a time", () => {
  const { prompt } = setup("v1")
  prompt.edit({ content: "v2" })
  prompt.edit({ content: "v3" })
  prompt.edit({ content: "v4" })
  prompt.revert()
  assert.equal(prompt.read(), "v3")
  prompt.revert()
  assert.equal(prompt.read(), "v2")
  prompt.revert()
  assert.equal(prompt.read(), "v1")
  assert.throws(() => prompt.revert(), /no earlier version/)
})

test("revert keeps the replaced text as a pre-revert backup", () => {
  const { dir, prompt } = setup("v1")
  prompt.edit({ content: "v2" })
  prompt.revert()
  const files = readdirSync(join(dir, "prompt-history"))
  assert.ok(files.some((f) => f.endsWith("-pre-revert.md")))
  assert.ok(files.some((f) => f.endsWith("-reverted.md")))
})

test("an edit after a revert can be reverted", () => {
  const { prompt } = setup("v1")
  prompt.edit({ content: "v2" })
  prompt.revert()
  prompt.edit({ content: "v3" })
  prompt.revert()
  assert.equal(prompt.read(), "v1")
})

test("bad edits are refused without a backup", () => {
  const { prompt } = setup("v1")
  assert.throws(() => prompt.edit({ find: "missing", replace: "x" }), /not in the system prompt/)
  assert.throws(() => prompt.edit({ content: "   " }), /empty/)
  assert.throws(() => prompt.edit({}), /give content/)
  assert.equal(prompt.history().length, 0)
  assert.equal(prompt.read(), "v1")
})

test("edits notify listeners (the brain restarts on change)", () => {
  const { prompt } = setup("v1")
  let n = 0
  prompt.onChange(() => n++)
  prompt.edit({ append: "x" })
  prompt.revert()
  assert.equal(n, 2)
})
