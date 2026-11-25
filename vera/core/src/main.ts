import { rmSync, writeFileSync } from "node:fs"
import { paths } from "./config.ts"
import { AppLink } from "./app.ts"
import { Vera } from "./vera.ts"
import { startServer } from "./server.ts"

/**
 * vera-core: the Vera App's hidden sidecar (VERA.md, "App ⇄ Core protocol").
 * vera.exe starts it as `main.ts --stdio` (the flag is accepted; it's the
 * only mode): app events on stdin, core commands on stdout, logs on stderr
 * and in ~/.vera/logs/. The App owns audio and UI. The loopback HTTP server
 * is for the brain's MCP tool calls and the debug hooks (POST
 * /api/utterance, GET /api/state); its port is in ~/.vera/core-runtime.json.
 * Closing stdin quits.
 *
 * VERA_PORT overrides the HTTP port (0 = any free port).
 */
if (process.stdin.isTTY) {
  process.stderr.write("vera-core is started by vera.exe and talks JSON lines on stdin; for a scripted demo run `pnpm --filter @vera/core fake-app`.\n")
  process.exit(1)
}

// stdout carries the protocol only. Anything that logs goes to stderr.
const toErr = (...a: unknown[]) => process.stderr.write(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n")
console.log = toErr
console.info = toErr
console.debug = toErr

async function main() {
  const link = new AppLink(process.stdin, process.stdout)
  const vera = new Vera(link)
  const envPort = process.env.VERA_PORT !== undefined && process.env.VERA_PORT !== "" ? Number(process.env.VERA_PORT) : undefined
  const server = await startServer(vera, envPort ?? vera.config.port)
  vera.port = server.port
  writeFileSync(paths.runtime, JSON.stringify({ pid: process.pid, port: server.port, url: server.url, startedAt: Date.now() }, null, 2))
  await vera.start()
  vera.log(`Vera core up, debug hook ${server.url} (brain ${vera.config.brain.harness})`)

  let closing = false
  const shutdown = async (why: string) => {
    if (closing) return
    closing = true
    vera.log(`shutting down (${why})`)
    const hard = setTimeout(() => process.exit(0), 5000)
    hard.unref()
    server.close()
    await vera.close()
    rmSync(paths.runtime, { force: true })
    process.exit(0)
  }
  // The App closing our stdin (or dying) means it's time to go.
  link.on("close", () => shutdown("stdin closed"))
  if (link.closed) void shutdown("stdin closed")
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("unhandledRejection", (err) => vera.log(`unhandled rejection: ${(err as Error)?.stack ?? err}`))
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`)
  process.exit(1)
})
