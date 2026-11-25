import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, type WriteStream } from "node:fs"
import { join } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { killTree, onLines, spawnCli } from "./proc.ts"
import type { BrainSettings } from "./config.ts"

export type JobAgent = "claude" | "codex" | "grok"
export type JobStatus = "running" | "done" | "failed" | "cancelled"

export interface Job {
  id: string
  agent: JobAgent
  task: string
  cwd: string
  status: JobStatus
  startedAt: number
  endedAt?: number
  /** Final answer text. */
  result?: string
  error?: string
  /** Harness session id, so a later job could resume it. */
  sessionId?: string
  /** Latest progress line for the panel. */
  progress?: string
  transcript: string
}

interface Running {
  child: ChildProcess
  log: WriteStream
  done: Promise<Job>
}

/** argv and a line parser for each agent's headless mode. */
interface AgentSpec {
  cli: string
  args(job: Job, s: BrainSettings): string[]
  /** Called with each stdout line; update job.result/sessionId/progress. */
  line(job: Job, line: string): void
  /** Called once at exit with all stdout (for single-JSON outputs). */
  finish?(job: Job, stdout: string): void
}

const specs: Record<JobAgent, AgentSpec> = {
  claude: {
    cli: "claude",
    args: (_job, s) => [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      ...(s.model ? ["--model", s.model] : []),
      ...(s.effort ? ["--effort", s.effort] : []),
    ],
    line(job, line) {
      const ev = tryJson(line)
      if (!ev) return
      if (ev.type === "system" && ev.subtype === "init") job.sessionId = ev.session_id
      if (ev.type === "assistant") {
        for (const c of ev.message?.content ?? []) {
          if (c.type === "text" && c.text) job.progress = c.text
          if (c.type === "tool_use") job.progress = `using ${c.name}`
        }
      }
      if (ev.type === "result") {
        if (ev.is_error) job.error = ev.result || ev.subtype || "failed"
        else job.result = ev.result
      }
    },
  },
  codex: {
    cli: "codex",
    args: (job, s) => [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      job.cwd,
      ...(s.model ? ["-m", s.model] : []),
      ...(s.effort ? ["-c", `model_reasoning_effort="${s.effort}"`] : []),
      "-",
    ],
    line(job, line) {
      const ev = tryJson(line)
      if (!ev) return
      if (ev.type === "thread.started") job.sessionId = ev.thread_id
      if (ev.type === "item.completed" && ev.item?.type === "agent_message") job.result = ev.item.text
      if (ev.type === "item.started" && ev.item?.type) job.progress = `${ev.item.type}${ev.item.command ? ": " + ev.item.command : ""}`
      if (ev.type === "turn.failed" || ev.type === "error") job.error = ev.error?.message ?? ev.message ?? "failed"
    },
  },
  grok: {
    cli: "grok",
    args: (job, s) => [
      "-p",
      "--output-format",
      "json",
      "--always-approve",
      "--cwd",
      job.cwd,
      ...(s.model ? ["-m", s.model] : []),
      ...(s.effort ? ["--reasoning-effort", s.effort] : []),
    ],
    line() {},
    finish(job, stdout) {
      const start = stdout.indexOf("{")
      const ev = start >= 0 ? tryJson(stdout.slice(start)) : null
      if (!ev) {
        if (stdout.trim()) job.result = stdout.trim()
        return
      }
      job.sessionId = ev.sessionId
      if (typeof ev.text === "string") job.result = ev.text
      if (ev.error) job.error = typeof ev.error === "string" ? ev.error : JSON.stringify(ev.error)
    },
  },
}

/**
 * Agents often open with a plan ("I'll look through...", "Let me check...").
 * Drop leading paragraphs like that so summaries start with the answer.
 */
