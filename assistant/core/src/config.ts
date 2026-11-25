import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Root of the @assistant/core package (assistant/core). */
export const CORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** ~/.assistant, or $ASSISTANT_HOME (tests and benches point this elsewhere). */
export function assistantHome(): string {
  return process.env.ASSISTANT_HOME ? resolve(process.env.ASSISTANT_HOME) : join(homedir(), ".assistant")
}

export const paths = {
  get home() {
    return assistantHome()
  },
  get config() {
    return join(assistantHome(), "config.json")
  },
  get systemPrompt() {
    return join(assistantHome(), "system-prompt.md")
  },
  get promptHistory() {
    return join(assistantHome(), "prompt-history")
  },
  get jobs() {
    return join(assistantHome(), "jobs")
  },
  get logs() {
    return join(assistantHome(), "logs")
  },
  get inbox() {
    return join(assistantHome(), "inbox.json")
  },
  get watches() {
    return join(assistantHome(), "t3-watches.json")
  },
  get brainDir() {
    return join(assistantHome(), "brain")
  },
  /** Core's small runtime state (Vera's last volume). */
  get state() {
    return join(assistantHome(), "core-state.json")
  },
  /** Written at startup: {pid, port, url} of the loopback HTTP server (tool calls, debug hook). */
  get runtime() {
    return join(assistantHome(), "core-runtime.json")
  },
  seedPrompt: join(CORE_DIR, "prompts", "system.md"),
}

export type BrainHarness = "claude-code" | "codex" | "grok" | "gemini" | "script"

export interface BrainSettings {
  model?: string
  effort?: string
  /** Jobs only: run this argv instead of the agent's CLI (tests use a fake agent). */
  command?: string[]
}

export interface AssistantConfig {
  /**
   * The persona. `name` is what she's called: her wake word (fuzzy variants
   * are derived from it), how the prompt names her (`{{name}}`), and what
   * the App shows. `sayAs` respells it for the voice when it's said wrong.
   */
  assistant: { name: string; sayAs?: string }
  /** Loopback HTTP port to try first (the brain's tool calls, the debug hook); a free one if it's taken. */
  port: number
  brain: {
    harness: BrainHarness
    /**
     * A turn that hasn't spoken this long is given up on: the brain is
     * interrupted and Shawn hears the error chime (never a silent wait).
     */
    firstSpeakTimeoutSeconds: number
    /** Any turn is given up on after this long, spoken or not. */
    turnTimeoutSeconds: number
    "claude-code": BrainSettings
    codex: BrainSettings
    grok: BrainSettings
    gemini: BrainSettings
    script: BrainSettings
  }
  wake: {
    /** Extra exact words (lowercase) that count as the wake word, beside the built-in fuzzy match. */
    words: string[]
    /** Accept misheard "Vera" ("Variable,", "Sarah,", and near a recent interaction "Hey there,") as a leading vocative. */
    soft: boolean
    /** Seconds after Vera last spoke or woke during which "Hey there," and friends also wake her. */
    warmSeconds: number
    /** Seconds after Vera stops speaking during which no wake word is needed. */
    followUpSeconds: number
    /** How many leading words may come before the wake word ("hey", "okay"). */
    maxLeadingWords: number
  }
  jobs: {
    /** Default working directory for ask_* jobs. */
    defaultCwd: string
    /** Seconds ask_* waits when wait:true before handing the job to the background. */
    waitTimeoutSeconds: number
    claude: BrainSettings
    codex: BrainSettings
    grok: BrainSettings
  }
  t3: {
    /** Path to the t3 CLI (.cmd or .exe). Defaults to $T3CODE_CLI_PATH. */
    cli?: string
    pollSeconds: number
  }
  /**
   * The App's own settings (it owns them; Core reads a few and writes only
   * `app.voice`, when Shawn asks for another voice).
   */
  app?: { voice?: string | null; voiceService?: { port?: number } }
  voice: {
    /**
     * Vera's own output level until the App reports one: 0-1 on the App's
     * scale, where v is 40 × (v − 1) dB (1 = the voice service's level).
     */
    defaultVolume: number
  }
}

export const DEFAULT_NAME = "Vera"

export const DEFAULT_CONFIG: AssistantConfig = {
  assistant: { name: DEFAULT_NAME },
  port: 7313,
  brain: {
    harness: "claude-code",
    firstSpeakTimeoutSeconds: 45,
    turnTimeoutSeconds: 150,
    "claude-code": { model: "sonnet", effort: "low" },
    codex: { model: "gpt-6.2-sol", effort: "low" },
    grok: {},
    gemini: {},
    script: {},
  },
  wake: { words: [], soft: true, warmSeconds: 120, followUpSeconds: 8, maxLeadingWords: 3 },
  jobs: {
    defaultCwd: "D:\\dev",
    waitTimeoutSeconds: 90,
    claude: {},
    codex: {},
    grok: {},
  },
  t3: { pollSeconds: 10 },
  voice: { defaultVolume: 0.7 },
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Deep merge: objects merge, everything else (arrays included) replaces. */
export function merge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) {
    out[k] = k in out ? merge(out[k], v) : v
  }
  return out as T
}

export function ensureHome(): void {
  for (const d of [paths.home, paths.promptHistory, paths.jobs, paths.logs, paths.brainDir]) {
    mkdirSync(d, { recursive: true })
  }
  if (!existsSync(paths.systemPrompt)) copyFileSync(paths.seedPrompt, paths.systemPrompt)
  if (!existsSync(paths.config)) {
    writeFileSync(paths.config, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n")
  }
}

/**
 * A name she can go by: one word of letters (an apostrophe or hyphen
 * inside is fine), 2 to 20 of them, trimmed, with a capital first letter.
 * Null for anything else. Matches the App's `valid_name`.
 */
export function validName(name: unknown): string | null {
  if (typeof name !== "string") return null
  const n = name.trim().replace(/^["“”']+|["“”'.!?]+$/g, "")
  const letters = [...n].filter((c) => /\p{L}/u.test(c)).length
  if (letters < 2 || letters > 20) return null
  if (!/^\p{L}[\p{L}'-]*\p{L}$/u.test(n)) return null
  return n[0].toUpperCase() + n.slice(1)
}

export function loadConfig(): AssistantConfig {
  ensureHome()
  let raw: unknown = {}
  try {
    raw = JSON.parse(readFileSync(paths.config, "utf8").replace(/^\uFEFF/, ""))
  } catch (err) {
    console.error(`[config] ${paths.config} is not valid JSON, using defaults: ${(err as Error).message}`)
  }
  return merge(DEFAULT_CONFIG, raw)
}

/** Update a few keys in config.json without dropping the user's other keys. */
export function saveConfigPatch(patch: unknown): AssistantConfig {
  let raw: unknown = {}
  try {
    raw = JSON.parse(readFileSync(paths.config, "utf8").replace(/^\uFEFF/, ""))
  } catch {}
  const next = merge(raw, patch)
  mkdirSync(dirname(paths.config), { recursive: true })
  writeFileSync(paths.config, JSON.stringify(next, null, 2) + "\n")
  return merge(DEFAULT_CONFIG, next)
}
