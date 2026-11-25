#!/usr/bin/env node
// End-to-end test of the whole loop with real audio and no human:
//   WAV scenario -> hex ears (HEX_AUDIO_FIXTURE) -> Core gate -> brain -> speak -> @vera/mouth.
//
//   powershell -File vera/core/scripts/e2e/make-phrases.ps1 -Out <dir>        # SAPI "Shawn" phrases
//   pnpm --filter @vera/mouth say "<long sentence>" --out <dir>/echo.wav       # Vera's voice, as echo
//   node vera/core/scripts/e2e/run.mjs <dir> [--barge-in] [--no-echo] [--loud]
//
// Runs Core in a throwaway VERA_HOME on port 7399 with playback silenced
// (SDL_AUDIODRIVER=dummy keeps ffplay's real-time pacing; --loud plays at 5%
// volume instead). Uses the real brain (a handful of short turns).
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"

const CORE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const args = process.argv.slice(2)
const dir = args.find((a) => !a.startsWith("--"))
if (!dir) {
  console.error("usage: run.mjs <phrases dir> [--barge-in] [--loud]")
  process.exit(2)
}
const bargeIn = args.includes("--barge-in")
const loud = args.includes("--loud")
const noEcho = args.includes("--no-echo") // a headset: Vera's voice never reaches the microphone
const RATE = 16000
const PORT = 7399

// ---- WAV in/out -------------------------------------------------------------

function readWav(file) {
  const b = readFileSync(file)
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === "fmt ") fmt = { format: b.readUInt16LE(off + 8), channels: b.readUInt16LE(off + 10), rate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) }
    if (id === "data") data = b.subarray(off + 8, off + 8 + size)
    off += 8 + size + (size & 1)
  }
  const n = data.length / (fmt.bits / 8) / fmt.channels
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = i * fmt.channels * (fmt.bits / 8)
    x[i] = fmt.format === 3 ? data.readFloatLE(p) : data.readInt16LE(p) / 32768
  }
  if (fmt.rate === RATE) return x
  const out = new Float32Array(Math.floor((n * RATE) / fmt.rate))
  for (let i = 0; i < out.length; i++) {
    const t = (i * fmt.rate) / RATE
    const k = Math.floor(t)
    out[i] = (x[k] ?? 0) * (1 - (t - k)) + (x[k + 1] ?? 0) * (t - k)
  }
  return out
}

/** Trim leading and trailing silence so the plan's times are speech onsets. */
function trim(x) {
  let a = 0
  let z = x.length - 1
  while (a < z && Math.abs(x[a]) < 0.01) a++
  while (z > a && Math.abs(x[z]) < 0.01) z--
  return x.subarray(Math.max(0, a - 160), z + 160)
}

