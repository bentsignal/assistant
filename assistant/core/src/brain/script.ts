import { EventEmitter } from "node:events"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Brain, BrainOptions, TurnResult } from "./types.ts"

/**
 * A scripted stand-in brain for headless tests (`brain.harness: "script"`).
 * It reads `<stateDir>/script-brain.json`:
 *
 *   [{ "match": "too loud", "steps": [{ "tool": "set_volume", "args": { "relative": "quieter" } },
 *                                     { "sleep": 200 },
 *                                     { "tool": "speak", "args": { "text": "Better?" } }] }]
 *
 * The first rule whose `match` (a case-insensitive regex) is found in the
 * turn message runs; no match speaks "Okay.". Failure steps, for tests:
 * `{ "fail": "why" }` ends the turn as a brain error, `{ "throw": "why" }`
 * throws, and `{ "hang": true }` never answers (until interrupted, or not
 * even then with `"hang": "deaf"`). Tool calls go through the
 * same HTTP tool endpoint the MCP server uses. Every turn message is
 * appended to `<stateDir>/script-brain.log.jsonl`, so tests can check what
 * the brain was told (inbox digests, interruption notes).
 */
interface Step {
  tool?: string
  args?: Record<string, unknown>
  sleep?: number
  fail?: string
  throw?: string
  hang?: boolean | "deaf"
}
interface Rule {
  match: string
  steps: Step[]
}

export class ScriptBrain extends EventEmitter implements Brain {
  readonly harness = "script" as const
  readonly label = "script"
  private aborted: (() => void) | null = null
  private busy = false

  constructor(private opts: BrainOptions) {
    super()
  }

  async start() {
    // Tests read the prompt this brain was given (her name in it, for one).
    writeFileSync(join(this.opts.stateDir, "script-brain.prompt.md"), this.opts.systemPrompt)
  }

  private rules(): Rule[] {
    const file = join(this.opts.stateDir, "script-brain.json")
    if (!existsSync(file)) return []
    return JSON.parse(readFileSync(file, "utf8"))
  }

  private async call(tool: string, args: unknown): Promise<string> {
    const res = await fetch(`${this.opts.mcp.env.ASSISTANT_URL}/api/tool`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-assistant-token": this.opts.mcp.env.ASSISTANT_TOKEN },
      body: JSON.stringify({ name: tool, args, brain: "script" }),
    })
    const body = (await res.json()) as { ok: boolean; text?: string; error?: string }
    return body.ok ? (body.text ?? "") : `ERROR ${body.error}`
  }

  async turn(text: string): Promise<TurnResult> {
    if (this.busy) throw new Error("a turn is already in flight")
    this.busy = true
    let interrupted = false
    const abort = new Promise<void>((r) => (this.aborted = () => ((interrupted = true), r())))
    const results: string[] = []
    try {
      appendFileSync(join(this.opts.stateDir, "script-brain.log.jsonl"), JSON.stringify({ at: Date.now(), text }) + "\n")
      const rule = this.rules().find((r) => new RegExp(r.match, "i").test(text))
      const steps: Step[] = rule?.steps ?? [{ tool: "speak", args: { text: "Okay." } }]
      for (const step of steps) {
        if (interrupted) break
        if (step.sleep) await Promise.race([new Promise((r) => setTimeout(r, step.sleep)), abort])
        if (step.hang === "deaf") await new Promise(() => {})
        if (step.hang) await abort
        if (interrupted) break
        if (step.throw) throw new Error(step.throw)
        if (step.fail) return { ok: false, text: results.join("\n"), error: step.fail }
        if (step.tool) results.push(`${step.tool}: ${await this.call(step.tool, step.args ?? {})}`)
      }
      const out = results.join("\n")
      if (out) this.emit("text", out)
      return { ok: true, text: out, interrupted }
    } finally {
      this.busy = false
      this.aborted = null
    }
  }

  async interrupt() {
    this.aborted?.()
  }

  async close() {
    this.aborted?.()
  }
}
