import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { resolveCli, runCli } from "./proc.ts"

/**
 * T3 Code through its own CLI plus one read-only HTTP endpoint.
 *
 * The `t3` CLI has `thread list|start|send|show` but no `project list`, and
 * `thread list` needs a project. For listing we mint a read-only bearer token
 * once (`t3 auth session issue --scope orchestration:read`, cached in
 * ~/.assistant/t3-token.json) and call the running server's HTTP API:
 *   GET {origin}/api/projects                -> { projects: [...] }
 *   GET {origin}/api/orchestration/shell     -> every thread's status, all projects
 * The server's origin comes from <T3CODE_HOME>/userdata/server-runtime.json.
 *
 * Sending to a thread steers its running turn by default (the message reaches
 * the agent now, as T3's composer does), and queues it only when asked. The
 * CLI's `thread send` always queues, so sends go through the server's own MCP
 * endpoint (`POST {origin}/mcp`, tool `t3_thread_send` with `mode`), with an
 * MCP client session minted the same way (`t3 auth session issue --subject
 * mcp-client`, cached in ~/.assistant/t3-mcp-token.json). If that fails, the
 * CLI queues it. Starting threads goes through the CLI.
 */

/** How a message reaches a thread: steer the running turn, or queue after it. */
export type SendMode = "steer" | "queue"

/** What happened to a sent message. */
export interface SendResult {
  delivery: "started" | "queued" | "steered" | "restarted"
  runId?: string
  via: "mcp" | "cli"
  /**
   * T3 refused to let Assistant steer it: the thread runs with more access
   * than Assistant's MCP session may use (it's capped at approval-required
   * until Shawn approves more), so it was queued through the CLI instead.
   */
  steerRefused?: boolean
}

export interface T3Project {
  id: string
  title: string
  workspaceRoot: string
}

export interface T3ThreadRow {
  id: string
  projectId: string
  title: string
  status: string
  updatedAt: string
  latestRunId: string | null
  latestRunCompletedAt: string | null
  waiting: boolean
  lastError: string | null
}

const BUSY = new Set(["preparing", "queued", "starting", "running"])
export const isBusy = (status: string) => BUSY.has(status)

export class T3 {
  private tokenFile: string
  private cliName: string
  private home: string

  constructor(assistantHome: string, cliPath?: string) {
    this.tokenFile = join(assistantHome, "t3-token.json")
    this.cliName = cliPath ?? process.env.T3CODE_CLI_PATH ?? "t3"
    // The launcher .cmd sets T3CODE_HOME; read it from there when we can.
    let home = process.env.T3CODE_HOME
    if (!home) {
      try {
        home = resolveCli(this.cliName).env?.T3CODE_HOME
      } catch {}
    }
    this.home = home ?? join(homedir(), ".t3")
  }

  private cli(args: string[], input?: string, timeoutMs = 60_000) {
    return runCli(this.cliName, args, { input, timeoutMs })
  }

  private async cliJson(args: string[], input?: string, timeoutMs?: number): Promise<any> {
    const r = await this.cli([...args, "--json"], input, timeoutMs)
    const out = r.stdout.trim()
    if (r.code !== 0 && r.code !== 2 && !out) throw new Error(r.stderr.trim() || `t3 ${args[0]} ${args[1]} failed (${r.code})`)
    try {
      return JSON.parse(out)
    } catch {
      throw new Error((r.stderr.trim() || out || "t3 printed nothing").slice(0, 500))
    }
  }

  runtime(): { origin: string; pid: number } {
    const file = join(this.home, "userdata", "server-runtime.json")
    if (!existsSync(file)) throw new Error("T3 Code isn't running (no server-runtime.json)")
    const rt = JSON.parse(readFileSync(file, "utf8"))
    try {
      process.kill(rt.pid, 0)
    } catch (err: any) {
      if (err.code !== "EPERM") throw new Error("T3 Code isn't running")
    }
    return { origin: rt.origin, pid: rt.pid }
  }

