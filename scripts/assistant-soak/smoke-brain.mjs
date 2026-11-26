#!/usr/bin/env node
// A real-brain smoke check against the running assistant.exe: the soak test
// uses a scripted brain, so it can't catch a real brain that can't call its
// tools (the rename once shipped with every speak call denied). This posts a
// few utterances to Core's debug hook (POST /api/utterance) and asserts, in
// ~/.assistant/logs/core-*.log, that the brain called the expected tools and
// that a line then finished playing.
//
//   node scripts/assistant-soak/smoke-brain.mjs [--home ~/.assistant] [--timeout 60] [--skip-codex]
//
// --skip-codex leaves out the Codex steps on a machine where Codex isn't signed in.
// --skip-voice leaves out the voice steps where no voice service runs (a Core
// hosted by assistant/core/scripts/smoke-core.ts).
// --skip-t3 leaves out the T3 steps. Those launch a full-access scratch thread
// on Winserve (through Core's own T3 session), have her steer it and settle
// it by voice, and check both in T3. Then she starts a short thread on
// Winserve with t3_start_thread and this machine's environment id; the step
// waits for its watch to chime and land in the inbox, has her send to it
// once it's idle (that must start a turn), waits for that finish too, and
// settles it.
//
// The talk-over step (--skip-skills leaves it out) gives
// her a throwaway skill that naps 5 s through run_command, talks to her while
// it runs, and checks the command still finished and his words became the
// next message.
//
// The acknowledgement step asks something that needs a slow tool and checks
// that a line went to the App before the first tool other than speak (Core's
// own "One sec." or hers).
//
// The skill steps teach her a skill by voice (wrapping `hostname`), check she
// runs it on the next turn, then have her remove it.
//
// The MCP steps (--skip-mcp leaves them out) have her add a harmless local
// stdio MCP server by voice (assistant/core/scripts/smoke-mcp.mjs), use its
// tool on the next turn and say what it returned, then remove it.
//
// It talks out loud (it's the real app) and changes things it puts back:
// the voice (restored at the end), the brain (back to Claude), and the
// system prompt (an edit, then its revert). The persona steps ("Hey Alfred",
// "Jarvis") pass only when the line Core sends the App carries that
// persona's voice (`-> app {"cmd":"speak",…,"voice":"alfred"}`).

import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const HOME = opt("home", process.env.ASSISTANT_HOME || join(homedir(), ".assistant"))
const TIMEOUT_MS = Number(opt("timeout", "60")) * 1000

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""))
  } catch {
    return fallback
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const runtime = readJson(join(HOME, "core-runtime.json"), null)
const port = runtime?.port ?? 7313
const base = `http://127.0.0.1:${port}`
const config = readJson(join(HOME, "config.json"), {})
const NAME = config?.assistant?.name || "Vera"
const startVoice = config?.app?.voice ?? null
const startPrompt = existsSync(join(HOME, "system-prompt.md")) ? readFileSync(join(HOME, "system-prompt.md"), "utf8") : null

function newestLog() {
  const dir = join(HOME, "logs")
  const logs = readdirSync(dir)
    .filter((f) => /^core-.*\.log$/.test(f))
    .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  if (!logs.length) throw new Error(`no core-*.log in ${dir}`)
  return logs[0].f
}

/** A reader of the log from now on (it follows a day change to the newest file). */
function tail() {
  let file = newestLog()
  let offset = statSync(file).size
  let text = ""
  return () => {
    const now = newestLog()
    if (now !== file) {
      file = now
      offset = 0
    }
    const size = statSync(file).size
    if (size > offset) {
      const fd = openSync(file, "r")
      const buf = Buffer.alloc(size - offset)
      readSync(fd, buf, 0, buf.length, offset)
      closeSync(fd)
      offset = size
      text += buf.toString("utf8")
    }
    return text
  }
}

async function post(path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS + 30_000),
  })
  return res.json()
}

