/**
 * Wake-word gate. Pure functions; the clock is passed in so tests are exact.
 *
 * An utterance passes when:
 *  - it contains the wake word ("Vera", fuzzy) within the first few words or
 *    as a trailing vocative ("..., Vera?"), or anywhere else in the sentence; or
 *  - it started inside the follow-up window (after Vera stopped speaking); or
 *  - it is direct (the debug hook with direct:true).
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

export const DEFAULT_NAME = "Vera"

/**
 * Words a near match of the name must never be: they'd wake her all day.
 * (The name itself always counts.)
 */
const COMMON = new Set(
  (
    "a about after again all also am an and any are as at back be been but by call came can come could day did do does done down each even few find first for from get give go good got had has have he her here him his how if in into is it its just know last like look made make man many may me more most much must my new no not now of off oh old on one only or other our out over own part people say said same see she should so some take than that the their them then there these they thing think this those time to too two up us use very want was way we well went were what when where which who why will with work would year yes yet you your " +
    "safe sake sale save page cage wage rage case cave game came name same tame lame fame dame over nose note none nine line lime mine fine wine vine wire were wore more mode node code rode hope rope cope dope sane lane cane pane wane vane " +
    // Near misses of the default personas' names (Saul, Tony, Alfred, Buzz, Jarvis).
    "soul sail seal sall tiny tone tons toni tory alfredo buzzy busy jarvi"
  ).split(/\s+/),
)

/** Letters that sound alike at the start of a word (a near match may swap them). */
const ALIKE: Record<string, string> = { b: "v", v: "b", w: "v", c: "k", k: "c", s: "z", z: "s" }

function sameStart(a: string, b: string): boolean {
  return a[0] === b[0] || ALIKE[a[0]] === b[0]
}

