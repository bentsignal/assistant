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
  there: "Vera, are you there?",
  time: "Hey Vera, what time is it?",
  bare: "Hey Vera.",
  paris: "What's the weather in Paris?",
  rome: "And in Rome?",
  oslo: "How about Oslo?",
  pasta: "I think the pasta needs more salt.",
  alps: "Vera, tell me about the Alps.",
  andes: "Vera, actually, tell me about the Andes.",
  fact: "Vera, tell me a fun fact.",
  joke: "Vera, tell me a joke.",
  story: "Vera, tell me a long story.",
  two: "Actually, what's two plus two?",
  news: "Vera, read me the news.",
  stop: "Stop.",
  kitchen: "Vera, describe the kitchen.",
  garden: "Vera, and the garden?",
  room: "Vera, describe the living room.",
  another: "Vera, tell me another long story.",
  hear: "Vera, can you hear me?",
  back: "Vera, are you back?",
  slow: "Vera, think about this slowly.",
  again: "Vera, are you still there?",
  break: "Vera, break something.",
  thanks: "Thanks, Vera.",
  ponder: "Vera, ponder the universe.",
  france: "What's the capital of France, Vera?",
  eggs: "Vera, how long do eggs boil?",
  cool: "Cool.",
  last: "Vera, what's the time now?",
  pasta2: "Vera, how long should pasta cook?",
  water: "Vera, how much salt goes in the water?",
  night: "Good night, Vera.",
  rename: "Vera, call yourself Nova.",
  oldname: "Vera, what's the time now?",
  nova: "Nova, what's the capital of Spain?",
  renameBack: "Nova, call yourself Vera again.",
  alfred: "Hey Alfred, what's the capital of Italy?",
  jarvis: "Jarvis, what's the capital of Japan?",
  followup: "And what about Germany?",
  veraAgain: "Vera, what's the capital of Peru?",
}

const LONG = {
  story:
    "Once there was a lighthouse keeper who counted the ships that passed each night, and she wrote every name in a blue notebook by the window.",
  news: "Here is the news. The city opened a new park by the river this morning, and the weather stays mild through the weekend with light wind.",
  kitchen: "The kitchen is bright and warm, with a long wooden counter, a big window over the sink, and copper pans hanging by the stove.",
  room: "The living room has a deep green sofa, a low table covered in books, and a lamp in the corner that throws a soft yellow light.",
  another:
    "Long ago a baker in a small village made one loaf of bread every morning for each family, and nobody ever went hungry there.",
}

const speak = (text) => ({ tool: "speak", args: { text } })
const rule = (key, steps) => ({ match: `\\] Shawn: .*${key}`, steps })
const SCRIPT = [
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
      ASSISTANT_AUDIO_SIM: "echo_db=-30,delay_ms=60,noise_db=-75",
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

  /** The `final` for what was said (Ears adds ~0.7 s of pause). */
  async heard(said) {
    const final = await this.trace.waitFor(isTo("final"), { after: said.at, within: 8000, what: `the final for "${U[said.name]}"` })
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

  childPid(name) {
    const started = this.trace.find((e) => e.kind === "child" && e.name === name && e.event === "started")
    return started.length ? started[started.length - 1].pid : null
  }

  // ---- the script ----------------------------------------------------------------

  async script() {
    const step = async (label, fn) => {
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
      this.check(this.trace.find(isFrom("speak"), old.at).length === 0, "\"Vera, ...\" was ignored")
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
      this.check(v.core === "jarvis" && v.app === "jarvis", `"Jarvis" answers in jarvis's voice (core ${v.core}, app ${v.app})`)
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
    }
    summary.push(result)
    console.log(
      `run ${i}: ${result.ok ? "PASS" : "FAIL"} · ${result.addressedTurns} addressed turns · ${result.checks} checks · ${result.seconds} s` +
        (result.replyLatencyMs ? ` · reply latency median ${result.replyLatencyMs.median} ms, p90 ${result.replyLatencyMs.p90}, max ${result.replyLatencyMs.max}` : ""),
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
