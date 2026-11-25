import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The brain's system prompt, editable by voice. Every edit backs up the
 * previous text to the history folder first, so it can be reverted.
 *
 * History files are `<stamp>-<seq>-edit.md` (the text before an edit). A
 * revert restores the newest `-edit.md`, renames it `-reverted.md` so the
 * next revert walks one step further back, and saves the text it replaced
 * as `-pre-revert.md` (kept for safety, never restored automatically).
 */
export class SystemPrompt {
  private listeners = new Set<() => void>()
  private seq = 0

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
    for (const l of this.listeners) l()
  }
}
