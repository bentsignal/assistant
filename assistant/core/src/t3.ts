import { createHash, randomBytes } from "node:crypto"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { registerCli, resolveCli, runCli, which, type Launch } from "./proc.ts"

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
 * the agent now, as T3's composer does), starts a turn on an idle one, and
 * queues it only when asked. The
 * CLI's `thread send` always queues, so sends go through the server's own MCP
 * endpoint (`POST {origin}/mcp`, tool `t3_thread_send` with `mode`), with an
 * MCP client session minted the same way (`t3 auth session issue --subject
 * mcp-client`, cached in ~/.assistant/t3-mcp-token.json). If that fails, the
 * CLI queues it. Starting threads goes through the CLI.
 */

/**
 * How a message reaches a thread. "auto" (the default) steers a running
 * turn and starts a turn on an idle thread; "queue" waits for the running
 * turn to end (only when Shawn asks); "steer" only steers.
 */
export type SendMode = "auto" | "steer" | "queue"

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

/** Where the t3 CLI was found, or everywhere it was looked for. */
export type T3CliFound = { ok: true; name: string; launch?: Launch; via: string } | { ok: false; looked: string[] }

/**
 * Finds T3 Code's `t3` CLI: config `t3.cliPath` (or the older `t3.cli`),
 * then $T3CODE_CLI_PATH, then `t3` on PATH, then the launcher T3 Code
 * writes (`<T3CODE_HOME or ~/.t3>/bin/t3.cmd`), then T3 Code's own app,
 * run as Node the way that launcher runs it. Pure: everything it reads is
 * passed in, for tests.
 */
export function findT3Cli(io: {
  configured?: string
  env: NodeJS.ProcessEnv
  exists: (path: string) => boolean
  which: (name: string) => string | null
  home: string
  platform: string
}): T3CliFound {
  const looked: string[] = []
  const tryPath = (p: string | undefined, via: string): T3CliFound | null => {
    if (!p?.trim()) return null
    const path = p.trim().replace(/^"|"$/g, "")
    if (io.exists(path)) return { ok: true, name: path, via }
    looked.push(`${via} ${path} (missing)`)
    return null
  }
  const win = io.platform === "win32"
  const t3Home = io.env.T3CODE_HOME?.trim() || join(io.home, ".t3")
  const onPath = (): T3CliFound | null => {
    const p = io.which("t3")
    if (p) return { ok: true, name: p, via: "PATH" }
    looked.push("t3 on PATH")
    return null
  }
  const hit =
    tryPath(io.configured, "config t3.cliPath") ??
    tryPath(io.env.T3CODE_CLI_PATH, "T3CODE_CLI_PATH") ??
    onPath() ??
    tryPath(join(t3Home, "bin", win ? "t3.cmd" : "t3"), "T3 Code's launcher")
  if (hit) return hit
  if (win) {
    const programs = join(io.env.LOCALAPPDATA?.trim() || join(io.home, "AppData", "Local"), "Programs", "t3code")
    const script = join(programs, "resources", "server.asar", "apps", "server", "dist", "bin.mjs")
    for (const exe of ["T3 Code (Beta).exe", "T3 Code.exe"]) {
      const file = join(programs, exe)
      if (io.exists(file)) {
        return {
          ok: true,
          name: file,
          via: "the T3 Code app",
          launch: { file, prefix: [script], env: { ELECTRON_RUN_AS_NODE: "1", T3CODE_DESKTOP_CLI_LAUNCHER: "1", T3CODE_HOME: t3Home } },
        }
      }
      looked.push(file)
    }
  }
  return { ok: false, looked }
}

const BUSY = new Set(["preparing", "queued", "starting", "running"])
export const isBusy = (status: string) => BUSY.has(status)

export class T3 {
  private tokenFile: string
  private found: { key: string; result: T3CliFound } | null = null

  constructor(
    assistantHome: string,
    private settings: () => { cliPath?: string; cli?: string } = () => ({}),
  ) {
    this.tokenFile = join(assistantHome, "t3-token.json")
  }

