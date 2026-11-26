import { join } from "node:path"
import { availableBrains } from "./brain/index.ts"
import { CORE_DIR, paths, type BrainHarness } from "./config.ts"
import { probeServer, redactSpec, redactValue, resolveSpec, transportOf } from "./mcp/config.ts"
import { appliesNote, checkValue, describeSettings, getKey, SETTINGS } from "./settings.ts"
import { installCommandLine, installOf, readCheck, startDetached, updateArgs } from "./updates.ts"
import { oneLine, truncate } from "./inbox.ts"
import type { Job, JobAgent } from "./jobs.ts"
import type { Assistant } from "./assistant.ts"
import { runCli, type RunResult } from "./proc.ts"
import { formatSkill, skillSlug, splitCommand } from "./skills.ts"
import { launchedId } from "./t3.ts"
import { describeVoices, fetchVoices, pickVoice } from "./voices.ts"

/**
 * What to say when T3 refuses an action for its access level: plainly, with
 * the one thing Shawn can do, never "I can't".
 */
export function t3Refusal(assistant: Assistant, err: Error & { code?: string }): string {
  const modeRefused = err.code === "runtime_mode_escalation_denied" || err.code === "interaction_mode_escalation_denied"
  if (!modeRefused) return `T3 refused: ${truncate(err.message, 400)}`
  if (assistant.t3.mcpAccess !== "full-access") {
    return `T3 refused because your T3 session is only approval-required: getting full access failed (${truncate(assistant.t3.mcpGrantError ?? "unknown reason", 200)}). Try t3_access with retry: true once. If that fails too, tell Shawn plainly in one sentence: T3 Code must be running on this machine with its t3 command working, and then he can say "retry T3 access".`
  }
  if (/Linked environment/i.test(err.message)) {
    return `T3 refused: ${truncate(err.message, 300)} Tell Shawn plainly: that machine was linked with less than full access; to fix it he runs "t3 pair" on that machine and then "t3 environment link <its address> --pairing-code <the code> --access full-access" here (or links it again with full access in T3's Settings, Sharing and access). Offer to queue the message meanwhile (t3_send with queue).`
  }
  return `T3 refused: ${truncate(err.message, 400)} Tell Shawn in one sentence what it said.`
}

/** The brief for a setup job: install, configure, verify, then write the skill file. */
export function setupBrief(goal: string, slug: string, file: string, details: string): string {
  const example = formatSkill({
    name: slug,
    description: "One sentence: what this lets the voice assistant do.",
    commands: ["program-name"],
    body: "- What it's for, and when to use it.\n- Exact commands, one per line, with what each prints (read-only ones first).\n- Where its config and auth live, and how to refresh a login.",
  })
  return `You are setting something up for Shawn's voice assistant (Assistant, "Vera") on this Windows machine, so she can use it from now on.

Goal: ${goal}
${details ? `Details from Shawn: ${details}\n` : ""}
Do this:
1. Work out what's needed. Shawn's own tools are on his GitHub under bentsignal (gh repo list bentsignal; gh repo view bentsignal/<name> for the README); use those when the goal names one of his.
2. Install and configure it so it works non-interactively from a plain command line (a CLI on PATH, or an absolute path to one). Prefer read-only access unless the goal needs more. Store secrets where the tool itself expects them, never in the skill file.
3. Check that it works with a harmless, read-only command.
4. Write the skill file ${file} (UTF-8), in exactly this shape:

${example}
"commands" lists the programs (names on PATH, or absolute paths) she may run for this skill, comma separated. She runs them without a shell, so no pipes, redirects or &&; if a task needs those, wrap it in a small script and list that script's runner (for example powershell with -File and the script's path in the body).
5. If something only Shawn can do blocks you (a login in a browser, an API key, pressing a button on a device), still write the skill with what works so far plus a line "Needs Shawn:" saying exactly what he must do, and stop.

Reply in two short sentences: what works now, and anything Shawn must do.`
}

function steerNote(assistant: Assistant): string {
  return assistant.t3.mcpAccess === "full-access"
    ? "T3 refused to let you steer that thread; it gets the message after its current turn."
    : "your T3 session is only approval-required (try t3_access with retry), so it waits for the current turn."
}

