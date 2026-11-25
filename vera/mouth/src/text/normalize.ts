// Turn whatever the brain hands to speak() into plain, speakable English.
//
// Order matters: block structure (code fences, lists, tables) first, then
// links and paths (which contain dots and slashes the later passes would
// mangle), then symbols, numbers, abbreviations, and acronyms.

import {
  decimalToWords,
  intToWords,
  moneyToWords,
  numberToWords,
  ordinalToWords,
  timeToWords,
  yearToWords,
} from "./numbers.ts"

/** Acronyms said as a word rather than spelled. Lowercase keys. */
const SAY_AS_WORD: Record<string, string> = {
  json: "jason", yaml: "yammel", toml: "tommel", nasa: "nasa", ram: "ram", gif: "gif",
  ok: "okay", todo: "to do", readme: "read me", wifi: "wifi", oauth: "oh auth",
  ascii: "askey", scsi: "scuzzy", gui: "gooey", sql: "sequel", nato: "nato", asap: "A sap",
  lol: "lol", cors: "cors", cron: "cron", regex: "rej ex", npm: "N P M", pnpm: "P N P M",
  vram: "V ram", wasm: "wasm", grok: "grok",
}

/** Words that read badly as written. Case-insensitive whole words. */
const RESPELL: Record<string, string> = {
  github: "git hub", gitlab: "git lab", vscode: "V S code", nodejs: "node J S", "node.js": "node J S",
  kubectl: "cube control", sudo: "sue doo", stdin: "standard in", stdout: "standard out",
  stderr: "standard error", async: "a sync", eslint: "E S lint", tsconfig: "T S config",
  localhost: "local host", t3: "T three", npm: "N P M", pnpm: "P N P M", tsx: "T S X",
  macos: "mac O S", ios: "eye O S", ffmpeg: "F F M peg", ffplay: "F F play", pwsh: "power shell", wsl: "W S L",
}

const ABBREVIATIONS: [RegExp, string][] = [
  [/\be\.g\.,?/gi, "for example,"],
  [/\bi\.e\.,?/gi, "that is,"],
  [/\betc\./gi, "et cetera."],
  [/\bvs\.?(?=\s)/gi, "versus"],
  [/\bapprox\./gi, "approximately"],
  [/\bw\/o\b/gi, "without"],
  [/\bw\/(?=\s)/gi, "with"],
  [/\bMr\.(?=\s)/g, "Mister"],
  [/\bMrs\.(?=\s)/g, "Missus"],
  [/\bMs\.(?=\s)/g, "Miz"],
  [/\bDr\.(?=\s)/g, "Doctor"],
  [/\bno\.(?=\s*\d)/gi, "number"],
  [/\bmins?\b/g, "minutes"],
  [/\bsecs?\b/g, "seconds"],
  [/\bhrs?\b/g, "hours"],
  [/\bimo\b/gi, "in my opinion"],
  [/\bbtw\b/gi, "by the way"],
  [/\bfyi\b/gi, "for your information"],
  [/\btl;?dr\b/gi, "in short"],
]

const LETTER_NAMES: Record<string, string> = {
  a: "A", b: "B", c: "C", d: "D", e: "E", f: "F", g: "G", h: "H", i: "I", j: "J", k: "K",
  l: "L", m: "M", n: "N", o: "O", p: "P", q: "Q", r: "R", s: "S", t: "T", u: "U", v: "V",
  w: "double-you", x: "X", y: "Y", z: "Z",
}

/** Spell an acronym: "CLI" -> "C L I". The Kokoro lexicon reads single letters by name. */
export function spell(word: string): string {
  return [...word.toLowerCase()].map((c) => LETTER_NAMES[c] ?? (/\d/.test(c) ? intToWords(Number(c)) : "")).filter(Boolean).join(" ")
}

const EXTENSIONS: Record<string, string> = {
  ts: "T S", tsx: "T S X", js: "J S", jsx: "J S X", mjs: "M J S", cjs: "C J S", rs: "R S",
  py: "pie", md: "M D", json: "jason", yaml: "yammel", yml: "yammel", toml: "tommel",
  txt: "text", html: "H T M L", css: "C S S", sh: "S H", ps1: "P S one", exe: "exe",
  go: "go", rb: "ruby", java: "java", kt: "kotlin", swift: "swift", c: "C", h: "H",
  cpp: "C P P", hpp: "H P P", cs: "C sharp", lock: "lock", log: "log", wav: "wave",
  mp3: "M P three", png: "P N G", jpg: "jay peg", jpeg: "jay peg", svg: "S V G", pdf: "P D F",
  zip: "zip", csv: "C S V", xml: "X M L", sql: "sequel", env: "env", wgsl: "W G S L",
  onnx: "onnx", bin: "bin", dll: "D L L", ndjson: "N D jason", nix: "nix", vue: "view",
}
const EXT_RE = Object.keys(EXTENSIONS).sort((a, b) => b.length - a.length).join("|")

