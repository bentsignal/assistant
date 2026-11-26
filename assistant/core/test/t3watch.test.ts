/**
 * T3 watches on this machine and on linked ones, the send mode, and the
 * T3 tools that start or send (with fakes in place of T3).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { T3, T3Watcher, rowFromRead, watchNotice, type T3ThreadRow, type WatchEvent } from "../src/t3.ts"
import { HANDLERS } from "../src/tools.ts"

const LOCAL = "local-env"
const AIR = "68895f1f-7a01-406f-a6bf-63a153f852f6"

/** A fake T3: local rows from `threads()`, remote ones from `remoteRead()` (per environment). */
function fakeT3() {
  const local = new Map<string, T3ThreadRow>()
  const remote = new Map<string, any>() // `${env}/${id}` -> t3_thread_read result
  const reads: string[] = []
  const down = new Set<string>()
  const t3 = {
    async threads() {
      if (down.has("local")) throw new Error("T3 Code isn't running")
      return [...local.values()]
    },
    async show() {
      return { messages: [{ role: "assistant", text: "local reply" }] }
    },
    async remoteRead(env: string | undefined, id: string) {
      reads.push(`${env ?? "local"}/${id}`)
      if (env && down.has(env)) throw Object.assign(new Error(`Linked environment ${env} isn't reachable`), { code: "environment_unreachable" })
      const r = remote.get(`${env ?? "local"}/${id}`)
      if (!r) throw Object.assign(new Error(`Thread ${id} was not found`), { code: "thread_not_found" })
      return r
    },
    async localEnvironmentId() {
      return LOCAL
    },
  }
  return { t3, local, remote, reads, down }
}

const read = (id: string, status: string, completedAt: string | null, opts: { reply?: string; pending?: number; runStatus?: string } = {}) => ({
  thread: { threadId: id, title: `Thread ${id}`, status, pendingRequestCount: opts.pending ?? 0, updatedAt: "2026-11-26T00:00:00Z" },
  recentRuns: [{ runId: "r2", ordinal: 2, status: opts.runStatus ?? (completedAt ? "completed" : "running"), completedAt }],
  items: opts.reply ? [{ position: 9, type: "assistant_message", text: opts.reply }] : [],
})

function watcher(src: ReturnType<typeof fakeT3>) {
  const dir = mkdtempSync(join(tmpdir(), "assistant-watch-"))
  const events: WatchEvent[] = []
  const logs: string[] = []
  const w = new T3Watcher(src.t3 as any, join(dir, "watches.json"), (e) => events.push(e), () => {}, (l) => logs.push(l))
  return { w, events, logs, file: join(dir, "watches.json") }
}

test("rowFromRead takes status, the latest run, a pending request, and the last reply from t3_thread_read", () => {
  const row = rowFromRead(read("t1", "idle", "2026-11-26T01:00:00Z", { reply: "All done.", pending: 1 }))
  assert.equal(row.id, "t1")
  assert.equal(row.latestRunCompletedAt, "2026-11-26T01:00:00Z")
  assert.equal(row.waiting, true)
  assert.equal(row.message, "All done.")
})

test("a watch on another machine stores its environment and is polled there, and its finish notifies", async () => {
  const src = fakeT3()
  src.remote.set(`${AIR}/mcp:5e53`, read("mcp:5e53", "running", null))
  const { w, events, file } = watcher(src)
  const watch = await w.add("mcp:5e53", { environmentId: AIR })
  assert.equal(watch.environmentId, AIR)
  assert.equal(JSON.parse(readFileSync(file, "utf8"))[0].environmentId, AIR)
  await w.poll()
  assert.equal(events.length, 0)
  assert.ok(src.reads.every((r) => r === `${AIR}/mcp:5e53`), "read on its own machine, never this one")
  src.remote.set(`${AIR}/mcp:5e53`, read("mcp:5e53", "completed", "2026-11-26T02:00:00Z", { reply: "Pushed." }))
  await w.poll()
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, "finished")
  assert.equal(events[0].message, "Pushed.")
  const notice = watchNotice(events[0])
  assert.match(notice.title, /finished/)
  assert.match(notice.title, new RegExp(AIR))
  await w.poll()
  assert.equal(events.length, 1, "notifies once per run")
})

test("this machine's own environment id is a local watch", async () => {
  const src = fakeT3()
  src.local.set("t1", { id: "t1", projectId: "p", title: "Local", status: "running", updatedAt: "", latestRunId: null, latestRunCompletedAt: null, waiting: false, lastError: null })
  const { w } = watcher(src)
  const watch = await w.add("t1", { environmentId: LOCAL })
  assert.equal(watch.environmentId, undefined)
  assert.ok(w.watches.has("t1"))
})

