import { spawn, type ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { onLines } from "./proc.ts"

/** Ears JSON-lines protocol (VERA.md). */
export type EarsMessage =
  | { type: "ready"; engine?: string; model?: string }
  | { type: "speech_start"; t: number }
  | { type: "partial"; text: string; t: number }
  | { type: "final"; text: string; start: number; end: number }
  | { type: "error"; message: string }

/**
 * Runs the configured Ears process and turns its stdout into events. Pause
 * and resume are reference-free and idempotent: we remember the last state
 * we sent and only write on change. Restarts Ears with backoff if it exits.
 */
export class Ears extends EventEmitter {
  private child: ChildProcess | null = null
  private paused = false
  private closing = false
  private backoff = 1000
  ready = false
  info: { engine?: string; model?: string } = {}

  constructor(
    private command: string[],
    private cwd?: string,
  ) {
    super()
  }

  start() {
    if (this.child) return
    const [file, ...args] = this.command
    const child = spawn(file, args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    this.child = child
    onLines(child.stdout!, (line) => {
      let msg: EarsMessage
      try {
        msg = JSON.parse(line)
      } catch {
        console.error(`[ears] not JSON: ${line.slice(0, 200)}`)
        return
      }
      if (msg.type === "ready") {
        this.ready = true
        this.backoff = 1000
        this.info = { engine: msg.engine, model: msg.model }
        if (this.paused) this.write({ cmd: "pause" })
      }
      this.emit("message", msg)
      this.emit(msg.type, msg)
    })
    onLines(child.stderr!, (line) => console.error(`[ears] ${line}`))
    child.stdin!.on("error", () => {})
    child.on("error", (err) => this.emit("message", { type: "error", message: `ears failed to start: ${err.message}` }))
    child.on("exit", (code) => {
      this.child = null
      this.ready = false
      this.emit("exit", code)
      if (!this.closing) {
        console.error(`[ears] exited (${code}); restarting in ${this.backoff} ms`)
        setTimeout(() => this.start(), this.backoff).unref()
        this.backoff = Math.min(this.backoff * 2, 30_000)
      }
    })
  }

  private write(cmd: object) {
    this.child?.stdin?.write(JSON.stringify(cmd) + "\n")
  }

  pause() {
    if (this.paused) return
    this.paused = true
    this.write({ cmd: "pause" })
  }

  resume() {
    if (!this.paused) return
    this.paused = false
    this.write({ cmd: "resume" })
  }

  get isPaused() {
    return this.paused
  }

  async close() {
    this.closing = true
    if (!this.child) return
    this.write({ cmd: "shutdown" })
    const child = this.child
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        child.kill()
        resolve()
      }, 2000)
      child.once("exit", () => {
        clearTimeout(t)
        resolve()
      })
    })
  }
}
