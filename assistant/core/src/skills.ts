import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

/**
 * Her skills: what she has learned to do, one Markdown file each in
 * `~/.assistant/skills/<name>.md`, outside the repo and the prompt, so app
 * updates and prompt edits never touch them. Every skill is put into the
 * brain's system prompt (see `renderSkills`), and a change to any of them
 * restarts the brain before the next turn, as a prompt edit does.
 *
 * A skill file:
 *
 *   ---
 *   name: free-mail
 *   description: Read and summarize Shawn's email with the Free Mail CLI.
 *   commands: freemail
 *   ---
 *   (what it's for, the exact commands, where its config and auth live)
 *
 * `commands` lists the programs `run_command` may run for this skill (the
 * brain has no shell of its own). `interactive` (optional) lists command
 * lines that wait on Shawn, like `freemail auth login` (a prefix matches),
 * or `true` for all of them: those run detached at once (`commands.ts`). Removing a skill moves it to
 * `skills/.removed/`, so a mistake can be undone by hand; a seeded skill
 * that was removed is never seeded again.
 */
export interface Skill {
  name: string
  description: string
  /** Programs `run_command` may run for this skill, like `freemail` or `hue`. */
  commands: string[]
  /** Command lines that wait on Shawn (a browser login): run detached at once. "*" is every command. */
  interactive?: string[]
  body: string
  file: string
}

/** Skills Core writes once, when missing. Shawn (or she) can edit or remove them. */
export const SEED_SKILLS: Omit<Skill, "file">[] = [
  {
    name: "shawns-preferences",
    description: "How Shawn likes things done: where new projects, coding, computer use and searches go.",
    commands: [],
    body: `- New software projects: a GitHub repo under bentsignal (private unless he says otherwise), a T3 project for it, and the work itself in T3 threads. Create the repo through a T3 thread or a job (gh repo create bentsignal/<name> --private), register the folder with t3_tool t3_project_create (or t3_project_clone), then start a thread there.
- Coding, in any project: T3 threads (t3_start_thread, t3_send, or t3_tool t3_thread_launch with runtimeMode full-access). Not ask_claude, except for a quick one-off question or a tiny edit.
- Anything about you (Assistant, Vera) or this project: the orchestrator thread with send_feedback, or a T3 thread in the assistant project.
- Computer use (desktop apps, clicking, driving a browser to do something): ask_codex.
- Searching X/Twitter, or what people are saying right now: ask_grok (the Grok CLI).
- General web lookups: your own web search, directly.
- His machines: Winserve (environment 573af78b-3442-4163-8b9b-bc5cb90eefde, his development server, where the orchestrator thread lives), GamerBox (his desktop, where you run), and airshawn (his laptop). Look projects and threads up yourself with the T3 tools on each.
- He'd rather you work it out than ask: ask a short question only when it's truly ambiguous.`,
  },
]

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/

/** "Free Mail CLI" -> "free-mail-cli". */
export function skillSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "")
  if (!NAME.test(slug)) throw new Error(`"${name}" isn't a usable skill name`)
  return slug
}

export function parseSkill(text: string, file: string): Skill {
  const norm = text.replace(/^﻿/, "").replace(/\r\n/g, "\n")
  const m = norm.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  const meta: Record<string, string> = {}
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/)
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "")
    }
  }
  const body = (m ? m[2] : norm).trim()
  return {
    name: meta.name || basename(file, ".md"),
    description: meta.description || body.split("\n")[0].slice(0, 200),
    commands: (meta.commands ?? "")
      .replace(/^\[|\]$/g, "")
      .split(/[,\s]+/)
      .map((c) => c.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean),
    ...(parseInteractive(meta.interactive) ? { interactive: parseInteractive(meta.interactive) } : {}),
    body,
    file,
  }
}

