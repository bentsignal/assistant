import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { which } from "../proc.ts"

/**
 * Her own MCP servers: `~/.assistant/mcp.json`, in Claude Code's
 * `mcpServers` shape, merged with the Assistant server into the brain's MCP
 * config (both harnesses). She adds, removes, enables, disables and tests
 * them herself (the `mcp_*` tools); a change restarts the brain before the
 * next turn, keeping the conversation. Nothing here needs a rebuild.
 *
 *   { "mcpServers": {
 *       "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:\\notes"] },
 *       "linear": { "type": "http", "url": "https://mcp.linear.app/mcp",
 *                   "headers": { "Authorization": "Bearer ${LINEAR_TOKEN}" } },
 *       "old": { "command": "x", "disabled": true } } }
 *
 * Secrets stay out of the file, the prompt and the logs: an env or header
 * value may be `${VAR}` (an environment variable, `${VAR:-fallback}` too) or
 * `${file:C:\path\token.txt}` (a file's trimmed text), resolved only when
 * the brain's config is written. Literal values work but are never shown.
 *
 * A broken server never breaks the brain: one that's malformed, whose
 * command isn't found, or whose secrets don't resolve is left out (with the
 * reason), and one that fails to start is reported by the harness.
 */
export interface McpServerSpec {
  type?: "stdio" | "http" | "sse"
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** Kept in the file but not given to the brain. */
  disabled?: boolean
  /** One line: what it's for (hers, for the list). */
  description?: string
}

/** A server as the harness gets it: references resolved, no `disabled`/`description`. */
export type ResolvedServer =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> }

export interface Skipped {
  name: string
  reason: string
}

/** The Assistant server's own name; nobody else may take it. */
export const RESERVED = "assistant"
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/

export function validServerName(name: unknown): string {
  if (typeof name !== "string" || !NAME.test(name.trim())) {
    throw new Error(`a server name is 1 to 40 letters, digits, - or _ (got ${JSON.stringify(name)})`)
  }
  const n = name.trim()
  if (n.toLowerCase() === RESERVED) throw new Error(`"${RESERVED}" is your own server's name; pick another`)
  return n
}

const REF = /\$\{([^}]+)\}/g

/** True when a value is only references (or has none that look secret): safe to show. */
function isReference(v: string): boolean {
  return /^\s*(\$\{[^}]+\}\s*)+$/.test(v) || /^(Bearer|Basic|Token)\s+\$\{[^}]+\}$/i.test(v.trim())
}

/** A value fit to show or log: references as written, literals hidden. */
export function redactValue(v: string): string {
  return isReference(v) ? v : "‹hidden›"
}

/** A spec fit to show or log: env and header values that aren't references are hidden. */
export function redactSpec(spec: McpServerSpec): McpServerSpec {
  const hide = (o?: Record<string, string>) =>
    o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, redactValue(String(v))])) : undefined
  return { ...spec, ...(spec.env ? { env: hide(spec.env) } : {}), ...(spec.headers ? { headers: hide(spec.headers) } : {}) }
}

/** Expands `${VAR}`, `${VAR:-fallback}` and `${file:path}` in one value. Throws naming what's missing. */
export function resolveRefs(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(REF, (_, ref: string) => {
    if (ref.startsWith("file:")) {
      const path = ref.slice(5).trim()
      try {
        return readFileSync(path, "utf8").trim()
      } catch {
        throw new Error(`the file ${path} can't be read`)
      }
    }
    const [name, fallback] = ref.split(":-", 2)
    const v = env[name.trim()]
    if (v !== undefined && v !== "") return v
    if (fallback !== undefined) return fallback
    throw new Error(`the environment variable ${name.trim()} isn't set`)
  })
}

/** The spec's transport: `type`, else http for a url, else stdio. */
export function transportOf(spec: McpServerSpec): "stdio" | "http" | "sse" {
  if (spec.type === "http" || spec.type === "sse" || spec.type === "stdio") return spec.type
  return spec.url ? "http" : "stdio"
}