  private async token(fresh = false): Promise<string> {
    if (!fresh && existsSync(this.tokenFile)) {
      try {
        const t = JSON.parse(readFileSync(this.tokenFile, "utf8"))
        if (t.token && t.expires > Date.now() + 3600_000) return t.token
      } catch {}
    }
    const r = await this.cli(["auth", "session", "issue", "--token-only", "--label", "assistant", "--ttl", "30d", "--scope", "orchestration:read"])
    const token = r.stdout.split(/\s+/).find((s) => s.startsWith("ey"))
    if (!token) throw new Error(`couldn't get a T3 token: ${r.stderr.trim() || r.stdout.trim()}`)
    writeFileSync(this.tokenFile, JSON.stringify({ token, expires: Date.now() + 29 * 86400_000 }), { mode: 0o600 })
    return token
  }

  private async get(path: string, headers: Record<string, string> = {}): Promise<any> {
    const { origin } = this.runtime()
    for (const fresh of [false, true]) {
      const token = await this.token(fresh)
      const res = await fetch(origin + path, { headers: { authorization: `Bearer ${token}`, ...headers } })
      if (res.status === 401 && !fresh) continue
      if (!res.ok) throw new Error(`T3 ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
      return res.json()
    }
  }

  async projects(): Promise<T3Project[]> {
    const j = await this.get("/api/projects")
    return (j.projects ?? [])
      .filter((p: any) => !p.deletedAt && !p.archivedAt)
      .map((p: any) => ({ id: p.id, title: p.title, workspaceRoot: p.workspaceRoot }))
  }

  /** Every thread's status across all projects, in one request. */
  async threads(): Promise<T3ThreadRow[]> {
    const j = await this.get("/api/orchestration/shell?omitIdleSubagents=true", { "x-t3-orchestration-protocol": "2" })
    return (j.threads ?? []).map(
      (t: any): T3ThreadRow => ({
        id: t.id ?? t.threadId,
        projectId: t.projectId,
        title: t.title,
        status: t.status ?? "idle",
        updatedAt: t.updatedAt,
        latestRunId: t.latestRunId ?? null,
        latestRunCompletedAt: t.latestRunCompletedAt ?? null,
        waiting: t.status === "waiting" || !!t.pendingRuntimeRequest,
        lastError: t.lastError ?? null,
      }),
    )
  }

  /** Resolve a project by id, exact/partial title, or folder. */
  async findProject(query: string): Promise<T3Project> {
    const all = await this.projects()
    const q = query.trim().toLowerCase()
    const hit =
      all.find((p) => p.id === query) ??
      all.find((p) => p.title.toLowerCase() === q) ??
      all.find((p) => p.workspaceRoot.toLowerCase() === q) ??
      all.find((p) => p.title.toLowerCase().includes(q)) ??
      all.find((p) => p.workspaceRoot.toLowerCase().endsWith("\\" + q))
    if (!hit) throw new Error(`no T3 project matches "${query}". Projects: ${all.map((p) => p.title).join(", ")}`)
    return hit
  }

  async listThreads(project?: string, limit = 10): Promise<(T3ThreadRow & { project: string })[]> {
    const [projects, threads] = await Promise.all([this.projects(), this.threads()])
    const byId = new Map(projects.map((p) => [p.id, p.title]))
    let rows = threads
    if (project) {
      const p = await this.findProject(project)
      rows = rows.filter((t) => t.projectId === p.id)
    }
    return rows
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, limit)
      .map((t) => ({ ...t, project: byId.get(t.projectId) ?? t.projectId }))
  }

  async show(threadId: string, messages = 4): Promise<any> {
    return this.cliJson(["thread", "show", threadId, "--messages", String(messages)])
  }

  async start(projectId: string, message: string, opts: { title?: string; wait?: boolean } = {}): Promise<any> {
    const args = ["thread", "start", projectId, "-"]
    if (opts.title) args.push("--title", opts.title)
    if (opts.wait) args.push("--wait")
    return this.cliJson(args, message, opts.wait ? 600_000 : 60_000)
  }

  /**
   * Sends `message` to a thread: steering its running turn (an idle one
   * starts a turn) unless `mode` is "queue". `environmentId` names a linked
   * machine's T3; without it, this machine's.
   */
  async send(threadId: string, message: string, opts: { mode?: SendMode; environmentId?: string } = {}): Promise<SendResult> {
    const mode = opts.mode ?? "steer"
    const env = opts.environmentId ? { environmentId: opts.environmentId } : {}
    try {
      const r = await this.mcpTool("t3_thread_send", { ...env, threadId, message, mode })
      return { delivery: r.delivery, runId: r.runId, via: "mcp" }
    } catch (err) {
      const code = (err as any).code as string | undefined
      // Steering a full-access thread needs a full-access client, which only
      // Shawn can approve: the CLI (his own, authorized) queues it instead.
      // It reaches only this machine's T3; a linked one's thread stays refused.
      const refused = code === "runtime_mode_escalation_denied"
      if (!refused && (code || opts.environmentId)) throw err
      try {
        const r = await this.cliJson(["thread", "send", threadId, "-"], message, 60_000)
        return { delivery: r.delivery ?? "queued", runId: r.runId, via: "cli", ...(refused ? { steerRefused: true } : {}) }
      } catch (cliErr) {
        throw refused ? err : cliErr
      }
    }
  }

  /** The machines linked to this T3 (their environment ids), this one first. */
  async environments(): Promise<any> {
    return this.mcpTool("t3_environment_links", {})
  }

  /** Threads on a linked machine (or this one), newest first. */
  async remoteThreads(environmentId: string | undefined, limit = 10): Promise<any> {
    return this.mcpTool("t3_thread_list", { ...(environmentId ? { environmentId } : {}), allProjects: true, limit })
  }

  /** A thread's latest items on a linked machine (or this one). */
  async remoteRead(environmentId: string | undefined, threadId: string, limit = 4): Promise<any> {
    return this.mcpTool("t3_thread_read", { ...(environmentId ? { environmentId } : {}), threadId, limit })
  }

  /** Projects on a linked machine (or this one). */
  async remoteProjects(environmentId: string | undefined): Promise<any> {
    return this.mcpTool("t3_project_list", { ...(environmentId ? { environmentId } : {}), limit: 100 })
  }

  private mcpTokenFile(): string {
    return join(dirname(this.tokenFile), "t3-mcp-token.json")
  }

  /** A T3 MCP client session (subject `mcp-client`, may operate threads), cached for 30 days. */
  private async mcpToken(fresh = false): Promise<string> {
    const file = this.mcpTokenFile()
    if (!fresh && existsSync(file)) {
      try {
        const t = JSON.parse(readFileSync(file, "utf8"))
        if (t.token && t.expires > Date.now() + 3600_000) return t.token
      } catch {}
    }
    const r = await this.cli([
      "auth", "session", "issue", "--token-only", "--label", "assistant", "--ttl", "30d",
      "--subject", "mcp-client", "--scope", "orchestration:read", "--scope", "orchestration:operate",
    ])
    const token = r.stdout.split(/\s+/).find((s) => s.startsWith("ey"))
    if (!token) throw new Error(`couldn't get a T3 MCP session: ${r.stderr.trim() || r.stdout.trim()}`)
    writeFileSync(file, JSON.stringify({ token, expires: Date.now() + 29 * 86400_000 }), { mode: 0o600 })
    return token
  }

  /** Calls one of the server's MCP tools and returns its JSON result (throws its failure). */
  async mcpTool(name: string, args: Record<string, unknown>): Promise<any> {
    const { origin } = this.runtime()
    for (const fresh of [false, true]) {
      const token = await this.mcpToken(fresh)
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      }
      const post = (body: unknown) =>
        fetch(origin + "/mcp", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
      const init = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "assistant", version: "1" } },
      })
      if (init.status === 401 && !fresh) continue
      if (!init.ok) throw new Error(`T3 MCP: HTTP ${init.status} ${(await init.text()).slice(0, 200)}`)
      await init.text()
      const session = init.headers.get("mcp-session-id")
      if (session) headers["mcp-session-id"] = session
      await (await post({ jsonrpc: "2.0", method: "notifications/initialized" })).text()
      const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } })
      const reply = parseRpc(await res.text())
      if (session) void fetch(origin + "/mcp", { method: "DELETE", headers }).catch(() => {})
      if (reply.error) throw new Error(`T3 MCP: ${reply.error.message ?? JSON.stringify(reply.error)}`)
      const text = reply.result?.content?.find((c: any) => c.type === "text")?.text ?? "{}"
      let value: any
      try {
        value = JSON.parse(text)
      } catch {
        value = { message: text }
      }
      if (reply.result?.isError || value?._tag === "OrchestratorMcpFailure") {
        const err = new Error(value?.message ?? text) as Error & { code?: string }
        err.code = value?.code
        throw err
      }
      return value
    }
    throw new Error("T3 MCP: unauthorized")
  }
}

