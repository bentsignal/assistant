#!/usr/bin/env node
// A slow stdio MCP server for tests of talking over a running tool: one tool,
// `slow_word`, that waits `ms` (default 6000) and returns the word given as
// its first argument. Core's tests (ScriptBrain's `mcp` step) and
// scripts/assistant-soak/smoke-brain.mjs talk over her while it runs; the
// tool must still finish.
//
//   node assistant/core/scripts/slow-mcp.mjs <word> [ms]
//
// Each call it finishes, and each one it was told to cancel
// (notifications/cancelled), is appended to $SLOW_MCP_LOG when that's set.

import { appendFileSync } from "node:fs"

const WORD = process.argv[2] || "kumquat"
const MS = Number(process.argv[3] || 6000)
const LOG = process.env.SLOW_MCP_LOG
const note = (line) => LOG && appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`)
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n")
const TOOL = {
  name: "slow_word",
  description: `Looks up today's slow word. Takes about ${Math.round(MS / 1000)} seconds; wait for it.`,
  inputSchema: { type: "object", properties: {} },
}

let buf = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (d) => {
  buf += d
  let i
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    const { id, method, params } = msg
    if (method === "notifications/cancelled") note(`cancelled ${params?.requestId}`)
    if (id === undefined) continue
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "slow-mcp", version: "1" } },
      })
    } else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } })
    else if (method === "tools/call") {
      note(`started ${id}`)
      setTimeout(() => {
        note(`finished ${id}`)
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `The slow word is ${WORD}.` }] } })
      }, MS)
    } else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} })
    else send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } })
  }
})
process.stdin.on("end", () => process.exit(0))
