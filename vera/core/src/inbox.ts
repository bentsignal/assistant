import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs"

export type InboxKind = "job" | "t3" | "system"

export interface InboxItem {
  id: string
  kind: InboxKind
  title: string
  /** Short text for the digest. */
  summary: string
  /** Job id or T3 thread id this is about. */
  ref?: string
  createdAt: number
  /** Shown to the brain in a turn digest. */
  delivered: boolean
  /** Shawn has heard/seen it (the brain read it out). */
  read: boolean
}

/**
 * The inbox: background results that arrive with a chime, not speech.
 * New items are handed to the brain once, as a digest in front of the next
 * user turn. Persisted to a JSON file so a restart keeps them.
 */
export class Inbox {
  items: InboxItem[] = []
  private seq = 0
  private listeners = new Set<(items: InboxItem[]) => void>()

  constructor(
    private file: string | null,
    private limit = 200,
  ) {
    if (file && existsSync(file)) {
      try {
        this.items = JSON.parse(readFileSync(file, "utf8"))
        this.seq = this.items.reduce((m, i) => Math.max(m, Number(i.id.replace(/\D/g, "")) || 0), 0)
      } catch {
        this.items = []
      }
    }
  }

  onChange(cb: (items: InboxItem[]) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  add(item: Omit<InboxItem, "id" | "createdAt" | "delivered" | "read"> & { createdAt?: number }): InboxItem {
    const full: InboxItem = {
      id: `i${++this.seq}`,
      createdAt: item.createdAt ?? Date.now(),
      delivered: false,
      read: false,
      kind: item.kind,
      title: item.title,
      summary: item.summary,
      ref: item.ref,
    }
    this.items.push(full)
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit)
    this.changed()
    return full
  }

  undelivered(): InboxItem[] {
    return this.items.filter((i) => !i.delivered)
  }

  unread(): InboxItem[] {
    return this.items.filter((i) => !i.read)
  }

  /**
   * Digest of items the brain hasn't seen, for the front of the next user
   * turn. Marks them delivered. Returns "" when there is nothing new.
   */
  takeDigest(maxChars = 1200): string {
    const fresh = this.undelivered()
    if (fresh.length === 0) return ""
    for (const i of fresh) i.delivered = true
    this.changed()
    const per = Math.max(120, Math.floor(maxChars / fresh.length))
    const lines = fresh.map((i) => `- [${i.id}] ${i.title}: ${truncate(oneLine(i.summary), per)}`)
    return (
      `[Inbox: ${fresh.length} new item${fresh.length === 1 ? "" : "s"} arrived since the last turn. ` +
      `Shawn already heard the chime. Don't bring these up unless he asks or it answers his question.]\n` +
      lines.join("\n")
    )
  }

  markRead(ids?: string[]): number {
    let n = 0
    for (const i of this.items) {
      if (!i.read && (!ids || ids.includes(i.id))) {
        i.read = true
        i.delivered = true
        n++
      }
    }
    if (n) this.changed()
    return n
  }

  clear(): void {
    this.items = []
    this.changed()
  }

  private changed() {
    if (this.file) {
      const tmp = this.file + ".tmp"
      writeFileSync(tmp, JSON.stringify(this.items, null, 2))
      renameSync(tmp, this.file)
    }
    for (const l of this.listeners) l(this.items)
  }
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).trimEnd() + "…"
}
