// Real playback on this machine's speakers. Run: pnpm --filter @vera/mouth test:playback
// Needs the Kokoro model (pnpm --filter @vera/mouth setup) and ffplay.

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createMouth, type VeraMouth } from "../src/mouth.ts"
import { livePids } from "../src/player.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function waitDead(pids: number[], ms: number): Promise<number[]> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const left = pids.filter(alive)
    if (!left.length) return []
    await sleep(50)
  }
  return pids.filter(alive)
}

let mouth: VeraMouth

test("load", async () => {
  mouth = await createMouth({ log: () => {} })
  await sleep(1500) // let the warm players finish starting
})

test("short sentence: start latency, accurate speaking and events", async () => {
  const lat: number[] = []
  for (let i = 0; i < 4; i++) {
    const events: string[] = []
    const offS = mouth.on("start", () => events.push(`start:${mouth.speaking}`))
    const offE = mouth.on("end", () => events.push(`end:${mouth.speaking}`))
    assert.equal(mouth.speaking, false)
    const t0 = performance.now()
    let startAt = -1
    const offT = mouth.on("start", () => (startAt = performance.now() - t0))
    const done = mouth.speak(i % 2 ? "Okay, done." : "On it.")
    await done
    const total = performance.now() - t0
    offS(); offE(); offT()
    assert.deepEqual(events, ["start:true", "end:false"])
    assert.equal(mouth.speaking, false)
    assert.ok(startAt > 0 && startAt < total)
    lat.push(startAt)
    await sleep(700) // let the pool refill
  }
  const sorted = [...lat].sort((a, b) => a - b)
  console.log(`# start latency ms: ${lat.map((l) => l.toFixed(0)).join(", ")} (median ${sorted[sorted.length >> 1].toFixed(0)}), timing ${JSON.stringify(mouth.lastTiming)}`)
  assert.ok(sorted[sorted.length >> 1] < 400, "median start latency under 400 ms")
})

test("stop mid-sentence is immediate and leaves no player behind", async () => {
  let ends = 0
  const off = mouth.on("end", () => ends++)
  const p = mouth.speak("Here is a deliberately long answer. It has several sentences so that stopping it halfway is easy to hear. This third sentence should never be heard at all. Nor should this one.")
  while (!mouth.speaking) await sleep(10)
  await sleep(1200)
  const playing = livePids()
  const t0 = performance.now()
  mouth.stop()
  assert.equal(mouth.speaking, false, "speaking clears synchronously")
  await p
  const resolveMs = performance.now() - t0
  off()
  assert.equal(ends, 1)
  assert.ok(resolveMs < 300, `speak resolved ${resolveMs.toFixed(0)} ms after stop`)
  assert.ok(mouth.lastTiming?.stopped)
  // The killed player is gone; only warm (parked) players remain.
  await sleep(300)
  const stillThere = playing.filter((pid) => alive(pid) && !livePids().includes(pid))
  assert.deepEqual(stillThere, [])
  console.log(`# stop -> speak() resolved in ${resolveMs.toFixed(0)} ms`)
})

test("queued speech plays back to back as one speaking stretch; stop drops the queue", async () => {
  const events: string[] = []
  const offS = mouth.on("start", () => events.push("start"))
  const offE = mouth.on("end", () => events.push("end"))
  await Promise.all([mouth.speak("First."), mouth.speak("Second.")])
  assert.deepEqual(events, ["start", "end"])
  events.length = 0
  const a = mouth.speak("One more long sentence that is going to be interrupted before it finishes.")
  const b = mouth.speak("This queued sentence is dropped.")
  while (!mouth.speaking) await sleep(10)
  mouth.stop()
  await Promise.all([a, b])
  offS(); offE()
  assert.deepEqual(events, ["start", "end"])
})

test("chimes play and resolve", async () => {
  for (const k of ["notify", "listening", "done", "error"] as const) {
    const t0 = performance.now()
    await mouth.chime(k)
    console.log(`# chime ${k}: ${(performance.now() - t0).toFixed(0)} ms`)
    await sleep(250)
  }
  assert.equal(mouth.speaking, false)
})

test("close kills every player", async () => {
  const pids = livePids()
  assert.ok(pids.length > 0, "warm players exist before close")
  await mouth.close()
  assert.deepEqual(await waitDead(pids, 2000), [])
  await assert.rejects(mouth.speak("nope"), /closed/)
})

test("players die when the parent process is killed hard", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/child-speaker.ts", import.meta.url))], {
    stdio: ["ignore", "pipe", "inherit"],
  })
  const pids = await new Promise<number[]>((resolve, reject) => {
    let buf = ""
    child.stdout.on("data", (d) => {
      buf += d
      const line = buf.split("\n").find((l) => l.startsWith("{"))
      if (line) resolve(JSON.parse(line).pids)
    })
    child.on("exit", () => reject(new Error("child exited early")))
    setTimeout(() => reject(new Error("child never started speaking")), 30000)
  })
  assert.ok(pids.length >= 1)
  child.kill("SIGKILL")
  // Parked players exit at once on EOF; the playing one finishes what it had buffered.
  const left = await waitDead(pids, 15000)
  assert.deepEqual(left, [], "no orphaned ffplay")
})