/** A JSON-RPC reply, sent plain or as server-sent events. */
export function parseRpc(body: string): any {
  const trimmed = body.trim()
  if (trimmed.startsWith("{")) return JSON.parse(trimmed)
  const data = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((l) => l.startsWith("{"))
  for (const d of data.reverse()) {
    const v = JSON.parse(d)
    if (v.id !== undefined) return v
  }
  throw new Error(`T3 MCP: unreadable reply ${trimmed.slice(0, 200)}`)
}

export interface Watch {
  threadId: string
  title: string
  project?: string
  since: number
  lastStatus: string
  lastWaiting: boolean
  lastCompletedAt: string | null
  /** Set when Vera sent a message, so a run that starts and ends between polls still counts. */
  expectRun?: boolean
}

export type WatchEvent = { kind: "finished" | "waiting" | "failed"; watch: Watch; status: string; message: string }

/**
 * Polls watched threads (one HTTP request per poll for all of them) and
 * reports when one finishes a run or waits on an approval or an answer.
 */
export class T3Watcher {
  watches = new Map<string, Watch>()
  private timer: NodeJS.Timeout | null = null
  private polling = false

  constructor(
    private t3: T3,
    private file: string,
    private onEvent: (e: WatchEvent) => void,
    private onChange: () => void,
  ) {
    if (existsSync(file)) {
      try {
        for (const w of JSON.parse(readFileSync(file, "utf8")) as Watch[]) this.watches.set(w.threadId, w)
      } catch {}
    }
  }