const FINISHED = /<- app \{"type":"playback".*"state":"finished"/

/**
 * Says `text` and waits until the log shows each tool, a speak, and a
 * finished line after it; with `voice`, the speak sent to the App must
 * carry that voice.
 */
async function step(label, text, tools, voice) {
  const read = tail()
  const started = Date.now()
  const turn = post("/api/utterance", { text, wait: true }).catch((err) => ({ error: err.message }))
  let missing = "the turn"
  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(300)
    const log = read()
    missing = ""
    // Each expected tool somewhere in the turn (the brain may speak first),
    // then a speak whose line finished playing.
    for (const tool of tools) {
      if (!new RegExp(`\\btool (?:${tool})\\b`).test(log)) {
        missing = `tool ${tool}`
        break
      }
    }
    if (!missing) {
      const speakAt = log.search(/\btool speak\b/)
      if (speakAt < 0) missing = "tool speak"
      else if (voice && !new RegExp(`-> app \\{"cmd":"speak"[^\\n]*"voice":"${voice}"`).test(log.slice(speakAt)))
        missing = `a speak in voice ${voice}`
      else if (!FINISHED.test(log.slice(speakAt))) missing = "playback finished"
    }
    if (!missing) {
      await turn // let the turn end before the next one
      console.log(`PASS ${label} (${((Date.now() - started) / 1000).toFixed(1)} s)`)
      return true
    }
  }
  const tools_ = [...read().matchAll(/\btool (\w+)/g)].map((m) => m[1])
  console.log(`FAIL ${label}: no ${missing} within ${TIMEOUT_MS / 1000} s (tools seen: ${tools_.join(", ") || "none"})`)
  await Promise.race([turn, sleep(5000)])
  return false
}

const results = []
try {
  const state = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json())
  console.log(`Core on ${base}, brain ${state?.brain ?? "?"}, name ${NAME}, voice ${startVoice ?? "(default)"}`)
} catch (err) {
  console.log(`FAIL Core isn't answering on ${base}: ${err.message}`)
  process.exit(1)
}

results.push(await step("say ready", `${NAME}, say ready.`, ["speak"]))
const skipVoice = argv.includes("--skip-voice")
if (!skipVoice) results.push(await step("switch to Eli", `${NAME}, switch to Eli.`, ["set_voice"]))
if (!skipVoice) results.push(await step("own voices again", `${NAME}, use each persona's own voice again.`, ["set_voice"]))
results.push(await step("Hey Alfred", "Hey Alfred, say hello.", [], "alfred"))
results.push(await step("Jarvis", "Jarvis, say hello.", [], "jarvis"))
// A mishearing of Vera's name still wakes her but keeps whoever answered last.
results.push(await step("Jarvis sticks", "Vara, say ready.", [], "jarvis"))
results.push(await step("asked for Alfred", "Let me talk to Alfred.", [], "alfred"))
if (!argv.includes("--skip-codex")) {
  results.push(await step("use codex", `${NAME}, use codex.`, ["set_brain"]))
  results.push(await step("codex answers", `${NAME}, say ready.`, ["speak"]))
  results.push(await step("use claude", `${NAME}, use claude.`, ["set_brain"]))
}
results.push(await step("prompt edit", `${NAME}, remember to keep answers under two sentences.`, ["edit_system_prompt"]))
results.push(await step("prompt revert", `${NAME}, undo that last change to your prompt.`, ["revert_system_prompt"]))

// Skills: learned by voice, used on the next turn, then forgotten.
{
  const host = hostname().toLowerCase()
  results.push(
    await step(
      "skill learned",
      `${NAME}, learn a new skill called machine-name: running the hostname command prints this computer's name. Save it so you remember it.`,
      ["skill_save"],
    ),
  )
  const read = tail()
  results.push(await step("skill used", `${NAME}, what's this computer called?`, ["run_command"]))
  const ran = new RegExp(`tool run_command -> Exit 0[^\n]*${host}`, "i").test(read())
  console.log(`${ran ? "PASS" : "FAIL"} skill ran hostname and got ${host}`)
  results.push(ran)
  results.push(await step("skill forgotten", `${NAME}, remove your machine-name skill now, no need to confirm.`, ["skill_remove"]))
}

