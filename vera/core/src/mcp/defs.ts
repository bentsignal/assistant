/**
 * The Vera MCP server's tools. The descriptions carry the routing rules, so
 * they hold even if the system prompt is edited. The daemon implements each
 * tool in src/tools.ts; the stdio MCP server only forwards.
 */
export interface ToolDef {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
}

const str = (description: string) => ({ type: "string", description })
const bool = (description: string) => ({ type: "boolean", description })

const askProps = {
  task: str("The full task for the agent, self-contained: it has no access to this conversation."),
  cwd: str("Working folder. Defaults to D:\\dev. Use the project's folder when the task is about one project."),
  wait: bool(
    "true to wait for the answer (quick lookups that Shawn is waiting on, up to ~90 s; if it takes longer it continues in the background). Default false: runs in the background, and Shawn gets a chime and an inbox item when it's done.",
  ),
}

export const TOOLS: ToolDef[] = [
  {
    name: "speak",
    description:
      "Say something out loud. This is the ONLY way Shawn hears you; your plain text output is never spoken. Keep it to one or two short spoken sentences: no markdown, lists, URLs, code, or symbols; say numbers the way a person would. Put anything long or visual in `show` and speak a one-line summary. Call it early in a turn; later calls queue after earlier ones.",
    inputSchema: { type: "object", properties: { text: str("What to say, plain spoken English.") }, required: ["text"] },
  },
  {
    name: "show",
    description:
      "Put a card on Vera's panel (a screen across the kitchen). Use for anything worth seeing rather than hearing: lists, tables, links, code, long answers, recipes. Markdown is fine here. Pair it with a one-line `speak`.",
    inputSchema: {
      type: "object",
      properties: { title: str("Short card title."), markdown: str("Card body in Markdown.") },
      required: ["title", "markdown"],
    },
  },
  {
    name: "ask_claude",
    description:
      "Hand a task to Claude Code (headless, full permissions, in a folder). Use for quick one-off questions about local code or files and small file edits. NOT for real coding work in a project (use t3_start_thread), NOT for using the computer or desktop apps (ask_codex), NOT for X/Twitter (ask_grok). Background by default.",
    inputSchema: { type: "object", properties: askProps, required: ["task"] },
  },
  {
    name: "ask_codex",
    description:
      "Hand a task to Codex (headless, full permissions, with computer-use plugins). Use for USING THE COMPUTER: operating desktop apps, clicking around, browser automation, system settings, anything on screen. OpenAI models are best at computer use. Background by default.",
    inputSchema: { type: "object", properties: askProps, required: ["task"] },
  },
  {
    name: "ask_grok",
    description:
      "Hand a task to Grok (headless, with live X search). Use for searching X/Twitter and for what people are saying right now about something. General web search: use your own web search tool instead. Background by default.",
    inputSchema: { type: "object", properties: askProps, required: ["task"] },
  },
  {
    name: "job_status",
    description: "Status and result of background jobs. Without an id, lists recent jobs. With an id (like j3), returns that job's full result.",
    inputSchema: { type: "object", properties: { id: str("Job id, like j3.") } },
  },
  {
    name: "cancel_job",
    description: "Stop a running background job.",
    inputSchema: { type: "object", properties: { id: str("Job id, like j3.") }, required: ["id"] },
  },
  {
    name: "inbox",
    description:
      "Read the inbox: finished background jobs and T3 threads that finished or need an answer. Use when Shawn asks what's new. Items you read out are marked read.",
    inputSchema: {
      type: "object",
      properties: {
        all: bool("Include items already read (default: unread only)."),
        mark_read: bool("Mark the returned items read (default true)."),
      },
    },
  },
  {
    name: "t3_list_projects",
    description: "List Shawn's T3 Code projects (name, id, folder).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "t3_list_threads",
    description: "List recent T3 Code threads with their status (running, waiting, idle, ...). Optionally for one project (name, id, or folder).",
    inputSchema: {
      type: "object",
      properties: { project: str("Project name, id, or folder. Omit for all projects."), limit: { type: "number", description: "Default 10." } },
    },
  },
  {
    name: "t3_read_thread",
    description: "Read a T3 thread's state and latest messages, for example to relay what an agent asked or reported.",
    inputSchema: {
      type: "object",
      properties: { thread: str("Thread id."), messages: { type: "number", description: "How many latest messages (default 4)." } },
      required: ["thread"],
    },
  },
  {
    name: "t3_start_thread",
    description:
      "Start a T3 Code thread: the place for real coding work in a project (Shawn watches T3 side by side). The message is the agent's full brief. Vera watches the thread automatically and pings when it finishes or needs input. Confirm with Shawn first if the project is ambiguous.",
    inputSchema: {
      type: "object",
      properties: {
        project: str("Project name, id, or folder."),
        message: str("The brief for the agent."),
        title: str("Short thread title."),
        watch: bool("Watch it (default true)."),
      },
      required: ["project", "message"],
    },
  },
  {
    name: "t3_send",
    description:
      "Send a message to a T3 thread: Shawn's answer to an agent's question, approval, or a follow-up. Relay his words faithfully. A busy thread gets it as its next turn. The thread is watched afterwards.",
    inputSchema: {
      type: "object",
      properties: { thread: str("Thread id."), message: str("What to send.") },
      required: ["thread", "message"],
    },
  },
  {
    name: "t3_watch",
    description: "Watch a T3 thread: chime and an inbox item when it finishes or waits on an approval or an answer. stop:true stops watching.",
    inputSchema: {
      type: "object",
      properties: { thread: str("Thread id."), stop: bool("Stop watching instead.") },
      required: ["thread"],
    },
  },
  {
    name: "read_system_prompt",
    description: "Read your own system prompt (~/.vera/system-prompt.md).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "edit_system_prompt",
    description:
      "Change your own system prompt when Shawn asks you to change how you behave. Give exactly one of: content (whole new prompt), find+replace (exact text swap), or append (add a rule at the end). The old version is backed up first and the change applies from the next turn. Afterwards, tell Shawn the change in one sentence.",
    inputSchema: {
      type: "object",
      properties: {
        content: str("Whole new prompt."),
        find: str("Exact text to replace."),
        replace: str("Replacement text."),
        append: str("Text to add at the end."),
      },
    },
  },
  {
    name: "revert_system_prompt",
    description: "Undo the last system prompt edit (each call goes one edit further back).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_brain",
    description:
      "Switch the harness that runs you, when Shawn asks (for example 'use Codex', 'switch to Claude'). Applies from the next turn; this conversation's recent lines carry over. Confirm the switch in a few words first.",
    inputSchema: {
      type: "object",
      properties: {
        harness: { type: "string", enum: ["claude-code", "codex"], description: "Which harness." },
        model: str("Optional model, like sonnet, opus, haiku, or a Codex model id."),
        effort: str("Optional effort: low, medium, high."),
      },
      required: ["harness"],
    },
  },
]
