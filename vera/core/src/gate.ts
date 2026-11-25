/**
 * Wake-word gate. Pure functions; the clock is passed in so tests are exact.
 *
 * An utterance passes when:
 *  - it contains the wake word ("Vera", fuzzy) within the first few words or
 *    as a trailing vocative ("..., Vera?"), or anywhere else in the sentence; or
 *  - it started inside the follow-up window (after Vera stopped speaking); or
 *  - it is direct (panel text box, API with direct:true).
 *
 * Leading wake words and fillers ("hey", "okay") are stripped from the text the
 * brain sees. A bare "Vera" opens the follow-up window without a turn. Stop
 * phrases ("Vera, stop", "never mind") cancel instead of starting a turn.
 *
 * Soft wake words: Parakeet sometimes hears "Vera" as a real word or name
 * (measured in a noisy kitchen simulation: "Variable", "Mirror", "Sarah",
 * "Hey there", "Okay there", "Hey girl", "Vera of"). Those count only as a
 * leading vocative: the first word (after fillers), followed by a comma, a
 * question mark, or nothing at all. "Variable, what time is it?" wakes;
 * "variable names are long" and "I told Sarah" don't. The ones that are
 * ordinary greetings ("hey there", "okay there", "hey girl") additionally
 * need a recent Vera interaction (`recentlyActive`, Core passes true within
 * two minutes of Vera last speaking or waking), so a TV saying "Hey there,
 * folks" an hour later never wakes her.
 */

const FILLERS = new Set(["hey", "hi", "ok", "okay", "oh", "um", "uh", "so", "yo", "alright", "right", "and"])

/** vera, vara, vira, bera, wera, veera, viera, verra, verah, vehra, ... but not "very", "were", "era". */
const WAKE_RE = /^(?:v|b|w)(?:e|i|a|ee|ie|ei|eh)r{1,2}(?:a|ah|uh)$/

const STOP_PHRASES = [
  "stop",
  "stop talking",
  "stop it",
  "be quiet",
  "quiet",
  "shush",
  "hush",
  "shut up",
  "never mind",
  "nevermind",
  "cancel",
  "cancel that",
  "forget it",
  "forget that",
  "that's all",
  "thats all",
  "nothing",
  "no thanks",
  "no thank you",
  "enough",
  "that's enough",
  "thats enough",
  "shh",
  "shhh",
  "stop stop",
  "hold on",
  "wait",
]

/** Misheard "Vera" that is a real word or name: leading vocative only. */
const SOFT_WAKE = new Set(["variable", "mirror", "sarah", "sara"])
/** Misheard "Hey Vera" that is also an ordinary greeting: leading vocative and only near a recent interaction. */
const WARM_WAKE: [string, string][] = [
  ["hey", "there"],
  ["okay", "there"],
  ["ok", "there"],
  ["hey", "girl"],
]
/** Words Parakeet hangs on the wake word ("Vera of", "Vera uh") that the brain shouldn't see. */
const AFTER_WAKE_FILLERS = new Set(["of", "uh", "um"])

