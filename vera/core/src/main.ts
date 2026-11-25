import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { Vera } from "./vera.ts"
import { startServer } from "./server.ts"

/** Open the panel as a chromeless Edge/Chrome app window. */
function openPanel(url: string, browser?: string) {
  const candidates = [
    browser,
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  ].filter((p): p is string => !!p && existsSync(p))
  const exe = candidates[0]
  if (!exe) {
    console.log(`Open ${url} in a browser.`)
    return
  }
  spawn(exe, [`--app=${url}`, "--window-size=1280,860"], { detached: true, stdio: "ignore" }).unref()
}

async function main() {
  const vera = new Vera()
  let server: { close: () => void; url: string }
  try {
    server = await startServer(vera)
  } catch (err: any) {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${vera.config.port} is busy: is Vera already running?`)
      if (process.argv.includes("--open")) openPanel(`http://127.0.0.1:${vera.config.port}`, vera.config.panel.browser)
      process.exit(1)
    }
    throw err
  }
  await vera.start()
  vera.log(`Vera on ${server.url} (brain ${vera.config.brain.harness}, mouth ${vera.mouthName}, ears ${vera.config.ears.command ? "on" : "none"})`)
  if (process.argv.includes("--open") && vera.config.panel.open) openPanel(server.url, vera.config.panel.browser)

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    vera.log("shutting down")
    server.close()
    await vera.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
