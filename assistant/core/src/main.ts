import { rmSync, writeFileSync } from "node:fs"
import { paths } from "./config.ts"
import { AppLink } from "./app.ts"
import { Assistant } from "./assistant.ts"
import { startServer } from "./server.ts"

/**
 * assistant-core: the Vera App's hidden sidecar (DESIGN.md, "App ⇄ Core protocol").
 * assistant.exe starts it as `main.ts --stdio` (the flag is accepted; it's the
 * only mode): app events on stdin, core commands on stdout, logs on stderr
 * and in ~/.assistant/logs/. The App owns audio and UI. The loopback HTTP server
 * is for the brain's MCP tool calls and the debug hooks (POST
 * /api/utterance, GET /api/state); its port is in ~/.assistant/core-runtime.json.
 * Closing stdin quits.
 *
 * ASSISTANT_PORT overrides the HTTP port (0 = any free port).
 */
if (process.stdin.isTTY) {
  process.stderr.write("assistant-core is started by assistant.exe and talks JSON lines on stdin; for a scripted demo run `pnpm --filter @assistant/core fake-app`.\n")
  process.exit(1)
}

// stdout carries the protocol only. Anything that logs goes to stderr.
const toErr = (...a: unknown[]) => process.stderr.write(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n")
console.log = toErr
console.info = toErr
console.debug = toErr

async function main() {
  const link = new AppLink(process.stdin, process.stdout)
  const assistant = new Assistant(link)
  const envPort = process.env.ASSISTANT_PORT !== undefined && process.env.ASSISTANT_PORT !== "" ? Number(process.env.ASSISTANT_PORT) : undefined
  const server = await startServer(assistant, envPort ?? assistant.config.port)
  assistant.port = server.port
  writeFileSync(paths.runtime, JSON.stringify({ pid: process.pid, port: server.port, url: server.url, startedAt: Date.now() }, null, 2))
  await assistant.start()
  assistant.log(`Assistant core up, debug hook ${server.url} (brain ${assistant.config.brain.harness})`)

  let closing = false
  const shutdown = async (why: string) => {
    if (closing) return
    closing = true
    assistant.log(`shutting down (${why})`)
    const hard = setTimeout(() => process.exit(0), 5000)
    hard.unref()
    server.close()
    await assistant.close()
    rmSync(paths.runtime, { force: true })
    process.exit(0)
  }
  // The App closing our stdin (or dying) means it's time to go.
  link.on("close", () => shutdown("stdin closed"))
  if (link.closed) void shutdown("stdin closed")
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("unhandledRejection", (err) => assistant.log(`unhandled rejection: ${(err as Error)?.stack ?? err}`))
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`)
  process.exit(1)
})