/** runCli, but a program installed after Core started is found too (PATH is reread once). */
async function runFresh(name: string, args: string[], opts: { input?: string; cwd?: string; timeoutMs?: number }): Promise<RunResult> {
  try {
    return await runCli(name, args, opts)
  } catch (err) {
    if (!/not found on PATH/.test((err as Error).message) || process.platform !== "win32") throw err
    const r = await runCli("powershell", [
      "-NoProfile",
      "-Command",
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    ]).catch(() => null)
    const fresh = r?.stdout.trim()
    if (!fresh) throw err
    const seen = new Set<string>()
    process.env.PATH = [...(process.env.PATH ?? "").split(";"), ...fresh.split(";")]
      .filter((d) => d && !seen.has(d.toLowerCase()) && seen.add(d.toLowerCase()))
      .join(";")
    return runCli(name, args, opts)
  }
}

/** Daemon side of the Assistant MCP tools (see src/mcp/defs.ts for the schemas). */
export type ToolHandler = (assistant: Assistant, args: any) => Promise<string> | string

function need(args: any, key: string): string {
  const v = args?.[key]
  if (typeof v !== "string" || !v.trim()) throw new Error(`missing ${key}`)
  return v
}

function describeJob(job: Job, full = false): string {
  const secs = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000)
  const head = `${job.id} (${job.agent}, ${job.status}, ${secs}s): ${truncate(oneLine(job.task), 120)}`
  if (job.status === "running") return head + (job.progress ? `\n  now: ${truncate(oneLine(job.progress), 200)}` : "")
  const body = job.status === "done" ? (job.result ?? "(no output)") : (job.error ?? job.status)
  return `${head}\n${full ? body : truncate(body, 400)}`
}

async function ask(assistant: Assistant, agent: JobAgent, args: any): Promise<string> {
  const task = need(args, "task")
  const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : assistant.config.jobs.defaultCwd
  const turn = assistant.currentTurnId
  const job = assistant.jobs.start(agent, task, cwd)
  if (!args.wait) return `Started ${agent} job ${job.id} in the background. Shawn gets a chime and an inbox item when it's done; no need to wait.`
  const done = await assistant.jobs.wait(job.id, assistant.config.jobs.waitTimeoutSeconds * 1000)
  if (done.status === "running") {
    return `${job.id} is still running after ${assistant.config.jobs.waitTimeoutSeconds}s; it continues in the background and will chime when done.`
  }
  // Only skip the inbox if the turn that asked is still there to hear the answer
  // (not interrupted by "stop" in the meantime).
  if (assistant.currentTurnId === turn && turn !== null) assistant.markJobSync(job.id)
  return describeJob(done, true)
}

async function resolveThreadTitle(assistant: Assistant, id: string): Promise<string> {
  const row = (await assistant.t3.threads()).find((t) => t.id === id)
  return row?.title ?? id
}

/** A linked machine's environment id from the tool's args (`environmentId`, or the older `environment`). */
export function envArg(args: any): string | undefined {
  for (const k of ["environmentId", "environment"]) {
    const v = args?.[k]
    if (typeof v === "string" && v.trim()) return v.trim()
  }
  return undefined
}

/** How a delivered message went, for her to say. */
export function deliveryWords(delivery: string): string {
  return delivery === "steered"
    ? "Steered into its running turn"
    : delivery === "queued"
      ? "Queued after its current turn"
      : delivery === "started"
        ? "Started a new turn with it"
        : delivery === "restarted"
          ? "Restarted its turn with it"
          : "Sent"
}

/** Watches a thread Vera just started or sent to; says why if it can't. */
async function autoWatch(assistant: Assistant, threadId: string, environmentId?: string): Promise<string> {
  try {
    await assistant.watcher.ensure(threadId, environmentId)
    return "watching it"
  } catch (err) {
    assistant.log(`[t3] couldn't watch ${threadId}: ${(err as Error).message}`)
    return `but couldn't watch it (${truncate((err as Error).message, 200)}), so tell Shawn there'll be no chime when it's done`
  }
}

