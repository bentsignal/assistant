// Fake Ears for testing the protocol: emits scripted transcript lines and logs
// the commands it receives to stderr. Usage in config.json:
//   "ears": { "command": ["node", "<path>/scripts/fake-ears.mjs", "2000:Vera, what's three times three?", "9000:and four times four?"] }
// Each arg is "<ms after start>:<text>".
import { createInterface } from "node:readline"
const t0 = Date.now()
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n")
out({ type: "ready", engine: "fake", model: "script" })
let paused = false
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l)
  console.error(`fake-ears got ${m.cmd} at +${Date.now() - t0} ms`)
  if (m.cmd === "pause") paused = true
  if (m.cmd === "resume") paused = false
  if (m.cmd === "shutdown") process.exit(0)
})
for (const arg of process.argv.slice(2)) {
  const i = arg.indexOf(":")
  const at = Number(arg.slice(0, i))
  const text = arg.slice(i + 1)
  setTimeout(() => {
    if (paused) console.error(`fake-ears: would have heard "${text}" but is paused`)
    const start = Date.now()
    out({ type: "speech_start", t: start })
    out({ type: "partial", text: text.split(" ").slice(0, 2).join(" "), t: start + 300 })
    setTimeout(() => out({ type: "final", text, start, end: Date.now() }), 600)
  }, at)
}
setInterval(() => {}, 1 << 30)
