#!/usr/bin/env node
// Assistant's end-to-end soak test (docs/assistant-soak.md): the real assistant.exe, the
// real Core, the real voice service, and real speech to text, with a
// simulated microphone and speakers (ASSISTANT_AUDIO_SIM), a scripted brain, and
// faults injected mid-conversation. It reads the app's trace (ASSISTANT_TRACE)
// and fails on any turn that doesn't play in time, any stale reply, a HUD
// that doesn't go back to hidden, a wedged turn, or a failure that isn't
// heard and seen.
//
//   node scripts/assistant-soak/soak.mjs [--exe target/release/assistant.exe] [--runs 3] [--keep]
//
// It runs in a throwaway ASSISTANT_HOME (its own config, logs, single instance,
// and voice service port), never touches ~/.assistant or the Run key, and plays
// nothing through the speakers. The HUD and a second tray icon do show
// while it runs.

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, readSync, closeSync, copyFileSync } from "node:fs"
import net from "node:net"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "..", "..")
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const EXE = resolve(opt("exe", join(REPO, "target", "release", "assistant.exe")))
const RUNS = Number(opt("runs", "1"))
const KEEP = argv.includes("--keep")
/** Only the steps whose label contains one of these (comma separated); the warm-up turn always runs. */
const ONLY = (opt("only", "") || "").split(",").map((x) => x.trim()).filter(Boolean)
/** A dip in Vera's level deeper than this, with no barge-in right after it, is a false dip. */
const FALSE_DIP_DB = 3
const VOICE_PORT = Number(opt("voice-port", "7315"))
const CONTROL_PORT = Number(opt("control-port", "47551"))
const FIXTURES = resolve(opt("fixtures", join(tmpdir(), "assistant-soak", "utterances")))
/** Bound from the end of what "Shawn" said to Vera's first audio. */
const REPLY_BOUND_MS = Number(opt("reply-bound", "6000"))
/** Shawn's real data folder (before the rename it was ~/.vera): the voice's venv and models come from it. */
const REAL_HOME = [join(homedir(), ".assistant"), join(homedir(), ".vera")].find((dir) => existsSync(join(dir, "voice", "venv"))) ?? join(homedir(), ".assistant")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()

// ---- what "Shawn" says, and what the scripted brain answers -------------------

const U = {
  there: "Hey Vera, are you there?",
  time: "Hey Vera, what time is it?",
  bare: "Hey Vera.",
  paris: "What's the weather in Paris?",
  rome: "And in Rome?",
  oslo: "How about Oslo?",
  pasta: "I think the pasta needs more salt.",
  alps: "Hey Vera, tell me about the Alps.",
  andes: "Hey Vera, actually, tell me about the Andes.",
  fact: "Hey Vera, tell me a fun fact.",
  joke: "Hey Vera, tell me a joke.",
  story: "Hey Vera, tell me a long story.",
  two: "Actually, what's two plus two?",
  news: "Hey Vera, read me the news.",
  stop: "Stop.",
  kitchen: "Hey Vera, describe the kitchen.",
  garden: "Hey Vera, and the garden?",
  room: "Hey Vera, describe the living room.",
  another: "Hey Vera, tell me another long story.",
  hear: "Hey Vera, can you hear me?",
  back: "Hey Vera, are you back?",
  slow: "Hey Vera, think about this slowly.",
  again: "Hey Vera, are you still there?",
  break: "Hey Vera, break something.",
  thanks: "Hey Vera, thanks.",
  ponder: "Hey Vera, ponder the universe.",
  france: "Hey Vera, what's the capital of France?",
  eggs: "Hey Vera, how long do eggs boil?",
  cool: "Cool.",
  last: "Hey Vera, what's the time now?",
  pasta2: "Hey Vera, how long should pasta cook?",
  water: "Hey Vera, how much salt goes in the water?",
  night: "Hey Vera, good night.",
  rename: "Hey Vera, call yourself Nova.",
  oldname: "Hey Vera, what's the time now?",
  nova: "Hey Nova, what's the capital of Spain?",
  renameBack: "Hey Nova, call yourself Vera again.",
  alfred: "Hey Alfred, what's the capital of Italy?",
  jarvis: "Hey Jarvis, what's the capital of Japan?",
  followup: "And what about Germany?",
  veraAgain: "Hey Vera, what's the capital of Peru?",
  ocean: "Hey Vera, tell me about the ocean.",
  beach: "Hey Vera, describe the beach.",
  count: "Hey Vera, count to ten.",
  forest: "Hey Vera, tell me about the forest.",
  chile: "Wait, what's the capital of Chile?",
  // Said in two parts with a 3 s pause between: one turn each.
  umA: "Hey Vera, what's the capital of, um",
  umB: "Norway?",
  andA: "Hey Vera, what's the weather in Lisbon and",
  andB: "in Madrid?",
  flaky: "Hey Vera, look into the flaky build.",
  flakyMore: "And the tests too.",
  // Said 1 s after she has started thinking about the first part.
  deploy: "Hey Vera, check on the deploy.",
  deployMore: "And roll back the staging server if it failed.",
  // A turn she answers with nothing (a tool, no words), then he goes on
  // 3 s later with no wake word (Shawn's log, 2026-11-26 15:34:55).
  lights: "Hey Vera, turn off the living room lights.",
  lightsMore: "And dim the kitchen ones too.",
  // He has the floor (2026-11-26 14:04:58): she must start nothing while he talks.
  harbor: "Hey Vera, tell me about the harbor.",
  mountains: "Wait, wait, I'd rather hear about the mountains instead, the tall ones up north that keep their snow all year round.",
  pantry: "Hey Vera, check the pantry.",
  pantryMore: "Hey Vera, while you're at it, look at the fridge, the freezer, and the shelves by the back door too.",
  // Listening off by voice.
  sleepNow: "Hey Vera, stop listening for a while.",
  awake: "Hey Vera, are you listening again?",
}

const LONG = {
  harbor:
    "The harbor is busy at dawn, with fishing boats coming in low in the water, nets piled on the quay, and gulls circling over the market stalls.",
  story:
    "Once there was a lighthouse keeper who counted the ships that passed each night, and she wrote every name in a blue notebook by the window.",
  news: "Here is the news. The city opened a new park by the river this morning, and the weather stays mild through the weekend with light wind.",
  kitchen: "The kitchen is bright and warm, with a long wooden counter, a big window over the sink, and copper pans hanging by the stove.",
  room: "The living room has a deep green sofa, a low table covered in books, and a lamp in the corner that throws a soft yellow light.",
  ocean:
    "The ocean covers most of the planet, and it is deepest in the far west of the Pacific, where the water goes down for almost eleven kilometres. The light never reaches the bottom, the water there is close to freezing, and still there are fish and shrimp and strange pale creatures living in the dark, slowly, for a very long time.",
  forest: "The forest is old and quiet, with tall pines that close over the path, moss on every stone, and a cold stream that runs under a fallen tree.",
  beach: "The beach is wide and pale, with soft dunes behind it, a line of old wooden posts running into the sea, and gulls standing in the shallow water.",
  another:
    "Long ago a baker in a small village made one loaf of bread every morning for each family, and nobody ever went hungry there.",
}

