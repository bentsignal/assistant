#!/usr/bin/env node
// A real-brain smoke check against the running assistant.exe: the soak test
// uses a scripted brain, so it can't catch a real brain that can't call its
// tools (the rename once shipped with every speak call denied). This posts a
// few utterances to Core's debug hook (POST /api/utterance) and asserts, in
// ~/.assistant/logs/core-*.log, that the brain called the expected tools and
// that a line then finished playing.
//
//   node scripts/assistant-soak/smoke-brain.mjs [--home ~/.assistant] [--timeout 60]
//
// It talks out loud (it's the real app) and changes things it puts back:
// the voice (restored at the end), the brain (back to Claude), and the
// system prompt (an edit, then its revert).

import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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

/** Says `text` and waits until the log shows each tool (in order) and then a finished line. */
async function step(label, text, tools) {
  const read = tail()
  const started = Date.now()
  const turn = post("/api/utterance", { text, wait: true }).catch((err) => ({ error: err.message }))
  let missing = "the turn"
  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(300)
    const log = read()
    let at = 0
    missing = ""
    for (const tool of tools) {
      const m = new RegExp(`\\btool ${tool}\\b`).exec(log.slice(at))
      if (!m) {
        missing = `tool ${tool}`
        break
      }
      at += m.index + m[0].length
    }
    if (!missing) {
      const speakAt = log.slice(at).search(/\btool speak\b/)
      const after = speakAt >= 0 ? log.slice(at + speakAt) : log.slice(at)
      if (speakAt < 0) missing = "tool speak"
      else if (!FINISHED.test(after)) missing = "playback finished"
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
results.push(await step("switch to Eli", `${NAME}, switch to Eli.`, ["set_voice"]))
results.push(await step("use codex", `${NAME}, use codex.`, ["set_brain"]))
results.push(await step("codex answers", `${NAME}, say ready.`, ["speak"]))
results.push(await step("use claude", `${NAME}, use claude.`, ["set_brain"]))
results.push(await step("prompt edit", `${NAME}, remember to keep answers under two sentences.`, ["edit_system_prompt"]))
results.push(await step("prompt revert", `${NAME}, undo that last change to your prompt.`, ["revert_system_prompt"]))

// Put back what the run changed.
const after = readJson(join(HOME, "config.json"), {})
if ((after?.app?.voice ?? null) !== startVoice) {
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