function writeWav(file, x) {
  const data = Buffer.alloc(x.length * 2)
  for (let i = 0; i < x.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), i * 2)
  const h = Buffer.alloc(44)
  h.write("RIFF", 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write("WAVEfmt ", 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write("data", 36)
  h.writeUInt32LE(data.length, 40)
  writeFileSync(file, Buffer.concat([h, data]))
}

// ---- scenario ---------------------------------------------------------------

// at: fixture second the phrase starts. expect: what Core should do with it.
const PLAN = [
  { at: 3, file: "nowake", expect: "ignore", why: "no wake word" },
  { at: 9, file: "time", expect: "turn:wake", why: "wake word" },
  { at: 18.5, file: "followup", expect: "turn:followup", why: "follow-up window, no wake word" },
  { at: 42, file: "late", expect: "ignore", why: "window long closed" },
  { at: 48, file: "variable", expect: "turn:wake", why: "soft wake word (misheard Vera)" },
  { at: 58, file: "fact", expect: "turn:wake", why: "wake word, long answer" },
  { at: 67, file: "stop", expect: bargeIn ? "barge-in" : "dropped", why: bargeIn ? (noEcho ? "barge-in (headset, no echo)" : "barge-in over echo") : "half-duplex: Ears paused" },
]
// Vera's own voice reaching the microphone while she answers the tomato question.
const ECHO = { at: 63, file: "echo", gain: 0.25 }
// Inbox notifications (seconds after Ears is ready): one while idle, one during speech (deferred).
const NOTIFY = [34, 42.8]
const TOTAL = 84

const rng = (() => {
  let s = 7
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
})()
const mix = new Float32Array(TOTAL * RATE)
for (let i = 0; i < mix.length; i++) mix[i] = rng() * 0.0015 // room noise, about -62 dBFS
const add = (x, at, gain = 1) => {
  const o = Math.round(at * RATE)
  for (let i = 0; i < x.length && o + i < mix.length; i++) mix[o + i] += x[i] * gain
}
const durations = {}
for (const p of PLAN) {
  const x = trim(readWav(join(dir, `${p.file}.wav`)))
  durations[p.file] = x.length / RATE
  add(x, p.at, 0.8)
}
if (!noEcho && existsSync(join(dir, `${ECHO.file}.wav`))) add(trim(readWav(join(dir, `${ECHO.file}.wav`))), ECHO.at, ECHO.gain)
const home = mkdtempSync(join(tmpdir(), "vera-e2e-"))
const fixture = join(home, "scenario.wav")
writeWav(fixture, mix)

// ---- run Core ---------------------------------------------------------------

mkdirSync(home, { recursive: true })
writeFileSync(
  join(home, "config.json"),
  JSON.stringify(
    {
      port: PORT,
      panel: { open: false },
      ears: { command: "auto", bargeIn },
      mouth: { module: "@vera/mouth", options: { volume: loud ? 0.05 : 0.3 } },
      t3: { pollSeconds: 3600 },
    },
    null,
    2,
  ),
)
const env = { ...process.env, VERA_HOME: home, HEX_AUDIO_FIXTURE: fixture }
if (!loud) env.SDL_AUDIODRIVER = "dummy"
const tsx = join(CORE, "node_modules", "tsx", "dist", "cli.mjs")
const t0wall = Date.now()
const core = spawn(process.execPath, [tsx, join(CORE, "src", "main.ts")], { cwd: CORE, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
const logs = []
let readyAt = 0
const onLine = (line) => {
  logs.push(line)
  if (process.env.E2E_VERBOSE) console.log(line)
  if (!readyAt && line.includes("ears ready")) {
    readyAt = Date.now()
    console.log(`ears ready after ${((readyAt - t0wall) / 1000).toFixed(1)} s; scenario runs ${TOTAL} s`)
    schedule()
  }
}
let buf = ""
for (const s of [core.stdout, core.stderr]) {
  s.setEncoding("utf8")
  s.on("data", (d) => {
    buf += d
    let i
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i).trimEnd())
      buf = buf.slice(i + 1)
    }
  })
}

const events = []
let ws
async function post(path, body = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return r.json()
}
function connect() {
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
  ws.on("message", (m) => {
    const e = JSON.parse(String(m))
    if (e.type === "state") {
      const st = e.state.status
      if (events.at(-1)?.status !== st) events.push({ t: Date.now(), type: "status", status: st })
    } else events.push({ t: Date.now(), ...e })
  })
  ws.on("error", () => setTimeout(connect, 300))
}
setTimeout(connect, 1500)

function schedule() {
  for (const s of NOTIFY) setTimeout(() => post("/api/notify", { title: `e2e ping at ${s}s` }).catch(() => {}), s * 1000)
  setTimeout(finish, TOTAL * 1000)
}

const deadline = setTimeout(() => {
  console.error("Ears never became ready. Last lines:\n" + logs.slice(-20).join("\n"))
  finish(1)
}, 120_000)