test("a fresh watch counts a run that already ended before the first read, and a failed run says failed", async () => {
  const src = fakeT3()
  src.remote.set(`${AIR}/t2`, read("t2", "idle", "2026-11-26T03:00:00Z", { runStatus: "failed" }))
  const { w, events } = watcher(src)
  await w.add("t2", { environmentId: AIR, fresh: true })
  await w.poll()
  assert.deepEqual(events.map((e) => e.kind), ["failed"])
})

test("waiting for input notifies once", async () => {
  const src = fakeT3()
  src.remote.set(`${AIR}/t3`, read("t3", "running", null))
  const { w, events } = watcher(src)
  await w.add("t3", { environmentId: AIR })
  src.remote.set(`${AIR}/t3`, read("t3", "waiting", null, { pending: 1 }))
  await w.poll()
  await w.poll()
  assert.deepEqual(events.map((e) => e.kind), ["waiting"])
})

test("waiting only on its own background work isn't asking him anything, and the same notice never repeats", async () => {
  const src = fakeT3()
  const bg = (status: string, reply: string) => {
    const r: any = read("orch", status, "2026-11-26T02:00:00Z", { reply })
    r.thread.pendingBackgroundTasks = status === "waiting" ? [{ taskId: "b1", kind: "command" }] : []
    return r
  }
  // A local thread the shell lists as waiting, though it's only awaiting its own background command.
  src.local.set("orch", { id: "orch", projectId: "p", title: "Orchestrator", status: "running", updatedAt: "", latestRunId: "r2", latestRunCompletedAt: null, waiting: false, lastError: null })
  src.remote.set("local/orch", bg("running", "Working on it."))
  const { w, events } = watcher(src)
  await w.add("orch", { fresh: true })
  for (let i = 0; i < 3; i++) {
    src.local.set("orch", { ...src.local.get("orch")!, status: "waiting", waiting: true })
    src.remote.set("local/orch", bg("waiting", "Still building."))
    await w.poll()
    src.local.set("orch", { ...src.local.get("orch")!, status: "running", waiting: false })
    await w.poll()
  }
  assert.deepEqual(events.map((e) => e.kind), [])
  // It finishes: one notice with its newest reply; a re-read with nothing new stays quiet.
  src.local.set("orch", { ...src.local.get("orch")!, status: "idle", waiting: false, latestRunCompletedAt: "2026-11-26T03:00:00Z" })
  src.remote.set("local/orch", bg("idle", "All done."))
  await w.poll()
  assert.deepEqual(events.map((e) => [e.kind, e.message]), [["finished", "All done."]])
  src.local.set("orch", { ...src.local.get("orch")!, status: "running" })
  await w.poll()
  src.local.set("orch", { ...src.local.get("orch")!, status: "idle", latestRunCompletedAt: "2026-11-26T03:05:00Z" })
  await w.poll()
  assert.equal(events.length, 1)
})