/** Levenshtein distance, giving up past 2. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/** The name as it's matched: lowercase letters only. */
function nameKey(name: string | undefined): string {
  return normalizeWord(name || DEFAULT_NAME).replace(/'/g, "")
}

/**
 * How a word relates to her name: `exact` (the name, or for Vera her tuned
 * variants, which wake her anywhere in a sentence), `near` (one letter off a
 * name of four letters or more, starting alike and not a common word: a
 * likely mishearing, which wakes her only first or last), or null.
 */
export function wakeMatch(word: string, name: string = DEFAULT_NAME, extra: string[] = []): "exact" | "near" | null {
  const w = normalizeWord(word).replace(/'/g, "")
  if (!w) return null
  if (extra.includes(w)) return "exact"
  const n = nameKey(name)
  if (n === "vera") return WAKE_RE.test(w) ? "exact" : null
  if (w === n) return "exact"
  if (n.length >= 4 && !COMMON.has(w) && sameStart(w, n) && distance(w, n) === 1) return "near"
  return null
}

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

/** How a word matches any of her names: the best match and which name it was. */
function matchNames(word: string, names: string[], extra: string[]): { kind: "exact" | "near"; name: string } | null {
  let near: string | null = null
  for (const [i, name] of names.entries()) {
    const m = wakeMatch(word, name, i === 0 ? extra : [])
    if (m === "exact") return { kind: "exact", name }
    if (m === "near" && near === null) near = name
  }
  return near === null ? null : { kind: "near", name: near }
}

/** The wake word itself (an exact match), for her name (default Vera). */
export function isWakeWord(word: string, extra: string[] = [], name: string = DEFAULT_NAME): boolean {
  return wakeMatch(word, name, extra) === "exact"
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
  /** Which of her names woke her (when `found` and `names` was given). */
  name?: string
  /**
   * The name was said as itself ("Optimus"), not a mishearing ("Vara",
   * "Variable,", "Alfread"): only that switches who answers.
   */
  explicit?: boolean
}

/**
 * One persona as the gate sees it: its name, the phrases that wake it
 * ("hey vera"; unset: "hey <name>"), and whether the name alone does too.
 */
export interface WakeName {
  name: string
  phrases?: string[]
  bare?: boolean
}

export interface WakeOptions {
  /**
   * Her personas with their wake phrases; overrides `names` and `name`.
   * A phrase wakes her ("Hey Vera", "hey, Vera", "hay Vera"); the name
   * alone ("Vera, ...") only for a persona with `bare`.
   */
  personas?: WakeName[]
  /** Her name (default Vera): the wake word. Vera's tuned mishearings apply only to Vera. */
  name?: string
  /**
   * All her names (personas), any of which wakes her; overrides `name`.
   * Each gets the same fuzzy matching; `extra` words count as the first.
   */
  names?: string[]
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
  const m = stripWake(text, opts)
  if (m.found && m.name) {
    const key = nameKey(m.name)
    const said = text.trim().split(/\s+/).map((w) => normalizeWord(w).replace(/'/g, ""))
    if (said.includes(key)) m.explicit = true
  }
  // Which name woke her is reported only to callers that gave several (personas).
  if (!opts.names?.length && !opts.personas && m.name !== undefined) {
    delete m.name
    delete m.explicit
  }
  return m
}

function stripWake(text: string, opts: WakeOptions): WakeMatch {
  if (opts.personas) return stripPersonas(text, opts, opts.personas)
  const names = opts.names?.filter(Boolean).length ? opts.names.filter(Boolean) : [opts.name || DEFAULT_NAME]
  return stripBare(text, opts, names, true)
}

/** The bare-name wake: any of `names` alone wakes her; `veraSoft` adds Vera's tuned mishearings. */
function stripBare(text: string, opts: WakeOptions, names: string[], veraSoft: boolean): WakeMatch {
  const extra = (opts.extra ?? []).map((w) => w.toLowerCase())
  const vera = veraSoft ? names.find((n) => nameKey(n) === "vera") : undefined
  const maxLeading = opts.maxLeadingWords ?? 3
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { found: false, text: "" }
  const found = (w: string) => (names.length ? matchNames(w, names, extra) : null)
  const match = (w: string) => found(w)?.kind ?? null

  // Leading: up to maxLeading filler words, then the wake word (a near
  // match of the name counts here too: "Noba, what time is it?").
  for (let i = 0; i < Math.min(words.length, maxLeading + 1); i++) {
    const m = match(words[i])
    if (m && (m === "exact" || opts.soft !== false)) {
      const before = words.slice(0, i).map(normalizeWord)
      if (before.every((w) => FILLERS.has(w))) {
        return { found: true, name: found(words[i])!.name, text: afterWake(words, i + 1), ...(m === "near" ? { soft: true } : {}) }
      }
    }
  }
  // Vera's tuned mishearings ("Variable,", "Hey there,") are hers alone.
  if (vera && opts.soft !== false) {
    // Soft: first non-filler word, as a vocative.
    let i = 0
    while (i < words.length - 1 && i < maxLeading && FILLERS.has(normalizeWord(words[i]))) i++
    if (SOFT_WAKE.has(normalizeWord(words[i])) && vocativeEnd(words, i)) {
      return { found: true, soft: true, name: vera, text: afterWake(words, i + 1) }
    }
    // Warm: "Hey there, ..." only right after Vera was active.
    if (opts.recentlyActive && words.length >= 2) {
      const a = normalizeWord(words[0])
      const b = normalizeWord(words[1])
      if (WARM_WAKE.some(([x, y]) => x === a && y === b) && vocativeEnd(words, 1)) {
        return { found: true, soft: true, name: vera, text: afterWake(words, 2) }
      }
    }
  }
  // Trailing vocative: "what's the time, Vera?"
  const last = found(words[words.length - 1])
  if (last && (last.kind === "exact" || opts.soft !== false)) {
    return { found: true, name: last.name, text: cleanEdges(words.slice(0, -1).join(" ")) }
  }
  // Anywhere else: keep the sentence as said (the name itself only).
  const inside = words.map(found).find((m) => m?.kind === "exact")
  if (inside) return { found: true, name: inside.name, text: text.trim() }
  return { found: false, text: text.trim() }
}

/** How a phrase's other words may be heard: "hey" as "hay", "hi", "hei", ... */
const WORD_ALIKE: Record<string, string[]> = {
  hey: ["hey", "hay", "hei", "hae", "heh", "hi", "heya", "hiya"],
  hi: ["hi", "hey", "hay"],
  okay: ["okay", "ok", "okey", "kay"],
  ok: ["ok", "okay", "okey"],
}

/** The phrases that wake a persona: its own, else "hey <name>". */
export function phrasesOf(p: WakeName): string[] {
  return p.phrases ?? [`hey ${p.name}`]
}

/**
 * Personas by wake phrase, then (for those with `bare`) by the name alone.
 * A phrase is matched word for word with punctuation ignored ("Hey, Vera."),
 * its name word fuzzily as the name is (exact anywhere; a near miss, or for
 * Vera "Sarah"/"Variable", only leading), and its other words by sound
 * ("hay Vera"). "Hey there," (a misheard "Hey Vera") wakes Vera near a recent
 * interaction, whether or not her name alone does.
 */
function stripPersonas(text: string, opts: WakeOptions, personas: WakeName[]): WakeMatch {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { found: false, text: "" }
  const extra = (opts.extra ?? []).map((w) => w.toLowerCase())
  const maxLeading = opts.maxLeadingWords ?? 3
  const soft = opts.soft !== false
  const keys = words.map((w) => normalizeWord(w).replace(/'/g, ""))
  const vera = personas.find((p) => nameKey(p.name) === "vera")

  type Hit = { at: number; len: number; name: string; kind: "exact" | "near" | "soft" }
  const hits: Hit[] = []
  for (const [pi, p] of personas.entries()) {
    const key = nameKey(p.name)
    for (const phrase of phrasesOf(p)) {
      const tokens = normalizePhrase(phrase).replace(/'/g, "").split(" ").filter(Boolean)
      if (!tokens.length) continue
      const fused = tokens.join("")
      for (let i = 0; i < words.length; i++) {
        // "Heyvera": the phrase run together into one word.
        if (tokens.length > 1 && keys[i] === fused) {
          hits.push({ at: i, len: 1, name: p.name, kind: "exact" })
          continue
        }
        if (i + tokens.length > words.length) break
        let kind: Hit["kind"] | null = "exact"
        for (const [j, t] of tokens.entries()) {
          const w = keys[i + j]
          if (t === key) {
            const m = wakeMatch(w, p.name, pi === 0 ? extra : [])
            const k = m ?? (vera === p && SOFT_WAKE.has(w) ? "soft" : null)
            if (!k) kind = null
            else if (k !== "exact") kind = k
          } else if (!(WORD_ALIKE[t] ?? [t]).includes(w)) kind = null
          if (!kind) break
        }
        if (kind) hits.push({ at: i, len: tokens.length, name: p.name, kind })
      }
    }
  }
  const leading = (i: number) => i <= maxLeading && keys.slice(0, i).every((w) => FILLERS.has(w))
  const explicit = (h: Hit) => keys.slice(h.at, h.at + h.len).some((w) => w === nameKey(h.name) || w.endsWith(nameKey(h.name)))
  const result = (h: Hit, rest: string): WakeMatch => ({
    found: true,
    name: h.name,
    text: rest,
    ...(h.kind !== "exact" ? { soft: true } : {}),
    ...(h.kind === "exact" && explicit(h) ? { explicit: true } : {}),
  })
  // Leading: "Hey Vera, what time is it?" (a near miss or "Hey Sarah," counts here only).
  const lead = hits
    .filter((h) => leading(h.at) && (h.kind === "exact" || (soft && (h.kind === "near" || vocativeEnd(words, h.at + h.len - 1)))))
    .sort((a, b) => a.at - b.at || (a.kind === "exact" ? -1 : 1))[0]
  if (lead) return result(lead, afterWake(words, lead.at + lead.len))

  // The name alone, for personas that allow it.
  const bare = personas.filter((p) => p.bare).map((p) => p.name)
  const b = stripBare(text, { ...opts, recentlyActive: false }, bare, !!vera?.bare)
  if (b.found) return b

  // Warm: "Hey there, ..." only right after she was active.
  if (vera && soft && opts.recentlyActive && words.length >= 2) {
    if (WARM_WAKE.some(([x, y]) => x === keys[0] && y === keys[1]) && vocativeEnd(words, 1)) {
      return { found: true, soft: true, name: vera.name, text: afterWake(words, 2) }
    }
  }
  const exact = hits.filter((h) => h.kind === "exact")
  // Trailing: "what's the weather, hey Vera?"
  const tail = exact.find((h) => h.at + h.len === words.length)
  if (tail) return result(tail, cleanEdges(words.slice(0, tail.at).join(" ")))
  // Anywhere else: keep the sentence as said.
  if (exact.length) return result(exact[0], text.trim())
  return { found: false, text: text.trim() }
}

/**
 * The name alone, said to her the way that woke her before wake phrases
 * ("Vera, what time is it?"), of a persona it no longer wakes: who he meant,
 * so Core can tell him once how she wakes now. Null otherwise ("Vera the app
 * is...": not said to her).
 */
export function bareNameAddress(text: string, personas: WakeName[], maxLeading = 3): string | null {
  const words = text.trim().split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length - 1 && i < maxLeading && FILLERS.has(normalizeWord(words[i]))) i++
  if (!words[i] || !vocativeEnd(words, i)) return null
  const w = normalizeWord(words[i]).replace(/'/g, "")
  return personas.find((p) => !p.bare && nameKey(p.name) === w)?.name ?? null
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

/**
 * `persona`: the name he said, as itself, which switches who answers. Absent
 * for follow-ups, direct turns, and wakes through a mishearing ("Vara",
 * "Hey there,", "Alfread"): those keep whoever answered last.
 */
export type GateResult =
  | { action: "ignore"; reason: string }
  | { action: "wake"; text: ""; persona?: string } // bare wake word: listen for the next utterance
  | { action: "stop"; text: string; persona?: string }
  | { action: "turn"; text: string; via: "wake" | "followup" | "direct"; persona?: string }

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
  const persona = m.found && m.name && m.explicit ? { persona: m.name } : {}
  if (!text) return { action: "wake", text: "", ...persona }
  if (isStopPhrase(text)) return { action: "stop", text, ...persona }
  return { action: "turn", text, via, ...persona }
}
