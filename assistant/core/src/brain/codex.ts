import { EventEmitter } from "node:events"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ChildProcess } from "node:child_process"
import { killTree, onLines, spawnCli } from "../proc.ts"
import type { ResolvedServer } from "../mcp/config.ts"
import type { Brain, BrainOptions, TurnResult } from "./types.ts"

/** TOML literal string: no escapes, so Windows paths survive. */
function tomlStr(s: string): string {
  if (!s.includes("'")) return `'${s}'`
  return JSON.stringify(s) // basic string with escapes
}

/** A TOML key: bare when it can be. */
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)
}

function tomlTable(o: Record<string, string>): string {
  return `{${Object.entries(o)
    .map(([k, v]) => `${tomlKey(k)}=${tomlStr(v)}`)
    .join(",")}}`
}

/**
 * One of her MCP servers as a Codex `-c mcp_servers.<name>=…` value: stdio
 * (command, args, env) or streamable HTTP (url, http_headers). Codex has no
 * legacy SSE transport, so an SSE server is left out (null).
 */
export function codexServer(s: ResolvedServer): string | null {
  const tail = `startup_timeout_sec=20,tool_timeout_sec=300,default_tools_approval_mode="approve"`
  if (s.type === "stdio") return `{command=${tomlStr(s.command)},args=[${s.args.map(tomlStr).join(",")}],env=${tomlTable(s.env)},${tail}}`
  if (s.type === "http") return `{url=${tomlStr(s.url)},http_headers=${tomlTable(s.headers)},${tail}}`
  return null
}

/** Features that would give the brain tools beyond the Assistant MCP server and web search. */
const DISABLED_FEATURES = [
  "apps",
  "plugins",
  "remote_plugin",
  "computer_use",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "image_generation",
  "multi_agent",
  "goals",
  "hooks",
  "skill_search",
  "tool_suggest",
  "sleep_tool",
  "view_image",
  "shell_tool",
  "unified_exec",
  // Not "code_mode_host": Codex's web search runs inside code mode's `exec`.
  // Vera's tools skip it (omit_tools_from) so `speak` is a direct call.
]

/** Core's name for a Codex MCP tool call: hers are `mcp__<server>__<tool>`, like Claude's. */
function codexToolName(item: any): string {
  const own = item.server && item.server !== "assistant"
  return own ? `mcp__${item.server}__${item.tool}` : item.tool
}

