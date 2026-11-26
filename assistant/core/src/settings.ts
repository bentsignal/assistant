import { existsSync, statSync } from "node:fs"
import type { AssistantConfig } from "./config.ts"

/**
 * The keys of ~/.assistant/config.json she may read and set by voice
 * (`config_get` / `config_set`), each checked against a schema so a slip
 * can't stop her starting. Anything not listed is refused: the port, the
 * harness (`set_brain`), her names (`set_name`), the voice override
 * (`set_voice`), and every argv a job or the brain runs.
 *
 * `applies` says when a change takes effect:
 *  - "now":   Core reads it live, from the next turn or tool call
 *  - "brain": the brain restarts before the next turn (the conversation is kept)
 *  - "app":   the App reads it at its next start (Core tells her to say so)
 */
export type Applies = "now" | "brain" | "app"

export type KeySchema =
  | { type: "number"; min: number; max: number; integer?: boolean }
  | { type: "boolean" }
  | { type: "string"; pattern?: RegExp; maxLength?: number; nullable?: boolean }
  | { type: "enum"; values: string[]; nullable?: boolean }
  | { type: "words" }
  | { type: "path"; kind: "file" | "dir"; nullable?: boolean }

export interface KeyDef {
  schema: KeySchema
  applies: Applies
  about: string
}

const num = (min: number, max: number, applies: Applies, about: string, integer = false): KeyDef => ({ schema: { type: "number", min, max, integer }, applies, about })
const model: KeySchema = { type: "string", pattern: /^[A-Za-z0-9._:\/\[\]-]{1,80}$/, nullable: true }
const effort: KeySchema = { type: "enum", values: ["minimal", "low", "medium", "high", "xhigh", "max"], nullable: true }
const id: KeySchema = { type: "string", pattern: /^[A-Za-z0-9:_.-]{1,200}$/, nullable: true }

export const SETTINGS: Record<string, KeyDef> = {
  "wake.words": { schema: { type: "words" }, applies: "now", about: "Extra exact words (lowercase) that wake her, beside her names." },
  "wake.soft": { schema: { type: "boolean" }, applies: "now", about: "Accept misheard names as a leading vocative." },
  "wake.warmSeconds": num(0, 3600, "now", "Seconds after she last spoke during which 'hey there' also wakes her."),
  "wake.followUpSeconds": num(0, 120, "now", "Seconds after she stops speaking during which no wake word is needed."),
  "wake.maxLeadingWords": num(0, 6, "now", "Words that may come before her name ('hey', 'okay').", true),
  "turn.finishedMs": num(200, 5000, "app", "Silence that ends his turn after a question.", true),
  "turn.pauseMs": num(300, 8000, "app", "Silence that ends his turn after a clean ending.", true),
  "turn.unfinishedMs": num(500, 15000, "app", "Silence that ends a turn that trails off on 'um', 'and', ...", true),
  "turn.maxMs": num(1000, 30000, "app", "The longest wait for the end of his turn.", true),
  "turn.mergeSeconds": num(0, 60, "now", "Words within this long of his last ones join the same turn while she thinks."),
  "turn.bargeMergeSeconds": num(0, 10, "now", "Words this soon after her first audio join the turn."),
  "turn.acknowledgeMs": num(0, 10000, "now", "Silence after his turn before Core says a short 'one sec' for her (also before a slow first tool); 0 is off."),
  "brain.firstSpeakTimeoutSeconds": num(10, 600, "now", "A turn that hasn't spoken this long is given up on."),
  "brain.turnTimeoutSeconds": num(30, 1800, "now", "Any turn is given up on after this long."),
  "brain.claude-code.model": { schema: model, applies: "brain", about: "Her model on Claude Code (set_brain does this too)." },
  "brain.claude-code.effort": { schema: effort, applies: "brain", about: "Her effort on Claude Code." },
  "brain.codex.model": { schema: model, applies: "brain", about: "Her model on Codex." },
  "brain.codex.effort": { schema: effort, applies: "brain", about: "Her effort on Codex." },
  "jobs.defaultCwd": { schema: { type: "path", kind: "dir" }, applies: "now", about: "Default working folder for ask_* jobs." },
  "jobs.waitTimeoutSeconds": num(5, 600, "now", "How long ask_* with wait:true waits before going to the background."),
  "jobs.claude.model": { schema: model, applies: "now", about: "Model for ask_claude jobs." },
  "jobs.claude.effort": { schema: effort, applies: "now", about: "Effort for ask_claude jobs." },
  "jobs.codex.model": { schema: model, applies: "now", about: "Model for ask_codex jobs." },
  "jobs.codex.effort": { schema: effort, applies: "now", about: "Effort for ask_codex jobs." },
  "jobs.grok.model": { schema: model, applies: "now", about: "Model for ask_grok jobs." },
  "t3.cliPath": { schema: { type: "path", kind: "file", nullable: true }, applies: "now", about: "Path to T3 Code's t3 CLI (t3.cmd), when it isn't found by itself." },
  "t3.pollSeconds": num(2, 600, "now", "How often watched T3 threads are checked."),
  "t3.orchestratorThread.threadId": { schema: id, applies: "now", about: "The T3 thread send_feedback goes to." },
  "t3.orchestratorThread.environmentId": { schema: id, applies: "now", about: "The machine that thread is on (a T3 environment id)." },
  "voice.defaultVolume": num(0.05, 1, "app", "Her volume until the App reports one."),
  "app.updates.channel": { schema: { type: "enum", values: ["stable", "nightly"], nullable: true }, applies: "app", about: "Which release channel updates follow (update_channel does this)." },
  "app.updates.check": { schema: { type: "boolean" }, applies: "app", about: "Check for updates by itself." },
  "app.updates.trayBadge": { schema: { type: "boolean" }, applies: "app", about: "A quiet dot on the tray icon when an update is available." },
}

