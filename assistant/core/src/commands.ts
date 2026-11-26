/**
 * `run_command`'s runs: a skill's program, run by Core and owned by Core.
 *
 * Nothing that happens to the brain's turn stops one: not a barge-in, not
 * an interrupted turn, not a cancelled MCP request. The tool waits for a
 * run up to `jobs.commandDetachSeconds`; one still going then (or any
 * command its skill marks `interactive`, at once) is detached: it keeps
 * running, and when it ends its output goes to the inbox (with a chime) and
 * so to her next turn. A run whose turn is gone by the time it ends (he
 * stopped her, or the turn was cut) is reported the same way, so no result
 * is ever lost. A failure always reports its real stderr first.
 */
import type { RunResult } from "./proc.ts"
import { truncate } from "./inbox.ts"

export interface CommandRun {
  id: string
  /** The command line as she gave it. */
  line: string
  skill: string
  interactive: boolean
  startedAt: number
  /** Set once she was told it went to the background. */
  detached: boolean
  /** Its output so far (stdout and stderr as they came), bounded. */
  output: string
  done: Promise<RunResult>
  result?: RunResult
  endedAt?: number
  error?: string
}

/** What a run ended with, for her: the exit status, then stderr first on a failure (that's where the reason is). */
export function describeRun(r: RunResult, skill: string, timeoutMs?: number): string {
  const failed = r.timedOut || r.code !== 0
  const head = r.timedOut
    ? `Timed out after ${Math.round((timeoutMs ?? 0) / 1000)} s and was stopped`
    : r.code === 0
      ? "Exit 0"
      : `Failed with exit ${r.code}`
  const out = r.stdout.trim()
  const err = r.stderr.trim()
  if (failed) {
    const reason = err ? `[stderr]\n${truncate(err, 5000)}` : "(nothing on stderr)"
    return truncate(`${head} (${skill}).\n${reason}${out ? `\n[stdout]\n${truncate(out, 2500)}` : ""}`, 8000)
  }
  return truncate(`${head} (${skill}).\n${out || "(no output)"}${err ? `\n[stderr]\n${truncate(err, 2000)}` : ""}`, 8000)
}

export class CommandRuns {
  private seq = 0
  readonly runs = new Map<string, CommandRun>()

  constructor(private report: (run: CommandRun, text: string) => void) {}

  /**
   * Starts `exec` (which runs the program to completion) and tracks it.
   * `reportIf` is asked when it ends: true sends its result to the inbox
   * even though it wasn't detached (its turn is gone).
   */
  start(
    line: string,
    skill: string,
    interactive: boolean,
    exec: (onData: (chunk: string) => void) => Promise<RunResult>,
    opts: { timeoutMs?: number; reportIf?: () => boolean } = {},
  ): CommandRun {
    const run: CommandRun = {
      id: `c${++this.seq}`,
      line,
      skill,
      interactive,
      startedAt: Date.now(),
      detached: false,
      output: "",
      done: undefined as unknown as Promise<RunResult>,
    }
    const onData = (chunk: string) => {
      if (run.output.length < 20_000) run.output += chunk
    }
    run.done = exec(onData).then(
      (r) => {
        run.result = r
        run.endedAt = Date.now()
        if (run.detached || opts.reportIf?.()) this.report(run, describeRun(r, skill, opts.timeoutMs))
        return r
      },
      (err: Error) => {
        run.error = err.message
        run.endedAt = Date.now()
        if (run.detached || opts.reportIf?.()) this.report(run, `Couldn't run it (${skill}): ${err.message}`)
        throw err
      },
    )
    run.done.catch(() => {})
    this.runs.set(run.id, run)
    // Keep the last few finished ones (job_status-style lookups); running ones always stay.
    const finished = [...this.runs.values()].filter((r) => r.endedAt)
    for (const r of finished.slice(0, Math.max(0, finished.length - 20))) this.runs.delete(r.id)
    return run
  }

  /**
   * Waits for `run` up to `ms`. Its result, or null once it's detached
   * (still running; reported when it ends).
   */
  async wait(run: CommandRun, ms: number): Promise<RunResult | null> {
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)))
    try {
      const r = await Promise.race([run.done, late])
      if (r === null && !run.endedAt) run.detached = true
      return r ?? run.result ?? null
    } finally {
      clearTimeout(timer)
    }
  }

  running(): CommandRun[] {
    return [...this.runs.values()].filter((r) => !r.endedAt)
  }
}
