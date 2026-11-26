#!/usr/bin/env node
// End-to-end test of install, update, and rollback against a local release feed, quietly:
// a throwaway install folder and ASSISTANT_HOME, simulated audio (nothing plays), Core's
// scripted brain, and the fake GitHub feed (scripts/assistant-fake-feed.mjs). Nothing touches
// ~/.assistant, the real install, or the Run key.
//
//   node scripts/assistant-update-test.mjs [--work S:\dev\cache\uptest] [--keep]
//
// Needs a package from scripts/assistant-package.sh in dist/ (its stage is relabelled to make
// the "newer" B and the broken C), the voice models (ASSISTANT_VOICE_MODELS, default
// ~/.assistant/models) and a speech model folder (ASSISTANT_STT_MODELS, default
// ~/.assistant/models/stt; downloaded there once if empty).
//
// 1. Bootstrap: install-assistant.ps1 installs A from the feed (download, checksum, unpack,
//    install-self: a voice env made from A's uv.lock, install.json, launcher).
// 2. The launcher starts A; it confirms it started cleanly.
// 3. The feed's nightly becomes B; Settings' "Check" and "Update" (through the sim control
//    port) download, verify, unpack, hand over, quit, and B starts and confirms; A is kept as
//    previous.
// 4. The feed's nightly becomes C, whose Core is missing: it never confirms, so the supervisor
//    rolls back to B and notes C's failure.
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : fallback
}
const work = resolve(arg("--work", join(process.env.TEMP ?? "/tmp", "assistant-update-test")))
const keep = process.argv.includes("--keep")
const feedPort = 7399
const simPort = 7398
const voicePort = 7317
const root = join(work, "root")
const home = join(work, "home")
const feed = join(work, "feed")
const dist = join(repo, "dist")
const realHome = join(homedir(), ".assistant")

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
const state = () => JSON.parse(readFileSync(join(root, "install.json"), "utf8"))
const fail = (why) => {
  console.error(`FAIL: ${why}`)
  try {
    console.error(readFileSync(join(home, "logs", "updater.log"), "utf8").split("\n").slice(-30).join("\n"))
  } catch {}
  process.exit(1)
}

async function until(what, test, seconds) {
  const end = Date.now() + seconds * 1000
  while (Date.now() < end) {
    try {
      const value = await test()
      if (value) return value
    } catch {}
    await sleep(1000)
  }
  fail(`timed out after ${seconds} s waiting for ${what}`)
}

function sim(line) {
  return new Promise((resolveLine, reject) => {
    const socket = connect(simPort, "127.0.0.1", () => socket.write(line + "\n"))
    let answer = ""
    socket.on("data", (d) => {
      answer += d
      if (answer.includes("\n")) {
        socket.end()
        resolveLine(answer.trim())
      }
    })
    socket.on("error", reject)
  })
}

/** The paths of every running assistant.exe. */
function running() {
  return spawnSync("powershell", ["-NoProfile", "-Command", "(Get-Process assistant -ErrorAction SilentlyContinue).Path"])
    .stdout.toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
}

// --- packages ---------------------------------------------------------------

const stage = join(dist, "stage")
const base = JSON.parse(readFileSync(join(stage, "assistant-package.json"), "utf8"))
const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")

/** A release in the feed's `nightly`: the stage relabelled, maybe broken. */
function release(label, { broken = false, notes = "" } = {}) {
  const dir = join(work, "variants", label)
  rmSync(dir, { recursive: true, force: true })
  cpSync(stage, dir, { recursive: true })
  writeFileSync(join(dir, "assistant-package.json"), JSON.stringify({ ...base, label }, null, 2))
  if (broken) rmSync(join(dir, "core", "dist"), { recursive: true, force: true })
  const out = join(feed, "nightly")
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const name = `assistant-${label}-windows-x64.zip`
  const zip = join(out, name)
  const made = spawnSync(tar, ["-a", "-cf", zip, ...readdirSync(dir)], { cwd: dir })
  if (made.status !== 0) fail(`tar: ${made.stderr}`)
  const manifest = {
    schema: 1, name: "assistant", version: base.version, label, channel: "nightly",
    commit: base.commit, date: new Date().toISOString(), notes: notes || `- test release ${label}`,
    asset: { name, size: statSync(zip).size, sha256: sha256(zip) }, voice_lock: base.voice_lock,
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2))
  writeFileSync(join(out, `${name}.sha256`), `${manifest.asset.sha256} *${name}\n`)
  log(`feed nightly is now ${label}${broken ? " (broken: no Core)" : ""}`)
}

