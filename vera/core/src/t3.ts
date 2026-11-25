import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { resolveCli, runCli } from "./proc.ts"

/**
 * T3 Code through its own CLI plus one read-only HTTP endpoint.
 *
 * The `t3` CLI has `thread list|start|send|show` but no `project list`, and
 * `thread list` needs a project. For listing we mint a read-only bearer token
 * once (`t3 auth session issue --scope orchestration:read`, cached in
 * ~/.vera/t3-token.json) and call the running server's HTTP API:
 *   GET {origin}/api/projects                -> { projects: [...] }
 *   GET {origin}/api/orchestration/shell     -> every thread's status, all projects
 * The server's origin comes from <T3CODE_HOME>/userdata/server-runtime.json.
 * Anything that changes threads goes through the CLI.
 */

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

  constructor(veraHome: string, cliPath?: string) {
    this.tokenFile = join(veraHome, "t3-token.json")
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
    const r = await this.cli(["auth", "session", "issue", "--token-only", "--label", "vera", "--ttl", "30d", "--scope", "orchestration:read"])
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

  async send(threadId: string, message: string, opts: { wait?: boolean } = {}): Promise<any> {
    const args = ["thread", "send", threadId, "-"]
    if (opts.wait) args.push("--wait")
    return this.cliJson(args, message, opts.wait ? 600_000 : 60_000)
  }
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
