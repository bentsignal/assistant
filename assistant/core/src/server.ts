import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { BrainHarness } from "./config.ts"
import type { ChimeKind } from "./app.ts"
import { runTool } from "./tools.ts"
import type { Assistant } from "./assistant.ts"

const CHIMES = new Set<ChimeKind>(["notify", "listening", "done", "error"])

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
 * Core's loopback HTTP server. It serves no pages. The brain's MCP server
 * calls tools through POST /api/tool; the rest are debug and test hooks
 * (/api/state, /api/utterance, /api/say, /api/chime, /api/notify, /api/t3-tool,
 * /api/brain).
 *
 * Every POST must be JSON (which a cross-site page can't send without a CORS
 * preflight we never answer), and a request carrying a foreign Origin is
 * refused, so a web page can't drive Vera's full-permission tools.
 * /api/tool also needs the per-run token that only the brain's MCP server
 * gets.
 *
 * `port` is tried first (0 picks a free one); if it's taken, a free port is
 * used instead, because the App's Core must always start.
 */
export async function startServer(assistant: Assistant, port: number): Promise<{ close: () => void; url: string; port: number }> {
  try {
    return await listen(assistant, port)
  } catch (err: any) {
    if (err.code !== "EADDRINUSE" || port === 0) throw err
    assistant.log(`port ${port} is busy; using a free port`)
    return listen(assistant, 0)
  }
}

function listen(assistant: Assistant, wantPort: number): Promise<{ close: () => void; url: string; port: number }> {
  let port = wantPort
  const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
  const originOk = (req: IncomingMessage) => !req.headers.origin || allowedOrigins().has(req.headers.origin)

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`)
    try {
      if (req.method === "GET") {
        if (url.pathname === "/api/state") return json(res, 200, assistant.snapshot())
        return json(res, 404, { error: "not found" })
      }
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" })
      if (!originOk(req)) return json(res, 403, { error: "foreign origin" })
      if (!String(req.headers["content-type"] ?? "").includes("application/json")) {
        return json(res, 415, { error: "send application/json" })
      }
      const body = await readBody(req)

      switch (url.pathname) {
        case "/api/tool": {
          if (req.headers["x-assistant-token"] !== assistant.token) return json(res, 401, { ok: false, error: "bad token" })
          try {
            const text = await runTool(assistant, body.name, body.args)
            return json(res, 200, { ok: true, text })
          } catch (err) {
            assistant.log(`tool ${body.name} failed: ${(err as Error).message}`)
            return json(res, 200, { ok: false, error: (err as Error).message })
          }
        }
        case "/api/utterance": {
          if (typeof body.text !== "string") return json(res, 400, { error: "text required" })
          const r = await assistant.utterance({
            text: body.text,
            direct: !!body.direct,
            start: typeof body.start === "number" ? body.start : undefined,
            end: typeof body.end === "number" ? body.end : undefined,
            source: "api",
          })
          // {wait:true}: answer once the turn ends (tests and brain checks).
          if (body.wait && r.turnId) return json(res, 200, { gate: r, turn: await assistant.waitTurn(r.turnId) })
          return json(res, 200, { gate: r })
        }
        case "/api/brain": // switch the brain harness, as set_brain does
          return json(res, 200, { brain: assistant.setBrain(body.harness as BrainHarness, body.model, body.effort) })
        case "/api/say": // have the App say a line, without the brain
          if (typeof body.text !== "string" || !body.text.trim()) return json(res, 400, { error: "text required" })
          assistant.say(body.text)
          return json(res, 200, { ok: true })
        case "/api/t3-tool": // call a T3 MCP tool with Core's session (test hook; any local user can run t3 anyway)
          try {
            return json(res, 200, { result: await assistant.t3.mcpTool(String(body.name ?? ""), body.args ?? {}) })
          } catch (err) {
            return json(res, 200, { error: (err as Error).message, code: (err as any).code })
          }
        case "/api/notify": // add an inbox item and chime, as a finished job would (test hook)
          assistant.notify({ kind: "system", title: String(body.title ?? "Test notification"), summary: String(body.summary ?? "") })
          return json(res, 200, { ok: true })
        case "/api/chime": {
          const kind = body.kind ?? "notify"
          if (!CHIMES.has(kind)) return json(res, 400, { error: `kind is one of ${[...CHIMES].join(", ")}` })
          assistant.chime(kind)
          return json(res, 200, { ok: true })
        }
        default:
          return json(res, 404, { error: "not found" })
      }
    } catch (err) {
      assistant.log(`http ${req.method} ${url.pathname} failed: ${(err as Error).message}`)
      if (!res.headersSent) json(res, 500, { error: (err as Error).message })
    }
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(wantPort, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      })
    })
  })
}