/** Checks a spec's shape. Returns it cleaned (strings trimmed, empties dropped) or throws why it's wrong. */
export function checkSpec(raw: unknown): McpServerSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("a server is an object")
  const o = raw as Record<string, unknown>
  const strMap = (v: unknown, what: string): Record<string, string> | undefined => {
    if (v === undefined || v === null) return undefined
    if (typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} is an object of strings`)
    const out: Record<string, string> = {}
    for (const [k, x] of Object.entries(v)) {
      if (typeof x !== "string" && typeof x !== "number") throw new Error(`${what}.${k} must be a string`)
      out[k] = String(x)
    }
    return Object.keys(out).length ? out : undefined
  }
  const type = o.type === undefined ? undefined : String(o.type)
  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "sse") throw new Error(`type is stdio, http or sse (got ${type})`)
  const spec: McpServerSpec = { ...(type ? { type: type as McpServerSpec["type"] } : {}) }
  if (typeof o.description === "string" && o.description.trim()) spec.description = o.description.trim()
  if (o.disabled === true) spec.disabled = true
  const t = transportOf({ type: spec.type, url: typeof o.url === "string" ? o.url : undefined })
  if (t === "stdio") {
    if (typeof o.command !== "string" || !o.command.trim()) throw new Error("a stdio server needs a command")
    spec.command = o.command.trim()
    if (o.args !== undefined) {
      if (!Array.isArray(o.args)) throw new Error("args is a list of strings")
      spec.args = o.args.map(String)
    }
    const env = strMap(o.env, "env")
    if (env) spec.env = env
  } else {
    if (typeof o.url !== "string" || !o.url.trim()) throw new Error(`an ${t} server needs a url`)
    let u: URL
    try {
      u = new URL(o.url.trim())
    } catch {
      throw new Error(`${o.url} isn't a URL`)
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("the url must be http or https")
    spec.url = o.url.trim()
    const headers = strMap(o.headers, "headers")
    if (headers) spec.headers = headers
  }
  return spec
}

/**
 * Resolves one spec for the harness: references expanded, the command
 * found. Throws the reason it can't be used.
 */
export function resolveSpec(
  spec: McpServerSpec,
  env: NodeJS.ProcessEnv = process.env,
  find: (name: string) => string | null = which,
  platform: string = process.platform,
): ResolvedServer {
  const clean = checkSpec(spec)
  const map = (o?: Record<string, string>) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, resolveRefs(v, env)]))
  const t = transportOf(clean)
  if (t === "stdio") {
    const command = resolveRefs(clean.command!, env)
    const found = isAbsolute(command) ? (existsSync(command) ? command : null) : find(command)
    if (!found) throw new Error(`its command ${command} isn't found`)
    const args = (clean.args ?? []).map((a) => resolveRefs(a, env))
    // A Windows shim (npx.cmd) runs only through cmd.exe.
    if (platform === "win32" && /\.(cmd|bat)$/i.test(found)) {
      return { type: "stdio", command: env.ComSpec ?? "cmd.exe", args: ["/d", "/c", found, ...args], env: map(clean.env) }
    }
    return { type: "stdio", command, args, env: map(clean.env) }
  }
  return { type: t, url: resolveRefs(clean.url!, env), headers: map(clean.headers) }
}

/** What the brain gets from mcp.json: the usable, enabled servers, and the ones left out with why. */
export function brainServers(
  file: { servers: Record<string, unknown>; error?: string },
  env: NodeJS.ProcessEnv = process.env,
  find: (name: string) => string | null = which,
): { servers: Record<string, ResolvedServer>; skipped: Skipped[] } {
  const servers: Record<string, ResolvedServer> = {}
  const skipped: Skipped[] = []
  if (file.error) skipped.push({ name: "mcp.json", reason: file.error })
  for (const [name, raw] of Object.entries(file.servers)) {
    try {
      validServerName(name)
      if ((raw as McpServerSpec | null)?.disabled === true) continue
      servers[name] = resolveSpec(raw as McpServerSpec, env, find)
    } catch (err) {
      skipped.push({ name, reason: (err as Error).message })
    }
  }
  return { servers, skipped }
}

/** Claude Code's `--mcp-config` file: the Assistant server first, then hers. */
export function claudeMcpConfig(assistant: { command: string; args: string[]; env: Record<string, string> }, servers: Record<string, ResolvedServer>) {
  const out: Record<string, unknown> = { [RESERVED]: { type: "stdio", ...assistant } }
  for (const [name, s] of Object.entries(servers)) out[name] = s
  return { mcpServers: out }
}

