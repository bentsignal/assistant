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
]

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
}

/** Find and strip the wake word. */
export function stripWakeWord(text: string, opts: { extra?: string[]; maxLeadingWords?: number } = {}): WakeMatch {
  const extra = (opts.extra ?? []).map((w) => w.toLowerCase())
  const maxLeading = opts.maxLeadingWords ?? 3
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { found: false, text: "" }

  // Leading: up to maxLeading filler words, then the wake word.
  for (let i = 0; i < Math.min(words.length, maxLeading + 1); i++) {
    if (isWakeWord(words[i], extra)) {
      const before = words.slice(0, i).map(normalizeWord)
      if (before.every((w) => FILLERS.has(w))) {
        const rest = words.slice(i + 1).join(" ")
        return { found: true, text: cleanEdges(rest) }
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
  opts: { extra?: string[]; maxLeadingWords?: number } = {},
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
