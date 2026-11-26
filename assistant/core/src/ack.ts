/**
 * Harness acknowledgements: no dead air while she works.
 *
 * When a turn's first brain action is a slow tool call (anything but
 * `speak` and a few instant ones) and she still hasn't said anything
 * `ACK_AFTER_MS` after it started, Core says a short line in the current
 * persona's voice and manner ("One sec.", "Checking."). A plain answer, a
 * quick tool, or a remark that needs no reply never gets one: Shawn found
 * acknowledgements on silence alone (before every slow-ish answer) worse
 * than none. Both are OFF by default (`turn.acknowledgeMs`,
 * `turn.silenceAckMs` are 0): her system prompt decides when she says
 * "on it" herself, so Shawn tunes it there. This is only a fallback he can
 * turn on in config. The voice
 * service keeps these rendered (Core warms them at start and when personas
 * change), so they play at once. Turns meant to end silently ("thanks",
 * "okay") never get one, nor does one she answers quickly. Once Core has
 * acknowledged, her own opening "checking" is dropped and the next tool
 * result tells her it was said. Barge-in cuts it like any line of the turn.
 */
import type { Persona } from "./config.ts"

/** How long a slow first tool may run with her silent before Core acknowledges. */
export const ACK_AFTER_MS = 1500

/** Tools that answer at once: calling one first isn't a reason to acknowledge. */
export const QUICK_TOOLS = new Set([
  "speak", "show", "hide", "set_volume", "set_voice", "switch_persona", "set_name", "inbox", "job_status", "cancel_job",
  "config_get", "skill_list", "skill_read", "read_system_prompt", "mcp_list",
])

/** Lines meant to end the exchange: no reply needed, so no acknowledgement. */
const SILENT = /^(?:(?:ok(?:ay)?|k|thanks?(?: you)?(?: so much| very much)?|thank you|ty|cheers|cool|nice|great|perfect|awesome|got it|gotcha|alright|all right|sounds good|good|fine|sure|yep|yeah|yes|no|nope|nah|never ?mind|forget it|that's all|that's it|nothing|bye|good ?night|see you|later|hmm+|mm+|uh huh|wow|lol|ha(?:ha)*)[\s,.!?]*)+$/i

/** Whether `text` (the wake word already stripped) is a turn that ends silently. */
export function endsSilently(text: string): boolean {
  const t = text.replace(/^\[[^\]]*\]\s*/g, "").trim()
  if (!t) return true
  return SILENT.test(t.replace(/\b(vera|alfred|jarvis|optimus|buzz|saul|tony)\b[,.]?/gi, "").trim() || "ok")
}

/** Each built-in persona's acknowledgements, in character. */
const BUILT_IN: Record<string, string[]> = {
  vera: ["One sec.", "Checking.", "On it.", "Give me a second."],
  alfred: ["One moment, sir.", "Right away, sir.", "Allow me a moment."],
  jarvis: ["Right away, sir.", "One moment, sir.", "Checking now, sir."],
  optimus: ["Stand by.", "One moment.", "Checking now."],
  buzz: ["Scanning!", "Stand by, space ranger.", "Checking the star charts."],
  saul: ["Gimme a sec.", "Hang on, hang on.", "Let me make a call."],
  tony: ["Gimme a sec.", "Hold on.", "Lemme check."],
}

const GENERIC = ["One sec.", "Checking.", "Give me a second."]

/** A persona's acknowledgements: its own (`acks` in config), its built-in ones, else plain ones. */
export function acksFor(persona: Pick<Persona, "name"> & { acks?: unknown }): string[] {
  const own = Array.isArray(persona.acks) ? persona.acks.filter((a): a is string => typeof a === "string" && !!a.trim() && a.length <= 48) : []
  if (own.length) return own
  return BUILT_IN[persona.name.toLowerCase()] ?? GENERIC
}

/** The `n`th acknowledgement for a persona (they rotate, so it doesn't sound canned). */
export function pickAck(persona: Pick<Persona, "name"> & { acks?: unknown }, n: number): string {
  const all = acksFor(persona)
  return all[Math.abs(n) % all.length]
}

/** A sentence that only acknowledges ("Checking.", "Let me look.", "One moment, sir."). */
const ACK_SENTENCE =
  /^(?:(?:ok(?:ay)?|sure|right|alright|yes|yep)[, ]+)?(?:one (?:sec(?:ond)?|moment|minute)|just a (?:sec(?:ond)?|moment)|give me (?:a )?(?:sec(?:ond)?|moment|minute)|gimme (?:a )?sec|hang on|hold on|stand by|checking(?: (?:now|that|on (?:it|that)))?|let me (?:check|look|see)(?: (?:that|on that|now))?|lemme (?:check|look|see)|looking(?: (?:now|into it))?|on it|right away|allow me a moment|working on it)(?:,? sir)?[.!…]*$/i

/**
 * Her first line after Core acknowledged: without its opening
 * acknowledgement ("Checking. It finished." -> "It finished."), or "" when
 * it was nothing else.
 */
export function stripOpeningAck(text: string): string {
  const parts = text.trim().match(/[^.!?…]+[.!?…]*\s*/g) ?? []
  let i = 0
  while (i < parts.length && ACK_SENTENCE.test(parts[i].trim())) i++
  return parts.slice(i).join("").trim()
}

/** What the tool result after a harness acknowledgement tells her. */
export function ackNote(said: string): string {
  return `[Core already said "${said}" out loud for you while this ran. Don't acknowledge again: no "checking" or "one sec"; go straight to the answer.]`
}

/** Whether calling `tool` first in a turn calls for an acknowledgement. */
export function slowTool(tool: string): boolean {
  const name = tool.replace(/^mcp__assistant__/, "")
  return !QUICK_TOOLS.has(name)
}
