// Split normalized text into chunks that can be synthesized one at a time,
// so the first chunk plays while the rest are still being generated.

export interface Chunk {
  text: string
  /** Silence to insert after this chunk, in milliseconds. */
  pauseMs: number
}

export interface SplitOptions {
  /** A chunk longer than this many words is split at a clause boundary. */
  maxWords?: number
  /** The first chunk is kept shorter than this, when a clause boundary allows, to start talking sooner. */
  firstMaxWords?: number
}

const PAUSE = { sentence: 260, question: 300, clause: 110, colon: 180, paragraph: 420 }

function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length
}

function pauseFor(text: string, endOfParagraph: boolean): number {
  if (endOfParagraph) return PAUSE.paragraph
  const last = text.trim().slice(-1)
  if (last === "?" || last === "!") return PAUSE.question
  if (last === ":" || last === ";") return PAUSE.colon
  if (last === ",") return PAUSE.clause
  return PAUSE.sentence
}

/** Sentence boundaries: terminal punctuation followed by space and a non-lowercase start, or the end. */
export function splitSentences(paragraph: string): string[] {
  const out: string[] = []
  const re = /[^.!?]*(?:[.!?]+["')\]]*|$)/g
  let buf = ""
  for (const m of paragraph.matchAll(re)) {
    const piece = m[0]
    if (!piece) continue
    buf += piece
    const rest = paragraph.slice((m.index ?? 0) + piece.length)
    const endsSentence = /[.!?]["')\]]*$/.test(piece) && (rest === "" || /^\s+(?![a-z])/.test(rest))
    if (endsSentence || rest === "") {
      if (buf.trim()) out.push(buf.trim())
      buf = ""
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

/** Split at the clause boundary (, ; : or a dash) nearest the target word index. */
function splitAtClause(s: string, targetWords: number, minWords = 3): [string, string] | null {
  const candidates: { at: number; words: number }[] = []
  const re = /[,;:](?=\s)/g
  for (const m of s.matchAll(re)) {
    const at = (m.index ?? 0) + 1
    const w = words(s.slice(0, at))
    if (w >= minWords && words(s.slice(at)) >= minWords) candidates.push({ at, words: w })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => Math.abs(a.words - targetWords) - Math.abs(b.words - targetWords))
  const { at } = candidates[0]
  return [s.slice(0, at).trim(), s.slice(at).trim()]
}

/** Last resort for a run-on with no punctuation: split at a conjunction near the middle. */
function splitAtConjunction(s: string): [string, string] | null {
  const tokens = s.split(/\s+/)
  const mid = tokens.length / 2
  let best = -1
  for (let i = 3; i < tokens.length - 3; i++) {
    if (/^(and|but|so|because|which|while|then|or|that)$/i.test(tokens[i])) {
      if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i
    }
  }
  if (best < 0) return null
  return [tokens.slice(0, best).join(" "), tokens.slice(best).join(" ")]
}

function breakLong(s: string, maxWords: number): string[] {
  if (words(s) <= maxWords) return [s]
  const parts = splitAtClause(s, words(s) / 2) ?? splitAtConjunction(s)
  if (!parts) return [s]
  return parts.flatMap((p) => breakLong(p, maxWords))
}

export function splitForSpeech(text: string, opts: SplitOptions = {}): Chunk[] {
  const maxWords = opts.maxWords ?? 26
  const firstMaxWords = opts.firstMaxWords ?? 10
  const chunks: Chunk[] = []
  const paragraphs = text.split(/\n+/).map((p) => p.trim()).filter(Boolean)
  for (const [pi, para] of paragraphs.entries()) {
    const sentences = splitSentences(para).flatMap((s) => breakLong(s, maxWords))
    for (const [si, s] of sentences.entries()) {
      const lastInPara = si === sentences.length - 1 && pi < paragraphs.length - 1
      chunks.push({ text: s, pauseMs: pauseFor(s, lastInPara) })
    }
  }
  // Keep the first chunk short so audio starts quickly.
  if (chunks.length && words(chunks[0].text) > firstMaxWords) {
    const first = chunks[0]
    const parts = splitAtClause(first.text, Math.min(6, firstMaxWords - 2), 3)
    if (parts && words(parts[0]) <= firstMaxWords) {
      chunks.splice(0, 1, { text: parts[0], pauseMs: pauseFor(parts[0], false) }, { text: parts[1], pauseMs: first.pauseMs })
    }
  }
  if (chunks.length) chunks[chunks.length - 1].pauseMs = 0
  return chunks
}
