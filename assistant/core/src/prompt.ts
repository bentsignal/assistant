import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Persona } from "./config.ts"

/**
 * The brain's system prompt, editable by voice. Every edit backs up the
 * previous text to the history folder first, so it can be reverted.
 *
 * History files are `<stamp>-<seq>-edit.md` (the text before an edit). A
 * revert restores the newest `-edit.md`, renames it `-reverted.md` so the
 * next revert walks one step further back, and saves the text it replaced
 * as `-pre-revert.md` (kept for safety, never restored automatically).
 */
/**
 * The prompt as the brain gets it: `{{name}}` is her name. A prompt without it works as written.
 * `skills` (her skills, rendered) goes where `{{skills}}` is, else at the end, so a custom or
 * edited prompt still gets them.
 */
export function renderPrompt(text: string, name: string, personas: Persona[] = [], skills?: string): string {
  const out = text
    .replace(/\{\{\s*name\s*\}\}/g, name)
    .replace(/\{\{\s*personas\s*\}\}/g, describePersonas(personas.length ? personas : [{ name, voice: "" }]))
  const slot = /\{\{\s*skills\s*\}\}/g
  if (skills === undefined) return out.replace(slot, "")
  if (/\{\{\s*skills\s*\}\}/.test(out)) return out.replace(slot, () => skills)
  return out.replace(/\s*$/, "\n\n") + skills + "\n"
}

/** One line per persona for the prompt: "- Alfred (voice alfred): a dry, courteous English butler". */
export function describePersonas(personas: Persona[]): string {
  return personas
    .map((p) => `- ${p.name}${p.voice ? ` (voice ${p.voice})` : ""}${p.style ? `: ${p.style}` : ""}`)
    .join("\n")
}

export class SystemPrompt {
  private listeners = new Set<() => void>()
  private seq = 0
  /** The text as last seen, so a change from outside (Settings) is noticed once. */
  private seen: string | null = null
  private watching = false

  constructor(
    readonly file: string,
    readonly historyDir: string,
  ) {
    mkdirSync(historyDir, { recursive: true })
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /**
   * Notice edits made outside Core (the App's Settings writes the file
   * directly): each one applies like an `edit`, from the next turn.
   */
  watch(intervalMs = 500): void {
    if (this.watching) return
    this.watching = true
    this.seen = this.read()
    watchFile(this.file, { interval: intervalMs, persistent: false }, () => this.check())
  }

  unwatch(): void {
    if (!this.watching) return
    this.watching = false
    unwatchFile(this.file)
  }

  /** Emits a change when the file's text differs from what was last seen. True when it did. */
  check(): boolean {
    const now = this.read()
    if (this.seen === null) {
      this.seen = now
      return false
    }
    if (now === this.seen) return false
    this.emit()
    return true
  }

  read(): string {
    return existsSync(this.file) ? readFileSync(this.file, "utf8").replace(/^﻿/, "") : ""
  }

  private backup(text: string, kind: "edit" | "pre-revert"): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    // seq keeps ordering stable for edits in the same millisecond
    const name = `${stamp}-${String(++this.seq).padStart(4, "0")}-${kind}.md`
    writeFileSync(join(this.historyDir, name), text)
    return name
  }

  /**
   * Edit the prompt. Exactly one of: `content` (full replacement), `find` +
   * `replace`, or `append`.
   */
  edit(change: { content?: string; find?: string; replace?: string; append?: string }): { backup: string; text: string } {
    const before = this.read()
    let after: string
    if (typeof change.content === "string") after = change.content
    else if (typeof change.find === "string") {
      if (!before.includes(change.find)) throw new Error("find text not in the system prompt")
      after = before.replace(change.find, change.replace ?? "")
    } else if (typeof change.append === "string") after = before.replace(/\s*$/, "\n\n") + change.append.trim() + "\n"
    else throw new Error("give content, find+replace, or append")
    if (!after.trim()) throw new Error("refusing to write an empty system prompt")
    const backup = this.backup(before, "edit")
    writeFileSync(this.file, after)
    this.emit()
    return { backup, text: after }
  }

  /**
   * Move an unedited (or only appended-to) copy of an older seed prompt to
   * the current seed. The old text is backed up as an edit, so
   * `revert_system_prompt` brings it back. A prompt Shawn changed in the
   * middle is left alone. Returns what happened, for the log.
   */
  upgradeSeed(previousSeeds: string[], seed: string): "upgraded" | "current" | "custom" {
    const norm = (t: string) => t.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "")
    const now = norm(this.read())
    if (now.trim() === norm(seed).trim()) return "current"
    for (const old of previousSeeds.map(norm)) {
      if (!old.trim() || !now.startsWith(old.trimEnd())) continue
      const added = now.slice(old.trimEnd().length).trim()
      this.backup(now, "edit")
      writeFileSync(this.file, norm(seed).trimEnd() + "\n" + (added ? "\n" + added + "\n" : ""))
      this.emit()
      return "upgraded"
    }
    return "custom"
  }

  /** Edits that can still be reverted, newest first. */
  history(): string[] {
    return readdirSync(this.historyDir)
      .filter((f) => f.endsWith("-edit.md"))
      .sort()
      .reverse()
  }

  revert(): { restored: string; text: string } {
    const [newest] = this.history()
    if (!newest) throw new Error("no earlier version to revert to")
    const path = join(this.historyDir, newest)
    const text = readFileSync(path, "utf8")
    this.backup(this.read(), "pre-revert")
    writeFileSync(this.file, text)
    renameSync(path, path.replace(/-edit\.md$/, "-reverted.md"))
    this.emit()
    return { restored: newest, text }
  }

  private emit() {
    this.seen = this.read()
    for (const l of this.listeners) l()
  }
}
