import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { delimiter, dirname, extname, join } from "node:path"

/**
 * How to launch a CLI without a shell. On Windows, npm installs CLIs as .cmd
 * shims and T3 Code ships a .cmd launcher; running those through cmd.exe means
 * fragile quoting of prompts. So we read the shim and run what it runs.
 */
export interface Launch {
  file: string
  prefix: string[]
  env?: Record<string, string>
}

const cache = new Map<string, Launch>()

export function which(name: string): string | null {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  const dirs = (process.env.PATH ?? "").split(delimiter)
  if (/[\\/]/.test(name)) return existsSync(name) ? name : null
  for (const d of dirs) {
    for (const e of extname(name) ? [""] : exts) {
      const p = join(d, name + e.toLowerCase())
      if (existsSync(p)) return p
      const p2 = join(d, name + e)
      if (existsSync(p2)) return p2
    }
  }
  return null
}

/** Parse an npm .cmd shim or the T3 Code launcher into a direct launch. */
export function parseCmdShim(path: string): Launch | null {
  const text = readFileSync(path, "utf8")
  const dp0 = dirname(path) + "\\"
  // npm: "%_prog%"  "%dp0%\node_modules\...\bin\grok" %*
  const npm = text.match(/"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/)
  if (npm) {
    const local = join(dirname(path), "node.exe")
    return { file: existsSync(local) ? local : process.execPath, prefix: [join(dp0, npm[1])] }
  }
  // T3 Code: "<exe>" "<script>" %*  with set "K=V" lines
  const t3 = text.match(/^"([^"]+\.exe)"\s+"([^"]+)"\s+%\*/m)
  if (t3) {
    const env: Record<string, string> = {}
    for (const m of text.matchAll(/^(?:if not defined \S+ )?set "([A-Z0-9_]+)=([^"]*)"/gim)) env[m[1]] = m[2]
    return { file: t3[1], prefix: [t3[2]], env }
  }
  return null
}

/** Names a launch found another way (T3 Code's bundled CLI), so `spawnCli(name)` runs it. */
export function registerCli(name: string, launch: Launch): void {
  cache.set(name, launch)
}

export function resolveCli(name: string): Launch {
  const hit = cache.get(name)
  if (hit) return hit
  const path = which(name)
  if (!path) throw new Error(`${name} not found on PATH`)
  let launch: Launch
  if (/\.(cmd|bat)$/i.test(path)) {
    launch = parseCmdShim(path) ?? { file: process.env.ComSpec ?? "cmd.exe", prefix: ["/d", "/c", path] }
  } else {
    launch = { file: path, prefix: [] }
  }
  cache.set(name, launch)
  return launch
}

export function spawnCli(name: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  const l = resolveCli(name)
  return spawn(l.file, [...l.prefix, ...args], {
    windowsHide: true,
    ...opts,
    env: { ...process.env, ...l.env, ...(opts.env as Record<string, string> | undefined) },
  })
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Run a CLI to completion, optionally with stdin, with a timeout. */
export function runCli(
  name: string,
  args: string[],
  opts: { input?: string; cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnCli(name, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] })
    } catch (err) {
      reject(err)
      return
    }
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          killTree(child)
        }, opts.timeoutMs)
      : null
    child.stdout!.setEncoding("utf8").on("data", (d) => (stdout += d))
    child.stderr!.setEncoding("utf8").on("data", (d) => (stderr += d))
    child.on("error", (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
    child.stdin!.on("error", () => {})
    child.stdin!.end(opts.input ?? "")
  })
}

/** Kill a process and its children (Windows needs taskkill /T). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {})
  } else {
    try {
      child.kill("SIGTERM")
    } catch {}
  }
}

/** Split a stream into lines. */
export function onLines(stream: NodeJS.ReadableStream, cb: (line: string) => void): void {
  let buf = ""
  stream.setEncoding?.("utf8")
  stream.on("data", (d: string | Buffer) => {
    buf += d.toString()
    let i: number
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "")
      buf = buf.slice(i + 1)
      if (line.trim()) cb(line)
    }
  })
  stream.on("end", () => {
    if (buf.trim()) cb(buf)
    buf = ""
  })
}