/** The value at a dotted key ("t3.orchestratorThread.threadId"); key segments may hold "-" ("brain.claude-code.model"). */
export function getKey(obj: unknown, key: string): unknown {
  let cur: any = obj
  for (const part of key.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined
    cur = cur[part]
  }
  return cur
}

/** A patch that sets one dotted key: {"a": {"b": value}}. */
export function patchFor(key: string, value: unknown): Record<string, unknown> {
  const parts = key.split(".")
  let out: any = value
  for (const p of parts.reverse()) out = { [p]: out }
  return out
}

function asBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v
  if (typeof v === "string" && /^(true|yes|on|1)$/i.test(v.trim())) return true
  if (typeof v === "string" && /^(false|no|off|0)$/i.test(v.trim())) return false
  return null
}

/** Checks (and coerces: "12" to 12, "on" to true) a value for a key. Throws why it's refused. */
export function checkValue(
  key: string,
  raw: unknown,
  io: { exists: (p: string) => boolean; isDir: (p: string) => boolean } = { exists: existsSync, isDir: (p) => statSync(p).isDirectory() },
): unknown {
  const def = SETTINGS[key]
  if (!def) {
    const near = Object.keys(SETTINGS).filter((k) => k.toLowerCase().includes(key.split(".").pop()!.toLowerCase()))
    throw new Error(`${key} isn't a setting you can change${near.length ? ` (did you mean ${near.join(", ")}?)` : ""}. config_get lists them.`)
  }
  const s = def.schema
  const nullable = "nullable" in s && s.nullable
  if ((raw === null || raw === "" || (typeof raw === "string" && /^(null|none|unset|default)$/i.test(raw.trim()))) && nullable) return null
  switch (s.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN
      if (!Number.isFinite(n)) throw new Error(`${key} is a number`)
      if (s.integer && !Number.isInteger(n)) throw new Error(`${key} is a whole number`)
      if (n < s.min || n > s.max) throw new Error(`${key} is from ${s.min} to ${s.max}`)
      return n
    }
    case "boolean": {
      const b = asBool(raw)
      if (b === null) throw new Error(`${key} is true or false`)
      return b
    }
    case "enum": {
      const v = String(raw ?? "").trim().toLowerCase()
      if (!s.values.includes(v)) throw new Error(`${key} is one of ${s.values.join(", ")}`)
      return v
    }
    case "string": {
      if (typeof raw !== "string" || !raw.trim()) throw new Error(`${key} is text`)
      const v = raw.trim()
      if (s.maxLength && v.length > s.maxLength) throw new Error(`${key} is at most ${s.maxLength} characters`)
      if (s.pattern && !s.pattern.test(v)) throw new Error(`${JSON.stringify(v)} doesn't look right for ${key}`)
      return v
    }
    case "words": {
      const list = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/[,\s]+/) : null
      if (!list) throw new Error(`${key} is a list of words`)
      const words = list.map((w) => w.trim().toLowerCase()).filter(Boolean)
      if (words.length > 20 || words.some((w) => !/^[\p{L}'-]{2,30}$/u.test(w))) throw new Error(`${key} is up to 20 single words`)
      return words
    }
    case "path": {
      if (typeof raw !== "string" || !raw.trim()) throw new Error(`${key} is a path`)
      const p = raw.trim().replace(/^"|"$/g, "")
      if (!io.exists(p)) throw new Error(`${p} doesn't exist`)
      if ((s.kind === "dir") !== io.isDir(p)) throw new Error(`${p} isn't a ${s.kind === "dir" ? "folder" : "file"}`)
      return p
    }
  }
}

/** What to tell her about when a change applies. */
export function appliesNote(applies: Applies): string {
  if (applies === "now") return "It applies now."
  if (applies === "brain") return "It applies from the next turn (your brain restarts, keeping the conversation)."
  return "The App reads it when it next starts: tell Shawn it applies after a restart of Assistant."
}

/** Every key she may set, with its value now, for config_get. */
export function describeSettings(config: AssistantConfig): string {
  return Object.entries(SETTINGS)
    .map(([k, d]) => `${k} = ${JSON.stringify(getKey(config, k) ?? null)} (${d.applies}): ${d.about}`)
    .join("\n")
}
