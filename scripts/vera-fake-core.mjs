// A stand-in for Vera Core that speaks the app's stdio protocol (VERA.md,
// "App ⇄ Core protocol") and plays a short scripted turn, so vera.exe can be
// tried without Core, its brain, or the real audio engine:
//
//   ~/.vera/config.json  "app": { "core": { "command": ["node", "<repo>/scripts/vera-fake-core.mjs"] } }
//
// It logs every event it hears to stderr (Vera writes it to
// ~/.vera/logs/core.log) and starts one idle grandchild, so quitting Vera
// can be checked to end the whole tree. No dependencies.
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"

const send = (command) => process.stdout.write(JSON.stringify(command) + "\n")
const log = (...parts) => process.stderr.write(`[fake-core] ${parts.join(" ")}\n`)
const after = (ms, fn) => setTimeout(fn, ms)

const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
  windowsHide: true,
})
log(`grandchild pid ${grandchild.pid}`)

let played = false
const card = `The Windows build broke because \`transcribe-cpp\` was pinned to an older ggml.

## What changed
- Bumped the pin to **0.4.1** and rebuilt the Vulkan shaders
- \`scripts/check\` passes: 1,284 tests, 0 failures
- PR #2841 is open for review`

function play() {
  if (played) return
  played = true
  const turn = Number(process.env.VERA_FAKE_TURN_MS ?? 2500)
  after(500, () => send({ cmd: "hud", state: "listening" }))
  after(500 + turn, () => send({ cmd: "hud", state: "thinking" }))
  after(500 + turn * 2, () => {
    send({ cmd: "hud", state: "speaking" })
    send({ cmd: "speak", speak_id: "s1", text: "It finished. The build is green and the pull request is ready for review." })
    send({ cmd: "show", card_id: "c1", title: "Hex build is green", markdown: card })
  })
  after(500 + turn * 6, () => send({ cmd: "badge", count: 2 }))
  after(500 + turn * 7, () => send({ cmd: "hide", card_id: "c1" }))
  after(500 + turn * 7, () => send({ cmd: "chime", kind: "notify" }))
}

const lines = createInterface({ input: process.stdin })
lines.on("line", (line) => {
  log(`heard ${line}`)
  let event
  try {
    event = JSON.parse(line)
  } catch {
    return
  }
  if (event.type === "ready") play()
  if (event.type === "playback" && event.state !== "started") send({ cmd: "hud", state: "idle" })
})
lines.on("close", () => {
  log("stdin closed; exiting")
  grandchild.kill()
  process.exit(0)
})
