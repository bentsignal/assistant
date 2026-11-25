import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SystemPrompt } from "../src/prompt.ts"

function setup(text = "Be brief.\n") {
  const dir = mkdtempSync(join(tmpdir(), "assistant-prompt-"))
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

test("an unedited old stock prompt is upgraded (and revertible); appended rules carry over; custom prompts stay", () => {
  const old = "Old stock prompt.\nBe chatty.\n"
  const seed = "New stock prompt.\nBe brief.\n"
  const a = setup(old.replace(/\n/g, "\r\n"))
  assert.equal(a.prompt.upgradeSeed([old], seed), "upgraded")
  assert.equal(a.prompt.read(), seed)
  a.prompt.revert()
  assert.equal(a.prompt.read().replace(/\r\n/g, "\n"), old)

  const b = setup(old + "\nCall him chef.\n")
  assert.equal(b.prompt.upgradeSeed([old], seed), "upgraded")
  assert.equal(b.prompt.read(), seed + "\nCall him chef.\n")
  assert.equal(b.prompt.upgradeSeed([old], seed), "custom")

  const c = setup(seed)
  assert.equal(c.prompt.upgradeSeed([old], seed), "current")
  const d = setup("Old stock prompt.\nBe terse.\n")
  assert.equal(d.prompt.upgradeSeed([old], seed), "custom")
  assert.equal(d.prompt.read(), "Old stock prompt.\nBe terse.\n")
})

test("renderPrompt fills in her name; a prompt without the placeholder is used as written", async () => {
  const { renderPrompt } = await import("../src/prompt.ts")
  assert.equal(renderPrompt("You are {{name}}. {{ name }} is calm.", "Nova"), "You are Nova. Nova is calm.")
  assert.equal(renderPrompt("You are Vera.", "Nova"), "You are Vera.")
})
