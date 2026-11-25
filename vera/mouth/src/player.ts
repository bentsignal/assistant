// Playback through ffplay, fed raw 16-bit PCM on stdin.
//
// A cold ffplay takes ~700 ms to start on Windows (DLL loading), so the pool
// keeps warm processes parked on an empty stdin; taking one and writing PCM
// makes sound in ~50 ms. stop() kills the process outright, which is
// instant. Parked processes die on their own if this process dies, because
// their stdin pipe closes and ffplay exits on EOF.

import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

let resolvedCommand: string | undefined

/**
 * Find the real ffplay executable. Scoop installs a shim (ffplay.exe plus
 * ffplay.shim) that runs the real binary as a child; killing the shim would
 * orphan it, so read the shim's target instead.
 */
export function resolveFfplay(command?: string): string {
  if (command) return command
  if (resolvedCommand) return resolvedCommand
  let found = "ffplay"
  const lookup = spawnSync(process.platform === "win32" ? "where" : "which", ["ffplay"], { encoding: "utf8", windowsHide: true })
  const first = lookup.stdout?.split(/\r?\n/).find((l) => l.trim())
  if (first) {
    found = first.trim()
    const shim = found.replace(/\.exe$/i, ".shim")
    if (existsSync(shim)) {
      const m = /^\s*path\s*=\s*"?([^"\r\n]+)"?/m.exec(readFileSync(shim, "utf8"))
      if (m && existsSync(m[1])) found = m[1]
    } else if (/[\\/]shims[\\/]/i.test(found)) {
      const guess = join(dirname(found), "..", "apps", "ffmpeg", "current", "bin", "ffplay.exe")
      if (existsSync(guess)) found = guess
    }
  }
  resolvedCommand = found
  return found
}

function ffplayArgs(sampleRate: number, volume: number): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-nostats",
    "-nodisp", "-autoexit",
    "-fflags", "nobuffer", "-flags", "low_delay",
    "-probesize", "32", "-analyzeduration", "0",
    "-volume", String(Math.round(Math.max(0, Math.min(1, volume)) * 100)),
    "-f", "s16le", "-ar", String(sampleRate), "-ch_layout", "mono",
    "-i", "pipe:0",
  ]
}

const live = new Set<ChildProcess>()
let exitHookInstalled = false
function track(p: ChildProcess): void {
  live.add(p)
  p.once("exit", () => live.delete(p))
  if (!exitHookInstalled) {
    exitHookInstalled = true
    // Last line of defence: never leave a player behind on a normal exit.
    process.once("exit", () => {
      for (const c of live) c.kill()
    })
  }
}

/** Number of ffplay processes this module currently owns (for tests). */
export function liveProcessCount(): number {
  return live.size
}

export function toPcm16(x: Float32Array): Buffer {
  const b = Buffer.allocUnsafe(x.length * 2)
  for (let i = 0; i < x.length; i++) {
    const v = Math.max(-1, Math.min(1, x[i]))
    b.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  return b
}

/** One playback: write PCM, end, await done. kill() stops the sound immediately. */
export class Playback {
  readonly pid: number | undefined
  /** Resolves when ffplay exits: the audio finished, or the playback was killed. */
  readonly done: Promise<void>
  private proc: ChildProcess
  private ended = false
  private killed = false
  private exited = false
  stderr = ""
  /** Set when the process could not be started. */
  error: Error | undefined

  constructor(proc: ChildProcess) {
    this.proc = proc
    this.pid = proc.pid
    this.done = new Promise((resolve) => {
      proc.once("exit", () => {
        this.exited = true
        resolve()
      })
      proc.once("error", (e) => {
        this.error = e
        this.exited = true
        resolve()
      })
    })
    proc.stdin?.on("error", () => {}) // EPIPE after kill is expected
    proc.stderr?.on("data", (d) => (this.stderr += d))
  }

  get alive(): boolean {
    return !this.exited
  }

  write(samples: Float32Array): void {
    if (this.ended || this.killed || this.exited || samples.length === 0) return
    this.proc.stdin?.write(toPcm16(samples))
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.proc.stdin?.end()
  }

  kill(): void {
    if (this.killed || this.exited) return
    this.killed = true
    this.proc.stdin?.destroy()
    this.proc.kill()
  }
}

export interface PlayerOptions {
  command?: string
  /** Warm processes to keep parked. 0 spawns on demand (slow first sound). */
  warm: number
  volume: number
}

export class PlayerPool {
  private sampleRate: number
  private opts: PlayerOptions
  private parked: Playback[] = []
  private all = new Set<Playback>()
  private closed = false

  constructor(sampleRate: number, opts: PlayerOptions) {
    this.sampleRate = sampleRate
    this.opts = opts
    this.refill()
  }

  private spawn(): Playback {
    const cmd = resolveFfplay(this.opts.command)
    const proc = spawn(cmd, ffplayArgs(this.sampleRate, this.opts.volume), {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    })
    track(proc)
    const pb = new Playback(proc)
    this.all.add(pb)
    void pb.done.then(() => {
      this.all.delete(pb)
      const i = this.parked.indexOf(pb)
      if (i >= 0) this.parked.splice(i, 1)
    })
    return pb
  }

  private refill(): void {
    if (this.closed) return
    while (this.parked.length < this.opts.warm) this.parked.push(this.spawn())
  }

  /** A ready-to-write playback. Replaces itself in the pool in the background. */
  take(): Playback {
    if (this.closed) throw new Error("player pool is closed")
    let pb: Playback | undefined
    while ((pb = this.parked.shift()) && !pb.alive) {}
    if (!pb) pb = this.spawn()
    setImmediate(() => this.refill())
    return pb
  }

  /** Spawn the configured ffplay once to check it works. Throws with a helpful message if not. */
  static check(command?: string): void {
    const cmd = resolveFfplay(command)
    const r = spawnSync(cmd, ["-version"], { encoding: "utf8", windowsHide: true })
    if (r.error || r.status !== 0) {
      throw new Error(`ffplay not found or not runnable (${cmd}). Install ffmpeg (e.g. "scoop install ffmpeg") or set player.command.`)
    }
  }

  close(): void {
    this.closed = true
    for (const pb of this.all) pb.kill()
    this.parked = []
  }
}
