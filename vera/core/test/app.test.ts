import { test } from "node:test"
import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import { AppLink, AppMouth, playDeadlineMs, type CoreCommand } from "../src/app.ts"
import { heardPrefix } from "../src/vera.ts"

function setup() {
  const input = new PassThrough()
  const output = new PassThrough()
  const link = new AppLink(input, output)
  const sent: CoreCommand[] = []
  link.on("sent", (c: CoreCommand) => sent.push(c))
  const mouth = new AppMouth(link, () => {}, { graceMs: 0, startTimeoutMs: 200 })
  const events: string[] = []
  mouth.on("start", () => events.push("start"))
  mouth.on("end", () => events.push("end"))
  return { input, output, link, sent, mouth, events }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))

test("AppLink parses event lines, buffers early ones, and skips junk", async () => {
  const input = new PassThrough()
  const link = new AppLink(input, new PassThrough())
  input.write('{"type":"ready","mic":"m"}\nnot json\n{"type":"nope"}\n{"type":"speech_start","t":1}\n')
  await tick()
  const got: string[] = []
  link.on("event", (e) => got.push(e.type))
  await tick()
  assert.deepEqual(got, ["ready", "speech_start"])
  let closed = false
  link.on("close", () => (closed = true))
  input.end()
  await tick()
  assert.ok(closed)
})

test("AppMouth sends one speak at a time and frames a speaking stretch", async () => {
  const { sent, mouth, events } = setup()
  const a = mouth.say("One.")
  const b = mouth.say("Two.")
  assert.deepEqual(sent, [{ cmd: "speak", speak_id: a.id, text: "One." }])
  assert.equal(mouth.pendingStart, true)
  mouth.onPlayback(a.id, "started")
  assert.equal(mouth.speaking, true)
  mouth.onPlayback(a.id, "finished")
  assert.equal(sent.length, 2)
  assert.equal((sent[1] as any).speak_id, b.id)
  mouth.onPlayback(b.id, "started")
  mouth.onPlayback(b.id, "finished")
  await tick()
  assert.deepEqual(events, ["start", "end"])
  assert.equal((await a.done).state, "done")
  assert.equal((await b.done).state, "done")
})

test("an interruption Core didn't ask for drops the queue without sending more", async () => {
  const { sent, mouth } = setup()
  const a = mouth.say("One.")
  const b = mouth.say("Two.")
  mouth.onPlayback(a.id, "started")
  mouth.onPlayback(a.id, "interrupted")
  assert.equal(sent.filter((c) => c.cmd === "speak").length, 1)
  assert.equal(sent.filter((c) => c.cmd === "stop_speaking").length, 0, "the App already stopped")
  assert.equal(a.state, "cut")
  assert.equal(b.state, "dropped")
  assert.equal(mouth.speaking, false)
})

test("stop() sends stop_speaking once and ignores the App's late interrupted", async () => {
  const { sent, mouth, events } = setup()
  const a = mouth.say("One.")
  mouth.onPlayback(a.id, "started")
  mouth.stop()
  mouth.onPlayback(a.id, "interrupted")
  assert.deepEqual(
    sent.map((c) => c.cmd),
    ["speak", "stop_speaking"],
  )
  assert.deepEqual(events, ["start", "end"])
})

test("playback failed ends that item (not an interruption) and sends the next", async () => {
  const { sent, mouth, events } = setup()
  const a = mouth.say("One.")
  const b = mouth.say("Two.")
  mouth.onPlayback(a.id, "failed")
  assert.equal(a.state, "failed")
  assert.deepEqual(
    sent.map((c) => c.cmd),
    ["speak", "speak"],
    "no stop_speaking, and the next item goes out",
  )
  assert.equal((sent[1] as any).speak_id, b.id)
  mouth.onPlayback(b.id, "started")
  mouth.onPlayback(b.id, "failed") // it can also fail part-way
  await tick()
  assert.equal(b.state, "failed")
  assert.deepEqual(events, ["start", "end"])
  assert.equal(mouth.speaking, false)
})

test("a speak the App never starts is stopped in the App and skipped after the timeout", async () => {
  const { sent, mouth } = setup()
  const a = mouth.say("One.")
  mouth.say("Two.")
  await tick(260)
  assert.equal(a.state, "failed")
  // Stopped first, so it can never play late over the next line.
  assert.deepEqual(
    sent.map((c) => c.cmd),
    ["speak", "stop_speaking", "speak"],
  )
  assert.equal((sent[2] as any).text, "Two.")
  // Its late events change nothing.
  mouth.onPlayback(a.id, "started")
  mouth.onPlayback(a.id, "interrupted")
  assert.equal(a.state, "failed")
  assert.equal(mouth.playing?.text, "Two.")
})

test("playDeadlineMs follows the text: short lines get seconds, long ones more", () => {
  assert.equal(playDeadlineMs("Yes."), 8_000 + 4 * 160)
  assert.ok(playDeadlineMs("x".repeat(200)) < 45_000)
  assert.equal(playDeadlineMs("x".repeat(5000)), 190_000)
})

test("dropStale cuts and drops every line from earlier turns, keeps the new turn's", async () => {
  const { sent, mouth } = setup()
  const old1 = mouth.say("Old reply one.", 1)
  const old2 = mouth.say("Old reply two.", 1)
  mouth.onPlayback(old1.id, "started")
  const dropped = mouth.dropStale(2)
  assert.deepEqual(dropped.map((i) => i.id), [old1.id, old2.id])
  assert.equal(old1.state, "cut")
  assert.equal(old2.state, "dropped")
  assert.equal(sent.at(-1)?.cmd, "stop_speaking")
  const fresh = mouth.say("New reply.", 2)
  assert.equal((sent.at(-1) as any).speak_id, fresh.id)
  assert.deepEqual(mouth.dropStale(2), [], "the new turn's own line stays")
  assert.equal(mouth.playing?.id, fresh.id)
})

test("heardPrefix estimates where speech was cut", () => {
  assert.match(heardPrefix("Bread goes back at least fourteen thousand years.", 1000), /^after "Bread goes back…"/)
  assert.match(heardPrefix("Short.", 5000), /^at the end of/)
  assert.match(heardPrefix("Something long enough here.", 100), /^right at the start/)
})