  start(intervalMs: number) {
    this.stop()
    this.timer = setInterval(() => void this.poll(), intervalMs)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async add(threadId: string): Promise<Watch> {
    const row = (await this.t3.threads()).find((t) => t.id === threadId)
    if (!row) throw new Error(`no T3 thread ${threadId}`)
    const w: Watch = {
      threadId,
      title: row.title,
      since: Date.now(),
      lastStatus: row.status,
      lastWaiting: false, // so a thread already waiting reports once
      lastCompletedAt: row.latestRunCompletedAt,
      expectRun: isBusy(row.status),
    }
    this.watches.set(threadId, w)
    this.save()
    void this.poll()
    return w
  }

  remove(threadId: string): boolean {
    const had = this.watches.delete(threadId)
    if (had) this.save()
    return had
  }

  expectRun(threadId: string) {
    const w = this.watches.get(threadId)
    if (w) {
      w.expectRun = true
      this.save()
    }
  }

  async poll(): Promise<void> {
    if (this.polling || this.watches.size === 0) return
    this.polling = true
    try {
      const rows = new Map((await this.t3.threads()).map((t) => [t.id, t]))
      for (const w of this.watches.values()) {
        const row = rows.get(w.threadId)
        if (!row) continue
        const busy = isBusy(row.status)
        let kind: WatchEvent["kind"] | null = null
        if (row.waiting && !w.lastWaiting) kind = "waiting"
        else if (!busy && !row.waiting) {
          // A run that started and ended between two polls still moves latestRunCompletedAt.
          const newRun = !!row.latestRunCompletedAt && row.latestRunCompletedAt !== w.lastCompletedAt
          if (isBusy(w.lastStatus) || newRun) kind = row.status === "failed" ? "failed" : "finished"
        }
        w.title = row.title
        w.lastStatus = row.status
        w.lastWaiting = row.waiting
        if (busy) w.expectRun = false
        if (kind) {
          w.lastCompletedAt = row.latestRunCompletedAt
          w.expectRun = false
          let message = row.lastError ?? ""
          try {
            const shown = await this.t3.show(w.threadId, 2)
            const last = [...(shown.messages ?? [])].reverse().find((m: any) => m.role === "assistant")
            if (last?.text) message = last.text
          } catch {}
          this.onEvent({ kind, watch: w, status: row.status, message })
        }
      }
      this.save()
    } catch (err) {
      console.error(`[t3] watch poll failed: ${(err as Error).message}`)
    } finally {
      this.polling = false
    }
  }

  private save() {
    writeFileSync(this.file, JSON.stringify([...this.watches.values()], null, 2))
    this.onChange()
  }
}
