import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/** Root of the @vera/core package (vera/core). */
export const CORE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
/** Root of the vera/ pnpm workspace. */
export const WORKSPACE_DIR = resolve(CORE_DIR, "..")
/** Root of the vera-voice repo (the Hex fork that builds Ears). */
export const REPO_DIR = resolve(WORKSPACE_DIR, "..")

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
  get sounds() {
    return join(veraHome(), "sounds")
  },
  seedPrompt: join(CORE_DIR, "prompts", "system.md"),
}

export type BrainHarness = "claude-code" | "codex" | "grok" | "gemini"

export interface BrainSettings {
  model?: string
  effort?: string
}

export interface VeraConfig {
  port: number
  brain: {
    harness: BrainHarness
    "claude-code": BrainSettings
    codex: BrainSettings
    grok: BrainSettings
    gemini: BrainSettings
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
  ears: {
    /**
     * argv of the Ears process; "auto" (default) runs this repo's
     * target/release/hex.exe (else target/ears-dev/hex.exe) with `ears`;
     * null for none (text box and API only).
     */
    command: "auto" | string[] | null
    /** Extra flags for the auto command, e.g. ["--device", "Headset"]. */
    args: string[]
    cwd?: string
    /** Milliseconds Ears stay paused after Mouth stops, so Vera doesn't hear its own tail. */
    tailMs: number
    /** Milliseconds Ears stay paused after a chime. */
    chimeTailMs: number
    /**
     * Keep listening while Vera speaks, but only for "Vera, stop" (and other
     * stop phrases after the wake word) that Vera isn't saying herself.
     */
    bargeIn: boolean
  }
  mouth: {
    /** "auto" tries @vera/mouth then falls back to "sapi"; "stub" only logs; "sapi" speaks with Windows SAPI. */
    module: "auto" | "@vera/mouth" | "sapi" | "stub"
    options?: Record<string, unknown>
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
  panel: {
    /** Open the panel as a Chrome/Edge --app window on `pnpm start`. */
    open: boolean
    browser?: string
  }
}

export const DEFAULT_CONFIG: VeraConfig = {
  port: 7313,
  brain: {
    harness: "claude-code",
    "claude-code": { model: "sonnet", effort: "low" },
    codex: { model: "gpt-6.2-sol", effort: "low" },
    grok: {},
    gemini: {},
  },
  wake: { words: [], soft: true, warmSeconds: 120, followUpSeconds: 8, maxLeadingWords: 3 },
  ears: { command: "auto", args: [], tailMs: 300, chimeTailMs: 150, bargeIn: true },
  mouth: { module: "auto" },
  jobs: {
    defaultCwd: "D:\\dev",
    waitTimeoutSeconds: 90,
    claude: {},
    codex: {},
    grok: {},
  },
  t3: { pollSeconds: 10 },
  panel: { open: true },
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
  for (const d of [paths.home, paths.promptHistory, paths.jobs, paths.logs, paths.brainDir, paths.sounds]) {
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

/** Ears executables auto mode looks for, best first. */
export function earsCandidates(): string[] {
  const exe = process.platform === "win32" ? "hex.exe" : "hex"
  return [join(REPO_DIR, "target", "release", exe), join(REPO_DIR, "target", "ears-dev", exe)]
}

/** Resolve config.ears into an argv, or null with the reason. */
export function resolveEarsCommand(ears: VeraConfig["ears"]): { argv: string[] | null; note: string } {
  if (ears.command === null || (Array.isArray(ears.command) && ears.command.length === 0)) {
    return { argv: null, note: "ears off (ears.command is null): panel and API only" }
  }
  if (Array.isArray(ears.command)) return { argv: ears.command, note: `ears: ${ears.command.join(" ")}` }
  const found = earsCandidates().find((p) => existsSync(p))
  if (!found) {
    return {
      argv: null,
      note:
        `ears off: no ${earsCandidates()[0]} yet. Build it once from Git Bash in the repo root:\n` +
        `    sh scripts/vera-ears-build.sh\n` +
        `  (about 4 minutes; then restart Vera). Until then use the panel's text box.`,
    }
  }
  return { argv: [found, "ears", ...(ears.args ?? [])], note: `ears: ${found} ears ${(ears.args ?? []).join(" ")}`.trim() }
}