/** The mcp.json store. */
export class McpStore {
  private listeners = new Set<() => void>()
  private seen: string | null = null

  constructor(readonly file: string) {}

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private text(): string {
    try {
      return readFileSync(this.file, "utf8").replace(/^\uFEFF/, "")
    } catch {
      return ""
    }
  }

  /** The file's servers, or why it can't be read (a broken file gives none). */
  read(): { servers: Record<string, unknown>; error?: string } {
    const text = this.text()
    if (!text.trim()) return { servers: {} }
    try {
      const j = JSON.parse(text)
      const s = j?.mcpServers
      if (s === undefined) return { servers: {} }
      if (!s || typeof s !== "object" || Array.isArray(s)) return { servers: {}, error: "mcpServers isn't an object" }
      return { servers: s }
    } catch (err) {
      return { servers: {}, error: `it isn't valid JSON (${(err as Error).message})` }
    }
  }

  /** Emits a change when the file differs from what was last seen (edited by hand, or by a job). */
  check(): boolean {
    const now = this.text()
    if (this.seen === null) {
      this.seen = now
      return false
    }
    if (now === this.seen) return false
    this.seen = now
    for (const cb of this.listeners) cb()
    return true
  }

  private write(servers: Record<string, unknown>) {
    const r = this.read()
    if (r.error) throw new Error(`mcp.json can't be changed while ${r.error}; fix or remove ${this.file} first`)
    let doc: Record<string, unknown> = {}
    try {
      doc = JSON.parse(this.text() || "{}")
    } catch {}
    doc.mcpServers = servers
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 })
    this.check()
  }

  list(): { name: string; spec: McpServerSpec | null; error?: string }[] {
    const { servers } = this.read()
    return Object.entries(servers).map(([name, raw]) => {
      try {
        return { name, spec: checkSpec(raw) }
      } catch (err) {
        return { name, spec: null, error: (err as Error).message }
      }
    })
  }

  get(name: string): McpServerSpec | null {
    const { servers } = this.read()
    const key = Object.keys(servers).find((k) => k.toLowerCase() === name.trim().toLowerCase())
    return key ? checkSpec(servers[key]) : null
  }

  /** Adds or replaces a server. Returns whether it was new. */
  add(name: string, spec: unknown): { name: string; spec: McpServerSpec; created: boolean } {
    const n = validServerName(name)
    const clean = checkSpec(spec)
    const { servers } = this.read()
    const old = Object.keys(servers).find((k) => k.toLowerCase() === n.toLowerCase())
    if (old) delete servers[old]
    servers[n] = clean
    this.write(servers)
    return { name: n, spec: clean, created: !old }
  }

  remove(name: string): McpServerSpec {
    const { servers } = this.read()
    const key = Object.keys(servers).find((k) => k.toLowerCase() === name.trim().toLowerCase())
    if (!key) throw new Error(`no MCP server called ${name}`)
    const spec = servers[key] as McpServerSpec
    delete servers[key]
    this.write(servers)
    return spec
  }

  setEnabled(name: string, enabled: boolean): { name: string; changed: boolean } {
    const { servers } = this.read()
    const key = Object.keys(servers).find((k) => k.toLowerCase() === name.trim().toLowerCase())
    if (!key) throw new Error(`no MCP server called ${name}`)
    const spec = { ...(servers[key] as McpServerSpec) }
    const was = spec.disabled !== true
    if (was === enabled) return { name: key, changed: false }
    if (enabled) delete spec.disabled
    else spec.disabled = true
    servers[key] = spec
    this.write(servers)
    return { name: key, changed: true }
  }
}

export interface ProbeResult {
  ok: boolean
  tools: { name: string; description?: string }[]
  error?: string
  /** The server's last stderr lines (stdio), for a failure. */
  stderr?: string
}

/**
 * Starts a server, initializes it, lists its tools, and stops it: whether it
 * works, before the brain relies on it.
 */
export async function probeServer(server: ResolvedServer, timeoutMs = 30_000): Promise<ProbeResult> {
  if (server.type === "stdio") return probeStdio(server, timeoutMs)
  return probeHttp(server, timeoutMs)
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "assistant-probe", version: "1" } },
}