// --- run ----------------------------------------------------------------------

if (!existsSync(stage)) fail("no dist/stage: run scripts/assistant-package.sh first")
if (running().length) fail(`an assistant.exe is running (${running().join(", ")}); quit it first`)
rmSync(work, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
mkdirSync(feed, { recursive: true })
writeFileSync(join(home, "config.json"), JSON.stringify({
  brain: { harness: "script" },
  port: 7319,
  app: {
    startAtLogin: false,
    voiceService: { port: voicePort },
    updates: { channel: "nightly", check: false, repo: "test/assistant" },
  },
}, null, 2))
const env = {
  ...process.env,
  ASSISTANT_HOME: home,
  ASSISTANT_AUDIO_SIM: "echo_db=-30,delay_ms=60,noise_db=-75",
  ASSISTANT_SIM_CONTROL: `127.0.0.1:${simPort}`,
  ASSISTANT_UPDATE_API: `http://127.0.0.1:${feedPort}`,
  ASSISTANT_VOICE_MODELS: process.env.ASSISTANT_VOICE_MODELS ?? join(realHome, "models"),
  ASSISTANT_STT_MODELS: process.env.ASSISTANT_STT_MODELS ?? join(realHome, "models", "stt"),
}
const A = base.label
const B = `${base.version}-nightly.29990101.bbbbbbbb`
const C = `${base.version}-nightly.29990102.cccccccc`

release(A)
const feedServer = spawn(process.execPath, [join(repo, "scripts", "assistant-fake-feed.mjs"), feed, "--port", String(feedPort)], { stdio: "ignore" })
await sleep(800)
let ok = false
try {
  log("1. bootstrap installs A from the feed")
  const boot = spawnSync("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(repo, "scripts", "install-assistant.ps1"),
    "-Channel", "nightly", "-Repo", "test/assistant", "-Api", `http://127.0.0.1:${feedPort}`,
    "-Root", root, "-NoLogin", "-NoStart",
  ], { env, stdio: "inherit" })
  if (boot.status !== 0) fail(`install-assistant.ps1 exited ${boot.status}`)
  if (state().current !== A) fail(`install.json current is ${state().current}, not ${A}`)
  if (!existsSync(join(root, "assistant.exe"))) fail("no launcher")

  log("2. the launcher starts A, which confirms")
  spawn(join(root, "assistant.exe"), ["--hidden"], { env, detached: true, stdio: "ignore" }).unref()
  await until("A's sim port", async () => (await sim("")).startsWith("ok"), 60)
  await until("A running from versions\\A", () => running().some((p) => p.toLowerCase().endsWith(`\\versions\\${A}\\assistant.exe`.toLowerCase())), 30)

  log("3. B is published; Check, then Update")
  release(B, { notes: "- Updates: Stable and Nightly\n- Safe switch with rollback" })
  if ((await sim("update check")) !== "ok") fail("update check")
  await sleep(3000)
  if ((await sim("update install")) !== "ok") fail("update install")
  await until(`B to be current and confirmed`, () => {
    const s = state()
    return s.current === B && !s.pending
  }, 300)
  if (state().previous !== A) fail(`previous is ${state().previous}, not ${A}`)
  log(`   B confirmed; previous ${state().previous}; versions: ${readdirSync(join(root, "versions")).join(", ")}`)
  await until("B's sim port", async () => (await sim("")).startsWith("ok"), 60)

  log("4. C (no Core) is published; it fails to start and rolls back to B")
  release(C, { broken: true })
  if ((await sim("update check")) !== "ok") fail("update check")
  await sleep(3000)
  if ((await sim("update install")) !== "ok") fail("update install")
  await until("the rollback to B", () => {
    const s = state()
    return s.current === B && !s.pending && s.failed?.label === C
  }, 400)
  log(`   rolled back: ${state().failed.reason}`)
  await until("B running again", async () => (await sim("")).startsWith("ok"), 90)
  ok = true
  log("PASS")
} finally {
  spawnSync(join(root, "assistant.exe"), ["quit"], { env, stdio: "ignore" })
  await sleep(3000)
  feedServer.kill()
  if (ok && !keep) rmSync(work, { recursive: true, force: true })
  else log(`kept ${work}`)
}
