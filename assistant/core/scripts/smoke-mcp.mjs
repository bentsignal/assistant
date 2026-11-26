#!/usr/bin/env node
// A harmless stdio MCP server for scripts/assistant-soak/smoke-brain.mjs: one
// tool, `secret_word`, that returns the word given as its first argument. The
// smoke has her add it by voice, use it on the next turn, and remove it.
//
//   node assistant/core/scripts/smoke-mcp.mjs <word>

const WORD = process.argv[2] || "kumquat"
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n")
const TOOL = {
  name: "secret_word",
  description: "Today's secret word.",
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
    if (id === undefined) continue
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "smoke-echo", version: "1" } },
      })
    } else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } })
    else if (method === "tools/call") send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `The secret word is ${WORD}.` }] } })
    else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} })
    else send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } })
  }
})
process.stdin.on("end", () => process.exit(0))
