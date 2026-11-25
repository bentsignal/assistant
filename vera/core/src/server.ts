import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { WebSocketServer, type WebSocket } from "ws"
import { CORE_DIR, type BrainHarness } from "./config.ts"
import { runTool } from "./tools.ts"
import type { Vera } from "./vera.ts"

const PANEL_DIR = join(CORE_DIR, "panel")
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".wav": "audio/wav",
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<any> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw new Error("body too large")
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  return text ? JSON.parse(text) : {}
}

/**
 * Loopback-only HTTP and WebSocket. Every POST must be JSON (which a
 * cross-site page can't send without a CORS preflight we never answer), and
 * a request carrying a foreign Origin is refused, so a web page can't drive
 * Vera's full-permission tools. /api/tool also needs the per-run token that
 * only the brain's MCP server gets.
 */
export function startServer(vera: Vera): Promise<{ close: () => void; url: string }> {
  const port = vera.config.port
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  const originOk = (req: IncomingMessage) => !req.headers.origin || allowedOrigins.has(req.headers.origin)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`)
    try {
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^[\\/]+/, "")
        if (rel.includes("..")) return json(res, 400, { error: "bad path" })
        try {
          const body = await readFile(join(PANEL_DIR, rel))
          res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream", "cache-control": "no-store" })
          return res.end(body)
        } catch {
          return json(res, 404, { error: "not found" })
        }
      }
      if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, vera.snapshot())
      if (req.method === "GET" && url.pathname === "/api/turns") return json(res, 200, vera.turns)

      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" })
      if (!originOk(req)) return json(res, 403, { error: "foreign origin" })
      if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
        return json(res, 415, { error: "send application/json" })
      }
      const body = await readBody(req)

      switch (url.pathname) {
        case "/api/tool": {
          if (req.headers["x-vera-token"] !== vera.token) return json(res, 401, { ok: false, error: "bad token" })
          try {
            const text = await runTool(vera, body.name, body.args)
            return json(res, 200, { ok: true, text })
          } catch (err) {
            vera.log(`tool ${body.name} failed: ${(err as Error).message}`)
            return json(res, 200, { ok: false, error: (err as Error).message })
          }
        }
        case "/api/utterance": {
          if (typeof body.text !== "string") return json(res, 400, { error: "text required" })
          const r = await vera.utterance({
            text: body.text,
            direct: !!body.direct,
            start: typeof body.start === "number" ? body.start : undefined,
            source: body.source === "panel" ? "panel" : "api",
          })
          // {wait:true}: answer once the turn ends (test hook and benchmarks).
          if (body.wait && r.turnId) return json(res, 200, { gate: r, turn: await vera.waitTurn(r.turnId) })
          return json(res, 200, { gate: r })
        }
        case "/api/stop":
          vera.stop("panel")
          return json(res, 200, { ok: true })
        case "/api/talk":
          vera.openFollowUp()
          void vera.mouth.chime("listening")
          return json(res, 200, { ok: true })
        case "/api/inbox/read":
          return json(res, 200, { marked: vera.inbox.markRead(Array.isArray(body.ids) ? body.ids : undefined) })
        case "/api/brain":
          return json(res, 200, { brain: vera.setBrain(body.harness as BrainHarness, body.model, body.effort) })
        case "/api/say": // speak without the brain (Mouth smoke test)
          vera.say(String(body.text ?? ""))
          return json(res, 200, { ok: true })
        case "/api/chime":
          await vera.mouth.chime(body.kind ?? "notify")
          return json(res, 200, { ok: true })
        default:
          return json(res, 404, { error: "not found" })
      }
    } catch (err) {
      vera.log(`http ${req.method} ${url.pathname} failed: ${(err as Error).message}`)
      if (!res.headersSent) json(res, 500, { error: (err as Error).message })
    }
  })

  const wss = new WebSocketServer({ noServer: true })
  const clients = new Set<WebSocket>()
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws") || !originOk(req)) return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws)
      ws.send(JSON.stringify({ type: "state", state: vera.snapshot() }))
      ws.on("close", () => clients.delete(ws))
      ws.on("error", () => clients.delete(ws))
    })
  })
  const broadcast = (msg: object) => {
    const s = JSON.stringify(msg)
    for (const c of clients) if (c.readyState === c.OPEN) c.send(s)
  }
  vera.on("state", (state) => broadcast({ type: "state", state }))
  vera.on("log", (line) => broadcast({ type: "log", line }))
  vera.on("said", (text) => broadcast({ type: "said", text }))
  vera.on("heard", (e) => broadcast({ type: "heard", ...e }))

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => {
          for (const c of clients) c.close()
          server.close()
        },
      })
    })
  })
}