async function finish(code = 0) {
  clearTimeout(deadline)
  let turns = []
  try {
    turns = await (await fetch(`http://127.0.0.1:${PORT}/api/turns`)).json()
  } catch {}
  try {
    await post("/api/shutdown")
  } catch {}
  await new Promise((r) => {
    const t = setTimeout(() => {
      spawnSync("taskkill", ["/pid", String(core.pid), "/T", "/F"], { windowsHide: true })
      r()
    }, 8000)
    core.on("exit", () => {
      clearTimeout(t)
      r()
    })
  })
  ws?.close()
  report(turns)
  writeFileSync(join(home, "e2e.log"), logs.join("\n"))
  console.log(`\nlogs: ${join(home, "e2e.log")}`)
  process.exit(process.exitCode || code)
}

// ---- report -----------------------------------------------------------------

function report(turns) {
  const rel = (t) => ((t - readyAt) / 1000).toFixed(1).padStart(5)
  console.log("\n-- timeline (s after Ears ready) --")
  for (const e of events) {
    if (e.type === "heard") console.log(`${rel(e.t)} heard "${e.text}" -> ${e.gate.action}${e.gate.via ? ":" + e.gate.via : ""}${e.gate.reason ? ` (${e.gate.reason})` : ""}`)
    else if (e.type === "said") console.log(`${rel(e.t)} vera: "${e.text}"`)
    else if (e.type === "status") console.log(`${rel(e.t)} [${e.status}]`)
    else if (e.type === "log" && /dropped|barge-in|inbox:|end of speech|stop \(|chime/.test(e.line)) console.log(`${rel(e.t)} ${e.line.replace(/^\S+ /, "")}`)
  }
  console.log("\n-- checks --")
  const heard = events.filter((e) => e.type === "heard")
  const lines = logs.join("\n")
  let pass = 0
  let fail = 0
  const check = (ok, what) => {
    ok ? pass++ : fail++
    console.log(`${ok ? "PASS" : "FAIL"} ${what}`)
  }
  for (const p of PLAN) {
    const from = readyAt + p.at * 1000 - 500
    const to = readyAt + (p.at + durations[p.file] + 4) * 1000
    const h = heard.find((e) => e.t >= from && e.t <= to)
    let got = h ? `${h.gate.action}${h.gate.via ? ":" + h.gate.via : ""}` : "nothing"
    if (p.expect === "dropped") {
      const dropped = logs.some((l) => /dropped \(heard while speaking\)/.test(l) && /stop/i.test(l))
      got = h ? got : dropped ? "dropped" : "nothing (Ears paused)"
      check(!h || h.gate.action === "ignore", `${p.file}: ${p.why} -> ${got}`)
      continue
    }
    if (p.expect === "barge-in") {
      check(/barge-in/.test(lines), `${p.file}: ${p.why} -> ${/barge-in/.test(lines) ? "stopped" : got}`)
      continue
    }
    check(got === p.expect, `${p.file}: ${p.why} -> ${got}${h ? ` ("${h.text}")` : ""}`)
  }
  const inbox = logs.filter((l) => l.includes("inbox: e2e ping")).length
  check(inbox === NOTIFY.length, `inbox notifications added: ${inbox}/${NOTIFY.length}`)
  const heardTurns = turns.filter((t) => t.endToAudioMs !== undefined)
  console.log("\n-- latency: end of Shawn's speech -> Vera's first audio --")
  for (const t of turns) {
    console.log(`turn ${t.id} [${t.via}] "${t.text}": end->audio ${t.endToAudioMs ?? "-"} ms, brain first speak ${t.firstSpeakMs ?? "-"} ms; said: ${JSON.stringify(t.spoken)}`)
  }
  if (heardTurns.length) {
    const v = heardTurns.map((t) => t.endToAudioMs).sort((a, b) => a - b)
    console.log(`median ${v[Math.floor(v.length / 2)]} ms, range ${v[0]}-${v.at(-1)} ms (includes Ears' 700 ms end-of-speech pause)`)
  }
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
}