function parseInteractive(v: string | undefined): string[] | undefined {
  const t = (v ?? "").trim().replace(/^\[|\]$/g, "")
  if (!t || /^(false|no|none)$/i.test(t)) return undefined
  if (/^(true|yes|all|\*)$/i.test(t)) return ["*"]
  const list = t.split(",").map((c) => c.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
  return list.length ? list : undefined
}

/** Whether `argv` is one of the skill's interactive command lines (it waits on Shawn). */
export function isInteractive(skill: Pick<Skill, "interactive">, argv: string[]): boolean {
  const list = skill.interactive ?? []
  if (list.includes("*")) return true
  const norm = (p: string) => basename(p.trim().toLowerCase()).replace(/\.(exe|cmd|bat|ps1)$/, "")
  const line = [norm(argv[0] ?? ""), ...argv.slice(1).map((a) => a.toLowerCase())].join(" ")
  return list.some((c) => {
    const [prog, ...rest] = c.trim().toLowerCase().split(/\s+/)
    const want = [norm(prog), ...rest].join(" ")
    return line === want || line.startsWith(want + " ")
  })
}

export function formatSkill(s: Omit<Skill, "file">): string {
  const oneLine = (t: string) => t.replace(/\s+/g, " ").trim()
  const interactive = s.interactive?.length ? `interactive: ${s.interactive.includes("*") ? "true" : s.interactive.join(", ")}\n` : ""
  return `---\nname: ${s.name}\ndescription: ${oneLine(s.description)}\ncommands: ${s.commands.join(", ")}\n${interactive}---\n${s.body.trim()}\n`
}

/** The prompt section: every skill in full, until the budget runs out; after that, one line each. */
export function renderSkills(skills: Skill[], budget = 16_000): string {
  if (!skills.length) {
    return "# Your skills\n\nNone yet. When Shawn asks you to set something up so you can use it, do it and save it as a skill (see Skills above)."
  }
  const parts: string[] = []
  let used = 0
  const short: string[] = []
  for (const s of skills) {
    const runs = s.commands.length ? `\n(run_command may run: ${s.commands.join(", ")})` : ""
    const full = `## ${s.name}\n${s.description}${runs}\n\n${s.body}`
    if (used + full.length <= budget) {
      parts.push(full)
      used += full.length
    } else short.push(`- ${s.name}: ${s.description} (skill_read for the details)`)
  }
  return [
    "# Your skills",
    "",
    "What you've set up and learned, saved in ~/.assistant/skills. Use them without being reminded.",
    "",
    parts.join("\n\n"),
    ...(short.length ? ["", "More skills (read one with skill_read before using it):", ...short] : []),
  ].join("\n")
}

export class SkillStore {
  private listeners = new Set<() => void>()
  private signature = ""

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
    this.signature = this.sign()
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Writes the seed skills that were never written (a removed one stays removed). */
  seed(seeds = SEED_SKILLS): string[] {
    const ledgerFile = join(this.dir, ".seeded.json")
    let ledger: string[] = []
    try {
      ledger = JSON.parse(readFileSync(ledgerFile, "utf8"))
    } catch {}
    const added: string[] = []
    for (const s of seeds) {
      if (ledger.includes(s.name)) continue
      const file = join(this.dir, `${s.name}.md`)
      if (!existsSync(file)) {
        writeFileSync(file, formatSkill(s))
        added.push(s.name)
      }
      ledger.push(s.name)
    }
    writeFileSync(ledgerFile, JSON.stringify(ledger, null, 1))
    if (added.length) this.check()
    return added
  }

  list(): Skill[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => {
        try {
          return parseSkill(readFileSync(join(this.dir, f), "utf8"), join(this.dir, f))
        } catch {
          return null
        }
      })
      .filter((s): s is Skill => !!s)
  }

  get(name: string): Skill | undefined {
    const all = this.list()
    const q = name.trim().toLowerCase()
    let slug = q
    try {
      slug = skillSlug(name)
    } catch {}
    return all.find((s) => s.name.toLowerCase() === q || basename(s.file, ".md") === slug) ?? all.find((s) => s.name.toLowerCase().includes(q))
  }

  /** Creates or replaces a skill. Fields left out keep an existing skill's values. */
  save(input: { name: string; description?: string; body?: string; commands?: string[]; interactive?: string[] }): { skill: Skill; created: boolean } {
    const slug = skillSlug(input.name)
    const file = join(this.dir, `${slug}.md`)
    const old = existsSync(file) ? parseSkill(readFileSync(file, "utf8"), file) : undefined
    const description = input.description?.trim() || old?.description
    const body = input.body?.trim() || old?.body
    if (!description) throw new Error("a new skill needs a description: what it's for, in a sentence")
    if (!body) throw new Error("a new skill needs a body: the exact commands, and where its config and auth live")
    const commands = (input.commands ?? old?.commands ?? []).map((c) => c.trim()).filter(Boolean)
    for (const c of commands) if (!/^[\w.\-\\/: ]+$/.test(c)) throw new Error(`"${c}" isn't a program name`)
    const interactive = (input.interactive ?? old?.interactive ?? []).map((c) => c.trim()).filter(Boolean)
    const skill = { name: slug, description, body, commands, ...(interactive.length ? { interactive } : {}) }
    writeFileSync(file, formatSkill(skill))
    this.check()
    return { skill: { ...skill, file }, created: !old }
  }

  /** Moves a skill to skills/.removed (kept, not deleted). */
  remove(name: string): Skill {
    const s = this.get(name)
    if (!s) throw new Error(`no skill called ${name}`)
    const trash = join(this.dir, ".removed")
    mkdirSync(trash, { recursive: true })
    const dest = join(trash, `${basename(s.file, ".md")}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`)
    try {
      renameSync(s.file, dest)
    } catch {
      writeFileSync(dest, readFileSync(s.file))
      unlinkSync(s.file)
    }
    this.check()
    return s
  }

  /** The skill that lets `run_command` run `program`, if any. */
  allowing(program: string): Skill | undefined {
    const norm = (p: string) => basename(p.trim().toLowerCase()).replace(/\.(exe|cmd|bat|ps1)$/, "")
    const want = norm(program)
    return this.list().find((s) => s.commands.some((c) => c.trim().toLowerCase() === program.trim().toLowerCase() || norm(c) === want))
  }

  render(budget?: number): string {
    return renderSkills(this.list(), budget)
  }

  /** Notices files changed from outside (a setup job writes its skill itself). True when something changed. */
  check(): boolean {
    const now = this.sign()
    if (now === this.signature) return false
    this.signature = now
    for (const l of this.listeners) l()
    return true
  }

  private sign(): string {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => {
          const st = statSync(join(this.dir, f))
          return `${f}:${st.size}:${st.mtimeMs}`
        })
        .join("|")
    } catch {
      return ""
    }
  }
}

/**
 * Splits a command line into argv, honouring double and single quotes. No
 * shell: pipes, redirects and `&&` are plain arguments.
 */
export function splitCommand(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let quote: string | null = null
  let any = false
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      any = true
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur)
      cur = ""
      any = false
    } else cur += ch
  }
  if (quote) throw new Error("unclosed quote in the command")
  if (cur || any) out.push(cur)
  return out
}