// MCP servers as config: added by voice, used on the next turn, then removed.
if (!argv.includes("--skip-mcp")) {
  // No digits: she says numbers as words.
  const fruits = ["persimmon", "rambutan", "loquat", "kumquat", "tamarind", "quince", "mangosteen", "cherimoya"]
  const word = fruits[Math.floor(Math.random() * fruits.length)]
  const server = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "assistant", "core", "scripts", "smoke-mcp.mjs")
  results.push(
    await step(
      "mcp added",
      `${NAME}, add an MCP server called smoke-echo. It's a stdio server: the command is ${process.execPath} and its one argument is ${server} ${word}. That's two arguments: the script path, then the word ${word}. Test it, no need to confirm.`,
      ["mcp_add"],
    ),
  )
  const read = tail()
  results.push(await step("mcp used", `${NAME}, use your smoke-echo server to get the secret word, and tell me what it is.`, ["mcp__smoke-echo__secret_word"]))
  const said = new RegExp(`tool speak [^\\n]*${word}`, "i").test(read())
  console.log(`${said ? "PASS" : "FAIL"} she said the server's word (${word})`)
  results.push(said)
  results.push(await step("mcp removed", `${NAME}, remove your smoke-echo MCP server now, no need to confirm.`, ["mcp_remove"]))
  const left = readJson(join(HOME, "mcp.json"), {})?.mcpServers ?? {}
  const gone = !Object.keys(left).some((k) => k.toLowerCase() === "smoke-echo")
  console.log(`${gone ? "PASS" : "FAIL"} smoke-echo is out of mcp.json`)
  results.push(gone)
}

// His talking never breaks running work.
if (!argv.includes("--skip-skills")) results.push(...(await talkOverStep()))

/** Talks to her while a 5 s run_command runs: it must finish, and his words come next. */
async function talkOverStep() {
  const dir = join(HOME, "skills")
  mkdirSync(dir, { recursive: true })
  const nap = join(HOME, "smoke-nap.js")
  const skill = join(dir, "smoke-nap.md")
  writeFileSync(nap, "setTimeout(() => console.log('nap-done'), 5000)\n")
  writeFileSync(
    skill,
    `---\nname: smoke-nap\ndescription: A test skill: take a smoke nap.\ncommands: node, ${process.execPath}\n---\nWhen Shawn asks for a smoke nap, call run_command with argv ["${process.execPath.replace(/\\/g, "\\\\")}", "${nap.replace(/\\/g, "\\\\")}"] and wait for it; it prints nap-done after 5 s.\n`,
  )
  const out = []
  try {
    await sleep(1500) // the skill change restarts the brain before the next turn
    const read = tail()
    const first = post("/api/utterance", { text: `${NAME}, take a smoke nap.`, wait: true }).catch((err) => ({ error: err.message }))
    const running = await waitLog(read, /\btool run_command \{/, TIMEOUT_MS)
    if (!running) {
      console.log("FAIL she ran the nap command")
      return [false]
    }
    await sleep(1500)
    const second = post("/api/utterance", { text: `${NAME}, and after that say the word kiwi.`, wait: true }).catch((err) => ({ error: err.message }))
    const done = await waitLog(read, /tool run_command -> Exit 0 \(smoke-nap\)\. nap-done/, 20_000)
    console.log(`${done ? "PASS" : "FAIL"} the command finished although he talked over it`)
    out.push(!!done)
    const held = await waitLog(read, /turn \d+ -> [^\n]*run_command finished and returned[^\n]*kiwi|turn \d+ -> [^\n]*kiwi/, TIMEOUT_MS)
    console.log(`${held ? "PASS" : "FAIL"} his words were the next message`)
    out.push(!!held)
    const deferred = /still running, so the brain stops once it returns/.test(read())
    console.log(`${deferred ? "PASS" : "FAIL"} the brain wasn't stopped while the command ran`)
    out.push(deferred)
    await Promise.race([Promise.all([first, second]), sleep(30_000)])
  } finally {
    rmSync(skill, { force: true })
    rmSync(nap, { force: true })
  }
  return out
}

// No dead air: a line plays before the first slow tool.
if (!argv.includes("--skip-t3")) results.push(await ackStep())

// T3 with full access: steer a full-access thread on Winserve, then settle it.
if (!argv.includes("--skip-t3")) results.push(...(await t3Steps()))
if (!argv.includes("--skip-t3")) results.push(...(await watchSteps()))

/** Something that needs a slow tool: a line must reach the App before that tool runs. */
async function ackStep() {
  const read = tail()
  const ok = await step("answers with a slow tool", `${NAME}, how many T3 threads are running on this machine right now?`, ["t3_list_threads|t3_tool|t3_environments"])
  const log = read()
  const firstSpeak = log.search(/-> app \{"cmd":"speak"/)
  const firstTool = log.search(/\btool (?!speak\b)\w+ \{/)
  const acked = /acknowledged "[^"]+"/.exec(log)?.[0]
  const before = firstSpeak >= 0 && (firstTool < 0 || firstSpeak < firstTool)
  console.log(`${before ? "PASS" : "FAIL"} a line went out before the first slow tool (${acked ? `Core ${acked}` : "she spoke first herself"})`)
  return ok && before
}

/** Waits (up to `ms`) for the log to match `re`; returns the match or null. */
async function waitLog(read, re, ms) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const m = re.exec(read())
    if (m) return m
    await sleep(1000)
  }
  return null
}