/** Names of the MCP servers in the user's Codex config, so the brain can switch them off. */
export function userMcpServers(): string[] {
  const file = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml")
  if (!existsSync(file)) return []
  const names = new Set<string>()
  for (const m of readFileSync(file, "utf8").matchAll(/^\s*\[mcp_servers\.("[^"]+"|[A-Za-z0-9_-]+)\]\s*$/gm)) {
    names.add(m[1].replace(/"/g, ""))
  }
  return [...names].filter((n) => n !== "assistant")
}

/**
 * Codex brain over `codex app-server` (JSON-RPC 2.0 on stdio), one thread
 * for the whole conversation. Shawn's ~/.codex/config.toml is never edited:
 * the MCP server set is replaced per process with `-c mcp_servers=...`,
 * extra tool features are switched off with `--disable`, web search is set
 * live, the sandbox is read-only, and the system prompt is the thread's base
 * instructions.
 */
export class CodexBrain extends EventEmitter implements Brain {
  readonly harness = "codex" as const
  private child: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private threadId: string | null = null
  private ready: Promise<void> | null = null
  private current: {
    resolve: (r: TurnResult) => void
    text: string
    turnId?: string
    interrupted: boolean
  } | null = null

  constructor(private opts: BrainOptions) {
    super()
  }

  get label() {
    return `codex ${this.opts.model ?? "default"}/${this.opts.effort ?? "default"}`
  }

  start(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = this.spawn().catch((err) => {
      this.ready = null
      throw err
    })
    return this.ready
  }

  private async spawn(): Promise<void> {
    const { opts } = this
    const env = Object.entries(opts.mcp.env)
      .map(([k, v]) => `${k}=${tomlStr(v)}`)
      .join(",")
    const assistant = `{command=${tomlStr(opts.mcp.command)},args=[${opts.mcp.args.map(tomlStr).join(",")}],env={${env}},startup_timeout_sec=20,tool_timeout_sec=600,default_tools_approval_mode="approve",omit_tools_from=["code_mode","deferred"]}`
    const args = [
      "app-server",
      "-c",
      `mcp_servers.assistant=${assistant}`,
      // Her own servers (~/.assistant/mcp.json).
      ...Object.entries(opts.servers ?? {}).flatMap(([n, s]) => {
        const v = codexServer(s)
        return v ? ["-c", `mcp_servers.${tomlKey(n)}=${v}`] : []
      }),
      // -c merges into the user's table, so switch their own servers off for the brain.
      ...userMcpServers()
        .filter((n) => !(n in (opts.servers ?? {})))
        .flatMap((n) => ["-c", `mcp_servers.${tomlKey(n)}.enabled=false`]),
      ...(opts.effort ? ["-c", `model_reasoning_effort="${opts.effort}"`] : []),
      "-c",
      'web_search="live"',
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'approval_policy="never"',
      ...DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
    ]
    const child = spawnCli("codex", args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] })
    this.child = child
    onLines(child.stdout!, (line) => this.onLine(line))
    onLines(child.stderr!, (line) => opts.log(`[codex stderr] ${line.slice(0, 500)}`))
    child.stdin!.on("error", () => {})
    child.on("exit", (code) => {
      opts.log(`[codex] exited ${code}`)
      if (this.child === child) {
        this.child = null
        this.ready = null
        this.threadId = null
      }
      for (const p of this.pending.values()) p.reject(new Error(`codex exited (${code})`))
      this.pending.clear()
      this.finish({ ok: false, text: this.current?.text ?? "", error: `codex exited (${code})` })
      this.emit("exit", code)
    })
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve())
      child.once("error", reject)
    })
    await this.request("initialize", {
      clientInfo: { name: "assistant", title: "Vera", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    this.notify("initialized", {})
    const res = await this.request("thread/start", {
      cwd: opts.cwd,
      model: opts.model ?? null,
      sandbox: "read-only",
      approvalPolicy: "never",
      baseInstructions: opts.systemPrompt,
      ephemeral: false,
      serviceName: "assistant",
    })
    this.threadId = res.thread.id
    opts.log(`[codex] thread ${this.threadId} model ${res.model} effort ${res.reasoningEffort ?? "-"}`)
  }

  private write(msg: object) {
    this.child?.stdin?.write(JSON.stringify(msg) + "\n")
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: "2.0", id, method, params })
    })
  }

  private notify(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params })
  }

  private onLine(line: string) {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      this.opts.log(`[codex] ${line.slice(0, 300)}`)
      return
    }
    // Response to one of our requests
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else p.resolve(msg.result)
      return
    }
    // Request from the server: approve anything (the brain is read-only and only has Vera tools)
    if (msg.id !== undefined && msg.method) {
      this.answerServerRequest(msg)
      return
    }
    this.onNotification(msg.method, msg.params ?? {})
  }

  private answerServerRequest(msg: any) {
    const reply = (result: unknown) => this.write({ jsonrpc: "2.0", id: msg.id, result })
    switch (msg.method) {
      case "mcpServer/elicitation/request":
        return reply({ action: "accept", content: {}, _meta: null })
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return reply({ decision: "decline" })
      case "item/permissions/requestApproval":
        return reply({ decision: "decline" })
      case "applyPatchApproval":
      case "execCommandApproval":
        return reply({ decision: "denied" })
      default:
        this.opts.log(`[codex] unhandled server request ${msg.method}`)
        this.write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported by Vera" } })
    }
  }

  private onNotification(method: string, p: any) {
    switch (method) {
      case "turn/started":
        if (this.current) this.current.turnId = p.turn?.id
        break
      case "item/agentMessage/delta":
        if (this.current && p.delta) {
          this.current.text += p.delta
          this.emit("text", p.delta)
        }
        break
      case "item/started":
        if (p.item?.type === "mcpToolCall") {
          this.emit("tool", { id: p.item.id, name: codexToolName(p.item), input: p.item.arguments })
        }
        else if (p.item?.type === "webSearch") this.emit("tool", { id: p.item.id, name: "web_search", input: p.item.query })
        break
      case "item/completed":
        if (p.item?.type === "mcpToolCall" || p.item?.type === "webSearch") {
          const r = p.item.result
          const text = p.item.error?.message ?? (Array.isArray(r?.content) ? r.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("\n") : "")
          this.emit("tool_done", { id: p.item.id, result: String(text ?? ""), error: !!p.item.error })
        }
        break
      case "turn/completed": {
        const status = p.turn?.status
        const interrupted = this.current?.interrupted || status === "interrupted"
        const err = p.turn?.error?.message
        this.finish({
          ok: status === "completed" || !!interrupted,
          text: this.current?.text ?? "",
          error: status === "failed" ? (err ?? "turn failed") : undefined,
          interrupted: !!interrupted,
        })
        break
      }
      case "error":
        this.opts.log(`[codex] error ${JSON.stringify(p).slice(0, 400)}`)
        break
      case "mcpServer/startupStatus/updated":
        this.opts.log(`[codex] mcp ${JSON.stringify(p).slice(0, 200)}`)
        break
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
    let resolveTurn!: (r: TurnResult) => void
    const done = new Promise<TurnResult>((resolve) => (resolveTurn = resolve))
    const cur: NonNullable<CodexBrain["current"]> = { resolve: resolveTurn, text: "", interrupted: false }
    this.current = cur
    try {
      const res = await this.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text, text_elements: [] }],
        ...(this.opts.effort ? { effort: this.opts.effort } : {}),
      })
      if (res?.turn?.id) cur.turnId = res.turn.id
    } catch (err) {
      this.finish({ ok: false, text: "", error: (err as Error).message })
    }
    return done
  }

  async interrupt(): Promise<void> {
    const cur = this.current
    if (!cur || !this.threadId) return
    cur.interrupted = true
    if (cur.turnId) {
      await this.request("turn/interrupt", { threadId: this.threadId, turnId: cur.turnId }).catch(() => {})
    }
    setTimeout(() => {
      if (this.current === cur) this.finish({ ok: true, text: cur.text, interrupted: true })
    }, 3000).unref()
  }

  async close(): Promise<void> {
    const child = this.child
    this.child = null
    this.ready = null
    this.threadId = null
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
