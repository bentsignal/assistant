/**
 * When Shawn's next words continue the turn Vera thought was over: he went
 * on while she was still thinking (nothing of her answer had played), or
 * just as she began answering (a barge-in within `bargeMergeSeconds` of her
 * first audio). Ears already waits out his pauses (`turn.*Ms`, see
 * `src/assistant_ears/patience.rs`); this catches the ones that ran longer.
 * Such words and the turn they continue are one message to the brain.
 */
import type { GateResult } from "./gate.ts"

export interface Resumable {
  turnId: number
  /** What he said in that turn (wake word already stripped). */
  text: string
  why: "thinking" | "barge"
  /** When he resumed (or barged in), local clock. */
  at: number
}

/** How long a resumption stays one: his words have to arrive by then. */
export const RESUME_FINAL_MS = 60_000

/**
 * Whether `g` continues `resume`: a turn he didn't address afresh ("Vera,
 * tell me a joke" is a new request; "and the tests too" goes on).
 */
export function continues(resume: Resumable | null, g: GateResult, now: number): boolean {
  if (!resume || now - resume.at > RESUME_FINAL_MS) return false
  return g.action === "turn" && g.via === "followup"
}

const CONTINUATION = /^(and|or|but|so|then|to|with|because|also|plus|like|of|for|in|on|the|a|an|my|your)\b/i

/** A first part that stops on one of these was cut mid-phrase (`patience.rs` has the full list). */
const DANGLING = /\b(and|or|but|so|because|to|of|for|with|from|about|the|a|an|my|your|um|umm|uh|er|erm|hmm|like)$/i

/** The two parts as one message, as he'd have said it without the pause. */
export function joinTurns(first: string, second: string): string {
  const a = first.trim()
  const b = second.trim()
  if (!a) return b
  if (!b) return a
  const lowered = /^[A-Z][a-z]/.test(b) && b !== "I" && !b.startsWith("I ") && !b.startsWith("I'")
  const dangling = DANGLING.test(a.replace(/\.$/, ""))
  if (a.endsWith(".") && !a.endsWith("..") && (dangling || CONTINUATION.test(b) || /^[a-z]/.test(b))) {
    return `${a.slice(0, -1)} ${lowered ? b[0].toLowerCase() + b.slice(1) : b}`
  }
  return `${a} ${b}`
}

/** The note the merged turn's message starts with. */
export function resumeNote(why: Resumable["why"]): string {
  return why === "barge"
    ? "[He hadn't finished: you'd only just started answering when he went on, and you stopped. His whole message is below, the earlier part included; answer all of it, not just the end.]"
    : "[He hadn't finished: he went on before you said anything, so that answer was cancelled. His whole message is below, the earlier part included; answer all of it.]"
}