/** Read an identifier: snake_case, kebab-case, camelCase, dotted. */
export function speakIdentifier(id: string): string {
  return id
    .replace(/\(\)$/, "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_]+/g, " ")
    .replace(/::/g, " ")
    .replace(/\.(?=[A-Za-z])/g, " dot ")
    .replace(/\s+/g, " ")
    .trim()
}

function speakFileName(name: string): string {
  const m = new RegExp(`^(.*?)\\.(${EXT_RE})$`, "i").exec(name)
  if (!m) return speakIdentifier(name.replace(/^\./, "dot "))
  const stem = m[1] ? speakIdentifier(m[1].replace(/^\./, "dot ")) : ""
  return `${stem} dot ${EXTENSIONS[m[2].toLowerCase()]}`.trim()
}

/**
 * Read a file path the way a person would: the file name, and the folder it's in.
 * "src/dictation/audio.rs" -> "audio dot R S in dictation".
 */
export function speakPath(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter((p) => p && p !== ".")
  if (parts.length === 0) return "the root folder"
  const cleaned = parts.filter((p) => !/^[A-Za-z]:$/.test(p))
  const name = cleaned.at(-1) ?? parts.at(-1)!
  const spokenName = name === "~" ? "your home folder" : name === ".." ? "the parent folder" : speakFileName(name)
  if (cleaned.length < 2) return spokenName
  let parent = cleaned.at(-2)!
  if (parent === "~") return `${spokenName} in your home folder`
  if (parent === "..") return `${spokenName} in the parent folder`
  if (parent.startsWith(".")) parent = `dot ${parent.slice(1)}`
  return `${spokenName} in ${speakIdentifier(parent)}`
}

/** Inline code: a path, an identifier, or a short expression. */
function speakCode(code: string): string {
  const c = code.trim()
  if (looksLikePath(c)) return speakPath(c)
  if (/^[\w$.:-]+(\(\))?$/.test(c)) {
    if (new RegExp(`\\.(${EXT_RE})$`, "i").test(c)) return speakFileName(c)
    return speakIdentifier(c.replace(/-/g, " "))
  }
  return c
}

function looksLikePath(s: string): boolean {
  if (/\s/.test(s)) return false
  if (/^[A-Za-z]:[\\/]/.test(s)) return true
  if (/^(~|\.{1,2})?[\\/][\w.-]/.test(s)) return true
  return /^[\w.@-]+([\\/][\w.@-]+)+[\\/]?$/.test(s) && /[\\/]/.test(s) && !/^\d+\/\d+$/.test(s)
}

const UNITS: Record<string, [string, string]> = {
  ms: ["millisecond", "milliseconds"], s: ["second", "seconds"], sec: ["second", "seconds"],
  min: ["minute", "minutes"], m: ["minute", "minutes"], h: ["hour", "hours"], hr: ["hour", "hours"],
  kb: ["kilobyte", "kilobytes"], mb: ["megabyte", "megabytes"], gb: ["gigabyte", "gigabytes"],
  tb: ["terabyte", "terabytes"], kib: ["kibibyte", "kibibytes"], mib: ["mebibyte", "mebibytes"],
  gib: ["gibibyte", "gibibytes"], hz: ["hertz", "hertz"], khz: ["kilohertz", "kilohertz"],
  mhz: ["megahertz", "megahertz"], ghz: ["gigahertz", "gigahertz"], km: ["kilometer", "kilometers"],
  cm: ["centimeter", "centimeters"], mm: ["millimeter", "millimeters"],
  kg: ["kilogram", "kilograms"], g: ["gram", "grams"], lb: ["pound", "pounds"], lbs: ["pound", "pounds"],
  oz: ["ounce", "ounces"], ml: ["milliliter", "milliliters"], l: ["liter", "liters"],
  px: ["pixel", "pixels"], k: ["thousand", "thousand"], x: ["times", "times"],
  db: ["decibel", "decibels"], fps: ["frames per second", "frames per second"],
  "°f": ["degree Fahrenheit", "degrees Fahrenheit"], "°c": ["degree Celsius", "degrees Celsius"],
  "°": ["degree", "degrees"],
}
const UNIT_RE = Object.keys(UNITS).sort((a, b) => b.length - a.length).map((u) => u.replace("°", "°")).join("|")

function numbers(t: string): string {
  // Times: 3:45, 3:45pm, 10:00 a.m.
  t = t.replace(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?(?![\w:])/gi, (_m, h, m, mer) =>
    Number(h) < 25 && Number(m) < 60
      ? timeToWords(Number(h), Number(m), mer?.toLowerCase()) + (mer?.endsWith(".") ? "." : "")
      : _m,
  )
  t = t.replace(/\b(\d{1,2})\s*([ap])\.?m(\.?)(?!\w)/gi, (_m, h, ap, dot) => `${intToWords(Number(h))} ${ap.toUpperCase()} M${dot}`)
  // Money.
  t = t.replace(/([$€£])\s?(\d[\d,]*(?:\.\d+)?)\s(thousand|million|billion|trillion)\b/gi, (_m, sym, amt, scale) =>
    `${numberToWords(amt)} ${scale} ${moneyToWords(sym, "2").split(" ").pop()}`,
  )
  t = t.replace(/([$€£])\s?(\d[\d,]*(?:\.\d+)?)(?:(k|m|bn|b)\b)?/gi, (_m, sym, amt, mag) => moneyToWords(sym, amt, mag))
  // Percent.
  t = t.replace(/(-?\d[\d,]*(?:\.\d+)?)\s?%/g, (_m, n) => `${numberToWords(n)} percent`)
  // Versions: v1.2.3, version 2.0.1
  t = t.replace(/\bv(\d+(?:\.\d+)+)\b/gi, (_m, v) => `version ${v.split(".").map((p: string) => intToWords(Number(p))).join(" point ")}`)
  t = t.replace(/\b(\d+\.\d+\.\d+(?:\.\d+)*)\b/g, (_m, v) => v.split(".").map((p: string) => intToWords(Number(p))).join(" point "))
  // Ordinals.
  t = t.replace(/\b(\d+)(st|nd|rd|th)\b/gi, (_m, n) => ordinalToWords(Number(n)))
  // Fractions like 1/2 and ratios like 3/4.
  t = t.replace(/\b1\/2\b/g, "one half").replace(/\b1\/4\b/g, "one quarter").replace(/\b3\/4\b/g, "three quarters")
  t = t.replace(/\b(\d+)\/(\d+)\b/g, (_m, a, b) => `${intToWords(Number(a))} out of ${intToWords(Number(b))}`)
  // Ranges: 3-5, 10–20 (not dates or phone numbers).
  t = t.replace(/\b(\d+)\s?[–—-]\s?(\d+)\b(?![-–]\d)/g, (_m, a, b) => `${numberToWords(a)} to ${numberToWords(b)}`)
  // Number + unit: 250ms, 5 MB, 3x, 72°F.
  t = t.replace(new RegExp(`(-?\\d[\\d,]*(?:\\.\\d+)?)(\\s?)(${UNIT_RE})(?![\\w°])`, "gi"), (_m, n, sp, u) => {
    if (sp && u.length === 1) return _m // "5 m" is too ambiguous; "5m" is minutes
    const [one, many] = UNITS[u.toLowerCase()]
    const v = n.replace(/,/g, "")
    return `${numberToWords(n)} ${Number(v) === 1 ? one : many}`
  })
  // Issue / PR numbers: #123
  t = t.replace(/#(\d+)\b/g, (_m, n) => `number ${intToWords(Number(n))}`)
  // Years: a standalone 4-digit number from 1100 to 2099 not followed by a unit-like word.
  t = t.replace(/\b(1[1-9]\d\d|20\d\d)\b(?![.,]\d)/g, (_m, y) => yearToWords(Number(y)))
  // Decimals and grouped or plain integers.
  t = t.replace(/(?<![\w.])-?\d[\d,]*\.\d+\b/g, (m) => decimalToWords(m.replace(/,/g, "")))
  t = t.replace(/(?<![\w.])-?\d{1,3}(?:,\d{3})+\b/g, (m) => numberToWords(m))
  t = t.replace(/(?<![\w])-?\d+\b/g, (m) => numberToWords(m))
  // Digits glued to letters ("t3", "mp3", "gpt4o"): spell short letter runs, then the number.
  t = t.replace(/\b([A-Za-z]{1,3})(\d+)\b/g, (_m, l, n) => `${spell(l)} ${numberToWords(n)}`)
  t = t.replace(/(\d+)/g, (m) => ` ${numberToWords(m)} `)
  return t
}

function stripMarkdown(t: string): string {
  // Fenced code blocks: never read code aloud.
  t = t.replace(/(^|\n)\s*(```|~~~)[^\n]*\n[\s\S]*?(\n\s*\2[^\n]*|$)/g, "\n")
  t = t.replace(/```[\s\S]*?```/g, " ")
  // HTML tags and comments.
  t = t.replace(/<!--[\s\S]*?-->/g, " ").replace(/<\/?[a-z][^>]*>/gi, " ")
  // Images, links, autolinks.
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => (alt ? alt : " "))
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  t = t.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
  t = t.replace(/<(https?:\/\/[^>]+)>/g, "$1")
  // Tables: separator rows go, cells become a list.
  t = t.replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, "")
  t = t.replace(/^\s*\|(.*)\|\s*$/gm, (_m, row: string) => row.split("|").map((c) => c.trim()).filter(Boolean).join(", ") + ".")
  // Headings, blockquotes, rules, list markers. Each line becomes its own phrase.
  t = t.replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/gm, (_m, h) => endPhrase(h))
  t = t.replace(/^\s*>+\s?/gm, "")
  t = t.replace(/^\s*([-*_])\s*(\1\s*){2,}$/gm, "")
  t = t.replace(/^\s*(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/gm, (_m, item) => endPhrase(item))
  // Emphasis and strike-through (only when the markers hug a word).
  t = t.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
  t = t.replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1")
  t = t.replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1")
  t = t.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
  // Inline code: read paths and identifiers sensibly.
  t = t.replace(/`([^`\n]+)`/g, (_m, code) => speakCode(code))
  return t
}

function endPhrase(s: string): string {
  const x = s.trim()
  if (!x) return ""
  return /[.!?:;,]$/.test(x) ? x : `${x}.`
}

function linksAndPaths(t: string): string {
  // URLs and bare domains.
  t = t.replace(/\b(?:https?|ftp|file):\/\/[^\s)<>\]"']+/gi, "a link")
  t = t.replace(/\bwww\.[^\s)<>\]"']+/gi, "a link")
  // Email addresses.
  t = t.replace(/\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)+)\b/g, (_m, user, host: string) => `${speakIdentifier(user.replace(/\./g, " dot "))} at ${host.split(".").join(" dot ")}`)
  // File paths: absolute (C:\, /, ~/, ./) or relative with a slash.
  t = t.replace(/(?<![\w/\\])(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/](?=[\w.]))[\w.@\\/-]*[\w/\\]/g, (m) => speakPath(m))
  // Scoped packages: @vera/mouth -> "at vera slash mouth".
  t = t.replace(/(?<![\w@])@([\w-]+)\/([\w.-]*[\w-])/g, (_m, scope, name) => `at ${speakIdentifier(scope)} slash ${speakIdentifier(name)}`)
  t = t.replace(/(?<![\w/\\.])[\w.@-]*[\w@-](?:\/[\w.@-]*[\w@-])+\/?(?=[\s,;:!?)]|\.(?:\s|$)|$)/g, (m) => {
    // Fractions and short word pairs (client/server, yes/no) aren't paths.
    if (/^\d+\/\d+$/.test(m) || (/^[a-z]+\/[a-z]+$/i.test(m) && !/\./.test(m))) return m
    return speakPath(m)
  })
  // Bare file names with a known extension: config.json, audio.rs.
  t = t.replace(new RegExp(`(?<![\\w/\\\\])([\\w-]+(?:\\.[\\w-]+)*)\\.(${EXT_RE})\\b(?!\\.\\w)`, "gi"), (m) => speakFileName(m))
  // Bare domains like example.com or anoma.ly.
  t = t.replace(/\b[a-z][\w-]*\.(?:com|org|net|io|dev|ai|ly|app|co|sh|gg|xyz|me)(?:\/[^\s]*)?\b/gi, "a link")
  return t
}

function symbols(t: string): string {
  t = t.replace(/\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic})*/gu, " ")
  t = t.replace(/[✓✔]/g, " ").replace(/[✗✘]/g, " ")
  t = t.replace(/#(\d+)\b/g, "number $1")
  t = t.replace(/(^|\s)--?(?=[a-z])/g, "$1") // command-line flags: read the flag name
  t = t
    .replace(/\s*(?:->|→|=>|⇒)\s*/g, " to ")
    .replace(/\s*(?:<-|←)\s*/g, " from ")
    .replace(/\s*!==?\s*/g, " is not ")
    .replace(/\s*===?\s*/g, " equals ")
    .replace(/\s*>=\s*/g, " at least ")
    .replace(/\s*<=\s*/g, " at most ")
    .replace(/\s*&&\s*/g, " and ")
    .replace(/\s*\|\|\s*/g, " or ")
    .replace(/(\w)\s*&\s*(\w)/g, "$1 and $2")
    .replace(/\s&\s/g, " and ")
    .replace(/~\s?(?=\d)/g, "about ")
    .replace(/≈\s?/g, "about ")
    .replace(/(\d)\s*\+\s*(\d)/g, "$1 plus $2")
    .replace(/(\w)\+\+/g, "$1 plus plus")
    .replace(/(\w)\+(?!\w)/g, "$1 plus")
    .replace(/(\d)\s*[x×]\s*(\d)/g, "$1 by $2")
    .replace(/\s*=\s*/g, " equals ")
    .replace(/(^|\s)@(\w)/g, "$1at $2")
    .replace(/\b(\w+)\/(\w+)\b/g, (_m, a, b) => (/^\d+$/.test(a) || /^\d+$/.test(b) ? `${a}/${b}` : `${a} or ${b}`))
    .replace(/\s*[|]\s*/g, ", ")
    .replace(/[*#^`<>{}[\]\\]/g, " ")
    .replace(/(\w)_(\w)/g, "$1 $2")
    .replace(/[“”„]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, "...")
    .replace(/\s+[–—]\s+|—/g, ", ")
  return t
}

function abbreviations(t: string): string {
  t = t.replace(/\band\/or\b/gi, "and or")
  for (const [re, rep] of ABBREVIATIONS) t = t.replace(re, rep)
  return t
}

/** Acronyms with vowels that are still spelled. */
const FORCE_SPELL = new Set(["uuid", "guid", "ieee", "ui", "ux", "ai", "os", "id", "io"])

function words(t: string): string {
  t = t.replace(/\b[\w.]+\b/g, (w) => RESPELL[w.toLowerCase()] ?? w)
  // camelCase / PascalCase identifiers in prose: createMouth -> create Mouth.
  t = t.replace(/\b[a-z]+(?:[A-Z][a-z\d]+)+\b/g, (w) => speakIdentifier(w))
  // ACRONYMS: spell unless they're said as a word.
  t = t.replace(/\b([A-Z][A-Z\d]{1,5})(s|'s)?\b/g, (m, ac: string, suffix?: string) => {
    if (/^\d/.test(ac) || !/[A-Z]/.test(ac)) return m
    if (ac === "I" || ac === "A") return m
    const lower = ac.toLowerCase()
    let said = SAY_AS_WORD[lower]
    if (!said && ac.length >= 4 && /[AEIOUY]/.test(ac) && !/\d/.test(ac) && !FORCE_SPELL.has(lower)) said = lower
    const base = said ?? spell(ac)
    if (!suffix) return base
    return said ? `${base}s` : `${base}'s`
  })
  return t
}

/** Collapse whitespace; drop dangling punctuation. */
function tidy(t: string): string {
  return t
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/([,;:])(?=[^\s\d])/g, "$1 ")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/([.!?])[,;:]+/g, "$1")
    .replace(/,{2,}/g, ",")
    .replace(/^[\s,.;:]+/gm, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[()]/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/[ ]{2,}/g, " ")
    .trim()
}

/** Normalize text for speech. Newlines that separate paragraphs and list items are kept. */
export function normalizeForSpeech(input: string): string {
  let t = input.replace(/\r\n?/g, "\n")
  t = stripMarkdown(t)
  t = linksAndPaths(t)
  t = abbreviations(t)
  t = symbols(t)
  t = numbers(t)
  t = words(t)
  return tidy(t)
}