/**
 * t3_start_thread on Winserve given by environment id, its watch to the
 * finish (chime and inbox), a send to it while idle (a new turn), and a
 * settle.
 */
async function watchSteps() {
  const WINSERVE = "573af78b-3442-4163-8b9b-bc5cb90eefde"
  const out = []
  const title = `Assistant watch smoke ${Date.now().toString(36)}`
  const read = tail()
  out.push(
    await step(
      "start a thread by environment id",
      `${NAME}, call t3_start_thread with project "No project", environmentId ${WINSERVE}, title "${title}", and this exact brief: Reply with the single word done, and do nothing else.`,
      ["t3_start_thread"],
    ),
  )
  const started = /tool t3_start_thread -> Started thread (\S+) in [^\n]*watching it/.exec(read())
  if (!started) {
    console.log("FAIL t3_start_thread started and watched a thread")
    return [...out, false]
  }
  const threadId = started[1]
  console.log(`PASS t3_start_thread started ${threadId} on Winserve and watches it`)
  out.push(true)
  const esc = threadId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const finished = await waitLog(read, new RegExp(`inbox: T3 [^\\n]* finished \\[${esc}\\][^\\n]*\\n[^\\n]*chime notify`), 240_000)
  console.log(`${finished ? "PASS" : "FAIL"} its finish chimed and landed in the inbox`)
  out.push(!!finished)
  const read2 = tail()
  out.push(
    await step(
      "send to the idle thread",
      `${NAME}, use t3_send to tell thread ${threadId} on environment ${WINSERVE}: reply with the single word mango.`,
      ["t3_send"],
    ),
  )
  const turned = /tool t3_send -> Started a new turn/.test(read2())
  console.log(`${turned ? "PASS" : "FAIL"} sending to the idle thread started a turn`)
  out.push(turned)
  const again = await waitLog(read2, new RegExp(`inbox: T3 [^\\n]* finished \\[${esc}\\]`), 240_000)
  console.log(`${again ? "PASS" : "FAIL"} that turn's finish was announced too`)
  out.push(!!again)
  try {
    const r = await post("/api/t3-tool", { name: "t3_thread_organize", args: { environmentId: WINSERVE, threadId, action: "settle" } })
    if (r.error) throw new Error(r.error)
    console.log(`PASS settled ${threadId}`)
    out.push(true)
  } catch (err) {
    console.log(`FAIL settling ${threadId}: ${err.message}`)
    out.push(false)
  }
  return out
}