export const HANDLERS: Record<string, ToolHandler> = {
  speak(assistant, args) {
    const text = need(args, "text")
    const said = assistant.say(text, { fromBrain: true })
    if (said === false) return "Not spoken: Shawn talked over you or said stop. Say nothing more this turn."
    if (said === "skipped") return `Not spoken: it only acknowledged, and Core had already said "${assistant.currentTurn?.ack}" for you. Say the answer itself.`
    return "Speaking." + assistant.takeAckNote()
  },

  show(assistant, args) {
    const card = assistant.addCard(need(args, "title"), String(args.markdown ?? ""))
    return `Showing card ${card.id} in a popup. Close it with hide when he's done with it.`
  },

  hide(assistant, args) {
    const id = typeof args?.card_id === "string" && args.card_id.trim() ? args.card_id.trim() : undefined
    const closed = assistant.hideCard(id)
    if (!closed.length) return id ? `Card ${id} isn't open.` : "Nothing is showing."
    return `Closed ${closed.join(", ")}.`
  },

  set_volume(assistant, args) {
    const level = typeof args?.level === "number" ? args.level : typeof args?.level === "string" && args.level.trim() ? Number(args.level) : undefined
    const relative = args?.relative === "quieter" || args?.relative === "louder" ? args.relative : undefined
    const { from, to } = assistant.setVolume({ level, relative, a_lot: !!args?.a_lot })
    const pct = (n: number) => `${Math.round(n * 100)}%`
    return `Your voice volume is now ${pct(to)} (was ${pct(from)}). The computer's volume is unchanged.`
  },

  ask_claude: (assistant, args) => ask(assistant, "claude", args),
  ask_codex: (assistant, args) => ask(assistant, "codex", args),
  ask_grok: (assistant, args) => ask(assistant, "grok", args),

  job_status(assistant, args) {
    if (typeof args?.id === "string" && args.id) {
      const job = assistant.jobs.get(args.id)
      if (!job) throw new Error(`no job ${args.id}`)
      return describeJob(job, true)
    }
    const jobs = assistant.jobs.list(10)
    return jobs.length ? jobs.map((j) => describeJob(j)).join("\n\n") : "No jobs yet."
  },

  cancel_job(assistant, args) {
    const job = assistant.jobs.cancel(need(args, "id"))
    return `${job.id} is ${job.status}.`
  },

  inbox(assistant, args) {
    const items = args?.all ? assistant.inbox.items : assistant.inbox.unread()
    if (!items.length) return "The inbox is empty."
    if (args?.mark_read !== false) assistant.inbox.markRead(items.map((i) => i.id))
    return items
      .slice(-15)
      .map((i) => {
        const ago = Math.round((Date.now() - i.createdAt) / 60000)
        return `[${i.id}] ${i.title} (${ago} min ago${i.ref ? `, ref ${i.ref}` : ""}):\n${truncate(i.summary, 1500)}`
      })
      .join("\n\n")
  },

  async t3_environments(assistant) {
    const envs = await assistant.t3.environments()
    return truncate(`Your T3 access here: ${assistant.t3.mcpAccess}. This machine is environment ${envs.environmentId}.
${JSON.stringify(envs, null, 1)}`, 4000)
  },

  async t3_access(assistant, args) {
    if (args?.retry) assistant.t3.forgetMcpSession()
    await assistant.t3.environments().catch(() => {})
    if (assistant.t3.mcpAccess === "full-access") return "Your T3 access is full-access: you can do anything Shawn can in T3 Code on this machine (and on linked machines, up to each link's access)."
    return `Your T3 access is ${assistant.t3.mcpAccess}; getting full access failed: ${truncate(assistant.t3.mcpGrantError ?? "unknown", 300)}. Tell Shawn plainly in one sentence: T3 Code must be running here with its t3 command working; then he says "retry T3 access".`
  },

  async send_feedback(assistant, args) {
    const message = need(args, "message")
    const target = assistant.config.t3.orchestratorThread
    try {
      const sent = await assistant.t3.send(target.threadId, message, { mode: "auto", environmentId: target.environmentId })
      const how = deliveryWords(sent.delivery).toLowerCase()
      return `Feedback to the orchestrator: ${how}${sent.steerRefused ? ` (queued, not steered: ${steerNote(assistant)})` : ""}. Confirm in a few words.`
    } catch (err) {
      const code = (err as any).code as string | undefined
      if (code?.endsWith("_escalation_denied")) return t3Refusal(assistant, err as Error & { code?: string })
      // Not a fault of hers: she says so briefly, nothing chimes or turns red.
      return `Couldn't reach the orchestrator (${truncate((err as Error).message, 200)}). Tell Shawn so in one short sentence; don't retry.`
    }
  },

  async t3_list_projects(assistant, args) {
    if (typeof args?.environment === "string" && args.environment) {
      return truncate(JSON.stringify(await assistant.t3.remoteProjects(args.environment)), 4000)
    }
    const projects = await assistant.t3.projects()
    return projects.map((p) => `${p.title} — id ${p.id} — ${p.workspaceRoot}`).join("\n")
  },

  async t3_list_threads(assistant, args) {
    if (typeof args?.environment === "string" && args.environment) {
      return truncate(JSON.stringify(await assistant.t3.remoteThreads(args.environment, Number(args?.limit) || 10)), 6000)
    }
    const rows = await assistant.t3.listThreads(args?.project || undefined, Number(args?.limit) || 10)
    if (!rows.length) return "No threads."
    return rows
      .map((t) => `${t.title} — ${t.waiting ? "waiting for input" : t.status} — project ${t.project} — id ${t.id} — updated ${t.updatedAt}`)
      .join("\n")
  },

  async t3_read_thread(assistant, args) {
    if (typeof args?.environment === "string" && args.environment) {
      const read = await assistant.t3.remoteRead(args.environment, need(args, "thread"), Number(args?.messages) || 4)
      return truncate(JSON.stringify(read), 8000)
    }
    const shown = await assistant.t3.show(need(args, "thread"), Number(args?.messages) || 4)
    const t = shown.thread ?? {}
    const msgs = (shown.messages ?? []).map((m: any) => `${m.role}: ${truncate(m.text ?? "", 2500)}`).join("\n\n")
    return `"${t.title}" — ${t.status}${t.pendingRequestCount ? `, ${t.pendingRequestCount} pending request(s)` : ""}\n\n${msgs || "(no messages)"}`
  },

  async t3_start_thread(assistant, args) {
    const environmentId = envArg(args)
    const message = need(args, "message")
    const project = await assistant.t3.findProject(need(args, "project"), environmentId)
    let id: string | undefined
    if (environmentId) {
      try {
        const res = await assistant.t3.launch(environmentId, project, message, { title: args.title, model: args.model })
        id = res.threadId
        if (!id) return `Started, but T3 didn't return an id: ${truncate(JSON.stringify(res.raw), 300)}`
      } catch (err) {
        if (!(err as any).code) throw err
        return t3Refusal(assistant, err as Error & { code?: string })
      }
    } else {
      const res = await assistant.t3.start(project.id, message, { title: args.title })
      id = res.threadId ?? res.thread?.threadId ?? res.id
      if (!id) return `Started, but T3 didn't return an id: ${truncate(JSON.stringify(res), 300)}`
    }
    const where = environmentId ? ` on ${environmentId}` : ""
    if (args.watch === false) return `Started thread ${id} in ${project.title}${where}.`
    return `Started thread ${id} in ${project.title}${where}, ${await autoWatch(assistant, id!, environmentId)}.`
  },

  async t3_send(assistant, args) {
    const thread = need(args, "thread")
    const environmentId = envArg(args)
    let sent
    try {
      sent = await assistant.t3.send(thread, need(args, "message"), { mode: args.queue === true ? "queue" : "auto", environmentId })
    } catch (err) {
      if (!(err as any).code) throw err
      return t3Refusal(assistant, err as Error & { code?: string })
    }
    const note = sent.steerRefused ? ` Queued rather than steered: ${steerNote(assistant)}` : ""
    const watching = await autoWatch(assistant, thread, environmentId)
    const name = environmentId ? `thread ${thread} on ${environmentId}` : `"${await resolveThreadTitle(assistant, thread).catch(() => thread)}"`
    return `${deliveryWords(sent.delivery)} (${name}); ${watching}.${note}`
  },

  async t3_watch(assistant, args) {
    const thread = need(args, "thread")
    const environmentId = envArg(args)
    if (args.stop) return assistant.watcher.remove(thread, environmentId) ? "Stopped watching." : "Wasn't watching that thread."
    const w = await assistant.watcher.add(thread, { environmentId })
    return `Watching "${w.title}"${w.environmentId ? ` on ${w.environmentId}` : ""} (now ${w.lastStatus}).`
  },

  async t3_tools(assistant, args) {
    const tools = await assistant.t3.mcpList()
    const one = typeof args?.name === "string" && args.name.trim() ? args.name.trim() : ""
    if (one) {
      const t = tools.find((x) => x.name === one)
      if (!t) throw new Error(`T3 has no tool ${one}. It has: ${tools.map((x) => x.name).join(", ")}`)
      return truncate(`${t.name}: ${t.description ?? ""}\n\nInput schema: ${JSON.stringify(t.inputSchema)}`, 6000)
    }
    return tools.map((t) => `${t.name}: ${truncate(oneLine(t.description ?? ""), 160)}`).join("\n")
  },

  async t3_tool(assistant, args) {
    const name = need(args, "name")
    let input = args.args ?? {}
    if (typeof input === "string") input = input.trim() ? JSON.parse(input) : {}
    if (typeof input !== "object" || Array.isArray(input)) throw new Error("args must be an object")
    try {
      const result = await assistant.t3.mcpTool(name, input)
      let watched = ""
      // A thread she launches is watched like one t3_start_thread starts.
      if (name === "t3_thread_launch" && (input.message || input.attachments)) {
        const id = launchedId(result)
        if (id) watched = `\n(${await autoWatch(assistant, id, envArg(input))})`
      }
      return truncate(JSON.stringify(result), 8000) + watched
    } catch (err) {
      return t3Refusal(assistant, err as Error & { code?: string })
    }
  },

  async t3_reauthorize(assistant) {
    const r = await assistant.t3.reauthorize()
    if (r.access === "full-access") return `T3 access repaired: full-access (t3 command: ${r.cli}). Confirm in a few words.`
    if (r.access === "approval-required") {
      return `Your T3 access is only approval-required now: the full-access grant failed (${truncate(r.error ?? "unknown", 300)}). Tell Shawn that in one plain sentence.`
    }
    return `T3 access couldn't be repaired: ${truncate(r.error ?? "unknown", 400)}. Tell Shawn exactly that in one plain sentence${
      /isn't on this machine/.test(r.error ?? "") ? " (he can tell you where t3.cmd is, and you set config t3.cliPath)" : ""
    }.`
  },

  mcp_list(assistant) {
    const all = assistant.mcp.list()
    if (!all.length) return "You have no MCP servers of your own yet (mcp.json is empty). mcp_add adds one."
    return all
      .map(({ name, spec, error }) => {
        if (!spec) return `${name}: broken entry (${error})`
        const what = spec.url ? `${transportOf(spec)} ${spec.url}` : `stdio ${[spec.command, ...(spec.args ?? [])].join(" ")}`
        const state = assistant.mcpState.get(name)
        const extras = [
          spec.env ? `env ${JSON.stringify(redactSpec(spec).env)}` : "",
          spec.headers ? `headers ${JSON.stringify(redactSpec(spec).headers)}` : "",
        ].filter(Boolean)
        return `${name}${spec.disabled ? " (disabled)" : ""}: ${truncate(what, 200)}${extras.length ? `, ${extras.join(", ")}` : ""}${
          spec.description ? ` — ${spec.description}` : ""
        }${state && !spec.disabled ? ` [${state.status}${state.error ? `: ${truncate(state.error, 160)}` : ""}]` : ""}`
      })
      .join("\n")
  },

  mcp_add(assistant, args) {
    const spec: Record<string, unknown> = {}
    for (const k of ["type", "command", "args", "env", "url", "headers", "description"]) if (args[k] !== undefined && args[k] !== null) spec[k] = args[k]
    if (typeof spec.args === "string") spec.args = splitCommand(spec.args)
    for (const k of ["env", "headers"]) if (typeof spec[k] === "string") spec[k] = JSON.parse(spec[k] as string)
    const { name, created } = assistant.mcp.add(need(args, "name"), spec)
    return `${created ? "Added" : "Replaced"} the MCP server ${name}. Its tools are yours from your next turn (as mcp__${name}__<tool>). Test it now with mcp_test, then save a skill saying what it's for. Confirm in a few words.`
  },

  mcp_remove(assistant, args) {
    assistant.mcp.remove(need(args, "name"))
    assistant.mcpState.delete(args.name)
    return `Removed the MCP server ${args.name}; its tools go from your next turn. If a skill mentions it, update or remove that skill. Confirm in a few words.`
  },

  mcp_enable(assistant, args) {
    const r = assistant.mcp.setEnabled(need(args, "name"), true)
    return r.changed ? `${r.name} is on again from your next turn.` : `${r.name} was already on.`
  },

  mcp_disable(assistant, args) {
    const r = assistant.mcp.setEnabled(need(args, "name"), false)
    return r.changed ? `${r.name} is off from your next turn (kept in mcp.json).` : `${r.name} was already off.`
  },

  async mcp_test(assistant, args) {
    const name = need(args, "name")
    const spec = assistant.mcp.get(name)
    if (!spec) return `No MCP server called ${name}. Yours: ${assistant.mcp.list().map((s) => s.name).join(", ") || "none"}.`
    let server
    try {
      server = resolveSpec(spec)
    } catch (err) {
      return `${name} can't start: ${(err as Error).message}. Tell Shawn in one sentence what's needed.`
    }
    const r = await probeServer(server)
    if (!r.ok) {
      return `${name} failed: ${truncate(r.error ?? "unknown", 300)}${r.stderr ? `\nIt printed:\n${truncate(r.stderr, 600)}` : ""}`
    }
    const tools = r.tools.map((t) => `- ${t.name}${t.description ? `: ${truncate(oneLine(t.description), 120)}` : ""}`).join("\n")
    return `${name} works${spec.disabled ? " (but it's disabled: mcp_enable turns it on)" : ""}: ${r.tools.length} tool(s)${r.error ? ` (${r.error})` : ""}. From your next turn they're mcp__${name}__<tool>.\n${tools}`
  },

  config_get(assistant, args) {
    const key = typeof args?.key === "string" ? args.key.trim() : ""
    if (!key) return describeSettings(assistant.config)
    const def = SETTINGS[key]
    if (!def) return `${key} isn't one of your settings. They are:\n${describeSettings(assistant.config)}`
    return `${key} = ${JSON.stringify(getKey(assistant.config, key) ?? null)} (${def.about}) ${appliesNote(def.applies)}`
  },

  config_set(assistant, args) {
    const key = need(args, "key").trim()
    const value = checkValue(key, args.value)
    const before = getKey(assistant.config, key)
    if (JSON.stringify(before ?? null) === JSON.stringify(value)) return `${key} is already ${JSON.stringify(value)}.`
    assistant.setConfigKey(key, value)
    return `Set ${key} to ${JSON.stringify(value)} (was ${JSON.stringify(before ?? null)}). ${appliesNote(SETTINGS[key].applies)}`
  },

  update_status(assistant) {
    const inst = installOf(CORE_DIR)
    if (!inst.installed) return `Updates aren't available here: ${inst.why}. Say so in one sentence.`
    const configured = getKey(assistant.config, "app.updates.channel")
    const channel = configured === "stable" || configured === "nightly" ? configured : inst.channel
    return `Running Assistant ${inst.label} (${inst.channel} build), updating from ${channel === "nightly" ? "Nightly" : "Stable"}${
      configured ? "" : " (the build's own channel)"
    }. Say the version the way a person would, briefly.`
  },

  async update_check(_assistant, args) {
    const inst = installOf(CORE_DIR)
    if (!inst.installed) return `Updates aren't available here: ${inst.why}. Say so in one sentence.`
    const r = await runCli(inst.launcher, updateArgs({ channel: args?.channel }), { timeoutMs: 60_000 })
    const out = `${r.stdout}\n${r.stderr}`.trim()
    if (r.code !== 0) return `The check failed (exit ${r.code}): ${truncate(oneLine(out), 400)}`
    const c = readCheck(out)
    if (c.none) return "That channel has no release yet."
    if (c.upToDate) return `Up to date: ${inst.label} is the newest${args?.channel ? ` on ${args.channel}` : ""}.`
    if (c.available) return `An update is available: ${c.latest} (running ${inst.label}). update_install installs it, restarting you; ask Shawn first if he didn't ask to install.`
    return truncate(out, 1000)
  },

  async update_install(assistant, args) {
    const inst = installOf(CORE_DIR)
    if (!inst.installed) return `Updates aren't available here: ${inst.why}. Say so in one sentence.`
    const channel = typeof args?.channel === "string" && args.channel ? args.channel : null
    if (channel) assistant.setConfigKey("app.updates.channel", checkValue("app.updates.channel", channel))
    const check = await runCli(inst.launcher, updateArgs({ channel }), { timeoutMs: 60_000 })
    const c = readCheck(`${check.stdout}\n${check.stderr}`)
    if (c.upToDate) return `Nothing to install: ${inst.label} is already the newest. Say so.`
    if (c.none) return "That channel has no release yet. Say so."
    const log = join(paths.logs, "update-voice.log")
    await startDetached(installCommandLine(inst.launcher, updateArgs({ install: true, channel }), log))
    assistant.log(`update: installing ${c.latest ?? "the update"} (log ${log})`)
    return `Installing ${c.latest ?? "the update"}: it downloads, then Assistant restarts into it (about a minute). If you haven't said so yet, speak one short line now; then stop.`
  },

  async update_channel(assistant, args) {
    const inst = installOf(CORE_DIR)
    const channel = checkValue("app.updates.channel", need(args, "channel")) as string
    assistant.setConfigKey("app.updates.channel", channel)
    if (!inst.installed) return `Saved the channel as ${channel}, but updates aren't available here: ${inst.why}.`
    const r = await runCli(inst.launcher, updateArgs({ channel }), { timeoutMs: 60_000 }).catch(() => null)
    const c = r ? readCheck(`${r.stdout}\n${r.stderr}`) : null
    const news = c?.upToDate ? " It's already on its newest release." : c?.available ? ` ${c.latest} is available there: update_install installs it.` : ""
    return `Updates now follow ${channel === "nightly" ? "Nightly" : "Stable"}.${news} Confirm in a few words.`
  },

  skill_list(assistant) {
    const all = assistant.skills.list()
    if (!all.length) return "No skills yet."
    return all.map((s) => `${s.name}: ${s.description}${s.commands.length ? ` (runs ${s.commands.join(", ")})` : ""}`).join("\n")
  },

  skill_read(assistant, args) {
    const s = assistant.skills.get(need(args, "name"))
    if (!s) return `No skill called ${args.name}. Skills: ${assistant.skills.list().map((x) => x.name).join(", ") || "none"}.`
    return `${s.name} (${s.file})\n${s.description}\ncommands: ${s.commands.join(", ") || "none"}\n\n${s.body}`
  },

  skill_save(assistant, args) {
    const commands = Array.isArray(args.commands)
      ? args.commands.map(String)
      : typeof args.commands === "string"
        ? args.commands.split(/[,\s]+/).filter(Boolean)
        : undefined
    const { skill, created } = assistant.skills.save({
      name: need(args, "name"),
      description: typeof args.description === "string" ? args.description : undefined,
      body: typeof args.body === "string" ? args.body : undefined,
      commands,
    })
    return `${created ? "Saved the new" : "Updated the"} skill ${skill.name}. It's in your prompt from the next turn${
      skill.commands.length ? `, and run_command may run ${skill.commands.join(", ")} now` : ""
    }. Confirm in a few words.`
  },

  skill_remove(assistant, args) {
    const s = assistant.skills.remove(need(args, "name"))
    return `Removed the skill ${s.name} (kept in skills/.removed). Confirm in a few words.`
  },

  skill_setup(assistant, args) {
    const goal = need(args, "goal")
    const slug = skillSlug(typeof args.name === "string" && args.name.trim() ? args.name : goal)
    const file = join(assistant.skills.dir, `${slug}.md`)
    const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : assistant.config.jobs.defaultCwd
    const brief = setupBrief(goal, slug, file, typeof args.details === "string" ? args.details : "")
    const job = assistant.jobs.start("claude", brief, cwd)
    return `Started setup job ${job.id} for "${slug}". It installs and checks it, then writes the skill itself; Shawn gets a chime when it's done, and you have the skill from the next turn after. Say a few words ("On it, I'll set that up.") and stop.`
  },

  async run_command(assistant, args) {
    const argv = Array.isArray(args.argv) ? args.argv.map(String) : splitCommand(need(args, "command"))
    if (!argv.length) throw new Error("empty command")
    const skill = assistant.skills.allowing(argv[0])
    if (!skill) {
      const known = assistant.skills
        .list()
        .flatMap((s) => s.commands)
        .join(", ")
      return `No skill lets you run ${argv[0]} (allowed: ${known || "none"}). If it's a program you set up, add it to that skill's commands with skill_save; otherwise delegate it (ask_claude).`
    }
    const timeoutMs = Math.min(Math.max(Number(args.timeout_seconds) || 60, 5), 300) * 1000
    const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : undefined
    const r = await runFresh(argv[0], argv.slice(1), { input: typeof args.stdin === "string" ? args.stdin : undefined, cwd, timeoutMs })
    const head = r.timedOut ? `Timed out after ${timeoutMs / 1000}s` : `Exit ${r.code}`
    return truncate(`${head} (${skill.name}).\n${r.stdout.trim() || "(no output)"}${r.stderr.trim() ? `\n[stderr]\n${r.stderr.trim()}` : ""}`, 8000)
  },

  read_system_prompt(assistant) {
    return assistant.prompt.read()
  },

  edit_system_prompt(assistant, args) {
    const { backup } = assistant.prompt.edit(args ?? {})
    return `Saved. The old version is backed up as ${backup}. It applies from the next turn.`
  },

  revert_system_prompt(assistant) {
    const { restored } = assistant.prompt.revert()
    return `Reverted to the version from before the last edit (${restored}). It applies from the next turn.`
  },

  switch_persona(assistant, args) {
    const p = assistant.switchPersona(need(args, "name"), "asked")
    return `${p.name} is answering now, in its own voice${p.style ? ` (${p.style})` : ""}, until Shawn names or asks for another. Speak as ${p.name}.`
  },

  async set_name(assistant, args) {
    const name = need(args, "name")
    if (args.remove) {
      const p = assistant.removePersona(name)
      return `Removed ${p.name}; "${p.name}" no longer wakes you. Your names: ${assistant.personas.map((x) => x.name).join(", ")}.`
    }
    if (args.add) {
      const asked = typeof args.voice === "string" && args.voice.trim() ? args.voice.trim() : ""
      const list = await fetchVoices(assistant.voicePort).catch(() => null)
      let voice = asked.toLowerCase() || assistant.persona.voice
      if (list && asked) voice = pickVoice(list.voices, asked).id
      else if (list) {
        // No voice asked for: one of the same name, else the current persona's.
        try {
          voice = pickVoice(list.voices, name).id
        } catch {}
      }
      const p = assistant.addPersona(name, voice, typeof args.style === "string" ? args.style : undefined)
      return `Added ${p.name} (voice ${p.voice}). "${p.name}" wakes you now, and you answer in that voice. Confirm in a few words.`
    }
    const { from, to } = assistant.setName(name, typeof args.from === "string" && args.from.trim() ? args.from : undefined)
    if (from === to) return `That persona is already called ${to}.`
    return `Done: ${from} is ${to} now. Shawn wakes that persona with "${to}" from now on, and the next turn's prompt uses the new name. Confirm in a few words, as ${to}.`
  },

  async set_voice(assistant, args) {
    const wanted = typeof args.voice === "string" ? args.voice.trim() : ""
    const personaName = typeof args.persona === "string" ? args.persona.trim() : ""
    if (/^(default|persona|personas|own|normal|none|reset)$/i.test(wanted) && !personaName) {
      if (!assistant.voiceOverride) return "There's no override: each persona already speaks in its own voice."
      assistant.setVoice(null)
      return `Override cleared: each persona speaks in its own voice again (you're ${assistant.persona.name}, voice ${assistant.persona.voice}). Say a few words.`
    }
    const list = await fetchVoices(assistant.voicePort)
    const current = assistant.currentVoice ?? list.default
    const personaLines = assistant.personas.map((p) => `- ${p.name}: ${p.voice}`).join("\n")
    if (!wanted) {
      const override = assistant.voiceOverride
      return `Voices (* is the one you speak in now):
${describeVoices(list.voices, current)}

Personas and their voices:
${personaLines}${override ? `\n\nOverride on: every persona speaks as ${override} until set_voice default.` : ""}`
    }
    if (personaName) {
      const v = pickVoice(list.voices, wanted, assistant.findPersonaVoice(personaName))
      const p = assistant.setPersonaVoice(personaName, v.id)
      const note = assistant.voiceOverride ? ` (an override, ${assistant.voiceOverride}, is on; set_voice default clears it)` : ""
      return `${p.name} now speaks as ${v.name}${note}. Confirm in a few words.`
    }
    const v = pickVoice(list.voices, wanted, current)
    if (v.id === current) return `You already speak as ${v.name}.`
    assistant.setVoice(v.id)
    return `Switched to ${v.name} (an override for every persona until 'default'). Your next speak line, this turn included, is in the new voice; say a few words in it.`
  },

  set_brain(assistant, args) {
    const harness = (typeof args.harness === "string" && args.harness.trim() ? args.harness.trim() : assistant.config.brain.harness) as BrainHarness
    if (!availableBrains().includes(harness)) throw new Error(`unknown harness ${harness}; have ${availableBrains().join(", ")}`)
    const label = assistant.setBrain(harness, args.model, args.effort)
    return `Switching to ${label} from the next turn.`
  },
}

/** A tool's args as the log shows them: an MCP server's env and header values that aren't references are hidden. */
export function logged(name: string, args: any): unknown {
  if (name === "mcp_add" && args && typeof args === "object") {
    const hide = (o: unknown) =>
      o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, redactValue(String(v))])) : o === undefined ? undefined : "‹hidden›"
    return { ...args, ...(args.env !== undefined ? { env: hide(args.env) } : {}), ...(args.headers !== undefined ? { headers: hide(args.headers) } : {}) }
  }
  return args
}

export async function runTool(assistant: Assistant, name: string, args: unknown): Promise<string> {
  const h = HANDLERS[name]
  if (!h) throw new Error(`unknown tool ${name}`)
  if (name !== "speak") assistant.beforeTool(name) // acknowledges first, so it plays as the tool starts
  assistant.log(`tool ${name} ${truncate(oneLine(JSON.stringify(logged(name, args ?? {}))), 300)}`)
  assistant.currentTurn?.tools.push(name)
  let result = await h(assistant, args ?? {})
  if (name !== "speak") {
    assistant.log(`tool ${name} -> ${truncate(oneLine(result), 240)}`)
    result += assistant.takeAckNote()
  }
  return result
}