const speak = (text) => ({ tool: "speak", args: { text } })
const rule = (key, steps) => ({ match: `\\] Shawn: .*${key}`, steps })
const SCRIPT = [
  rule("fridge", [speak("The fridge and the shelves are full too.")]),
  rule("check the pantry", [speak("On it."), { sleep: 1500 }, speak("The pantry is stocked.")]),
  rule("mountains", [speak("The northern peaks keep their snow all year.")]),
  rule("harbor", [speak(LONG.harbor), speak("The tide turns at noon.")]),
  rule("dim the kitchen", [speak("Kitchen dimmed.")]),
  rule("living room lights", [{ sleep: 300 }]),
  rule("listening again", [speak("Yes, I'm listening.")]),
  rule("stop listening", [speak("Okay, I'll stop listening."), { tool: "stop_listening", args: {} }]),
  rule("norway", [speak("Oslo.")]),
  rule("lisbon.*madrid", [speak("Both are sunny.")]),
  rule("flaky build.*tests", [speak("The build and the tests.")]),
  rule("flaky build", [{ sleep: 4000 }, speak("Looking at the build.")]),
  rule("deploy.*staging", [speak("Checking the deploy and the staging server.")]),
  rule("on the deploy", [{ sleep: 4000 }, speak("Checking the deploy.")]),
  rule("still there", [speak("Still here.")]),
  rule("are you there", [speak("I'm here.")]),
  rule("time now", [speak("It's half past twelve.")]),
  rule("what time", [speak("It's noon.")]),
  rule("paris", [speak("Paris is mild today.")]),
  rule("rome", [speak("Rome is warm and sunny.")]),
  rule("oslo", [speak("Oslo is cold.")]),
  rule("alps", [{ sleep: 4500 }, speak("The Alps are in Europe.")]),
  rule("andes", [speak("The Andes run down South America.")]),
  rule("fun fact", [speak("Octopuses have three hearts, and blue blood, and they can taste with their arms.")]),
  rule("joke", [speak("I would tell a joke, but it is too cheesy.")]),
  rule("another long story", [speak(LONG.another), speak("And that is the end of it.")]),
  rule("long story", [speak(LONG.story), speak("And that is where the story ends.")]),
  rule("(two|2) plus (two|2)", [speak("Four.")]),
  rule("news", [speak(LONG.news), speak("That is all for now.")]),
  rule("kitchen", [speak(LONG.kitchen), speak("The kettle is on the stove.")]),
  rule("garden", [speak("The garden is green and quiet.")]),
  rule("living room", [speak(LONG.room)]),
  rule("hear me", [speak("Yes, I hear you.")]),
  rule("are you back", [speak("I'm back.")]),
  rule("slowly", [{ sleep: 4500 }, speak("Done thinking.")]),
  rule("break", [{ fail: "the model is overloaded" }]),
  rule("thank", [speak("You're welcome.")]),
  rule("ponder", [{ hang: true }]),
  rule("france", [speak("Paris.")]),
  rule("eggs", [speak("About ten minutes.")]),
  rule("cool", [speak("Yep.")]),
  rule("pasta cook", [speak("About nine minutes.")]),
  rule("in the water", [speak("A big pinch.")]),
  rule("good night", [speak("Good night.")]),
  rule("spain", [speak("Madrid.")]),
  rule("italy", [speak("Rome.")]),
  rule("japan", [speak("Tokyo.")]),
  rule("germany", [speak("Berlin.")]),
  rule("peru", [speak("Lima.")]),
  rule("ocean", [speak(LONG.ocean), speak("That is the ocean.")]),
  rule("count to ten", [speak("One, two, three, four, five, six, seven, eight, nine, ten.")]),
  rule("forest", [speak(LONG.forest), speak("Mind the roots.")]),
  rule("chile", [speak("Santiago.")]),
  rule("beach", [speak(LONG.beach), speak("The tide is coming in.")]),
  rule("call yourself vera", [{ tool: "set_name", args: { name: "Vera" } }, speak("Vera again.")]),
  rule("call yourself nova", [{ tool: "set_name", args: { name: "Nova" } }, speak("Okay, I'm Nova.")]),
]

// ---- the app's trace -------------------------------------------------------------

class Trace {
  constructor(path) {
    this.path = path
    this.events = []
    this.offset = 0
    this.carry = ""
  }
  poll() {
    if (!existsSync(this.path)) return
    const fd = openSync(this.path, "r")
    try {
      const buf = Buffer.alloc(1 << 16)
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, this.offset)
        if (n <= 0) break
        this.offset += n
        this.carry += buf.subarray(0, n).toString("utf8")
      }
    } finally {
      closeSync(fd)
    }
    const lines = this.carry.split("\n")
    this.carry = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      if (ev.kind === "to_core" || ev.kind === "from_core") {
        try {
          ev.msg = JSON.parse(ev.line)
        } catch {
          ev.msg = {}
        }
      }
      this.events.push(ev)
    }
  }
  /** Events after `t` (ms) matching `pred`. */
  find(pred, after = 0) {
    this.poll()
    return this.events.filter((e) => e.t >= after && pred(e))
  }
  async waitFor(pred, { after = 0, within = 10_000, what = "an event" } = {}) {
    const deadline = now() + within
    for (;;) {
      const hit = this.find(pred, after)[0]
      if (hit) return hit
      if (now() > deadline) throw new Failure(`timed out after ${within} ms waiting for ${what}`)
      await sleep(40)
    }
  }
  lastHud() {
    this.poll()
    const huds = this.events.filter((e) => e.kind === "hud")
    return huds.length ? huds[huds.length - 1] : null
  }
}

class Failure extends Error {}

const isTo = (type, extra = () => true) => (e) => e.kind === "to_core" && e.msg?.type === type && extra(e.msg)
const isFrom = (cmd, extra = () => true) => (e) => e.kind === "from_core" && e.msg?.cmd === cmd && extra(e.msg)

// ---- one run -------------------------------------------------------------------------

class Run {
  constructor(index) {
    this.index = index
    this.home = join(tmpdir(), "assistant-soak", `run-${Date.now()}-${index}`)
    this.trace = new Trace(join(this.home, "trace.ndjson"))
    this.steps = []
    this.failures = []
    this.checks = 0
    this.addressed = 0
    this.latencies = []
  }

  setup() {
    mkdirSync(join(this.home, "brain"), { recursive: true })
    mkdirSync(join(this.home, "voice"), { recursive: true })
    const config = {
      // Deliberately no app.startAtLogin: a build under target\ then never
      // touches the Run key.
      app: {
        volume: 0.7,
        repo: REPO,
        // The real venv and repo code; only the port (and ASSISTANT_HOME) differ.
        voiceService: {
          port: VOICE_PORT,
          command: [join(REAL_HOME, "voice", "venv", "Scripts", "pythonw.exe"), "-m", "assistant_voice", "serve", "--port", String(VOICE_PORT)],
          cwd: join(REPO, "assistant", "voice"),
        },
      },
      port: 0,
      brain: { harness: "script", firstSpeakTimeoutSeconds: 8, turnTimeoutSeconds: 60 },
      wake: { followUpSeconds: 8 },
      t3: { pollSeconds: 3600 },
      jobs: { defaultCwd: REPO },
    }
    writeFileSync(join(this.home, "config.json"), JSON.stringify(config, null, 2))
    writeFileSync(join(this.home, "brain", "script-brain.json"), JSON.stringify(SCRIPT, null, 2))
    const calibration = join(REAL_HOME, "voice", "calibration.json")
    if (existsSync(calibration)) copyFileSync(calibration, join(this.home, "voice", "calibration.json"))
  }

  env() {
    return {
      ...process.env,
      ASSISTANT_HOME: this.home,
      ASSISTANT_AUDIO_SIM: opt("sim", "echo_db=-30,delay_ms=60,noise_db=-75"),
      ASSISTANT_SIM_CONTROL: `127.0.0.1:${CONTROL_PORT}`,
      ASSISTANT_TRACE: join(this.home, "trace.ndjson"),
      ASSISTANT_VOICE_MODELS: join(REAL_HOME, "models"),
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
    }
  }

  async start() {
    this.setup()
    this.app = spawn(EXE, ["--hidden"], { env: this.env(), stdio: "ignore", windowsHide: true })
    this.app.on("exit", (code) => (this.exited = code))
    const t0 = now()
    await this.trace.waitFor(isTo("ready"), { within: 60_000, what: "the app's ready" })
    await this.trace.waitFor((e) => e.kind === "voice" && e.ready, { within: 120_000, what: "the voice service" })
    this.log(`up in ${now() - t0} ms`)
    await this.connect()
    const voices = await fetch(`http://127.0.0.1:${VOICE_PORT}/v1/voices`).then((r) => r.json())
    this.voices = (voices.voices ?? []).filter((v) => v.available !== false).map((v) => v.id)
    // Warm the echo canceller: barge-in waits for a second of converged audio.
    await this.turn("there", "I'm here.")
    await this.hidden()
  }

