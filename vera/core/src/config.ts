import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Root of the @vera/core package (vera/core). */
export const CORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** ~/.vera, or $VERA_HOME (tests and benches point this elsewhere). */
export function veraHome(): string {
  return process.env.VERA_HOME ? resolve(process.env.VERA_HOME) : join(homedir(), ".vera")
}

export const paths = {
  get home() {
    return veraHome()
  },
  get config() {
    return join(veraHome(), "config.json")
  },
  get systemPrompt() {
    return join(veraHome(), "system-prompt.md")
  },
  get promptHistory() {
    return join(veraHome(), "prompt-history")
  },
  get jobs() {
    return join(veraHome(), "jobs")
  },
  get logs() {
    return join(veraHome(), "logs")
  },
  get inbox() {
    return join(veraHome(), "inbox.json")
  },
  get watches() {
    return join(veraHome(), "t3-watches.json")
  },
  get brainDir() {
    return join(veraHome(), "brain")
  },
  /** Core's small runtime state (Vera's last volume). */
  get state() {
    return join(veraHome(), "core-state.json")
  },
  /** Written at startup: {pid, port, url} of the loopback HTTP server (tool calls, debug hook). */
  get runtime() {
    return join(veraHome(), "core-runtime.json")
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

export interface VeraConfig {
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
  voice: {
    /**
     * Vera's own output level until the App reports one: 0-1 on the App's
     * scale, where v is 40 × (v − 1) dB (1 = the voice service's level).
     */
    defaultVolume: number
  }
}

export const DEFAULT_CONFIG: VeraConfig = {
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

export function loadConfig(): VeraConfig {
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
export function saveConfigPatch(patch: unknown): VeraConfig {
  let raw: unknown = {}
  try {
    raw = JSON.parse(readFileSync(paths.config, "utf8").replace(/^\uFEFF/, ""))
  } catch {}
  const next = merge(raw, patch)
  mkdirSync(dirname(paths.config), { recursive: true })
  writeFileSync(paths.config, JSON.stringify(next, null, 2) + "\n")
  return merge(DEFAULT_CONFIG, next)
}
