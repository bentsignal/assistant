/**
 * Vera MCP server (stdio). The brain harness spawns it; every tool call is
 * forwarded to the daemon over localhost HTTP (POST $VERA_URL/api/tool with
 * the daemon's per-run token). Kept dependency-free so it starts fast.
 *
 * MCP over stdio is newline-delimited JSON-RPC 2.0.
 */
import { TOOLS } from "./defs.ts"

const VERA_URL = process.env.VERA_URL ?? "http://127.0.0.1:7313"
const TOKEN = process.env.VERA_TOKEN ?? ""
const BRAIN = process.env.VERA_BRAIN ?? ""

function send(msg: object) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

async function callTool(name: string, args: unknown): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  try {
    const res = await fetch(`${VERA_URL}/api/tool`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vera-token": TOKEN },
      body: JSON.stringify({ name, args: args ?? {}, brain: BRAIN }),
    })
    const body = (await res.json()) as { ok: boolean; text?: string; error?: string }
    if (!res.ok || !body.ok) return { content: [{ type: "text", text: body.error ?? `HTTP ${res.status}` }], isError: true }
    return { content: [{ type: "text", text: body.text ?? "ok" }] }
  } catch (err) {
    return { content: [{ type: "text", text: `Vera daemon unreachable: ${(err as Error).message}` }], isError: true }
  }
}

async function handle(msg: any) {
  const { id, method, params } = msg
  if (id === undefined) return // notifications (initialized, cancelled) need no answer
  switch (method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "vera", version: "0.1.0" },
          instructions:
            "Vera's tools. Speak only with `speak`. Delegate real work: T3 threads for coding, ask_codex for computer use, ask_grok for X/Twitter, ask_claude for quick local file questions.",
        },
      })
    case "ping":
      return send({ jsonrpc: "2.0", id, result: {} })
    case "tools/list":
      return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } })
    case "tools/call":
      return send({ jsonrpc: "2.0", id, result: await callTool(params?.name, params?.arguments) })
    case "resources/list":
      return send({ jsonrpc: "2.0", id, result: { resources: [] } })
    case "prompts/list":
      return send({ jsonrpc: "2.0", id, result: { prompts: [] } })
    default:
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } })
  }
}

let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (d: string) => {
  buf += d
  let i: number
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })
      continue
    }
    void handle(msg)
  }
})
process.stdin.on("end", () => process.exit(0))