  async connect() {
    for (let i = 0; i < 50; i++) {
      try {
        this.socket = await new Promise((ok, fail) => {
          const s = net.connect(CONTROL_PORT, "127.0.0.1", () => ok(s))
          s.once("error", fail)
        })
        break
      } catch {
        await sleep(200)
      }
    }
    if (!this.socket) throw new Failure("the test control port never opened")
    this.answers = []
    let carry = ""
    this.socket.on("data", (d) => {
      carry += d.toString()
      const lines = carry.split("\n")
      carry = lines.pop()
      for (const l of lines) this.answers.shift()?.(l)
    })
  }

  control(line) {
    return new Promise((ok, fail) => {
      this.answers.push((answer) => (answer.startsWith("ok") ? ok(answer.slice(3)) : fail(new Failure(`${line}: ${answer}`))))
      this.socket.write(line + "\n")
    })
  }

  log(line) {
    console.log(`  [run ${this.index}] ${line}`)
  }

  check(ok, what) {
    this.checks++
    if (!ok) {
      this.failures.push(what)
      this.log(`FAIL ${what}`)
    }
    return ok
  }

  /** "Shawn" says `name` into the microphone; resolves when he's done talking. */
  async say(name, gainDb = -6) {
    const at = now()
    const ms = Number(await this.control(`mic ${gainDb} ${join(FIXTURES, `${name}.wav`)}`))
    await sleep(ms)
    return { name, at, end: at + ms }
  }

  /** The `final` for what was said (Ears waits 0.7 s after a question, 1.2 s after a statement). */
  async heard(said, within = 8000) {
    const final = await this.trace.waitFor(isTo("final"), { after: said.at, within, what: `the final for "${U[said.name]}"` })
    said.finalAt = final.t
    said.text = final.msg.text
    return final
  }

  /** Waits for Core to send `text`, and for it to play audibly to its end. */
  async reply(said, text, { bound = REPLY_BOUND_MS, until = "finished" } = {}) {
    const speakCmd = await this.trace.waitFor(isFrom("speak", (m) => m.text === text), {
      after: said.at,
      within: bound + 4000,
      what: `Core to say "${text}" (heard "${said.text ?? "?"}")`,
    })
    const id = speakCmd.msg.speak_id
    const started = await this.trace.waitFor(isTo("playback", (m) => m.speak_id === id && m.state !== "finished"), {
      after: speakCmd.t,
      within: bound + 4000,
      what: `"${text}" to start playing`,
    })
    const latency = started.t - said.end
    if (started.msg.state === "started") this.latencies.push(latency)
    this.check(started.msg.state === "started", `"${text}" started (got ${started.msg.state})`)
    this.check(latency <= bound, `"${text}" started ${latency} ms after Shawn stopped (bound ${bound} ms)`)
    if (until === "started") return { id, started, speakCmd }
    const ended = await this.trace.waitFor(
      isTo("playback", (m) => m.speak_id === id && ["finished", "interrupted", "failed"].includes(m.state)),
      { after: started.t, within: 60_000, what: `"${text}" to end` },
    )
    this.check(ended.msg.state === until, `"${text}" ended ${ended.msg.state} (expected ${until})`)
    await sleep(400)
    const audible = this.trace.find((e) => e.kind === "out" && e.end > started.t && e.start < ended.t + 300 && e.rms_db > -65)
    this.check(audible.length > 0, `"${text}" was audible`)
    return { id, started, ended, speakCmd }
  }

  /** A whole addressed turn: say it, it's heard, the reply plays. */
  async turn(name, text, opts = {}) {
    const said = await this.say(name, opts.gain)
    await this.heard(said)
    this.addressed++
    this.steps.push({ said, replies: [text, ...(opts.more ?? [])] })
    const played = await this.reply(said, text, opts)
    for (const more of opts.more ?? []) await this.reply({ ...said, at: played.ended.t, end: played.ended.t }, more, { bound: 2500 })
    return { said, played }
  }

  /** The HUD goes back to hidden (and stays there a moment). */
  async hidden(within = 15_000) {
    const deadline = now() + within
    for (;;) {
      const last = this.trace.lastHud()
      if (!last || last.look === "hidden") {
        await sleep(500)
        const again = this.trace.lastHud()
        if (!again || again.look === "hidden") return this.check(true, "HUD hidden")
        continue
      }
      if (now() > deadline) return this.check(false, `the HUD went back to hidden within ${within} ms (stuck on ${last.look})`)
      await sleep(100)
    }
  }

  /** A failure was heard and seen: the error chime, the HUD's error look, a red status. */
  async surfaced(after, what) {
    try {
      await this.trace.waitFor((e) => e.kind === "alert", { after, within: 4000, what: `an alert for ${what}` })
      this.check(true, "alert")
    } catch (err) {
      this.check(false, `${what}: ${err.message}`)
    }
    // An error chime within the alert's spacing of this one counts: a burst is one sound.
    const error = this.trace.find((e) => e.kind === "chime" && e.sound === "error", after - 4500)
    this.check(error.length > 0, `${what}: the error chime played`)
    const look = this.trace.find((e) => e.kind === "hud" && e.look === "error", after - 4500)
    this.check(look.length > 0, `${what}: the HUD showed the error look`)
    const status = this.trace.find((e) => e.kind === "status" && e.tone === "problem", after)
    this.check(status.length > 0, `${what}: Settings' status turned red`)
    const tray = this.trace.find((e) => e.kind === "tray" && e.problem, after)
    this.check(tray.length > 0, `${what}: the tray showed the problem`)
  }

  /** The audio engine's last duck and barge-in counters (its 2 s duplex log line). */
  duplexCounters() {
    const path = join(this.home, "logs", "assistant-app.log")
    const text = existsSync(path) ? readFileSync(path, "utf8") : ""
    const lines = text.split("\n").filter((l) => l.includes("assistant audio: duplex"))
    const last = lines[lines.length - 1] ?? ""
    const field = (name) => Number(last.match(new RegExp(` ${name}=(\\d+)`))?.[1] ?? 0)
    return { ducks: field("ducks"), restores: field("restores"), suspicions: field("suspicions"), dismissed: field("dismissed"), bargeIns: field("barge_ins") }
  }

  /** The messages the scripted brain was given after `after` (its own log). */
  brainMessages(after = 0) {
    const path = join(this.home, "brain", "script-brain.log.jsonl")
    const text = existsSync(path) ? readFileSync(path, "utf8") : ""
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .filter((m) => m.at >= after)
  }

  /** Words of `name`'s line missing from `text` (case and punctuation ignored). */
  missingWords(name, text) {
    const digits = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
    const words = (s) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9' ]+/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => digits[Number(w)] ?? w)
    const have = new Set(words(text))
    // The wake phrase ("hey Vera") is stripped before the brain sees the words.
    return words(U[name]).filter((w) => w !== "vera" && w !== "hey" && !have.has(w))
  }

  /** Every word he said in `name` reached the brain, in one message after `after`. */
  checkReachedBrain(name, after, what) {
    const messages = this.brainMessages(after)
    const whole = messages.filter((m) => this.missingWords(name, m.text).length === 0)
    const last = messages[messages.length - 1]?.text ?? "(none)"
    this.check(whole.length >= 1, `${what}: every word of "${U[name]}" reached the brain (last message: ${JSON.stringify(last.slice(-200))}, missing ${this.missingWords(name, last).join(" ") || "-"})`)
    return { messages, whole }
  }

  /** Dips in Vera's level (the simulated speakers' `dip` events) with no barge-in right after. */
  falseDips(after = 0, before = Infinity) {
    const barges = this.trace.find(isTo("barge_in"))
    return this.trace
      .find((e) => e.kind === "dip" && e.start >= after && e.start <= before)
      .filter((d) => d.depth_db > FALSE_DIP_DB && !barges.some((b) => b.t >= d.start - 100 && b.t <= d.end + 1000))
  }

  childPid(name) {
    const started = this.trace.find((e) => e.kind === "child" && e.name === name && e.event === "started")
    return started.length ? started[started.length - 1].pid : null
  }

  // ---- the script ----------------------------------------------------------------