/** Launches a full-access scratch thread on Winserve, has her steer it and settle it by voice, and checks both. */
async function t3Steps() {
  const WINSERVE = "573af78b-3442-4163-8b9b-bc5cb90eefde"
  const out = []
  const title = `Assistant smoke ${Date.now().toString(36)}`
  const call = async (name, args) => {
    const r = await post("/api/t3-tool", { name, args })
    if (r.error) throw new Error(r.error)
    return r.result
  }
  let threadId
  try {
    const launched = await call("t3_thread_launch", {
      environmentId: WINSERVE,
      scratch: true,
      title,
      runtimeMode: "full-access",
      modelSelection: { provider: "claudeAgent", instanceId: "claudeAgent", model: "claude-sonnet-5-5", options: [{ id: "effort", value: "low" }] },
      message:
        "This is a test from Shawn's voice assistant. Run the shell command: powershell -NoProfile -Command Start-Sleep -Seconds 45 . Then reply with one word: done. Messages may arrive while you wait; follow them too.",
    })
    threadId = launched.threadId ?? launched.thread?.threadId
    if (!threadId) throw new Error(`no thread id: ${JSON.stringify(launched).slice(0, 300)}`)
    console.log(`PASS launched full-access thread "${title}" (${threadId})`)
    out.push(true)
  } catch (err) {
    console.log(`FAIL launching a full-access thread on Winserve: ${err.message}`)
    return [false]
  }
  await sleep(8000) // let its turn start
  const read = tail()
  out.push(
    await step(
      "steer the thread",
      `${NAME}, tell my "${title}" thread on Winserve to also say the word pineapple when it's done.`,
      ["t3_send|t3_tool|send_feedback"],
    ),
  )
  const steered = /tool (?:t3_send|t3_tool) -> [^\n]*(?:Steered|"steered")/.test(read())
  console.log(`${steered ? "PASS" : "FAIL"} the message steered the running turn (not queued or refused)`)
  out.push(steered)
  // T3 settles only a thread that isn't mid-turn: wait for its run (the sleep, then "done").
  for (let i = 0; i < 40; i++) {
    const list = await call("t3_thread_list", { environmentId: WINSERVE, allProjects: true, titleContains: title, limit: 5 }).catch(() => null)
    const row = list?.threads?.find((t) => t.threadId === threadId)
    if (row && !/^(preparing|queued|starting|running)$/.test(row.status ?? "")) break
    await sleep(3000)
  }
  out.push(await step("settle the thread", `${NAME}, settle the "${title}" thread on Winserve.`, ["t3_tool"]))
  try {
    const list = await call("t3_thread_list", { environmentId: WINSERVE, allProjects: true, settled: true, titleContains: title, limit: 5 })
    const settled = JSON.stringify(list).includes(threadId)
    console.log(`${settled ? "PASS" : "FAIL"} the thread is settled in T3`)
    out.push(settled)
    const shown = await call("t3_thread_read", { environmentId: WINSERVE, threadId, limit: 8 })
    const got = /pineapple/i.test(JSON.stringify(shown))
    console.log(`${got ? "PASS" : "FAIL"} the thread got the steered message`)
    out.push(got)
  } catch (err) {
    console.log(`FAIL checking the thread: ${err.message}`)
    out.push(false)
  }
  return out
}

// Put back what the run changed.
const after = readJson(join(HOME, "config.json"), {})
if (!skipVoice && (after?.app?.voice ?? null) !== startVoice) {
  const back = startVoice ? `${NAME}, switch your voice back to ${startVoice}.` : `${NAME}, switch back to your first voice.`
  results.push(await step("voice back", back, ["set_voice"]))
}
if (startPrompt !== null) {
  const now = readFileSync(join(HOME, "system-prompt.md"), "utf8")
  if (now !== startPrompt) {
    console.log("FAIL the system prompt differs from before the run (see ~/.assistant/prompt-history)")
    results.push(false)
  }
}
if (readJson(join(HOME, "config.json"), {})?.brain?.harness !== "claude-code") {
  console.log("note: the brain isn't back on claude-code; setting it")
  await post("/api/brain", { harness: "claude-code" })
}

const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} of ${results.length} steps failed` : `all ${results.length} steps passed`)
process.exit(failed ? 1 : 0)
