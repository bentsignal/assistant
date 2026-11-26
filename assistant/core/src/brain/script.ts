import { EventEmitter } from "node:events"
import { spawn } from "node:child_process"
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
 * same HTTP tool endpoint the MCP server uses. `{ "mcp": { "server", "tool",
 * "args" } }` calls a tool on one of her own stdio MCP servers (mcp.json) as
 * Claude would: "tool" and "tool_done" events, and an interrupt while it
 * runs cancels it with Claude's denial text. Every turn message is
 * appended to `<stateDir>/script-brain.log.jsonl`, so tests can check what
 * the brain was told (inbox digests, interruption notes).
 *
 * Like Claude, it takes a message steered into a running turn (`steer()`)
 * at its next step: logged with `steered: true`, and the first rule matching
 * it replaces the turn's remaining steps. A file of the shape
 * `{ "steer": false, "rules": [...] }` makes it refuse, as Codex does.
 */
interface Step {
  tool?: string
  args?: Record<string, unknown>
  sleep?: number
  fail?: string
  throw?: string
  hang?: boolean | "deaf"
  mcp?: { server: string; tool: string; args?: Record<string, unknown> }
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
  private steered: string[] = []
  private callSeq = 0

  constructor(private opts: BrainOptions) {
    super()
  }

  async start() {
    // Tests read the prompt this brain was given (her name in it, for one).
    writeFileSync(join(this.opts.stateDir, "script-brain.prompt.md"), this.opts.systemPrompt)
  }

  private script(): { steer: boolean; rules: Rule[] } {
    const file = join(this.opts.stateDir, "script-brain.json")
    if (!existsSync(file)) return { steer: true, rules: [] }
    const s = JSON.parse(readFileSync(file, "utf8"))
    return Array.isArray(s) ? { steer: true, rules: s } : { steer: s.steer !== false, rules: s.rules ?? [] }
  }

  private rules(): Rule[] {
    return this.script().rules
  }

  private record(text: string, steered = false) {
    appendFileSync(join(this.opts.stateDir, "script-brain.log.jsonl"), JSON.stringify({ at: Date.now(), text, ...(steered ? { steered } : {}) }) + "\n")
  }

  steer(text: string): boolean {
    if (!this.busy || !this.script().steer) return false
    this.steered.push(text)
    return true
  }

  /** One tools/call on her stdio server `step.server`; an abort cancels it the way Claude does. */
  private async callMcp(step: NonNullable<Step["mcp"]>, abort: Promise<void>): Promise<string> {
    const id = `script_${++this.callSeq}`
    this.emit("tool", { id, name: `mcp__${step.server}__${step.tool}`, input: step.args ?? {} })
    const s = this.opts.servers?.[step.server]
    let result: string
    if (!s || s.type !== "stdio") result = `ERROR no stdio server ${step.server}`
    else {
      const child = spawn(s.command, s.args, { env: { ...process.env, ...s.env }, stdio: ["pipe", "pipe", "ignore"] })
      const answers = new Map<number, (m: any) => void>()
      const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n")
      let buf = ""
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (d: string) => {
        buf += d
        let i
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i)
          buf = buf.slice(i + 1)
          try {
            const m = JSON.parse(line)
            answers.get(m.id)?.(m)
          } catch {}
        }
      })
      const ask = (rid: number, method: string, params: unknown) =>
        new Promise<any>((r) => {
          answers.set(rid, r)
          send({ jsonrpc: "2.0", id: rid, method, params })
        })
      try {
        await ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "script", version: "1" } })
        send({ jsonrpc: "2.0", method: "notifications/initialized" })
        const res = await Promise.race([ask(2, "tools/call", { name: step.tool, arguments: step.args ?? {} }), abort.then(() => null)])
        if (res === null) {
          send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "interrupted" } })
          result = "The user doesn't want to proceed with this tool use. The tool use was rejected."
        } else result = res.error ? `ERROR ${res.error.message}` : (res.result?.content ?? []).map((c: any) => c.text ?? "").join("\n")
      } finally {
        setTimeout(() => child.kill(), 300).unref()
      }
    }
    this.emit("tool_done", { id, result })
    return result
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
      this.record(text)
      const rule = this.rules().find((r) => new RegExp(r.match, "i").test(text))
      let steps: Step[] = rule?.steps ?? [{ tool: "speak", args: { text: "Okay." } }]
      for (let n = 0; ; n++) {
        // A message steered in meanwhile: taken now, and its rule goes on from here.
        while (this.steered.length && !interrupted) {
          const more = this.steered.shift()!
          this.record(more, true)
          const r = this.rules().find((x) => new RegExp(x.match, "i").test(more))
          if (r) steps = [...steps.slice(0, n), ...r.steps]
        }
        const step = steps[n]
        if (!step || interrupted) break
        if (step.sleep) await Promise.race([new Promise((r) => setTimeout(r, step.sleep)), abort])
        if (step.hang === "deaf") await new Promise(() => {})
        if (step.hang) await abort
        if (interrupted) break
        if (step.throw) throw new Error(step.throw)
        if (step.fail) return { ok: false, text: results.join("\n"), error: step.fail }
        if (step.mcp) results.push(`${step.mcp.tool}: ${await this.callMcp(step.mcp, abort)}`)
        if (step.tool) results.push(`${step.tool}: ${await this.call(step.tool, step.args ?? {})}`)
      }
      const out = results.join("\n")
      if (out) this.emit("text", out)
      return { ok: true, text: out, interrupted }
    } finally {
      this.busy = false
      this.aborted = null
      this.steered = []
    }
  }

  async interrupt() {
    this.aborted?.()
  }

  async close() {
    this.aborted?.()
  }
}