  /** Where the t3 CLI is (looked up again when config changes, or when `fresh`). */
  locate(fresh = false): T3CliFound {
    const s = this.settings()
    const configured = s.cliPath ?? s.cli
    const key = `${configured ?? ""}|${process.env.T3CODE_CLI_PATH ?? ""}`
    if (!fresh && this.found?.key === key && this.found.result.ok) return this.found.result
    const result = findT3Cli({ configured, env: process.env, exists: existsSync, which, home: homedir(), platform: process.platform })
    if (result.ok && result.launch) registerCli(result.name, result.launch)
    this.found = { key, result }
    return result
  }

  private cliName(): string {
    const f = this.locate()
    if (f.ok) return f.name
    throw new Error(`T3 Code's t3 command isn't on this machine: I looked at ${f.looked.join("; ")}. Setting config t3.cliPath to it fixes that.`)
  }

  /** T3 Code's home: $T3CODE_HOME, what its launcher sets, else ~/.t3. */
  private get home(): string {
    if (process.env.T3CODE_HOME) return process.env.T3CODE_HOME
    try {
      const home = resolveCli(this.cliName()).env?.T3CODE_HOME
      if (home) return home
    } catch {}
    return join(homedir(), ".t3")
  }

  private cli(args: string[], input?: string, timeoutMs = 60_000) {
    return runCli(this.cliName(), args, { input, timeoutMs })
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

  /** Resolve a project by id, exact/partial title, or folder, on this machine or a linked one. */
  async findProject(query: string, environmentId?: string): Promise<T3Project & { defaultModelSelection?: unknown }> {
    if (environmentId) {
      const j = await this.remoteProjects(environmentId)
      const all = (j.projects ?? [])
        .filter((p: any) => !p.deletedAt && !p.archivedAt)
        .map((p: any) => ({ id: p.id, title: p.title, workspaceRoot: p.workspaceRoot, defaultModelSelection: p.defaultModelSelection ?? null }))
      return matchProject(all, query, ` on ${environmentId}`)
    }
    return matchProject(await this.projects(), query)
  }

  /**
   * Starts a thread on a linked machine (or this one) through T3's MCP
   * launch, at full access. A project with no default model gets
   * `DEFAULT_LAUNCH_MODEL` (or `model`, a Claude model name).
   */
  async launch(
    environmentId: string,
    project: T3Project & { defaultModelSelection?: unknown },
    message: string,
    opts: { title?: string; model?: string } = {},
  ): Promise<{ threadId: string; raw: any }> {
    const args: Record<string, unknown> = {
      environmentId,
      projectId: project.id,
      title: opts.title?.trim() || titleFrom(message),
      message,
      runtimeMode: "full-access",
    }
    if (opts.model) args.modelSelection = { ...DEFAULT_LAUNCH_MODEL, model: opts.model }
    else if (!project.defaultModelSelection) args.modelSelection = DEFAULT_LAUNCH_MODEL
    const raw = await this.mcpTool("t3_thread_launch", args)
    return { threadId: launchedId(raw) ?? "", raw }
  }

  private localEnv: string | null = null

  /** This machine's environment id (cached once known). */
  async localEnvironmentId(): Promise<string | undefined> {
    if (this.localEnv) return this.localEnv
    try {
      this.localEnv = (await this.environments())?.environmentId ?? null
    } catch {}
    return this.localEnv ?? undefined
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
    const mode = opts.mode ?? "auto"
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
  async remoteRead(environmentId: string | undefined, threadId: string, limit = 4, maxCharsPerItem?: number): Promise<any> {
    return this.mcpTool("t3_thread_read", {
      ...(environmentId ? { environmentId } : {}),
      threadId,
      limit,
      ...(maxCharsPerItem ? { maxCharsPerItem } : {}),
    })
  }

  /** Projects on a linked machine (or this one). */
  async remoteProjects(environmentId: string | undefined): Promise<any> {
    return this.mcpTool("t3_project_list", { ...(environmentId ? { environmentId } : {}), limit: 100 })
  }

  private mcpTokenFile(): string {
    return join(dirname(this.tokenFile), "t3-mcp-token.json")
  }

  /** Drops the cached MCP session, so the next call gets (and grants) a new one. */
  forgetMcpSession(): void {
    try {
      rmSync(this.mcpTokenFile(), { force: true })
    } catch {}
    this.mcpAccess = "unknown"
    this.toolCache = null
  }

  /**
   * "Fix your T3 access": finds the CLI again, drops the cached session,
   * runs the full-access grant again (falling back to an approval-required
   * session), and says what came of it.
   */
  async reauthorize(): Promise<{ access: "full-access" | "approval-required" | "none"; cli: string; error?: string }> {
    const where = this.locate(true)
    if (!where.ok) {
      return { access: "none", cli: "", error: `T3 Code's t3 command isn't on this machine (I looked at ${where.looked.join("; ")})` }
    }
    const cli = `${where.name} (${where.via})`
    try {
      this.runtime()
    } catch (err) {
      return { access: "none", cli, error: (err as Error).message }
    }
    this.forgetMcpSession()
    try {
      await this.mcpToken(true)
    } catch (err) {
      return { access: "none", cli, error: (err as Error).message }
    }
    const access = this.mcpAccess === "full-access" ? "full-access" : "approval-required"
    return { access, cli, ...(access !== "full-access" && this.mcpGrantError ? { error: this.mcpGrantError } : {}) }
  }

  /** The access the cached MCP session has: "full-access" once granted, else T3's default ceiling. */
  mcpAccess: "full-access" | "approval-required" | "unknown" = "unknown"
  /** Why the full-access grant failed, if it did (Core then uses an approval-required session). */
  mcpGrantError: string | null = null

  /**
   * A T3 MCP client session, cached for 30 days. It's full-access: T3 caps a
   * session the CLI issues (`auth session issue --subject mcp-client`) at
   * approval-required, and only its OAuth approval sets a broader ceiling. So
   * Core runs that approval itself, as Shawn: a five-minute approver session
   * from his own CLI (which any local T3 CLI user may issue) approves
   * Assistant's OAuth client at full-access, as clicking Approve on T3's
   * agent sign-in page would. If that fails, it falls back to the CLI-issued
   * session, records why, and tries the grant again after an hour.
   */
  private async mcpToken(fresh = false): Promise<string> {
    const file = this.mcpTokenFile()
    let cached: { token: string; grantTriedAt: number } | null = null
    if (!fresh && existsSync(file)) {
      try {
        const t = JSON.parse(readFileSync(file, "utf8"))
        if (t.token && t.expires > Date.now() + 3600_000) {
          if (t.access === "full-access") {
            this.mcpAccess = "full-access"
            return t.token
          }
          // Not marked full-access (a fallback, or an older Core's session):
          // always replaced once a grant works. The grant is tried again on
          // use, at most every ten minutes; meanwhile the old session serves.
          cached = { token: t.token, grantTriedAt: Number(t.grantTriedAt ?? 0) }
          if (cached.grantTriedAt > Date.now() - 600_000) {
            this.mcpAccess = "approval-required"
            return t.token
          }
        }
      } catch {}
    }
    try {
      const granted = await this.grantFullAccess()
      writeFileSync(file, JSON.stringify({ token: granted.token, expires: granted.expires, access: "full-access" }), { mode: 0o600 })
      this.mcpAccess = "full-access"
      this.mcpGrantError = null
      return granted.token
    } catch (err) {
      this.mcpGrantError = (err as Error).message
      console.error(`[t3] full-access grant failed, using an approval-required session: ${this.mcpGrantError}`)
    }
    if (cached) {
      const t = JSON.parse(readFileSync(file, "utf8"))
      writeFileSync(file, JSON.stringify({ ...t, access: "approval-required", grantTriedAt: Date.now() }), { mode: 0o600 })
      this.mcpAccess = "approval-required"
      return cached.token
    }
    const r = await this.cli([
      "auth", "session", "issue", "--token-only", "--label", "assistant", "--ttl", "30d",
      "--subject", "mcp-client", "--scope", "orchestration:read", "--scope", "orchestration:operate",
    ])
    const token = r.stdout.split(/\s+/).find((s) => s.startsWith("ey"))
    if (!token) throw new Error(`couldn't get a T3 MCP session: ${r.stderr.trim() || r.stdout.trim()}`)
    writeFileSync(
      file,
      JSON.stringify({ token, expires: Date.now() + 29 * 86400_000, access: "approval-required", grantTriedAt: Date.now() }),
      { mode: 0o600 },
    )
    this.mcpAccess = "approval-required"
    return token
  }


  /**
   * T3's MCP OAuth (register, approval, decision, token), approved by a
   * short-lived session from the CLI. Returns a full-access MCP client session.
   */
  async grantFullAccess(): Promise<{ token: string; expires: number }> {
    const { origin } = this.runtime()
    const r = await this.cli(["auth", "session", "issue", "--token-only", "--label", "assistant approval", "--ttl", "5m"])
    const approver = r.stdout.split(/\s+/).find((s) => s.startsWith("ey"))
    if (!approver) throw new Error(`couldn't get an approver session from the t3 CLI: ${r.stderr.trim() || r.stdout.trim()}`)
    const post = async (path: string, body: unknown, bearer?: string) => {
      const res = await fetch(origin + path, {
        method: "POST",
        headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`T3 ${path}: HTTP ${res.status} ${text.slice(0, 300)}`)
      return JSON.parse(text)
    }
    // Never visited: the code comes back in the decision's redirect.
    const redirectUri = "http://127.0.0.1:7319/t3-callback"
    const client = await post("/oauth/mcp/register", {
      client_name: "Assistant",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    })
    const verifier = randomBytes(32).toString("base64url")
    const authorization = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: randomBytes(12).toString("base64url"),
      resource: origin + "/mcp",
    }
    const details = await post("/oauth/mcp/approval", authorization, approver)
    if (details.runtimeModeCeiling) {
      throw new Error(`${details.runtimeModeCeiling.organization}'s managed policy caps T3 at ${details.runtimeModeCeiling.maxRuntimeMode}`)
    }
    if (!details.csrfToken) throw new Error("T3 didn't let the CLI's session approve an MCP client")
    const decided = await post(
      "/oauth/mcp/decision",
      { authorization, decision: { _tag: "browser-session", access: "full-access", csrfToken: details.csrfToken } },
      approver,
    )
    const code = new URL(decided.redirectTo).searchParams.get("code")
    if (!code) throw new Error(`T3's approval returned no code: ${String(decided.redirectTo).slice(0, 200)}`)
    const res = await fetch(origin + "/oauth/mcp/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: authorization.resource,
      }),
      signal: AbortSignal.timeout(15_000),
    })
    const tok: any = await res.json().catch(() => ({}))
    if (!res.ok || !tok.access_token) throw new Error(`T3 /oauth/mcp/token: HTTP ${res.status} ${JSON.stringify(tok).slice(0, 300)}`)
    return { token: tok.access_token, expires: Date.now() + Math.max(3600, Number(tok.expires_in ?? 86400) - 3600) * 1000 }
  }

  /** Calls one of the server's MCP tools and returns its JSON result (throws its failure). */
  async mcpTool(name: string, args: Record<string, unknown>): Promise<any> {
    const reply = await this.mcpRpc("tools/call", { name, arguments: args })
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

  /** T3's MCP tools (name, description, input schema), cached for ten minutes. */
  async mcpList(): Promise<{ name: string; description?: string; inputSchema?: any }[]> {
    if (this.toolCache && this.toolCache.at > Date.now() - 600_000) return this.toolCache.tools
    const reply = await this.mcpRpc("tools/list", {})
    const tools = reply.result?.tools ?? []
    this.toolCache = { at: Date.now(), tools }
    return tools
  }

  private toolCache: { at: number; tools: any[] } | null = null

  /** One JSON-RPC request in its own MCP session. Throws a JSON-RPC error. */
  private async mcpRpc(method: string, params: Record<string, unknown>): Promise<any> {
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
      const res = await post({ jsonrpc: "2.0", id: 2, method, params })
      const reply = parseRpc(await res.text())
      if (session) void fetch(origin + "/mcp", { method: "DELETE", headers }).catch(() => {})
      if (reply.error) throw new Error(`T3 MCP: ${reply.error.message ?? JSON.stringify(reply.error)}`)
      return reply
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

/** The model a launched thread gets when its project has no default. */
export const DEFAULT_LAUNCH_MODEL = { provider: "claudeAgent", instanceId: "claudeAgent", model: "claude-sonnet-5-5" }

/** A project by id, exact title, folder, then partial title or folder name. */
export function matchProject<P extends T3Project>(all: P[], query: string, where = ""): P {
  const q = query.trim().toLowerCase()
  const hit =
    all.find((p) => p.id === query.trim()) ??
    all.find((p) => p.title.toLowerCase() === q) ??
    all.find((p) => p.workspaceRoot.toLowerCase() === q) ??
    all.find((p) => p.title.toLowerCase().includes(q)) ??
    all.find((p) => p.workspaceRoot.toLowerCase().replace(/\//g, "\\").endsWith("\\" + q))
  if (!hit) throw new Error(`no T3 project matches "${query}"${where}. Projects: ${all.map((p) => `${p.title} (${p.id})`).join(", ")}`)
  return hit
}

/** A short thread title from a brief's first words. */
export function titleFrom(message: string): string {
  const line = message.trim().split(/\r?\n/)[0] ?? ""
  return line.length > 60 ? line.slice(0, 57).trimEnd() + "..." : line || "Thread from Vera"
}

/** The new thread's id in a t3_thread_launch reply. */
export function launchedId(r: any): string | undefined {
  return r?.threadId ?? r?.thread?.threadId ?? r?.thread?.id ?? r?.id ?? undefined
}

export type ReadRow = T3ThreadRow & { latestRunStatus: string | null; message: string }

/** A thread row (plus its latest reply) from a `t3_thread_read` result. */
export function rowFromRead(read: any): ReadRow {
  const t = read?.thread ?? {}
  const runs = [...(read?.recentRuns ?? [])].sort((a: any, b: any) => (b.ordinal ?? 0) - (a.ordinal ?? 0))
  const latest = runs[0]
  const status = t.status ?? "idle"
  const reply = [...(read?.items ?? [])]
    .sort((a: any, b: any) => (b.position ?? 0) - (a.position ?? 0))
    .find((i: any) => /assistant/.test(String(i.type ?? i.role ?? "")) && i.text)
  return {
    id: t.threadId ?? t.id,
    projectId: t.projectId,
    title: t.title ?? t.threadId,
    status,
    updatedAt: t.updatedAt,
    latestRunId: t.latestRunId ?? latest?.runId ?? null,
    latestRunCompletedAt: latest?.completedAt ?? null,
    latestRunStatus: latest?.status ?? null,
    waiting: status === "waiting" || Number(t.pendingRequestCount ?? 0) > 0,
    lastError: t.lastError ?? latest?.error ?? null,
    message: reply?.text ?? "",
  }
}

/** Whether a T3 failure means the thread no longer exists (rather than the machine being out of reach). */
export function threadGone(err: Error & { code?: string }): boolean {
  return /not[_ -]?found|no such thread|unknown thread|no T3 thread|deleted/i.test(`${err.code ?? ""} ${err.message}`)
}

export interface Watch {
  threadId: string
  /** The linked machine the thread is on; absent for this one. */
  environmentId?: string
  title: string
  project?: string
  since: number
  lastStatus: string
  lastWaiting: boolean
  lastCompletedAt: string | null
  /** Set when Vera sent a message, so a run that starts and ends between polls still counts. */
  expectRun?: boolean
  /** Why it couldn't be read last time; she was told once, and it's cleared when it reads again. */
  pollError?: string
}

export type WatchEvent = {
  kind: "finished" | "waiting" | "failed" | "unreachable" | "gone"
  watch: Watch
  status: string
  message: string
}

/** What the watcher needs from T3 (a fake in tests). */
export type WatchSource = Pick<T3, "threads" | "show" | "remoteRead" | "localEnvironmentId">

/** A watch's key: the thread id, prefixed by its machine when it's on another one. */
export const watchKey = (threadId: string, environmentId?: string) => (environmentId ? `${environmentId}/${threadId}` : threadId)

/**
 * Polls watched threads and reports when one finishes a run or waits on an
 * approval or an answer. This machine's threads cost one HTTP request per
 * poll for all of them; a linked machine's are read one by one through T3's
 * MCP API. A watch that can't be read is reported once (and kept); a thread
 * that no longer exists is reported and dropped. Nothing is dropped silently.
 */
export class T3Watcher {
  watches = new Map<string, Watch>()
  private timer: NodeJS.Timeout | null = null
  private inflight: Promise<void> | null = null

  constructor(
    private t3: WatchSource,
    private file: string,
    private onEvent: (e: WatchEvent) => void,
    private onChange: () => void,
    private log: (line: string) => void = (l) => console.error(l),
  ) {
    if (existsSync(file)) {
      try {
        for (const w of JSON.parse(readFileSync(file, "utf8")) as Watch[]) this.watches.set(watchKey(w.threadId, w.environmentId), w)
      } catch {}
    }
  }

  start(intervalMs: number) {
    this.stop()
    this.timer = setInterval(() => {
      if (!this.inflight) void this.poll()
    }, intervalMs)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** This machine's own id stands for "this machine": such a watch reads the local server. */
  private async normalizeEnv(environmentId?: string): Promise<string | undefined> {
    if (!environmentId) return undefined
    const local = await this.t3.localEnvironmentId().catch(() => undefined)
    return environmentId === local ? undefined : environmentId
  }

  /** The watch on a thread (on `environmentId`, or on any machine when none is given). */
  get(threadId: string, environmentId?: string): Watch | undefined {
    const exact = this.watches.get(watchKey(threadId, environmentId))
    if (exact || environmentId) return exact
    for (const w of this.watches.values()) if (w.threadId === threadId) return w
    return undefined
  }

  /** Whether a thread is watched (its machine's own id counts as this machine). */
  async has(threadId: string, environmentId?: string): Promise<boolean> {
    return this.watches.has(watchKey(threadId, await this.normalizeEnv(environmentId)))
  }

  /** A thread's current row: from the shell on this machine, else through MCP. Throws if it can't. */
  private async readRow(threadId: string, environmentId?: string, rows?: Map<string, T3ThreadRow>): Promise<ReadRow> {
    if (!environmentId) {
      const row = (rows ?? new Map((await this.t3.threads()).map((t) => [t.id, t]))).get(threadId)
      if (row) return { ...row, latestRunStatus: null, message: "" }
    }
    // A linked machine's thread, or a local one the shell leaves out (a subagent, say).
    const row = rowFromRead(await this.t3.remoteRead(environmentId, threadId, 3, 2000))
    if (!row.id) {
      throw Object.assign(new Error(`no T3 thread ${threadId}${environmentId ? ` on ${environmentId}` : ""}`), { code: "thread_not_found" })
    }
    return row
  }

  /**
   * Watches a thread. `fresh`: Vera just started it or sent to it, so the
   * next time it reads idle counts as a finished run, even when the run
   * ended before this first read.
   */
  async add(threadId: string, opts: { environmentId?: string; fresh?: boolean } = {}): Promise<Watch> {
    const environmentId = await this.normalizeEnv(opts.environmentId)
    let row: ReadRow
    try {
      row = await this.readRow(threadId, environmentId)
    } catch (err) {
      throw new Error(`can't watch T3 thread ${threadId}${environmentId ? ` on ${environmentId}` : ""}: ${(err as Error).message}`)
    }
    const w: Watch = {
      threadId,
      ...(environmentId ? { environmentId } : {}),
      title: row.title,
      since: Date.now(),
      lastStatus: opts.fresh ? "starting" : row.status,
      lastWaiting: false, // so a thread already waiting reports once
      lastCompletedAt: opts.fresh ? null : row.latestRunCompletedAt,
      expectRun: !!opts.fresh || isBusy(row.status),
    }
    this.watches.set(watchKey(threadId, environmentId), w)
    this.save()
    void this.poll()
    return w
  }

  /** Watches it if it isn't yet; otherwise expects the run a send just started. */
  async ensure(threadId: string, environmentId?: string): Promise<Watch> {
    const env = await this.normalizeEnv(environmentId)
    const w = this.watches.get(watchKey(threadId, env))
    if (!w) return this.add(threadId, { environmentId: env, fresh: true })
    w.expectRun = true
    if (!isBusy(w.lastStatus)) w.lastStatus = "starting"
    this.save()
    return w
  }

  remove(threadId: string, environmentId?: string): boolean {
    const w = this.get(threadId, environmentId)
    const had = !!w && this.watches.delete(watchKey(w.threadId, w.environmentId))
    if (had) this.save()
    return had
  }

  expectRun(threadId: string, environmentId?: string) {
    const w = this.get(threadId, environmentId)
    if (w) {
      w.expectRun = true
      this.save()
    }
  }

  /** One poll of every watch; one already running is waited out first, so the caller sees a fresh read. */
  async poll(): Promise<void> {
    while (this.inflight) await this.inflight
    if (this.watches.size === 0) return
    this.inflight = this.pollOnce().finally(() => (this.inflight = null))
    return this.inflight
  }

  private async pollOnce(): Promise<void> {
    try {
      const watches = [...this.watches.values()]
      let rows: Map<string, T3ThreadRow> | undefined
      let localError: Error | null = null
      if (watches.some((w) => !w.environmentId)) {
        try {
          rows = new Map((await this.t3.threads()).map((t) => [t.id, t]))
        } catch (err) {
          localError = err as Error
        }
      }
      for (const w of watches) {
        let row: ReadRow
        try {
          if (!w.environmentId && localError) throw localError
          row = await this.readRow(w.threadId, w.environmentId, rows)
        } catch (err) {
          this.unreadable(w, err as Error & { code?: string })
          continue
        }
        if (w.pollError) {
          this.log(`[t3] watched thread "${w.title}" reads again`)
          delete w.pollError
        }
        await this.check(w, row)
      }
      this.save()
    } catch (err) {
      this.log(`[t3] watch poll failed: ${(err as Error).message}`)
    }
  }

  private unreadable(w: Watch, err: Error & { code?: string }) {
    const where = w.environmentId ? ` on ${w.environmentId}` : ""
    if (threadGone(err)) {
      this.log(`[t3] watched thread ${w.threadId}${where} is gone; stopped watching it: ${err.message}`)
      this.watches.delete(watchKey(w.threadId, w.environmentId))
      this.onEvent({ kind: "gone", watch: w, status: "gone", message: err.message })
      return
    }
    this.log(`[t3] can't read watched thread ${w.threadId}${where}: ${err.message}`)
    if (w.pollError) return // told once already; still watching
    w.pollError = err.message
    this.onEvent({ kind: "unreachable", watch: w, status: "unreachable", message: err.message })
  }

  private async check(w: Watch, row: ReadRow) {
    const busy = isBusy(row.status)
    let kind: WatchEvent["kind"] | null = null
    if (row.waiting && !w.lastWaiting) kind = "waiting"
    else if (!busy && !row.waiting) {
      // A run that started and ended between two polls still moves latestRunCompletedAt.
      const newRun = !!row.latestRunCompletedAt && row.latestRunCompletedAt !== w.lastCompletedAt
      if (isBusy(w.lastStatus) || newRun) kind = row.status === "failed" || row.latestRunStatus === "failed" ? "failed" : "finished"
    }
    w.title = row.title || w.title
    w.lastStatus = row.status
    w.lastWaiting = row.waiting
    if (busy) w.expectRun = false
    if (!kind) return
    w.lastCompletedAt = row.latestRunCompletedAt
    w.expectRun = false
    let message = row.message || row.lastError || ""
    if (!row.message && !w.environmentId) {
      try {
        const shown = await this.t3.show(w.threadId, 2)
        const last = [...(shown.messages ?? [])].reverse().find((m: any) => m.role === "assistant")
        if (last?.text) message = last.text
      } catch {}
    }
    this.onEvent({ kind, watch: w, status: row.status, message })
  }

  private save() {
    writeFileSync(this.file, JSON.stringify([...this.watches.values()], null, 2))
    this.onChange()
  }
}

/** The inbox item (and chime) for a watch event. */
export function watchNotice(e: WatchEvent): { kind: "t3"; title: string; summary: string; ref: string } {
  const where = e.watch.environmentId ? ` on ${e.watch.environmentId}` : ""
  const what =
    e.kind === "waiting"
      ? "needs your input"
      : e.kind === "failed"
        ? "failed"
        : e.kind === "unreachable"
          ? "can't be checked right now (still watching)"
          : e.kind === "gone"
            ? "is gone (stopped watching)"
            : "finished"
  return { kind: "t3", title: `T3 "${e.watch.title}"${where} ${what}`, summary: e.message || e.status, ref: e.watch.threadId }
}
