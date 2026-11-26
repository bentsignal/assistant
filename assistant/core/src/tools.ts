import { availableBrains } from "./brain/index.ts"
import type { BrainHarness } from "./config.ts"
import { oneLine, truncate } from "./inbox.ts"
import type { Job, JobAgent } from "./jobs.ts"
import type { Assistant } from "./assistant.ts"
import { describeVoices, fetchVoices, pickVoice } from "./voices.ts"

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

export const HANDLERS: Record<string, ToolHandler> = {
  speak(assistant, args) {
    const text = need(args, "text")
    if (!assistant.say(text)) return "Not spoken: Shawn talked over you or said stop. Say nothing more this turn."
    return "Speaking."
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
    return JSON.stringify(await assistant.t3.environments(), null, 1).slice(0, 4000)
  },

  async send_feedback(assistant, args) {
    const message = need(args, "message")
    const target = assistant.config.t3.orchestratorThread
    try {
      const sent = await assistant.t3.send(target.threadId, message, { environmentId: target.environmentId })
      const how = sent.delivery === "steered" ? "steered into its running turn" : sent.delivery === "queued" ? "queued" : "sent"
      return `Feedback ${how} to the orchestrator${sent.steerRefused ? " (T3 doesn't let you steer that thread yet, so it waits for its current turn)" : ""}. Confirm in a few words.`
    } catch (err) {
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
    const project = await assistant.t3.findProject(need(args, "project"))
    const res = await assistant.t3.start(project.id, need(args, "message"), { title: args.title })
    const id = res.threadId ?? res.thread?.threadId ?? res.id
    if (!id) return `Started, but T3 didn't return an id: ${truncate(JSON.stringify(res), 300)}`
    if (args.watch !== false) await assistant.watcher.add(id).catch(() => {})
    return `Started thread ${id} in ${project.title}${args.watch !== false ? ", watching it" : ""}.`
  },

  async t3_send(assistant, args) {
    const thread = need(args, "thread")
    const environmentId = typeof args.environment === "string" && args.environment ? args.environment : undefined
    const sent = await assistant.t3.send(thread, need(args, "message"), { mode: args.queue === true ? "queue" : "steer", environmentId })
    const how0 = sent.delivery === "steered" ? "Steered into its running turn" : sent.delivery === "queued" ? "Queued after its current turn" : "Sent"
    // Threads on another machine aren't watched (the watcher reads this one).
    if (environmentId) return `${how0} (thread ${thread} on ${environmentId}).`
    if (!assistant.watcher.watches.has(thread)) await assistant.watcher.add(thread).catch(() => {})
    else assistant.watcher.expectRun(thread)
    const how =
      sent.delivery === "steered" ? "Steered into its running turn" : sent.delivery === "queued" ? "Queued after its current turn" : "Sent"
    return `${how} ("${await resolveThreadTitle(assistant, thread)}"); watching for the reply.`
  },

  async t3_watch(assistant, args) {
    const thread = need(args, "thread")
    if (args.stop) return assistant.watcher.remove(thread) ? "Stopped watching." : "Wasn't watching that thread."
    const w = await assistant.watcher.add(thread)
    return `Watching "${w.title}" (now ${w.lastStatus}).`
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

export async function runTool(assistant: Assistant, name: string, args: unknown): Promise<string> {
  const h = HANDLERS[name]
  if (!h) throw new Error(`unknown tool ${name}`)
  assistant.log(`tool ${name} ${truncate(oneLine(JSON.stringify(args ?? {})), 300)}`)
  assistant.currentTurn?.tools.push(name)
  return h(assistant, args ?? {})
}
