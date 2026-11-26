import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SEED_SKILLS, SkillStore, parseSkill, renderSkills, skillSlug, splitCommand } from "../src/skills.ts"
import { renderPrompt } from "../src/prompt.ts"

const store = () => new SkillStore(join(mkdtempSync(join(tmpdir(), "assistant-skills-")), "skills"))

test("a saved skill round-trips through its file, and an update keeps the fields left out", () => {
  const s = store()
  const { skill, created } = s.save({
    name: "Free Mail",
    description: "Read and summarize Shawn's email.",
    body: "- freemail list --unread\n- Config: ~/.config/freemail/config.toml",
    commands: ["freemail"],
  })
  assert.equal(created, true)
  assert.equal(skill.name, "free-mail")
  const text = readFileSync(join(s.dir, "free-mail.md"), "utf8")
  assert.match(text, /^---\nname: free-mail\ndescription: Read and summarize Shawn's email\.\ncommands: freemail\n---\n- freemail list/)
  assert.deepEqual(s.get("free mail")?.commands, ["freemail"])

  const again = s.save({ name: "free-mail", body: "- freemail list --unread --json" })
  assert.equal(again.created, false)
  const got = s.get("free-mail")!
  assert.equal(got.description, "Read and summarize Shawn's email.")
  assert.deepEqual(got.commands, ["freemail"])
  assert.equal(got.body, "- freemail list --unread --json")
})

test("a new skill needs a description and a body; odd names and program names are refused", () => {
  const s = store()
  assert.throws(() => s.save({ name: "x", body: "y" }), /description/)
  assert.throws(() => s.save({ name: "x", description: "y" }), /body/)
  assert.throws(() => s.save({ name: "!!!", description: "y", body: "z" }), /usable skill name/)
  assert.throws(() => s.save({ name: "x", description: "y", body: "z", commands: ["rm -rf / && echo"] }), /program name/)
  assert.equal(s.list().length, 0)
})

test("removing a skill keeps it in .removed", () => {
  const s = store()
  s.save({ name: "hue", description: "Hue lights.", body: "hue lights list", commands: ["hue"] })
  s.remove("hue")
  assert.equal(s.list().length, 0)
  assert.equal(readdirSync(join(s.dir, ".removed")).length, 1)
  assert.throws(() => s.remove("hue"), /no skill/)
})

test("seed skills are written once; a removed seed stays removed; an edited one is never overwritten", () => {
  const s = store()
  assert.deepEqual(s.seed(), ["shawns-preferences"])
  const prefs = s.get("shawns-preferences")!
  assert.match(prefs.body, /bentsignal/)
  assert.match(prefs.body, /ask_codex/)
  assert.match(prefs.body, /ask_grok/)
  writeFileSync(prefs.file, readFileSync(prefs.file, "utf8") + "\n- Use tabs.\n")
  assert.deepEqual(s.seed(), [])
  assert.match(s.get("shawns-preferences")!.body, /Use tabs/)
  s.remove("shawns-preferences")
  assert.deepEqual(s.seed(), [])
  assert.equal(existsSync(join(s.dir, "shawns-preferences.md")), false)
  assert.ok(SEED_SKILLS.length >= 1)
})

test("run_command's allowlist: only programs a skill declares, with or without .exe or a path", () => {
  const s = store()
  s.save({ name: "free-mail", description: "Mail.", body: "freemail list", commands: ["freemail", "C:\\tools\\hue.exe"] })
  assert.equal(s.allowing("freemail")?.name, "free-mail")
  assert.equal(s.allowing("FreeMail.exe")?.name, "free-mail")
  assert.equal(s.allowing("hue")?.name, "free-mail")
  assert.equal(s.allowing("C:\\tools\\hue.exe")?.name, "free-mail")
  assert.equal(s.allowing("powershell"), undefined)
  assert.equal(s.allowing("cmd"), undefined)
})

test("changes notify listeners once, including files written from outside (a setup job)", () => {
  const s = store()
  let n = 0
  s.onChange(() => n++)
  s.save({ name: "a", description: "A.", body: "a" })
  assert.equal(n, 1)
  assert.equal(s.check(), false)
  writeFileSync(join(s.dir, "outside.md"), "---\nname: outside\ndescription: Written by a job.\ncommands: hostname\n---\nhostname prints the name.\n")
  assert.equal(s.check(), true)
  assert.equal(n, 2)
  assert.equal(s.check(), false)
  assert.equal(s.allowing("hostname")?.name, "outside")
})

test("a file without front matter still reads as a skill", () => {
  const sk = parseSkill("Turn the kettle on with kettle on.\n", "C:\\x\\kettle.md")
  assert.equal(sk.name, "kettle")
  assert.equal(sk.description, "Turn the kettle on with kettle on.")
  assert.deepEqual(sk.commands, [])
})

test("skills render into the prompt: in full under the budget, one line each past it", () => {
  const s = store()
  s.save({ name: "small", description: "Small one.", body: "short body", commands: ["small"] })
  s.save({ name: "zz-big", description: "Big one.", body: "x".repeat(5000) })
  const full = renderSkills(s.list())
  assert.match(full, /^# Your skills/)
  assert.match(full, /## small\nSmall one\.\n\(run_command may run: small\)\n\nshort body/)
  assert.match(full, /## zz-big/)
  const tight = renderSkills(s.list(), 200)
  assert.match(tight, /## small/)
  assert.doesNotMatch(tight, /x{100}/)
  assert.match(tight, /- zz-big: Big one\. \(skill_read/)
  assert.match(renderSkills([]), /None yet/)
})

test("renderPrompt puts skills at {{skills}}, or at the end of a prompt without it (edited or custom)", () => {
  const skills = "# Your skills\n\n## hue\nLights."
  assert.equal(renderPrompt("You are {{name}}.\n\n{{skills}}\n\nBe brief.", "Vera", [], skills), `You are Vera.\n\n${skills}\n\nBe brief.`)
  assert.equal(renderPrompt("You are Vera.\n", "Vera", [], skills), `You are Vera.\n\n${skills}\n`)
  assert.equal(renderPrompt("A {{skills}} B", "Vera"), "A  B")
  // `$&` in a skill must not be read as a replacement pattern.
  assert.equal(renderPrompt("{{skills}}", "Vera", [], "cost $& more"), "cost $& more")
})

test("the stock prompt carries the skills slot and the T3 and figure-it-out rules", () => {
  const stock = readFileSync(join(import.meta.dirname, "..", "prompts", "system.md"), "utf8")
  assert.match(stock, /\{\{skills\}\}/)
  assert.match(stock, /# Figure it out/)
  assert.match(stock, /full access in T3 Code/)
  assert.match(stock, /never tell him to do it himself/)
  const s = store()
  s.seed()
  const rendered = renderPrompt(stock, "Vera", [], s.render())
  assert.match(rendered, /## shawns-preferences/)
  assert.doesNotMatch(rendered, /\{\{skills\}\}/)
})

test("skill names and command lines", () => {
  assert.equal(skillSlug("Free Mail CLI"), "free-mail-cli")
  assert.equal(skillSlug("  Philips Hue!  "), "philips-hue")
  assert.deepEqual(splitCommand(`freemail list --from "Mom and Dad" --limit 5`), ["freemail", "list", "--from", "Mom and Dad", "--limit", "5"])
  assert.deepEqual(splitCommand(`hue set 'Kitchen' ""`), ["hue", "set", "Kitchen", ""])
  assert.deepEqual(splitCommand("a | b && c"), ["a", "|", "b", "&&", "c"])
  assert.throws(() => splitCommand(`a "b`), /unclosed/)
})