  async script() {
    const step = async (label, fn) => {
      if (ONLY.length && !ONLY.some((part) => label.includes(part))) return
      const t0 = now()
      try {
        await fn()
        this.log(`ok   ${label} (${((now() - t0) / 1000).toFixed(1)} s)`)
      } catch (err) {
        this.failures.push(`${label}: ${err.message}`)
        this.log(`FAIL ${label}: ${err.message}`)
        // Settle before the next step, so one failure doesn't cascade.
        await this.control("stop").catch(() => {})
        await sleep(2000)
        await this.hidden(20_000)
      }
    }

    await step("wake word, then the request", async () => {
      await this.turn("time", "It's noon.")
      await this.hidden()
    })

    await step("a bare 'Hey Vera', then the request", async () => {
      const said = await this.say("bare")
      await this.heard(said)
      await this.trace.waitFor((e) => e.kind === "chime" && e.sound === "listening", {
        after: said.at,
        within: 3000,
        what: "the listening chime",
      })
      await this.trace.waitFor((e) => e.kind === "hud" && e.look === "listening", { after: said.at, within: 3000, what: "the HUD listening" })
      await sleep(600)
      await this.turn("paris", "Paris is mild today.")
    })

    await step("follow-ups without the wake word", async () => {
      await sleep(500)
      await this.turn("rome", "Rome is warm and sunny.")
      await sleep(500)
      await this.turn("oslo", "Oslo is cold.")
      await this.hidden()
    })

    await step("speech not addressed to Vera is ignored", async () => {
      await sleep(1500) // the follow-up window has closed
      const said = await this.say("pasta")
      await this.heard(said)
      await sleep(5000)
      this.check(this.trace.find(isFrom("speak"), said.at).length === 0, "nothing was said back")
      this.check(this.trace.find((e) => e.kind === "hud" && e.look !== "hidden", said.at).length === 0, "the HUD stayed hidden")
    })

    await step("rapid back-to-back turns: the first answer never plays", async () => {
      const alps = await this.say("alps")
      await this.heard(alps)
      this.addressed++
      await sleep(300)
      const andes = await this.turn("andes", "The Andes run down South America.")
      void andes
      await sleep(4000) // past when the Alps answer would have come
      this.check(this.trace.find(isFrom("speak", (m) => m.text === "The Alps are in Europe."), alps.at).length === 0, "the stale Alps answer was never sent")
      await this.hidden()
      // While the answer plays, a new request cuts it.
      const fact = await this.say("fact")
      await this.heard(fact)
      this.addressed++
      const playing = await this.reply(fact, "Octopuses have three hearts, and blue blood, and they can taste with their arms.", { until: "started" })
      await sleep(800)
      const joke = await this.turn("joke", "I would tell a joke, but it is too cheesy.", { gain: -3 })
      const factEnd = this.trace.find(isTo("playback", (m) => m.speak_id === playing.id && m.state !== "started"), playing.started.t)[0]
      this.check(!!factEnd && factEnd.t <= joke.said.finalAt + 2000, "the fact was cut once the joke was asked")
      await this.hidden()
    })

    await step("barge-in mid-reply", async () => {
      const story = await this.say("story")
      await this.heard(story)
      this.addressed++
      const playing = await this.reply(story, LONG.story, { until: "started" })
      await sleep(2500)
      const two = await this.say("two", -3)
      const barge = await this.trace.waitFor(isTo("barge_in"), { after: two.at, within: 3000, what: "a barge-in" })
      this.check(barge.t - two.at < 1500, `barged in ${barge.t - two.at} ms after he started talking`)
      const cut = await this.trace.waitFor(isTo("playback", (m) => m.speak_id === playing.id && m.state !== "started"), {
        after: playing.started.t,
        within: 3000,
        what: "the story to stop",
      })
      this.check(cut.msg.state === "interrupted", `the story was interrupted (${cut.msg.state})`)
      await this.heard(two)
      this.addressed++
      await this.reply(two, "Four.")
      this.checkReachedBrain("two", two.at, "after the barge-in")
      this.check(this.trace.find(isFrom("speak", (m) => m.text === "And that is where the story ends."), story.at).length === 0, "the rest of the story was dropped")
      await this.hidden()
      // "Stop." over a reply: she stops and says nothing.
      const news = await this.say("news")
      await this.heard(news)
      this.addressed++
      const reading = await this.reply(news, LONG.news, { until: "started" })
      await sleep(2000)
      const stop = await this.say("stop", -3)
      await this.trace.waitFor(isTo("playback", (m) => m.speak_id === reading.id && m.state === "interrupted"), {
        after: stop.at,
        within: 3000,
        what: "the news to stop",
      })
      await sleep(3000)
      this.check(this.trace.find(isFrom("speak"), stop.at).length === 0, "nothing more was said after 'Stop.'")
      await this.hidden()
    })

    await step("switching the voice mid-reply, twice", async () => {
      const [a, b] = [this.voices.find((v) => v !== this.voices[0]) ?? this.voices[0], this.voices[0]]
      const kitchen = await this.say("kitchen")
      await this.heard(kitchen)
      this.addressed++
      const playing = await this.reply(kitchen, LONG.kitchen, { until: "started" })
      const before = this.trace.find((e) => e.kind === "engine").length
      await sleep(1200)
      await this.control(`voice ${a}`)
      await sleep(1200)
      await this.control(`voice ${b}`)
      const ended = await this.trace.waitFor(isTo("playback", (m) => m.speak_id === playing.id && m.state !== "started"), {
        after: playing.started.t,
        within: 30_000,
        what: "the kitchen line to end",
      })
      this.check(ended.msg.state === "finished", `the line kept playing through both voice changes (${ended.msg.state})`)
      this.check(this.trace.find((e) => e.kind === "engine").length === before, "the audio engine never restarted")
      this.check(this.trace.find(isTo("ready"), playing.started.t).length === 0, "speech to text never reloaded")
      const next = await this.reply({ at: ended.t, end: ended.t }, "The kettle is on the stove.", { bound: 2500 })
      const sent = this.trace.find((e) => e.kind === "speak", next.speakCmd.t - 5)[0]
      this.check(sent?.voice === b, `the next line used the new voice (${sent?.voice} vs ${b})`)
      await this.turn("garden", "The garden is green and quiet.")
      await this.hidden()
      // Back to each name's own voice (no override) for what follows.
      await this.control("voice default")
    })

    await step("changing the volume mid-reply", async () => {
      const room = await this.say("room")
      await this.heard(room)
      this.addressed++
      const playing = await this.reply(room, LONG.room, { until: "started" })
      await sleep(1500)
      await this.control("volume 0.45")
      const changed = await this.trace.waitFor(isTo("ui", (m) => m.action === "settings_changed" && m.volume === 0.45), {
        after: playing.started.t,
        within: 3000,
        what: "Core to hear the new volume",
      })
      void changed
      const ended = await this.trace.waitFor(isTo("playback", (m) => m.speak_id === playing.id && m.state !== "started"), {
        after: playing.started.t,
        within: 30_000,
        what: "the living room line to end",
      })
      this.check(ended.msg.state === "finished", `the line kept playing through the volume change (${ended.msg.state})`)
      await this.control("volume 0.7")
      await this.hidden()
    })

    await step("killing the voice service mid-reply", async () => {
      const another = await this.say("another")
      await this.heard(another)
      this.addressed++
      const playing = await this.reply(another, LONG.another, { until: "started" })
      await sleep(1500)
      const pid = this.childPid("voice-service")
      if (!pid) throw new Failure("no voice service pid in the trace")
      const killedAt = now()
      process.kill(pid)
      const ended = await this.trace.waitFor(isTo("playback", (m) => m.speak_id === playing.id && m.state !== "started"), {
        after: playing.started.t,
        within: 15_000,
        what: "the line to end once the voice died",
      })
      this.check(["failed", "interrupted", "finished"].includes(ended.msg.state), `the line ended (${ended.msg.state})`)
      await this.surfaced(killedAt, "the voice service dying")
      // While it's down (it's back in about 13 s): a turn ends at once with
      // the error chime, never a silent wait.
      const hear = await this.say("hear")
      await this.heard(hear)
      this.addressed++
      const speakCmd = await this.trace.waitFor(isFrom("speak", (m) => m.text === "Yes, I hear you."), { after: hear.at, within: 6000, what: "Core to answer" })
      const failed = await this.trace.waitFor(isTo("playback", (m) => m.speak_id === speakCmd.msg.speak_id && m.state !== "started"), {
        after: speakCmd.t,
        within: 15_000,
        what: "the answer to fail while the voice is down",
      })
      this.check(failed.msg.state === "failed" && failed.t - speakCmd.t < 3000, `the answer failed quickly (${failed.msg.state} after ${failed.t - speakCmd.t} ms)`)
      await this.surfaced(hear.at, "speaking while the voice is down")
      await this.hidden(20_000)
      // It comes back by itself.
      await this.trace.waitFor((e) => e.kind === "voice" && e.ready, { after: killedAt + 1000, within: 120_000, what: "the voice service to come back" })
      this.log(`voice back ${((now() - killedAt) / 1000).toFixed(1)} s after the kill`)
      await this.turn("back", "I'm back.")
      await this.hidden()
    })

    await step("killing Core mid-turn", async () => {
      const slow = await this.say("slow")
      await this.heard(slow)
      this.addressed++
      await this.trace.waitFor((e) => e.kind === "hud" && e.look === "thinking", { after: slow.at, within: 3000, what: "the HUD thinking" })
      await sleep(1500)
      const pid = this.childPid("core")
      if (!pid) throw new Failure("no Core pid in the trace")
      const killedAt = now()
      process.kill(pid)
      await this.surfaced(killedAt, "Core dying")
      await this.hidden(10_000)
      await this.trace.waitFor((e) => e.kind === "child" && e.name === "core" && e.event === "started", { after: killedAt, within: 15_000, what: "Core to restart" })
      await this.trace.waitFor(isTo("ready"), { after: killedAt, within: 15_000, what: "the new Core to be greeted" })
      await sleep(1500)
      this.check(this.trace.find(isFrom("speak", (m) => m.text === "Done thinking."), slow.at).length === 0, "the dead Core's turn never spoke")
      await this.turn("again", "Still here.")
      await this.hidden()
    })

    await step("a brain error", async () => {
      const brk = await this.say("break")
      await this.heard(brk)
      this.addressed++
      const err = await this.trace.waitFor(isFrom("error"), { after: brk.at, within: 5000, what: "Core's error" })
      this.check(err.msg.what === "brain", `the error is the brain's (${err.msg.what})`)
      await this.surfaced(brk.at, "a brain error")
      await this.hidden()
      await sleep(4500)
      await this.turn("thanks", "You're welcome.")
      await this.hidden()
    })

    await step("a brain that never answers", async () => {
      const ponder = await this.say("ponder")
      await this.heard(ponder)
      this.addressed++
      const err = await this.trace.waitFor(isFrom("error"), { after: ponder.at, within: 14_000, what: "Core's timeout" })
      this.check(err.msg.what === "brain_timeout", `a timeout (${err.msg.what})`)
      this.check(err.t - ponder.finalAt < 11_000, `reported ${err.t - ponder.finalAt} ms after the request`)
      await this.surfaced(ponder.at, "a brain timeout")
      await this.hidden()
      await sleep(4500)
      await this.turn("france", "Paris.")
      await this.turn("cool", "Yep.")
      await this.hidden()
    })

    await step("renaming her by voice, live", async () => {
      const engines = this.trace.find((e) => e.kind === "engine").length
      await this.turn("rename", "Okay, I'm Nova.")
      const named = this.trace.find(isFrom("name", (m) => m.name === "Nova"))
      this.check(named.length === 1, "Core told the App her new name")
      this.check(this.trace.find((e) => e.kind === "name" && e.name === "Nova").length === 1, "the App applied it")
      this.check(this.trace.find((e) => e.kind === "tray" && /^Nova\b/.test(e.tooltip)).length > 0, "the tray says Nova")
      this.check(this.trace.find((e) => e.kind === "engine").length === engines, "nothing restarted")
      await this.hidden()
      // The old name no longer wakes her.
      const old = await this.say("oldname")
      await this.heard(old)
      await sleep(4000)
      this.check(this.trace.find(isFrom("speak"), old.at).length === 0, "\"Hey Vera, ...\" was ignored")
      // The new one does, with speech to text leaning toward it.
      await this.turn("nova", "Madrid.")
      await this.hidden()
      await this.turn("renameBack", "Vera again.")
      await this.hidden()
    })

    await step("switching personas by name", async () => {
      // Each name answers in its own voice; a follow-up without a name stays
      // with the last one; one conversation underneath.
      const voiceOf = async (said, text) => {
        const cmd = await this.trace.waitFor(isFrom("speak", (m) => m.text === text), { after: said.at, within: 15_000, what: `"${text}"` })
        const sent = await this.trace.waitFor((e) => e.kind === "speak" && e.t >= cmd.t, { after: cmd.t - 1, within: 5_000, what: "the App's speak" })
        return { core: cmd.msg.voice, app: sent.voice }
      }
      const alfred = await this.turn("alfred", "Rome.")
      let v = await voiceOf(alfred.said, "Rome.")
      this.check(v.core === "alfred" && v.app === "alfred", `"Hey Alfred" answers in alfred's voice (core ${v.core}, app ${v.app})`)
      const jarvis = await this.turn("jarvis", "Tokyo.")
      v = await voiceOf(jarvis.said, "Tokyo.")
      this.check(v.core === "jarvis" && v.app === "jarvis", `"Hey Jarvis" answers in jarvis's voice (core ${v.core}, app ${v.app})`)
      const follow = await this.turn("followup", "Berlin.")
      v = await voiceOf(follow.said, "Berlin.")
      this.check(v.app === "jarvis", `a follow-up without a name stays with Jarvis (${v.app})`)
      await this.hidden()
      const vera = await this.turn("veraAgain", "Lima.")
      v = await voiceOf(vera.said, "Lima.")
      this.check(v.app === "isla", `"Vera" answers in isla's voice (${v.app})`)
      await this.hidden()
    })

    await step("more ordinary turns", async () => {
      await this.turn("eggs", "About ten minutes.")
      await this.hidden()
      await this.turn("last", "It's half past twelve.")
      await this.hidden()
      await this.turn("pasta2", "About nine minutes.")
      await sleep(500)
      await this.turn("water", "A big pinch.")
      await this.hidden()
      await this.turn("night", "Good night.")
      await this.hidden()
    })

    // "Shawn" stops for 3 s mid-sentence: she waits, and answers the whole thing.
    const twoParts = async (a, b, reply) => {
      const first = await this.say(a)
      await sleep(3000)
      const rest = await this.say(b)
      const said = { name: b, at: first.at, end: rest.end }
      await this.heard(said, 16_000)
      this.addressed++
      this.steps.push({ said, replies: [reply] })
      this.check(said.finalAt >= rest.at, `no final before he went on (heard "${said.text}")`)
      this.check(this.trace.find(isFrom("speak"), first.at).every((e) => e.t >= rest.at), "she said nothing during the pause")
      await this.reply({ ...said, at: rest.at }, reply)
      const finals = this.trace.find(isTo("final"), first.at).filter((e) => e.t <= said.finalAt + 1000)
      this.check(finals.length === 1, `one final for both parts (${finals.map((e) => `"${e.msg.text}"`).join(", ")})`)
      await this.hidden()
    }

    await step("a 3 s pause on an um mid-sentence stays one turn", async () => {
      await twoParts("umA", "umB", "Oslo.")
    })

    await step("a 3 s pause after a trailing 'and' stays one turn", async () => {
      await twoParts("andA", "andB", "Both are sunny.")
    })

    await step("he goes on after a turn she answered with nothing: still listening, no wake word needed", async () => {
      const first = await this.say("lights")
      await this.heard(first)
      this.addressed++
      // Her silent turn ends; he carries on, as Shawn did.
      await sleep(2500)
      const rest = await this.say("lightsMore")
      await this.heard(rest)
      this.steps.push({ said: rest, replies: ["Kitchen dimmed."] })
      await this.reply(rest, "Kitchen dimmed.")
      this.checkReachedBrain("lightsMore", rest.at, "what he said after her silent turn")
      await this.hidden()
    })

    await step("Listening off from the tray: nothing wakes her, a reply stops; on again: she answers", async () => {
      const said = await this.say("story")
      await this.heard(said)
      await this.trace.waitFor(isTo("playback", (m) => m.state === "started"), { after: said.at, within: 15_000, what: "the story to start" })
      const off = now()
      await this.control("listen off")
      const cut = await this.trace.waitFor(isTo("playback", (m) => m.state !== "started"), { after: off, within: 3000, what: "the story to stop" })
      this.check(cut.msg.state === "interrupted", `the reply stopped (${cut.msg.state})`)
      await this.trace.waitFor((e) => e.kind === "tray" && e.muted, { after: off, within: 3000, what: "the tray to show Listening off" })
      await this.hidden(5000)
      const ignored = await this.say("there")
      await sleep(4000)
      this.check(this.trace.find(isTo("speech_start"), ignored.at).length === 0, "her name woke nothing while off")
      this.check(this.trace.find(isFrom("speak"), ignored.at).length === 0, "she said nothing while off")
      this.check(this.trace.find((e) => e.kind === "chime", ignored.at).length === 0, "no chime while off")
      const cfg = JSON.parse(readFileSync(join(this.home, "config.json"), "utf8"))
      this.check(cfg.app?.listening === false, `Listening off is saved (app.listening = ${cfg.app?.listening})`)
      // Off closes the microphone; the simulated one keeps what was said
      // into it meanwhile (a real one doesn't), so it's dropped here.
      await this.control("mic-clear")
      await this.control("listen on")
      await sleep(500)
      await this.turn("awake", "Yes, I'm listening.")
      await this.hidden()
    })

    await step("'stop listening' by voice: she says so, then turns herself off", async () => {
      const said = await this.say("sleepNow")
      await this.heard(said)
      this.addressed++
      this.steps.push({ said, replies: ["Okay, I'll stop listening."] })
      const played = await this.reply(said, "Okay, I'll stop listening.")
      const off = await this.trace.waitFor(isFrom("listening", (m) => m.on === false), { after: said.at, within: 5000, what: "Core turning Listening off" })
      this.check(off.t >= played.ended.t - 50, "she finished her line before turning off")
      await this.trace.waitFor((e) => e.kind === "tray" && e.muted, { after: off.t, within: 3000, what: "the tray to show Listening off" })
      await this.control("listen on")
      await sleep(500)
      await this.hidden()
    })

    await step("he goes on while she's still thinking: one turn, no answer to half of it", async () => {
      const first = await this.say("flaky")
      await this.heard(first)
      this.addressed++
      await sleep(1500)
      const rest = await this.say("flakyMore")
      await this.heard(rest)
      this.steps.push({ said: rest, replies: ["The build and the tests."] })
      await this.reply(rest, "The build and the tests.")
      this.check(this.trace.find(isFrom("speak", (m) => m.text === "Looking at the build."), first.at).length === 0, "the answer to the first half was never sent")
      await this.hidden()
    })

    await step("he goes on 1 s after she starts thinking: every word reaches the brain in one turn, one answer", async () => {
      const first = await this.say("deploy")
      await this.heard(first)
      this.addressed++
      const thinking = await this.trace.waitFor((e) => e.kind === "hud" && e.look === "thinking", {
        after: first.finalAt,
        within: 3000,
        what: "her thinking about the first part",
      })
      await sleep(Math.max(0, thinking.t + 1000 - now()))
      const rest = await this.say("deployMore")
      await this.heard(rest)
      this.steps.push({ said: rest, replies: ["Checking the deploy and the staging server."] })
      await this.reply(rest, "Checking the deploy and the staging server.")
      await sleep(4500) // past when the first part's answer would have come
      const { messages, whole } = this.checkReachedBrain("deployMore", first.at, "the second part")
      this.check(
        whole.some((m) => this.missingWords("deploy", m.text).length === 0),
        `both parts in one brain message (${messages.map((m) => JSON.stringify(m.text.slice(-120))).join(" | ")})`,
      )
      this.check(messages.filter((m) => /staging/i.test(m.text)).length === 1, `the second part went to the brain once (${messages.length} messages)`)
      const answers = this.trace.find(isFrom("speak"), first.at)
      this.check(answers.length === 1, `she answered once (${answers.map((e) => `"${e.msg.text}"`).join(", ")})`)
      await this.hidden()
    })

    // Nothing of hers (a line, the next line, a chime) starts between `from` and `to`.
    const nothingStarted = (from, to, what) => {
      const starts = this.trace.find(isTo("playback", (m) => m.state === "started"), from).filter((e) => e.t <= to)
      const chimes = this.trace.find((e) => e.kind === "chime", from).filter((e) => e.t <= to)
      this.check(starts.length === 0, `${what}: no line started while he talked (${starts.map((e) => e.msg.speak_id).join(", ") || "none"})`)
      this.check(chimes.length === 0, `${what}: no chime while he talked (${chimes.length})`)
    }

    await step("he barges in and keeps talking for 4 s: nothing she says starts until he's done", async () => {
      const harbor = await this.say("harbor")
      await this.heard(harbor)
      this.addressed++
      const playing = await this.reply(harbor, LONG.harbor, { until: "started" })
      await sleep(2500)
      const mountains = await this.say("mountains", -3)
      const barge = this.trace.find(isTo("barge_in"), mountains.at)[0]
      this.check(!!barge, "his long interruption barged in")
      this.check(mountains.end - mountains.at >= 4000, `he talked for ${mountains.end - mountains.at} ms`)
      const cut = this.trace.find(isTo("playback", (m) => m.speak_id === playing.id && m.state === "interrupted"), playing.started.t)
      this.check(cut.length === 1, "the harbor line was interrupted")
      nothingStarted((barge?.t ?? mountains.at) + 50, mountains.end, "barge-in, then 4 s more")
      await this.heard(mountains)
      this.addressed++
      this.steps.push({ said: mountains, replies: ["The northern peaks keep their snow all year."] })
      await this.reply(mountains, "The northern peaks keep their snow all year.")
      this.check(this.trace.find(isFrom("speak", (m) => m.text === "The tide turns at noon."), harbor.at).length === 0, "the rest of the harbor was dropped")
      await this.hidden()
    })

    await step("a reply comes due while he's still talking: it waits, and his new turn drops it", async () => {
      const pantry = await this.say("pantry")
      await this.heard(pantry)
      this.addressed++
      this.steps.push({ said: pantry, replies: ["On it.", "The pantry is stocked."] })
      const ack = await this.reply(pantry, "On it.")
      // He goes on 0.4 s after "On it.", for ~5 s; her next line comes due ~1 s in.
      await sleep(Math.max(0, ack.ended.t + 400 - now()))
      const more = await this.say("pantryMore")
      this.check(more.end - more.at >= 4000, `he talked for ${more.end - more.at} ms`)
      nothingStarted(more.at + 300, more.end, "a reply due mid-sentence")
      await this.heard(more)
      this.addressed++
      this.steps.push({ said: more, replies: ["The fridge and the shelves are full too."] })
      await this.reply(more, "The fridge and the shelves are full too.")
      const staleStarted = this.trace
        .find(isFrom("speak", (m) => m.text === "The pantry is stocked."), pantry.at)
        .flatMap((s) => this.trace.find(isTo("playback", (m) => m.speak_id === s.msg.speak_id && m.state === "started"), s.t))
      this.check(staleStarted.length === 0, "the reply that came due while he talked never played (his words made a new turn)")
      await this.hidden()
    })

    await step("in a headset: room noise, breathing and clicks over a reply: no dips", async () => {
      // Shawn's headset: none of Vera reaches the microphone, which sends
      // near digital silence between sounds. A warm-up line first, so the
      // canceller has settled on the new device.
      await this.control("sim echo_db=-100,delay_ms=20,noise_db=-100").catch((err) => this.log(`(no live sim change: ${err.message})`))
      await this.turn("count", "One, two, three, four, five, six, seven, eight, nine, ten.")
      await this.hidden()
      const ocean = await this.say("ocean")
      await this.heard(ocean)
      this.addressed++
      const playing = await this.reply(ocean, LONG.ocean, { until: "started" })
      const before = this.duplexCounters()
      await sleep(2500)
      const from = now()
      for (const name of ["noise-breath", "noise-typing", "noise-knock", "noise-breath-loud", "noise-mouse", "noise-rustle", "noise-fan"]) {
        await this.say(name, 0)
        await sleep(200)
      }
      const until = now()
      const ended = await this.trace.waitFor(isTo("playback", (m) => m.speak_id === playing.id && m.state !== "started"), {
        after: playing.started.t,
        within: 40_000,
        what: "the ocean line to end",
      })
      this.check(ended.msg.state === "finished", `the line played to its end through the noise (${ended.msg.state})`)
      this.check(ended.t > until, "the noise all fell inside her line")
      this.check(this.trace.find(isTo("barge_in"), from).filter((e) => e.t <= ended.t).length === 0, "the noise never barged in")
      this.check(this.trace.find(isTo("final"), from).filter((e) => e.t <= ended.t + 1000).length === 0, "the noise was never heard as speech")
      await this.reply({ at: ended.t, end: ended.t }, "That is the ocean.", { bound: 2500 })
      await sleep(2500)
      const after = this.duplexCounters()
      const dips = this.trace.find((e) => e.kind === "dip" && e.start >= from - 200 && e.start <= until + 500)
      const deepest = Math.max(0, ...dips.map((d) => d.depth_db))
      this.noise = {
        ducks: after.ducks - before.ducks,
        restores: after.restores - before.restores,
        silentSuspicions: after.suspicions - before.suspicions,
        dips: dips.length,
        deepestDb: deepest,
      }
      this.log(`noise: ${this.noise.ducks} ducks, ${this.noise.silentSuspicions} silent suspicions, ${dips.length} dips, deepest ${deepest} dB`)
      this.check(this.noise.ducks === 0, `the noise never ducked her (${this.noise.ducks} ducks)`)
      this.check(deepest <= FALSE_DIP_DB, `no dip deeper than ${FALSE_DIP_DB} dB (deepest ${deepest} dB over ${dips.length} dips)`)
      await this.hidden()
    })

    await step("in a headset: a breath, then 'Stop.' over a reply", async () => {
      const beach = await this.say("beach")
      await this.heard(beach)
      this.addressed++
      const reading = await this.reply(beach, LONG.beach, { until: "started" })
      await sleep(1800)
      const breathAt = now()
      const breathMs = Number(await this.control(`mic 0 ${join(FIXTURES, "noise-breath.wav")}`))
      const stop = await this.say("stop", -3)
      const wordAt = breathAt + breathMs
      const cut = await this.trace.waitFor(isTo("playback", (m) => m.speak_id === reading.id && m.state === "interrupted"), {
        after: breathAt,
        within: breathMs + 3000,
        what: "the beach line to stop",
      })
      this.check(cut.t >= wordAt - 100, `she stopped on the word, not the breath (${cut.t - wordAt} ms after "Stop." began)`)
      this.check(cut.t - wordAt < 1500, `stopped ${cut.t - wordAt} ms after "Stop." began`)
      await sleep(3000)
      this.check(this.trace.find(isFrom("speak"), stop.at).length === 0, "nothing more was said after the breath and 'Stop.'")
      await this.hidden()
    })

    await step("in a headset: talking over a reply", async () => {
      const forest = await this.say("forest")
      await this.heard(forest)
      this.addressed++
      const playing = await this.reply(forest, LONG.forest, { until: "started" })
      await sleep(2500)
      const chile = await this.say("chile", -3)
      const barge = await this.trace.waitFor(isTo("barge_in"), { after: chile.at, within: 3000, what: "a barge-in" })
      this.check(barge.t - chile.at < 1500, `barged in ${barge.t - chile.at} ms after he started talking`)
      const cut = await this.trace.waitFor(isTo("playback", (m) => m.speak_id === playing.id && m.state !== "started"), {
        after: playing.started.t,
        within: 3000,
        what: "the forest line to stop",
      })
      this.check(cut.msg.state === "interrupted", `the forest line was interrupted (${cut.msg.state})`)
      await this.heard(chile)
      this.addressed++
      await this.reply(chile, "Santiago.")
      this.checkReachedBrain("chile", chile.at, "after the barge-in")
      this.check(this.trace.find(isFrom("speak", (m) => m.text === "Mind the roots."), forest.at).length === 0, "the rest of the forest was dropped")
      await this.hidden()
    })
  }