test("an unreachable machine is logged, told once, kept, and its finish still notifies when it's back", async () => {
  const src = fakeT3()
  src.remote.set(`${AIR}/t4`, read("t4", "running", null))
  const { w, events, logs } = watcher(src)
  await w.add("t4", { environmentId: AIR })
  src.down.add(AIR)
  await w.poll()
  await w.poll()
  assert.deepEqual(events.map((e) => e.kind), ["unreachable"])
  assert.equal(logs.filter((l) => /can't read watched thread t4/.test(l)).length, 2, "logged every time")
  assert.ok(w.watches.size === 1, "still watching")
  src.down.delete(AIR)
  src.remote.set(`${AIR}/t4`, read("t4", "completed", "2026-11-26T04:00:00Z"))
  await w.poll()
  assert.deepEqual(events.map((e) => e.kind), ["unreachable", "finished"])
  assert.equal(w.get("t4")?.pollError, undefined)
})

test("a thread that's gone is reported and dropped, never silently", async () => {
  const src = fakeT3()
  src.remote.set(`${AIR}/t5`, read("t5", "running", null))
  const { w, events } = watcher(src)
  await w.add("t5", { environmentId: AIR })
  src.remote.delete(`${AIR}/t5`)
  await w.poll()
  assert.deepEqual(events.map((e) => e.kind), ["gone"])
  assert.equal(w.watches.size, 0)
})

test("T3 down on this machine tells once per local watch, and a local thread the shell lacks is read through MCP", async () => {
  const src = fakeT3()
  src.remote.set("local/sub", read("sub", "running", null))
  const { w, events } = watcher(src)
  await w.add("sub")
  src.down.add("local")
  await w.poll()
  await w.poll()
  assert.deepEqual(events.map((e) => e.kind), ["unreachable"])
})

test("watching a thread on another machine that doesn't exist fails with why", async () => {
  const src = fakeT3()
  const { w } = watcher(src)
  await assert.rejects(w.add("nope", { environmentId: AIR }), /can't watch T3 thread nope on .*not found/)
})

test("T3.send defaults to mode auto (steer a running turn, start an idle one); queue only when asked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "assistant-t3-"))
  const t3 = new T3(dir)
  const calls: any[] = []
  ;(t3 as any).mcpTool = async (name: string, args: any) => {
    calls.push({ name, args })
    return { delivery: args.mode === "queue" ? "queued" : "started" }
  }
  assert.equal((await t3.send("idle-thread", "hi")).delivery, "started")
  await t3.send("t", "later", { mode: "queue" })
  assert.equal(calls[0].args.mode, "auto")
  assert.equal(calls[1].args.mode, "queue")
})

/** A fake Assistant for the tool handlers. */
function fakeAssistant() {
  const sent: any[] = []
  const watched: any[] = []
  const launched: any[] = []
  const assistant: any = {
    config: { t3: { orchestratorThread: { threadId: "orch", environmentId: undefined } } },
    log() {},
    currentTurn: null,
    takeAckNote: () => "",
    beforeTool() {},
    t3: {
      mcpAccess: "full-access",
      async send(thread: string, message: string, opts: any) {
        sent.push({ thread, message, ...opts })
        return { delivery: opts.mode === "queue" ? "queued" : "started", via: "mcp" }
      },
      async threads() {
        return [{ id: "t1", title: "Fix tests" }]
      },
      async findProject(q: string, env?: string) {
        if (env !== "573af78b") throw new Error("wrong machine")
        return { id: "p1", title: "No project", workspaceRoot: "C:\\scratch", defaultModelSelection: null }
      },
      async launch(env: string, project: any, message: string, opts: any) {
        launched.push({ env, project: project.id, message, ...opts })
        return { threadId: "mcp:new", raw: {} }
      },
      async mcpTool(name: string, args: any) {
        return name === "t3_thread_launch" ? { threadId: "mcp:launched", link: "x" } : { ok: true, args }
      },
    },
    watcher: {
      async ensure(id: string, env?: string) {
        watched.push({ id, env })
        return {}
      },
    },
  }
  return { assistant, sent, watched, launched }
}

test("t3_send and send_feedback send in auto mode (an idle thread starts a turn); queue only when he asks", async () => {
  const { assistant, sent, watched } = fakeAssistant()
  const r = await HANDLERS.t3_send(assistant, { thread: "t1", message: "go on" })
  assert.match(r, /Started a new turn/)
  await HANDLERS.t3_send(assistant, { thread: "t1", message: "after", queue: true })
  const fb = await HANDLERS.send_feedback(assistant, { message: "acks are late" })
  assert.match(fb, /started a new turn/)
  assert.deepEqual(sent.map((s) => s.mode), ["auto", "queue", "auto"])
  assert.deepEqual(watched, [{ id: "t1", env: undefined }, { id: "t1", env: undefined }])
})

test("t3_send to another machine's thread watches it there", async () => {
  const { assistant, watched } = fakeAssistant()
  await HANDLERS.t3_send(assistant, { thread: "mcp:5e53", message: "status?", environment: AIR })
  assert.deepEqual(watched, [{ id: "mcp:5e53", env: AIR }])
})

test("t3_start_thread with environmentId resolves the project on that machine, launches there, and watches it there", async () => {
  const { assistant, launched, watched } = fakeAssistant()
  const r = await HANDLERS.t3_start_thread(assistant, { project: "a70ac8fa", message: "Reply done.", environmentId: "573af78b" })
  assert.match(r, /Started thread mcp:new in No project on 573af78b, watching it/)
  assert.deepEqual(launched, [{ env: "573af78b", project: "p1", message: "Reply done.", title: undefined, model: undefined }])
  assert.deepEqual(watched, [{ id: "mcp:new", env: "573af78b" }])
})

test("t3_tool t3_thread_launch with a message watches the new thread on its machine", async () => {
  const { assistant, watched } = fakeAssistant()
  const r = await HANDLERS.t3_tool(assistant, { name: "t3_thread_launch", args: { environmentId: AIR, title: "x", message: "go" } })
  assert.match(r, /watching it/)
  assert.deepEqual(watched, [{ id: "mcp:launched", env: AIR }])
  await HANDLERS.t3_tool(assistant, { name: "t3_thread_launch", args: { environmentId: AIR, title: "idle" } })
  assert.equal(watched.length, 1, "an idle launch isn't watched")
})

test("a watch that can't be added says so in the tool result instead of failing quietly", async () => {
  const { assistant } = fakeAssistant()
  assistant.watcher.ensure = async () => {
    throw new Error("no T3 thread mcp:new")
  }
  const r = await HANDLERS.t3_start_thread(assistant, { project: "p", message: "m", environmentId: "573af78b" })
  assert.match(r, /couldn't watch it .*no chime/)
})
