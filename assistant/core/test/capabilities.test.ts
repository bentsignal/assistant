import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpStore, brainServers, claudeMcpConfig, probeServer, redactSpec, resolveRefs, resolveSpec, validServerName } from "../src/mcp/config.ts"
import { codexServer } from "../src/brain/codex.ts"
import { checkValue, getKey, patchFor, SETTINGS } from "../src/settings.ts"
import { findT3Cli } from "../src/t3.ts"
import { backLine, describeChannel, describeUpdate, failedLine, rolledBackLine, speakableVersion, type UpdateReply } from "../src/updates.ts"
import { logged } from "../src/tools.ts"

const found = (name: string) => (name === "node" || name === "npx" ? `C:\\bin\\${name}${name === "npx" ? ".cmd" : ".exe"}` : null)
const env = { LINEAR_TOKEN: "lin_secret", ComSpec: "C:\\Windows\\cmd.exe" }

// ---- MCP config merge -------------------------------------------------------

test("mcp: good servers are merged after the Assistant server; broken, disabled ones are left out with why", () => {
  const file = {
    servers: {
      files: { command: "node", args: ["server.js", "D:\\notes"] },
      linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_TOKEN}" } },
      ghost: { command: "no-such-program" },
      needskey: { command: "node", env: { API_KEY: "${MISSING_KEY}" } },
      off: { command: "node", disabled: true },
      bad: { url: "ftp://x" },
      assistant: { command: "node" },
    },
  }
  const { servers, skipped } = brainServers(file, env, found)
  assert.deepEqual(Object.keys(servers), ["files", "linear"])
  assert.deepEqual(servers.linear, { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin_secret" } })
  const why = Object.fromEntries(skipped.map((s) => [s.name, s.reason]))
  assert.match(why.ghost, /no-such-program isn't found/)
  assert.match(why.needskey, /MISSING_KEY isn't set/)
  assert.match(why.bad, /http or https/)
  assert.match(why.assistant, /your own server's name/)
  assert.equal("off" in why, false)
  const merged = claudeMcpConfig({ command: "node.exe", args: ["mcp.js"], env: { ASSISTANT_TOKEN: "t" } }, servers)
  assert.deepEqual(Object.keys(merged.mcpServers), ["assistant", "files", "linear"])
  assert.equal((merged.mcpServers.assistant as any).type, "stdio")
})

test("mcp: a broken mcp.json gives the brain none of her servers, and says why", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-"))
  const file = join(dir, "mcp.json")
  writeFileSync(file, "{ not json")
  const store = new McpStore(file)
  const { servers, skipped } = brainServers(store.read(), env, found)
  assert.deepEqual(servers, {})
  assert.equal(skipped[0].name, "mcp.json")
  assert.match(skipped[0].reason, /isn't valid JSON/)
  assert.throws(() => store.add("x", { command: "node" }), /can't be changed/)
})

test("mcp: a Windows .cmd command runs through cmd.exe; ${file:} references read a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-"))
  writeFileSync(join(dir, "token.txt"), "  tok123\n")
  const s = resolveSpec({ command: "npx", args: ["-y", "pkg"], env: { T: `\${file:${join(dir, "token.txt")}}` } }, env, found, "win32")
  assert.deepEqual(s, { type: "stdio", command: "C:\\Windows\\cmd.exe", args: ["/d", "/c", "C:\\bin\\npx.cmd", "-y", "pkg"], env: { T: "tok123" } })
  assert.equal(resolveRefs("${NOPE:-fallback}", {}), "fallback")
  assert.throws(() => resolveRefs("${file:Z:\\missing.txt}", {}), /can't be read/)
})

test("mcp: the store adds, replaces, disables, enables and removes; names are checked", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-"))
  const store = new McpStore(join(dir, "mcp.json"))
  let changes = 0
  store.check()
  store.onChange(() => changes++)
  assert.equal(store.add("echo", { command: "node", args: ["a.js"] }).created, true)
  assert.equal(store.add("ECHO", { command: "node", args: ["b.js"] }).created, false)
  assert.deepEqual(store.get("echo")?.args, ["b.js"])
  assert.equal(store.setEnabled("echo", false).changed, true)
  assert.equal(store.setEnabled("echo", false).changed, false)
  assert.equal(brainServers(store.read(), env, found).servers.echo, undefined)
  store.setEnabled("echo", true)
  assert.ok(brainServers(store.read(), env, found).servers.ECHO)
  store.remove("echo")
  assert.deepEqual(store.list(), [])
  assert.ok(changes >= 5)
  assert.throws(() => validServerName("has space"), /letters, digits/)
  assert.throws(() => store.add("x", { type: "stdio" }), /needs a command/)
  const onDisk = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"))
  assert.deepEqual(onDisk, { mcpServers: {} })
})

test("mcp: secrets are hidden from what she sees and the log; references are shown", () => {
  const spec = { url: "https://x/mcp", headers: { Authorization: "Bearer ${TOKEN}", "X-Key": "sk-live-123" } }
  assert.deepEqual(redactSpec(spec).headers, { Authorization: "Bearer ${TOKEN}", "X-Key": "‹hidden›" })
  const line = JSON.stringify(logged("mcp_add", { name: "s", command: "node", env: { A: "plain-secret", B: "${B}" } }))
  assert.doesNotMatch(line, /plain-secret/)
  assert.match(line, /\$\{B\}/)
})

test("mcp: Codex gets her servers as TOML inline tables; SSE is left out", () => {
  assert.equal(
    codexServer({ type: "stdio", command: "C:\\bin\\node.exe", args: ["a b.js"], env: { K: "v" } }),
    `{command='C:\\bin\\node.exe',args=['a b.js'],env={K='v'},startup_timeout_sec=20,tool_timeout_sec=300,default_tools_approval_mode="approve"}`,
  )
  assert.match(codexServer({ type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer t" } })!, /^\{url='https:\/\/x\/mcp',http_headers=\{Authorization='Bearer t'\}/)
  assert.equal(codexServer({ type: "sse", url: "https://x/sse", headers: {} }), null)
})

test("mcp: a probe starts a stdio server, lists its tools, and names a failure", async () => {
  const script = join(import.meta.dirname, "..", "scripts", "smoke-mcp.mjs")
  const ok = await probeServer({ type: "stdio", command: process.execPath, args: [script, "plum"], env: {} }, 15_000)
  assert.equal(ok.ok, true, ok.error)
  assert.deepEqual(ok.tools.map((t) => t.name), ["secret_word"])
  const bad = await probeServer({ type: "stdio", command: process.execPath, args: ["-e", "console.error('boom'); process.exit(3)"], env: {} }, 15_000)
  assert.equal(bad.ok, false)
  assert.match(bad.error ?? "", /exited \(3\)/)
  assert.match(bad.stderr ?? "", /boom/)
})

// ---- config_set allowlist ---------------------------------------------------

test("config: allowlisted keys are checked and coerced; anything else is refused", () => {
  assert.equal(checkValue("wake.followUpSeconds", "20"), 20)
  assert.equal(checkValue("wake.soft", "off"), false)
  assert.deepEqual(checkValue("wake.words", "Vee, Veer"), ["vee", "veer"])
  assert.equal(checkValue("app.updates.channel", "Nightly"), "nightly")
  assert.equal(checkValue("app.updates.channel", "default"), null)
  assert.throws(() => checkValue("wake.followUpSeconds", 999), /from 0 to 120/)
  assert.throws(() => checkValue("wake.maxLeadingWords", 1.5), /whole number/)
  assert.throws(() => checkValue("app.updates.channel", "beta"), /stable, nightly/)
  for (const key of ["port", "brain.harness", "assistant.name", "app.voice", "jobs.claude.command", "brain.claude-code.command"]) {
    assert.throws(() => checkValue(key, "x"), /isn't a setting/, key)
  }
  const io = { exists: (p: string) => p === "C:\\t3.cmd" || p === "D:\\dev", isDir: (p: string) => p === "D:\\dev" }
  assert.equal(checkValue("t3.cliPath", "\"C:\\t3.cmd\"", io), "C:\\t3.cmd")
  assert.throws(() => checkValue("t3.cliPath", "C:\\nope.cmd", io), /doesn't exist/)
  assert.throws(() => checkValue("t3.cliPath", "D:\\dev", io), /isn't a file/)
  assert.equal(checkValue("jobs.defaultCwd", "D:\\dev", io), "D:\\dev")
  assert.ok(Object.keys(SETTINGS).some((k) => k.startsWith("t3.")))
})

test("config: dotted keys read and patch nested config, dashes included", () => {
  assert.deepEqual(patchFor("brain.claude-code.model", "opus"), { brain: { "claude-code": { model: "opus" } } })
  assert.equal(getKey({ t3: { orchestratorThread: { threadId: "x" } } }, "t3.orchestratorThread.threadId"), "x")
  assert.equal(getKey({}, "t3.cliPath"), undefined)
})

// ---- t3 CLI discovery -------------------------------------------------------

test("t3 CLI: config, then T3CODE_CLI_PATH, then PATH, then T3 Code's launcher, then its app", () => {
  const io = (files: string[], onPath: string | null = null, configured?: string, e: NodeJS.ProcessEnv = {}) =>
    findT3Cli({ configured, env: e, exists: (p) => files.includes(p), which: () => onPath, home: "C:\\Users\\s", platform: "win32" })
  const all = ["D:\\t3\\t3.cmd", "E:\\env\\t3.cmd", "C:\\Users\\s\\.t3\\bin\\t3.cmd"]
  assert.deepEqual(io(all, "C:\\path\\t3.cmd", "D:\\t3\\t3.cmd", { T3CODE_CLI_PATH: "E:\\env\\t3.cmd" }), { ok: true, name: "D:\\t3\\t3.cmd", via: "config t3.cliPath" })
  assert.equal((io(all, "C:\\path\\t3.cmd", "Z:\\gone.cmd", { T3CODE_CLI_PATH: "E:\\env\\t3.cmd" }) as any).via, "T3CODE_CLI_PATH")
  assert.equal((io(all, "C:\\path\\t3.cmd") as any).via, "PATH")
  // GamerBox: not on PowerShell's PATH, but T3 Code wrote its launcher.
  assert.deepEqual(io(all), { ok: true, name: "C:\\Users\\s\\.t3\\bin\\t3.cmd", via: "T3 Code's launcher" })
  const app = "C:\\Users\\s\\AppData\\Local\\Programs\\t3code\\T3 Code (Beta).exe"
  const viaApp = io([app]) as any
  assert.equal(viaApp.via, "the T3 Code app")
  assert.equal(viaApp.launch.env.ELECTRON_RUN_AS_NODE, "1")
  assert.match(viaApp.launch.prefix[0], /server\.asar\\apps\\server\\dist\\bin\.mjs$/)
  const none = io([], null, "Z:\\gone.cmd") as any
  assert.equal(none.ok, false)
  assert.ok(none.looked.some((l: string) => l.includes("Z:\\gone.cmd")))
  assert.ok(none.looked.some((l: string) => l.includes("t3 on PATH")))
})

// ---- updates ----------------------------------------------------------------

const reply = (r: Partial<UpdateReply>): UpdateReply => ({ type: "update", state: "idle", running: "2.0.0-nightly.20261125.abc1234", channel: "nightly", installed: true, ...r })

test("updates: versions are said the way a person would, Nightlies by day and build", () => {
  assert.equal(speakableVersion("2.0.0-nightly.20261126.1a43cd3e"), "the November 26 Nightly, build 1 A 4 3")
  assert.equal(speakableVersion("2.1.0"), "version 2.1.0")
  assert.equal(speakableVersion("dev"), "dev")
})

test("updates: she says she's back from what's running, a rollback with its reason, and the updater's own failure", () => {
  assert.equal(backLine(reply({ state: "back", running: "2.0.0-nightly.20261126.1a43cd3e" })), "I'm back, on the November 26 Nightly, build 1 A 4 3.")
  assert.equal(
    rolledBackLine(reply({ state: "rolled_back", latest: "2.0.0-nightly.20261126.1a43cd3e", message: "it exited during startup (exit code: 1)" })),
    "The update to the November 26 Nightly, build 1 A 4 3 didn't take, so I'm back on the November 25 Nightly, build A B C 1: it exited during startup (exit code: 1).",
  )
  assert.equal(failedLine(reply({ state: "failed", message: "download: HTTP 404" })), "The update failed: download: HTTP 404.")
  assert.equal(failedLine(reply({ state: "failed" })), "The update failed: the updater didn't say why.")
})

test("updates: the tools report only what the App's updater answered", () => {
  assert.match(describeUpdate("install", reply({ state: "started", latest: "2.0.0-nightly.20261126.1a43cd3e" })), /^Started: .*one short line/)
  assert.match(describeUpdate("install", reply({ state: "up_to_date" })), /^No update available/)
  assert.match(describeUpdate("install", reply({ state: "no_release" })), /no release yet/)
  assert.match(describeUpdate("install", reply({ state: "failed", message: "GitHub said 503" })), /GitHub said 503/)
  // No answer is never a failure.
  assert.match(describeUpdate("install", null), /Don't say the update failed/)
  assert.match(describeUpdate("check", reply({ state: "available", latest: "2.0.0-nightly.20261126.1a43cd3e" })), /update_install installs it/)
  assert.match(describeUpdate("status", reply({ state: "up_to_date" })), /Running 2\.0\.0-nightly.*updating from Nightly/)
  assert.match(describeUpdate("install", reply({ state: "unavailable", installed: false, message: "this is a development build" })), /aren't available here/)
  assert.match(describeChannel("stable", reply({ state: "up_to_date", channel: "stable" })), /follow Stable\. It's already on its newest/)
})
