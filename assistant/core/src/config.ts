import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

declare const __ASSISTANT_BUNDLED__: boolean | undefined

/** Whether this is the bundled Core an install runs (dist/main.mjs, scripts/bundle.mjs). */
export const BUNDLED = typeof __ASSISTANT_BUNDLED__ !== "undefined" && __ASSISTANT_BUNDLED__

/** Root of the @assistant/core package (assistant/core): src/.. or dist/.. alike. */
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
  /** Her skills, one Markdown file each (src/skills.ts). */
  get skills() {
    return join(assistantHome(), "skills")
  },
  /** Her own MCP servers, Claude Code's `mcpServers` shape (src/mcp/config.ts). */
  get mcp() {
    return join(assistantHome(), "mcp.json")
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
  assistant: {
    name: string
    sayAs?: string
    /**
     * Her names ("personas"), each with its own voice and an optional
     * manner. Any of them wakes her; the reply is in the voice of the one
     * he used. One assistant, one memory. `name` is always `personas[0].name`.
     * Missing: `DEFAULT_PERSONAS`, with `name` first.
     */
    personas?: Persona[]
  }
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
  /**
   * When his turn is over. The App's ears read the waits: after a question
   * (`finishedMs`), any other clean ending (`pauseMs`), and words that trail
   * off on "um", "and", "the", … (`unfinishedMs`), never over `maxMs`
   * (src/assistant_ears/patience.rs; an App restart applies them). Core
   * reads the rest: words he says within `mergeSeconds` of his last ones,
   * while she's still thinking, hold her answer and join that turn; so do
   * words that barge in within `bargeMergeSeconds` of her first audio.
   */
  turn: {
    finishedMs: number
    pauseMs: number
    unfinishedMs: number
    maxMs: number
    mergeSeconds: number
    bargeMergeSeconds: number
    /** Silence after his turn before Core says "One sec." for her (`ack.ts`); 0 turns acknowledgements off. */
    acknowledgeMs: number
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
    /**
     * Path to the t3 CLI (.cmd or .exe). Unset: $T3CODE_CLI_PATH, then `t3`
     * on PATH, then T3 Code's usual install places (src/t3.ts `findT3Cli`).
     */
    cliPath?: string
    /** The older name of `cliPath`. */
    cli?: string
    pollSeconds: number
    /**
     * Where "send feedback to the orchestrator" goes: a T3 thread, on this
     * machine's T3 or a linked environment (`environmentId`).
     */
    orchestratorThread: { environmentId?: string; threadId: string }
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

/** One of her names: what wakes her, the voice she answers in, and a light manner. */
export interface Persona {
  name: string
  /** A voice id from the voice service's `/v1/voices`. */
  voice: string
  /** A short line of manner ("a dry, courteous English butler"). */
  style?: string
  /** Short lines Core says for this persona while she works ("One moment, sir."); built-in ones otherwise (`ack.ts`). */
  acks?: string[]
}

/** The names she starts with. The first is her own (Vera, in the `isla` voice). */
export const DEFAULT_PERSONAS: readonly Persona[] = [
  { name: DEFAULT_NAME, voice: "isla" },
  { name: "Alfred", voice: "alfred", style: "in character as Alfred Pennyworth from The Dark Knight" },
  { name: "Jarvis", voice: "jarvis", style: "in character as J.A.R.V.I.S. from Iron Man" },
  { name: "Optimus", voice: "optimus", style: "in character as Optimus Prime from Transformers" },
  { name: "Buzz", voice: "buzz", style: "in character as Buzz Lightyear from Toy Story" },
  { name: "Saul", voice: "saul", style: "in character as Saul Goodman from Breaking Bad and Better Call Saul" },
  { name: "Tony", voice: "tony", style: "in character as Tony Soprano from The Sopranos" },
]

/**
 * Her personas as config says, cleaned: valid names only, no name twice
 * (case ignored), at least one. Without `assistant.personas`, the defaults
 * with `assistant.name` (if it isn't Vera) in Vera's place.
 */
export function personasOf(config: Pick<AssistantConfig, "assistant">): Persona[] {
  const given = config.assistant?.personas
  const raw: unknown[] = Array.isArray(given) && given.length
    ? given
    : DEFAULT_PERSONAS.map((p, i) => (i === 0 ? { ...p, name: validName(config.assistant?.name) ?? p.name } : { ...p }))
  const out: Persona[] = []
  for (const r of raw) {
    if (!r || typeof r !== "object") continue
    const o = r as Record<string, unknown>
    const name = validName(o.name)
    if (!name || out.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue
    const voice = typeof o.voice === "string" && o.voice.trim() ? o.voice.trim() : DEFAULT_PERSONAS[0].voice
    const style = typeof o.style === "string" && o.style.trim() ? o.style.trim() : undefined
    const acks = Array.isArray(o.acks) ? o.acks.filter((a): a is string => typeof a === "string" && !!a.trim()).map((a) => a.trim()) : []
    out.push({ name, voice, ...(style ? { style } : {}), ...(acks.length ? { acks } : {}) })
  }
  return out.length ? out : [{ ...DEFAULT_PERSONAS[0] }]
}

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
  turn: { finishedMs: 700, pauseMs: 1200, unfinishedMs: 5000, maxMs: 8000, mergeSeconds: 12, bargeMergeSeconds: 2, acknowledgeMs: 1200 },
  jobs: {
    defaultCwd: "D:\\dev",
    waitTimeoutSeconds: 90,
    claude: {},
    codex: {},
    grok: {},
  },
  t3: {
    pollSeconds: 10,
    // Winserve's orchestrator thread (Shawn's development machine).
    orchestratorThread: {
      environmentId: "573af78b-3442-4163-8b9b-bc5cb90eefde",
      threadId: "mcp:launch:e567a1bd34d8a95f1c00a2ba8883e89cfbe5413356b07615454602cff62b76d9",
    },
  },
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