  /** Across the whole run: nothing stale played, every speak ended once, the HUD is hidden. */
  invariants() {
    this.trace.poll()
    const speaks = this.trace.events.filter(isFrom("speak"))
    const plays = this.trace.events.filter(isTo("playback"))
    // Ends per Core id since its speak (ids restart with a new Core).
    let unended = 0
    let doubled = 0
    for (const s of speaks) {
      const nextSame = speaks.find((o) => o.t > s.t && o.msg.speak_id === s.msg.speak_id)
      const ends = plays.filter(
        (p) => p.msg.speak_id === s.msg.speak_id && p.t >= s.t && (!nextSame || p.t < nextSame.t) && p.msg.state !== "started",
      )
      const coreDied = this.trace.events.some((e) => e.kind === "child" && e.name === "core" && e.event === "exited" && e.t > s.t && (!ends[0] || e.t < ends[0].t))
      if (ends.length === 0 && !coreDied) unended++
      if (ends.length > 1) doubled++
    }
    this.check(unended === 0, `every speak got its end (${unended} never did)`)
    this.check(doubled === 0, `no speak ended twice (${doubled} did)`)
    // Stale: a reply that started after a later request was heard.
    const finals = this.trace.events.filter(isTo("final"))
    let stale = 0
    for (const p of plays.filter((x) => x.msg.state === "started")) {
      const s = [...speaks].reverse().find((o) => o.t <= p.t && o.msg.speak_id === p.msg.speak_id)
      if (!s) continue
      const step = this.steps.findIndex((st) => st.replies.includes(s.msg.text))
      if (step < 0) continue
      const later = this.steps.slice(step + 1).find((st) => st.said.finalAt && st.said.finalAt < p.t)
      if (later) {
        stale++
        this.log(`stale: "${s.msg.text}" started after "${later.said.text}" was heard`)
      }
    }
    void finals
    this.check(stale === 0, `nothing stale ever played (${stale} did)`)
    const dips = this.trace.events.filter((e) => e.kind === "dip")
    const falseDips = this.falseDips()
    this.dipSummary = { dips: dips.length, falseDips: falseDips.length, deepestFalseDb: Math.max(0, ...falseDips.map((d) => d.depth_db)) }
    for (const d of falseDips) this.log(`false dip: ${d.depth_db} dB for ${d.end - d.start} ms`)
    this.check(falseDips.length === 0, `no false dips over ${FALSE_DIP_DB} dB across the run (${falseDips.length})`)
    const last = this.trace.lastHud()
    this.check(!last || last.look === "hidden", "the HUD ends hidden")
    this.check(this.exited === undefined, "assistant.exe never crashed")
  }

