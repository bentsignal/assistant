import { availableBrains } from "./brain/index.ts"
import type { BrainHarness } from "./config.ts"
import { oneLine, truncate } from "./inbox.ts"
import type { Job, JobAgent } from "./jobs.ts"
import type { Vera } from "./vera.ts"

/** Daemon side of the Vera MCP tools (see src/mcp/defs.ts for the schemas). */
export type ToolHandler = (vera: Vera, args: any) => Promise<string> | string

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

async function ask(vera: Vera, agent: JobAgent, args: any): Promise<string> {
  const task = need(args, "task")
  const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : vera.config.jobs.defaultCwd
  const job = vera.jobs.start(agent, task, cwd)
  if (!args.wait) return `Started ${agent} job ${job.id} in the background. Shawn gets a chime and an inbox item when it's done; no need to wait.`
  const done = await vera.jobs.wait(job.id, vera.config.jobs.waitTimeoutSeconds * 1000)
  if (done.status === "running") {
    return `${job.id} is still running after ${vera.config.jobs.waitTimeoutSeconds}s; it continues in the background and will chime when done.`
  }
  vera.markJobSync(job.id)
  return describeJob(done, true)
}

async function resolveThreadTitle(vera: Vera, id: string): Promise<string> {
  const row = (await vera.t3.threads()).find((t) => t.id === id)
  return row?.title ?? id
}

export const HANDLERS: Record<string, ToolHandler> = {
  speak(vera, args) {
    const text = need(args, "text")
    vera.say(text)
    return "Speaking."
  },

  show(vera, args) {
    const card = vera.addCard(need(args, "title"), String(args.markdown ?? ""))
    return `Shown on the panel (card ${card.id}).`
  },

  ask_claude: (vera, args) => ask(vera, "claude", args),
  ask_codex: (vera, args) => ask(vera, "codex", args),
  ask_grok: (vera, args) => ask(vera, "grok", args),

  job_status(vera, args) {
    if (typeof args?.id === "string" && args.id) {
      const job = vera.jobs.get(args.id)
      if (!job) throw new Error(`no job ${args.id}`)
      return describeJob(job, true)
    }
    const jobs = vera.jobs.list(10)
    return jobs.length ? jobs.map((j) => describeJob(j)).join("\n\n") : "No jobs yet."
  },

  cancel_job(vera, args) {
    const job = vera.jobs.cancel(need(args, "id"))
    return `${job.id} is ${job.status}.`
  },

  inbox(vera, args) {
    const items = args?.all ? vera.inbox.items : vera.inbox.unread()
    if (!items.length) return "The inbox is empty."
    if (args?.mark_read !== false) vera.inbox.markRead(items.map((i) => i.id))
    return items
      .slice(-15)
      .map((i) => {
        const ago = Math.round((Date.now() - i.createdAt) / 60000)
        return `[${i.id}] ${i.title} (${ago} min ago${i.ref ? `, ref ${i.ref}` : ""}):\n${truncate(i.summary, 1500)}`
      })
      .join("\n\n")
  },

  async t3_list_projects(vera) {
    const projects = await vera.t3.projects()
    return projects.map((p) => `${p.title} — id ${p.id} — ${p.workspaceRoot}`).join("\n")
  },

  async t3_list_threads(vera, args) {
    const rows = await vera.t3.listThreads(args?.project || undefined, Number(args?.limit) || 10)
    if (!rows.length) return "No threads."
    return rows
      .map((t) => `${t.title} — ${t.waiting ? "waiting for input" : t.status} — project ${t.project} — id ${t.id} — updated ${t.updatedAt}`)
      .join("\n")
  },

  async t3_read_thread(vera, args) {
    const shown = await vera.t3.show(need(args, "thread"), Number(args?.messages) || 4)
    const t = shown.thread ?? {}
    const msgs = (shown.messages ?? []).map((m: any) => `${m.role}: ${truncate(m.text ?? "", 2500)}`).join("\n\n")
    return `"${t.title}" — ${t.status}${t.pendingRequestCount ? `, ${t.pendingRequestCount} pending request(s)` : ""}\n\n${msgs || "(no messages)"}`
  },

  async t3_start_thread(vera, args) {
    const project = await vera.t3.findProject(need(args, "project"))
    const res = await vera.t3.start(project.id, need(args, "message"), { title: args.title })
    const id = res.threadId ?? res.thread?.threadId ?? res.id
    if (!id) return `Started, but T3 didn't return an id: ${truncate(JSON.stringify(res), 300)}`
    if (args.watch !== false) await vera.watcher.add(id).catch(() => {})
    return `Started thread ${id} in ${project.title}${args.watch !== false ? ", watching it" : ""}.`
  },

  async t3_send(vera, args) {
    const thread = need(args, "thread")
    await vera.t3.send(thread, need(args, "message"))
    if (!vera.watcher.watches.has(thread)) await vera.watcher.add(thread).catch(() => {})
    else vera.watcher.expectRun(thread)
    return `Sent to "${await resolveThreadTitle(vera, thread)}"; watching for the reply.`
  },

  async t3_watch(vera, args) {
    const thread = need(args, "thread")
    if (args.stop) return vera.watcher.remove(thread) ? "Stopped watching." : "Wasn't watching that thread."
    const w = await vera.watcher.add(thread)
    return `Watching "${w.title}" (now ${w.lastStatus}).`
  },

  read_system_prompt(vera) {
    return vera.prompt.read()
  },

  edit_system_prompt(vera, args) {
    const { backup } = vera.prompt.edit(args ?? {})
    return `Saved. The old version is backed up as ${backup}. It applies from the next turn.`
  },

  revert_system_prompt(vera) {
    const { restored } = vera.prompt.revert()
    return `Reverted to the version from before the last edit (${restored}). It applies from the next turn.`
  },

  set_brain(vera, args) {
    const harness = need(args, "harness") as BrainHarness
    if (!availableBrains().includes(harness)) throw new Error(`unknown harness ${harness}; have ${availableBrains().join(", ")}`)
    const label = vera.setBrain(harness, args.model, args.effort)
    return `Switching to ${label} from the next turn.`
  },
}

export async function runTool(vera: Vera, name: string, args: unknown): Promise<string> {
  const h = HANDLERS[name]
  if (!h) throw new Error(`unknown tool ${name}`)
  vera.log(`tool ${name} ${truncate(oneLine(JSON.stringify(args ?? {})), 300)}`)
  return h(vera, args ?? {})
}