export function cleanResult(text: string): string {
  const paras = text.trim().split(/\n\s*\n/)
  const preamble = /^(I'll|I will|I'm going to|I am going to|Let me|First,? I'll|Now I'll|Next,? I'll|I need to|I'm checking|Checking)\b/i
  while (paras.length > 1 && (preamble.test(paras[0].trim()) || /\bI'll (pull|check|look|search|dig)\b/.test(paras[0]))) paras.shift()
  return paras.join("\n\n")
}

function tryJson(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * Background jobs on other harnesses, each a headless CLI run with full
 * permissions in a working directory. Transcripts (raw stdout) go to
 * `<dir>/<id>.jsonl` and job state to `<dir>/<id>.json`.
 */
export class Jobs {
  jobs = new Map<string, Job>()
  private running = new Map<string, Running>()
  private seq = 0
  private listeners = new Set<(job: Job, event: "start" | "update" | "end") => void>()

  constructor(
    private dir: string,
    private settings: () => Record<JobAgent, BrainSettings>,
  ) {
    mkdirSync(dir, { recursive: true })
    for (const f of readdirSync(dir)) {
      const m = f.match(/^j(\d+)\.json$/)
      if (!m) continue
      this.seq = Math.max(this.seq, Number(m[1]))
      try {
        const job: Job = JSON.parse(readFileSync(join(dir, f), "utf8"))
        if (job.status === "running") {
          job.status = "failed"
          job.error = "Vera restarted while this job ran"
        }
        this.jobs.set(job.id, job)
      } catch {}
    }
  }

  on(cb: (job: Job, event: "start" | "update" | "end") => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  list(limit = 20): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id.startsWith("j") ? id : `j${id}`)
  }

  start(agent: JobAgent, task: string, cwd: string): Job {
    if (!existsSync(cwd)) throw new Error(`folder doesn't exist: ${cwd}`)
    const spec = specs[agent]
    const id = `j${++this.seq}`
    const job: Job = {
      id,
      agent,
      task,
      cwd,
      status: "running",
      startedAt: Date.now(),
      transcript: join(this.dir, `${id}.jsonl`),
    }
    this.jobs.set(id, job)
    const log = createWriteStream(job.transcript)
    const s = this.settings()[agent] ?? {}
    const child = s.command?.length
      ? spawn(s.command[0], s.command.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
      : spawnCli(spec.cli, spec.args(job, s), { cwd, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let lastEmit = 0
    onLines(child.stdout!, (line) => {
      log.write(line + "\n")
      stdout += line + "\n"
      spec.line(job, line)
      if (Date.now() - lastEmit > 1000) {
        lastEmit = Date.now()
        this.emit(job, "update")
      }
    })
    child.stderr!.setEncoding("utf8").on("data", (d) => {
      stderr += d
      if (stderr.length > 20000) stderr = stderr.slice(-20000)
    })
    const done = new Promise<Job>((resolve) => {
      const finish = (code: number | null, err?: Error) => {
        if (job.status !== "running") return resolve(job)
        spec.finish?.(job, stdout)
        job.endedAt = Date.now()
        if (err) job.error = err.message
        if (job.error || (code !== 0 && !job.result)) {
          job.status = "failed"
          job.error ??= stderr.trim().split("\n").slice(-3).join(" ") || `exited with code ${code}`
        } else job.status = "done"
        if (job.result) job.result = cleanResult(job.result)
        if (stderr.trim()) log.write(JSON.stringify({ type: "vera.stderr", text: stderr.slice(-4000) }) + "\n")
        log.end()
        this.running.delete(id)
        this.persist(job)
        this.emit(job, "end")
        resolve(job)
      }
      child.on("error", (err) => finish(null, err))
      child.on("close", (code) => finish(code))
    })
    child.stdin!.on("error", () => {})
    child.stdin!.end(task)
    this.running.set(id, { child, log, done })
    this.persist(job)
    this.emit(job, "start")
    return job
  }

  /** Wait for a job, or until the timeout; resolves with the job either way. */
  async wait(id: string, timeoutMs: number): Promise<Job> {
    const r = this.running.get(id)
    const job = this.get(id)
    if (!job) throw new Error(`no job ${id}`)
    if (!r) return job
    let timer: NodeJS.Timeout | undefined
    const t = new Promise<Job>((resolve) => (timer = setTimeout(() => resolve(job), timeoutMs)))
    const out = await Promise.race([r.done, t])
    clearTimeout(timer)
    return out
  }

  cancel(id: string): Job {
    const job = this.get(id)
    if (!job) throw new Error(`no job ${id}`)
    const r = this.running.get(job.id)
    if (r) {
      job.status = "cancelled"
      job.endedAt = Date.now()
      killTree(r.child)
      r.log.end()
      this.running.delete(job.id)
      this.persist(job)
      this.emit(job, "end")
    }
    return job
  }

  shutdown(): void {
    for (const id of [...this.running.keys()]) this.cancel(id)
  }

  private persist(job: Job) {
    writeFileSync(join(this.dir, `${job.id}.json`), JSON.stringify(job, null, 2))
  }

  private emit(job: Job, ev: "start" | "update" | "end") {
    for (const l of this.listeners) l(job, ev)
  }
}