  async stop() {
    try {
      this.socket?.end()
    } catch {}
    spawnSync(EXE, ["quit"], { env: this.env(), windowsHide: true, timeout: 15_000 })
    for (let i = 0; i < 100 && this.exited === undefined; i++) await sleep(100)
    if (this.exited === undefined) this.app.kill()
  }
}


// ---- room sounds that aren't speech ------------------------------------------------
// Breaths, typing, mouse clicks, a knock on the desk, clothes rustling, a fan,
// synthesized (deterministically) at a headset microphone's levels: Shawn's
// own live log shows these at -57 to -75 dBFS (4 ms peaks) against his speech
// at -22 to -36; these are louder, -35 to -48, to be safe.

const SR = 16_000
function xorshift(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return (s / 4294967296) * 2 - 1
  }
}
/** RBJ biquad, applied in place. */
function biquad(x, kind, f, q) {
  const w = (2 * Math.PI * f) / SR
  const a = Math.sin(w) / (2 * q)
  const c = Math.cos(w)
  let b0, b1, b2
  if (kind === "band") [b0, b1, b2] = [a, 0, -a]
  else if (kind === "low") [b0, b1, b2] = [(1 - c) / 2, 1 - c, (1 - c) / 2]
  else [b0, b1, b2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2]
  const [a0, a1, a2] = [1 + a, -2 * c, 1 - a]
  let [x1, x2, y1, y2] = [0, 0, 0, 0]
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0
    ;[x2, x1, y2, y1] = [x1, x[i], y1, y]
    x[i] = y
  }
  return x
}
const noiseOf = (n, rand) => Float64Array.from({ length: n }, rand)
/** Scales `x` so its loudest 4 ms reach `peakDb` dBFS (RMS). */
function level(x, peakDb) {
  let peak = 0
  for (let i = 0; i + 64 <= x.length; i += 64) {
    let e = 0
    for (let j = i; j < i + 64; j++) e += x[j] * x[j]
    peak = Math.max(peak, e / 64)
  }
  const gain = 10 ** (peakDb / 20) / Math.sqrt(peak || 1e-20)
  return x.map((v) => v * gain)
}
const silence = (s) => new Float64Array(Math.round(s * SR))
const concat = (...parts) => {
  const out = new Float64Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) out.set(p, (at += p.length) - p.length)
  return out
}
function breath(rand, inhale, exhale) {
  const one = (seconds, center, puff) => {
    const n = Math.round(seconds * SR)
    const x = biquad(biquad(noiseOf(n, rand), "band", center, 0.8), "high", 250, 0.7)
    const low = biquad(noiseOf(n, rand), "low", 180, 0.7)
    return x.map((v, i) => {
      const env = Math.sin((Math.PI * i) / n) ** 2 * (0.85 + 0.15 * Math.sin(i / 300))
      return (v + puff * low[i]) * env
    })
  }
  return concat(one(inhale, 1400, 0), silence(0.25), one(exhale, 900, 0.6))
}
function click(rand, freq, tau) {
  const n = Math.round(0.04 * SR)
  return Float64Array.from({ length: n }, (_, i) => {
    const t = i / SR
    return (rand() * Math.exp(-t / 0.0015) + 0.6 * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / tau))
  })
}
function clicks(rand, times, freq, release) {
  const out = new Float64Array(Math.round((times[times.length - 1] + 0.2) * SR))
  for (const at of times) {
    for (const [offset, gain] of [[0, 1], [release, 0.45]]) {
      const c = click(rand, freq * (0.9 + 0.2 * Math.abs(rand())), 0.006)
      const start = Math.round((at + offset) * SR)
      for (let i = 0; i < c.length && start + i < out.length; i++) out[start + i] += gain * c[i]
    }
  }
  return out
}
function knock(rand) {
  const n = Math.round(0.35 * SR)
  return Float64Array.from({ length: n }, (_, i) => {
    const t = i / SR
    return Math.sin(2 * Math.PI * 95 * t) * Math.exp(-t / 0.06) + 0.4 * rand() * Math.exp(-t / 0.004)
  })
}
function rustle(rand) {
  const n = Math.round(0.7 * SR)
  const x = biquad(noiseOf(n, rand), "band", 3000, 0.6)
  let crackle = 0
  return x.map((v, i) => {
    if (i % 160 === 0) crackle = Math.abs(rand()) ** 3
    return v * crackle * Math.sin((Math.PI * i) / n)
  })
}
function fan(rand, seconds) {
  const n = Math.round(seconds * SR)
  const x = biquad(noiseOf(n, rand), "low", 1200, 0.5)
  const ramp = 0.3 * SR
  return x.map((v, i) => v * Math.min(1, i / ramp, (n - i) / ramp))
}
function writeWav(path, x) {
  const data = Buffer.alloc(x.length * 2)
  x.forEach((v, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2))
  const h = Buffer.alloc(44)
  h.write("RIFF", 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write("WAVEfmt ", 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(SR, 24)
  h.writeUInt32LE(SR * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write("data", 36)
  h.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([h, data]))
}
/** name → [what it is, samples]. */
function roomSounds() {
  const r = xorshift(20261125)
  return {
    "noise-breath": ["two breaths", level(breath(r, 0.7, 0.9), -42)],
    "noise-breath-loud": ["a heavy breath out", level(breath(r, 0.5, 1.1), -36)],
    "noise-typing": ["typing", level(clicks(r, [0, 0.16, 0.29, 0.47, 0.6, 0.81, 0.95, 1.12], 2600, 0.07), -35)],
    "noise-mouse": ["mouse clicks", level(clicks(r, [0, 0.5, 0.62], 4200, 0.09), -38)],
    "noise-knock": ["a knock on the desk", level(knock(r), -36)],
    "noise-rustle": ["clothes rustling", level(rustle(r), -42)],
    "noise-fan": ["a fan running", level(fan(r, 2.5), -52)],
  }
}
function writeRoomSounds() {
  for (const [name, [, x]] of Object.entries(roomSounds())) writeWav(join(FIXTURES, `${name}.wav`), x)
}

// ---- main ---------------------------------------------------------------------------

function fixtures() {
  mkdirSync(FIXTURES, { recursive: true })
  const list = join(FIXTURES, "lines.json")
  writeFileSync(list, JSON.stringify(Object.entries(U).map(([name, text]) => ({ name, text }))))
  const made = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(HERE, "make-utterances.ps1"), "-List", list, "-Out", FIXTURES], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (made.status !== 0) throw new Error(`make-utterances failed: ${made.stderr}`)
  writeRoomSounds()
}

async function main() {
  if (!existsSync(EXE)) throw new Error(`no ${EXE}; build it first (scripts/assistant-build.sh)`)
  fixtures()
  let passedInARow = 0
  const summary = []
  for (let i = 1; i <= RUNS; i++) {
    const run = new Run(i)
    console.log(`run ${i}/${RUNS}: ${run.home}`)
    const t0 = now()
    try {
      await run.start()
      await run.script()
      run.invariants()
    } catch (err) {
      run.failures.push(`run aborted: ${err.message}`)
      console.log(`  [run ${i}] ABORT ${err.message}`)
    } finally {
      await run.stop()
    }
    const lat = run.latencies.sort((a, b) => a - b)
    const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))]
    const result = {
      run: i,
      ok: run.failures.length === 0,
      addressedTurns: run.addressed + 1,
      checks: run.checks,
      failures: run.failures,
      seconds: Math.round((now() - t0) / 1000),
      replyLatencyMs: lat.length ? { median: p(0.5), p90: p(0.9), max: lat[lat.length - 1] } : null,
      noise: run.noise ?? null,
      dips: run.dipSummary ?? null,
      duplex: run.duplexCounters(),
    }
    summary.push(result)
    console.log(
      `run ${i}: ${result.ok ? "PASS" : "FAIL"} · ${result.addressedTurns} addressed turns · ${result.checks} checks · ${result.seconds} s` +
        (result.replyLatencyMs ? ` · reply latency median ${result.replyLatencyMs.median} ms, p90 ${result.replyLatencyMs.p90}, max ${result.replyLatencyMs.max}` : "") +
        (result.noise ? ` · noise: ${result.noise.ducks} ducks, deepest dip ${result.noise.deepestDb} dB` : "") +
        (result.dips ? ` · dips ${result.dips.dips} (false ${result.dips.falseDips})` : "") +
        ` · ducks ${result.duplex.ducks}, barge-ins ${result.duplex.bargeIns}`,
    )
    passedInARow = result.ok ? passedInARow + 1 : 0
    if (result.ok && !KEEP) rmSync(run.home, { recursive: true, force: true })
    else console.log(`  kept ${run.home}`)
  }
  writeFileSync(join(tmpdir(), "assistant-soak", "last-summary.json"), JSON.stringify(summary, null, 2))
  console.log(`\n${summary.filter((r) => r.ok).length}/${RUNS} runs passed; ${passedInARow} in a row at the end`)
  process.exit(summary.every((r) => r.ok) ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
