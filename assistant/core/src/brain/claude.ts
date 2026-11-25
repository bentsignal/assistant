import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"
import { killTree, onLines, spawnCli } from "../proc.ts"
import type { Brain, BrainOptions, TurnResult } from "./types.ts"

/**
 * Claude Code brain: one persistent `claude -p` with stream-json in and out.
 *
 * - Built-in tools are cut to WebSearch and WebFetch (`--tools`); the only
 *   other tools are the Vera MCP server's (`--mcp-config --strict-mcp-config`),
 *   allowed without prompts. Nothing can prompt (`--permission-prompts none`).
 * - User settings, hooks, plugins and slash commands are skipped
 *   (`--setting-sources "" --disable-slash-commands`).
 * - The system prompt comes from a file and is not snapshotted, so a restart
 *   with `--resume` picks up an edited prompt while keeping the conversation.
 */
export class ClaudeBrain extends EventEmitter implements Brain {
  readonly harness = "claude-code" as const
  private child: ChildProcess | null = null
  readonly sessionId: string
  private started: boolean
  private current: {
    resolve: (r: TurnResult) => void
    text: string
    interrupted: boolean
  } | null = null
  private ready: Promise<void> | null = null

  constructor(private opts: BrainOptions) {
    super()
    this.sessionId = opts.resume ?? randomUUID()
    this.started = !!opts.resume
  }

  get label() {
    return `claude-code ${this.opts.model ?? "default"}/${this.opts.effort ?? "default"}`
  }

  start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = this.spawn()
    return this.ready
  }

  private async spawn(): Promise<void> {
    const { opts } = this
    const mcpFile = join(opts.stateDir, "mcp-claude.json")
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { assistant: { type: "stdio", ...opts.mcp } } }, null, 2))
    const promptFile = join(opts.stateDir, "system-prompt.claude.md")
    writeFileSync(promptFile, opts.systemPrompt)
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--system-prompt-file",
      promptFile,
      "--system-prompt-snapshot",
      "off",
      "--tools",
      "WebSearch,WebFetch",
      "--allowedTools",
      "mcp__vera,WebSearch,WebFetch",
      "--permission-prompts",
      "none",
      "--mcp-config",
      mcpFile,
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      ...(this.started ? ["--resume", this.sessionId] : ["--session-id", this.sessionId]),
      ...(opts.model ? ["--model", opts.model] : []),
      ...(opts.effort ? ["--effort", opts.effort] : []),
    ]
    const child = spawnCli("claude", args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] })
    this.child = child
    this.started = true
    onLines(child.stdout!, (line) => this.onLine(line))
    onLines(child.stderr!, (line) => {
      if (!/sign-in ends/.test(line)) opts.log(`[claude stderr] ${line}`)
    })
    child.stdin!.on("error", () => {})
    child.on("exit", (code) => {
      opts.log(`[claude] exited ${code}`)
      if (this.child === child) {
        this.child = null
        this.ready = null
      }
      this.finish({ ok: false, text: this.current?.text ?? "", error: `claude exited (${code})` })
      this.emit("exit", code)
    })
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve())
      child.once("error", reject)
    })
  }

  private onLine(line: string) {
    let ev: any
    try {
      ev = JSON.parse(line)
    } catch {
      this.opts.log(`[claude] ${line}`)
      return
    }
    if (ev.type === "system" && ev.subtype === "init") {
      const assistant = (ev.mcp_servers ?? []).find((s: any) => s.name === "assistant")
      this.opts.log(`[claude] session ${ev.session_id} model ${ev.model} assistant-mcp=${assistant?.status ?? "missing"} tools=${(ev.tools ?? []).length}`)
      return
    }
    if (ev.type === "assistant" && this.current) {
      for (const c of ev.message?.content ?? []) {
        if (c.type === "text" && c.text) {
          this.current.text += c.text
          this.emit("text", c.text)
        } else if (c.type === "tool_use") this.emit("tool", { name: c.name, input: c.input })
      }
      return
    }
    if (ev.type === "result") {
      const interrupted = this.current?.interrupted ?? false
      this.finish({
        ok: !ev.is_error || interrupted,
        text: this.current?.text ?? "",
        error: ev.is_error && !interrupted ? String(ev.result ?? ev.subtype ?? "error") : undefined,
        interrupted,
      })
    }
  }

  private finish(r: TurnResult) {
    const cur = this.current
    this.current = null
    cur?.resolve(r)
  }

  async turn(text: string): Promise<TurnResult> {
    if (this.current) throw new Error("a turn is already in flight")
    await this.start()
    return new Promise<TurnResult>((resolve) => {
      this.current = { resolve, text: "", interrupted: false }
      const msg = { type: "user", message: { role: "user", content: [{ type: "text", text }] } }
      this.child!.stdin!.write(JSON.stringify(msg) + "\n")
    })
  }

  async interrupt(): Promise<void> {
    if (!this.current || !this.child) return
    this.current.interrupted = true
    const req = { type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } }
    this.child.stdin!.write(JSON.stringify(req) + "\n")
    // If the harness doesn't answer, don't hang the conversation.
    const cur = this.current
    setTimeout(() => {
      if (this.current === cur) this.finish({ ok: true, text: cur.text, interrupted: true })
    }, 3000).unref()
  }

  async close(): Promise<void> {
    const child = this.child
    this.child = null
    this.ready = null
    if (child) {
      child.stdin!.end()
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          killTree(child)
          resolve()
        }, 1500)
        child.once("exit", () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  }
}