export function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .replace(/[’']s$/, "")
    .replace(/[^a-z0-9']/g, "")
}

export function isWakeWord(word: string, extra: string[] = []): boolean {
  const w = normalizeWord(word)
  if (!w) return false
  if (extra.includes(w)) return true
  return WAKE_RE.test(w)
}

export function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function isStopPhrase(text: string): boolean {
  let t = normalizePhrase(text)
  // "stop please", "please stop", "okay stop"
  t = t.replace(/^(please|okay|ok|just|oh) /, "").replace(/ (please|now|thanks|thank you)$/, "")
  return STOP_PHRASES.includes(t)
}

export interface WakeMatch {
  /** Wake word found anywhere. */
  found: boolean
  /** Text with leading/trailing wake word and fillers removed. */
  text: string
  /** Matched only through a soft wake word (a misheard "Vera"). */
  soft?: boolean
}

export interface WakeOptions {
  extra?: string[]
  maxLeadingWords?: number
  /** Accept soft wake words ("Variable, ..."). Default true. */
  soft?: boolean
  /** Vera spoke or woke recently: also accept greetings misheard for "Hey Vera". */
  recentlyActive?: boolean
}

/** A word ends a vocative: "Sarah," "Sarah?" "Sarah." or the utterance ends. */
function vocativeEnd(words: string[], i: number): boolean {
  if (i === words.length - 1) return true
  return /[,?.!:;]$/.test(words[i])
}

/** Find and strip the wake word. */
export function stripWakeWord(text: string, opts: WakeOptions = {}): WakeMatch {
  const extra = (opts.extra ?? []).map((w) => w.toLowerCase())
  const maxLeading = opts.maxLeadingWords ?? 3
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { found: false, text: "" }

  // Leading: up to maxLeading filler words, then the wake word.
  for (let i = 0; i < Math.min(words.length, maxLeading + 1); i++) {
    if (isWakeWord(words[i], extra)) {
      const before = words.slice(0, i).map(normalizeWord)
      if (before.every((w) => FILLERS.has(w))) {
        return { found: true, text: afterWake(words, i + 1) }
      }
    }
  }
  if (opts.soft !== false) {
    // Soft: first non-filler word, as a vocative.
    let i = 0
    while (i < words.length - 1 && i < maxLeading && FILLERS.has(normalizeWord(words[i]))) i++
    if (SOFT_WAKE.has(normalizeWord(words[i])) && vocativeEnd(words, i)) {
      return { found: true, soft: true, text: afterWake(words, i + 1) }
    }
    // Warm: "Hey there, ..." only right after Vera was active.
    if (opts.recentlyActive && words.length >= 2) {
      const a = normalizeWord(words[0])
      const b = normalizeWord(words[1])
      if (WARM_WAKE.some(([x, y]) => x === a && y === b) && vocativeEnd(words, 1)) {
        return { found: true, soft: true, text: afterWake(words, 2) }
      }
    }
  }
  // Trailing vocative: "what's the time, Vera?"
  const last = words[words.length - 1]
  if (isWakeWord(last, extra)) {
    return { found: true, text: cleanEdges(words.slice(0, -1).join(" ")) }
  }
  // Anywhere else: keep the sentence as said.
  if (words.some((w) => isWakeWord(w, extra))) return { found: true, text: text.trim() }
  return { found: false, text: text.trim() }
}

function afterWake(words: string[], from: number): string {
  const rest = words.slice(from)
  // "Vera of what time is it" / "Vera, uh, ..." -> drop the hanger-on.
  if (rest.length > 1 && AFTER_WAKE_FILLERS.has(normalizeWord(rest[0]))) rest.shift()
  return cleanEdges(rest.join(" "))
}

function cleanEdges(s: string): string {
  return s.replace(/^[\s,.:;!?-]+/, "").replace(/[\s,:;-]+$/, "").trim()
}

export interface GateInput {
  text: string
  /** When the speech started (epoch ms); defaults to now. */
  start?: number
  direct?: boolean
}

export interface GateState {
  /** Follow-up window end (epoch ms), or 0 when closed. */
  followUpUntil: number
}

export type GateResult =
  | { action: "ignore"; reason: string }
  | { action: "wake"; text: "" } // bare wake word: listen for the next utterance
  | { action: "stop"; text: string }
  | { action: "turn"; text: string; via: "wake" | "followup" | "direct" }

export function gate(
  input: GateInput,
  state: GateState,
  now: number,
  opts: WakeOptions = {},
): GateResult {
  const raw = (input.text ?? "").trim()
  if (!raw) return { action: "ignore", reason: "empty" }
  const m = stripWakeWord(raw, opts)
  const start = input.start ?? now
  const inWindow = state.followUpUntil > 0 && start <= state.followUpUntil
  const via = input.direct ? "direct" : m.found ? "wake" : inWindow ? "followup" : null
  if (!via) return { action: "ignore", reason: "no wake word" }

  const text = m.found ? m.text : raw
  if (!text) return { action: "wake", text: "" }
  if (isStopPhrase(text)) return { action: "stop", text }
  return { action: "turn", text, via }
}

/** What counts as "stop" right after the wake word when barging in. */
const BARGE_STOPS = ["stop", "be quiet", "quiet", "shush", "hush", "shut up", "enough", "cancel", "never mind", "nevermind", "pause", "wait"]

/**
 * Barge-in: does a transcript heard while Vera is talking hold the wake word
 * followed by a stop ("Vera, stop", "Vera be quiet") that isn't in what Vera
 * herself is saying (her own voice reaching the microphone)? Only the strict
 * wake word counts, never the soft ones. Returns the matched phrase or null.
 */
export function findBargeIn(heard: string, spoken: string, extra: string[] = []): string | null {
  const words = normalizePhrase(heard).split(" ").filter(Boolean)
  const said = ` ${normalizePhrase(spoken)} `
  for (let i = 0; i < words.length; i++) {
    if (!isWakeWord(words[i], extra)) continue
    let j = i + 1
    while (j < words.length && j <= i + 2 && FILLERS.has(words[j])) j++
    const rest = words.slice(j, j + 2).join(" ")
    const stop = BARGE_STOPS.find((p) => rest === p || rest.startsWith(p + " "))
    if (!stop) continue
    const phrase = `${words[i]} ${stop}`
    if (said.includes(` ${phrase} `) || said.includes(` ${stop} `)) continue
    return phrase
  }
  return null
}
