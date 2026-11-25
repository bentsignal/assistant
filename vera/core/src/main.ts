import { rmSync, writeFileSync } from "node:fs"
import { paths } from "./config.ts"
import { AppLink } from "./app.ts"
import { Vera } from "./vera.ts"
import { startServer } from "./server.ts"

/**
 * vera-core.
 *
 *   --stdio   Headless sidecar of the Vera App (VERA.md, "App ⇄ Core
 *             protocol"): app events on stdin, core commands on stdout, logs
 *             on stderr and in ~/.vera/logs/. No Ears, Mouth, panel, or
 *             window: the App owns audio and UI. The loopback HTTP server
 *             stays for the brain's MCP tool calls and the debug hook
 *             (POST /api/utterance); its port is in ~/.vera/core-runtime.json.
 *   (none)    v1 standalone daemon: spawns Ears and Mouth itself, serves the
 *             debug panel on http://127.0.0.1:7313 (never opens a window).
 *
 * VERA_PORT overrides the HTTP port (0 = any free port).
 */
const stdio = process.argv.includes("--stdio")

if (stdio) {
  // stdout carries the protocol only. Anything that logs goes to stderr.
  const toErr = (...a: unknown[]) => process.stderr.write(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n")
  console.log = toErr
  console.info = toErr
  console.debug = toErr
}

async function main() {
  const link = stdio ? new AppLink(process.stdin, process.stdout) : undefined
  const vera = new Vera({ mode: stdio ? "stdio" : "standalone", link })
  const envPort = process.env.VERA_PORT !== undefined && process.env.VERA_PORT !== "" ? Number(process.env.VERA_PORT) : undefined
  let server: Awaited<ReturnType<typeof startServer>>
  try {
    server = await startServer(vera, { panel: !stdio, port: envPort ?? vera.config.port, fallback: stdio })
  } catch (err: any) {
    if (err.code === "EADDRINUSE") {
      vera.log(`Port ${vera.config.port} is busy: is Vera already running?`)
      process.exit(1)
    }
    throw err
  }
  vera.port = server.port
  if (stdio) writeFileSync(paths.runtime, JSON.stringify({ pid: process.pid, port: server.port, url: server.url, startedAt: Date.now() }, null, 2))
  await vera.start()
  vera.log(
    stdio
      ? `Vera core (--stdio) up, debug hook ${server.url} (brain ${vera.config.brain.harness})`
      : `Vera on ${server.url} (brain ${vera.config.brain.harness}, mouth ${vera.mouthName}, ears ${vera.config.ears.command ? "on" : "none"})`,
  )

  let closing = false
  const shutdown = async (why: string) => {
    if (closing) return
    closing = true
    vera.log(`shutting down (${why})`)
    const hard = setTimeout(() => process.exit(0), 5000)
    hard.unref()
    server.close()
    await vera.close()
    if (stdio) rmSync(paths.runtime, { force: true })
    process.exit(0)
  }
  vera.on("shutdown", () => shutdown("api"))
  // The App closing our stdin (or dying) means it's time to go.
  link?.on("close", () => shutdown("stdin closed"))
  if (link?.closed) void shutdown("stdin closed")
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("unhandledRejection", (err) => vera.log(`unhandled rejection: ${(err as Error)?.stack ?? err}`))
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`)
  process.exit(1)
})