function probeStdio(server: Extract<ResolvedServer, { type: "stdio" }>, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let stderr = ""
    let buf = ""
    let done = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(server.command, server.args, {
        env: { ...process.env, ...server.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (err) {
      resolve({ ok: false, tools: [], error: (err as Error).message })
      return
    }
    const finish = (r: ProbeResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        child.stdin?.end()
      } catch {}
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => {})
      } else child.kill()
      resolve({ ...r, ...(r.ok ? {} : { stderr: stderr.trim().split(/\r?\n/).slice(-5).join("\n").slice(0, 800) }) })
    }
    const timer = setTimeout(() => finish({ ok: false, tools: [], error: `no answer within ${timeoutMs / 1000}s` }), timeoutMs)
    const send = (m: object) => child.stdin?.write(JSON.stringify(m) + "\n")
    child.on("error", (err) => finish({ ok: false, tools: [], error: err.message }))
    child.on("exit", (code) => finish({ ok: false, tools: [], error: `it exited (${code}) before listing its tools` }))
    child.stdin?.on("error", () => {})
    child.stderr?.setEncoding("utf8").on("data", (d: string) => (stderr = (stderr + d).slice(-4000)))
    child.stdout?.setEncoding("utf8").on("data", (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line.startsWith("{")) continue
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1) {
          if (msg.error) return finish({ ok: false, tools: [], error: `initialize failed: ${msg.error.message ?? JSON.stringify(msg.error)}` })
          send({ jsonrpc: "2.0", method: "notifications/initialized" })
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
        } else if (msg.id === 2) {
          if (msg.error) return finish({ ok: false, tools: [], error: `tools/list failed: ${msg.error.message ?? JSON.stringify(msg.error)}` })
          return finish({ ok: true, tools: (msg.result?.tools ?? []).map((t: any) => ({ name: t.name, description: t.description })) })
        }
      }
    })
    send(INIT)
  })
}

/** A JSON-RPC reply, sent plain or as server-sent events. */
function readRpc(body: string, id: number): any {
  const t = body.trim()
  if (t.startsWith("{")) return JSON.parse(t)
  for (const line of t.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    try {
      const v = JSON.parse(line.slice(5).trim())
      if (v.id === id) return v
    } catch {}
  }
  throw new Error(`unreadable reply: ${t.slice(0, 200)}`)
}

async function probeHttp(server: Extract<ResolvedServer, { type: "http" | "sse" }>, timeoutMs: number): Promise<ProbeResult> {
  if (server.type === "sse") {
    // The legacy SSE transport needs a long-lived stream; check it answers, and leave the rest to the harness.
    try {
      const res = await fetch(server.url, { headers: { accept: "text/event-stream", ...server.headers }, signal: AbortSignal.timeout(timeoutMs) })
      void res.body?.cancel()
      return res.ok ? { ok: true, tools: [], error: "SSE server answers; its tools are listed when the brain connects" } : { ok: false, tools: [], error: `HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, tools: [], error: (err as Error).message }
    }
  }
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...server.headers }
  const post = (m: object) => fetch(server.url, { method: "POST", headers, body: JSON.stringify(m), signal: AbortSignal.timeout(timeoutMs) })
  try {
    const init = await post(INIT)
    const initText = await init.text()
    if (!init.ok) return { ok: false, tools: [], error: `HTTP ${init.status} ${initText.slice(0, 200)}` }
    const r1 = readRpc(initText, 1)
    if (r1.error) return { ok: false, tools: [], error: `initialize failed: ${r1.error.message}` }
    const session = init.headers.get("mcp-session-id")
    if (session) headers["mcp-session-id"] = session
    await (await post({ jsonrpc: "2.0", method: "notifications/initialized" })).text()
    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
    const r2 = readRpc(await list.text(), 2)
    if (session) void fetch(server.url, { method: "DELETE", headers }).catch(() => {})
    if (r2.error) return { ok: false, tools: [], error: `tools/list failed: ${r2.error.message}` }
    return { ok: true, tools: (r2.result?.tools ?? []).map((t: any) => ({ name: t.name, description: t.description })) }
  } catch (err) {
    return { ok: false, tools: [], error: (err as Error).message }
  }
}
