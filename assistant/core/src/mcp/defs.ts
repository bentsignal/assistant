/**
 * The Assistant MCP server's tools. The descriptions carry the routing rules, so
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
      "Say something out loud. This is the ONLY way Shawn hears you; your plain text output is never spoken. Usually one short sentence, two at most: no markdown, lists, URLs, code, or symbols; say numbers the way a person would. The voice reads the text literally, so RESPELL HETERONYMS BY MEANING: lead the metal is 'led', read in the past tense is 'red', live the adjective is 'lyve', wind (to turn) is 'wined', tear (to rip) is 'tare', bass (sound) is 'base', close (near) is 'kloce', minute (tiny) is 'my-noot', wound (injury) is 'woond', bow (bend) is 'bau', row (fight) is 'rau', dove (bird) is 'duv'. Put anything long or visual in `show` and speak a few words about it. Call it early in a turn; later calls queue after earlier ones. If it returns 'Not spoken', Shawn talked over you: stop and say nothing more.",
    inputSchema: { type: "object", properties: { text: str("What to say, plain spoken English.") }, required: ["text"] },
  },
  {
    name: "set_volume",
    description:
      "Change YOUR OWN voice volume (how loud you sound). ONLY when Shawn explicitly asks you to be louder or quieter: 'you're too loud', 'quieter', 'turn yourself down', 'speak up', 'louder'. NEVER on your own initiative: not when he asks 'can you hear me?' (that's whether you hear him), not when he says 'hello?', repeats himself or seems frustrated, and not when he says he can't hear you at all (a sound problem, not your volume). It never touches the computer's volume. Give `relative` for 'quieter'/'louder' (a_lot: true for 'way too loud', 'much louder'), or `level` 0 to 1 for an exact setting ('half volume' is 0.5). Call it before you speak, then acknowledge in two or three words.",
    inputSchema: {
      type: "object",
      properties: {
        relative: { type: "string", enum: ["quieter", "louder"], description: "Step your volume down or up." },
        a_lot: bool("A big step ('way too loud', 'much quieter')."),
        level: { type: "number", description: "Exact volume, 0 to 1." },
      },
    },
  },
  {
    name: "stop_listening",
    description:
      "Turn yourself off: ONLY when Shawn asks you to stop listening, go to sleep, or turn yourself off. Speak a few words first; you turn off once you've finished speaking, then hear nothing and say nothing until he turns Listening back on from the tray (you can't turn yourself back on). Never for 'stop', 'never mind' or 'be quiet' alone.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "show",
    description:
      "Open a small popup card on Shawn's screen, for something worth SEEING rather than hearing: a short list, a recipe's steps, a table, a link, a snippet of code. Keep it short (a title and a few lines of Markdown); don't show what you can say in a sentence. Speak a few words with it ('It's on screen.'). Returns the card id.",
    inputSchema: {
      type: "object",
      properties: { title: str("Short card title."), markdown: str("Card body in Markdown, brief.") },
      required: ["title", "markdown"],
    },
  },
  {
    name: "hide",
    description:
      "Close a popup card you showed: when Shawn says 'close that', 'got it', 'hide it', 'dismiss', or is clearly done with it. Without card_id, closes every open card. Closing is quiet: no need to speak unless he asked something else.",
    inputSchema: { type: "object", properties: { card_id: str("Card id like c3. Omit to close all open cards.") } },
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
      "Hand a task to Codex (headless, full permissions, with computer-use plugins). Use for USING THE COMPUTER: operating desktop apps, clicking around, driving a browser to DO something (fill a form, change a setting), anything on screen. OpenAI models are best at computer use. NOT for looking information up online: use your own web search for that. NEVER for your own voice volume (that's set_volume); the computer's volume only when Shawn explicitly asks about the computer's or an app's volume. Background by default.",
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
    name: "t3_environments",
    description: "List the machines linked to Shawn's T3 Code (environment ids and names), for working with threads on another machine.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "send_feedback",
    description:
      "Send Shawn's feedback about you (Assistant) to the orchestrator: the T3 thread on his development machine that works on you. Use when he says 'send feedback', 'tell the orchestrator', 'note that for the developer'. Pass his words, plus a line of context if it helps. It steers the orchestrator's running turn, or starts one. If it can't be reached, say so in a short sentence.",
    inputSchema: { type: "object", properties: { message: str("The feedback, in his words.") }, required: ["message"] },
  },
  {
    name: "t3_list_projects",
    description: "List Shawn's T3 Code projects (name, id, folder).",
    inputSchema: { type: "object", properties: { environment: str("A linked machine's environment id (t3_environments); omit for this one."), } },
  },
  {
    name: "t3_list_threads",
    description: "List recent T3 Code threads with their status (running, waiting, idle, ...). Optionally for one project (name, id, or folder).",
    inputSchema: {
      type: "object",
      properties: {
        project: str("Project name, id, or folder. Omit for all projects."),
        limit: { type: "number", description: "Default 10." },
        environment: str("A linked machine's environment id (t3_environments); omit for this one."),
      },
    },
  },
  {
    name: "t3_read_thread",
    description: "Read a T3 thread's state and latest messages, for example to relay what an agent asked or reported.",
    inputSchema: {
      type: "object",
      properties: {
        thread: str("Thread id."),
        messages: { type: "number", description: "How many latest messages (default 4)." },
        environment: str("A linked machine's environment id (t3_environments); omit for this one."),
      },
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
        environmentId: str("A linked machine's environment id (t3_environments) to start it there; omit for this one."),
        model: str("Only on another machine, when its project has no default model: a Claude model id (default claude-sonnet-5-5)."),
      },
      required: ["project", "message"],
    },
  },
  {
    name: "t3_send",
    description:
      "Send a message to a T3 thread: Shawn's answer to an agent's question, approval, or a follow-up. Relay his words faithfully. A busy thread is steered (the agent gets it in its running turn, at once) and an idle one starts a turn. Set queue only when Shawn says to queue it (it then waits for the current turn to end). The thread is watched afterwards, on whichever machine it's on.",
    inputSchema: {
      type: "object",
      properties: {
        thread: str("Thread id."),
        message: str("What to send."),
        queue: bool("Queue it after the running turn instead of steering (only when he asks to queue)."),
        environment: str("A linked machine's environment id (t3_environments); omit for this one."),
      },
      required: ["thread", "message"],
    },
  },
  {
    name: "t3_watch",
    description:
      "Watch a T3 thread on this machine or a linked one: chime and an inbox item when it finishes, fails, or waits on an approval or an answer (and once if it can't be checked). stop:true stops watching. Threads you start or send to are watched already.",
    inputSchema: {
      type: "object",
      properties: {
        thread: str("Thread id."),
        environmentId: str("The linked machine's environment id (t3_environments) when the thread is on another machine."),
        stop: bool("Stop watching instead."),
      },
      required: ["thread"],
    },
  },
  {
    name: "t3_tools",
    description:
      "List every T3 Code tool you can call with t3_tool (you have Shawn's full access: anything he can do in T3). With name, gives that tool's description and input schema; read it before the first call of a tool. Notable ones: t3_thread_launch (new thread: projectId, title, message, runtimeMode full-access, workspaceStrategy), t3_project_create / t3_project_clone (new projects), t3_thread_search, t3_thread_organize (settle, archive, pin, snooze), t3_thread_interrupt, t3_thread_wait, t3_pending_request (answer an agent's question), t3_thread_configure (model, modes), delegate_task, schedule_task, pull_request_*, create_issue.",
    inputSchema: { type: "object", properties: { name: str("One tool's name, for its schema. Omit to list them all.") } },
  },
  {
    name: "t3_tool",
    description:
      "Call any T3 Code tool by name (see t3_tools) with its arguments, with Shawn's full access. Pass environmentId in args to act on another machine (t3_environments lists them; Winserve is 573af78b-3442-4163-8b9b-bc5cb90eefde). A launch in a project with no default model needs modelSelection (orchestrator_capabilities lists providers and models; for Claude: {provider: claudeAgent, instanceId: claudeAgent, model: claude-sonnet-5-5}). Use it for whatever the simpler t3_* tools don't cover: launching threads with options, creating projects, settling or archiving threads, answering pending requests, PRs, issues. A thread t3_thread_launch starts with a message is watched for you (chime and inbox when done). Confirm out loud before anything destructive or outward-facing.",
    inputSchema: {
      type: "object",
      properties: {
        name: str("The T3 tool, like t3_thread_launch or t3_thread_organize."),
        args: { type: "object", description: "Its arguments, as its input schema says." },
      },
      required: ["name"],
    },
  },
  {
    name: "t3_access",
    description:
      "Check what access you have in T3 Code (it should be full-access). retry:true gets a fresh session first, for when T3 refused something for its access level or Shawn says 'retry T3 access'.",
    inputSchema: { type: "object", properties: { retry: bool("Get a fresh T3 session first.") } },
  },
  {
    name: "t3_reauthorize",
    description:
      "Repair your T3 access: finds T3 Code's t3 command again (config t3.cliPath, T3CODE_CLI_PATH, PATH, T3 Code's install), drops your cached T3 session, gets full access again through T3's own approval, and says the access you now have. Use it when Shawn says 'fix your T3 access', or when T3 tools keep failing for access or sign-in. If it can't find the t3 command or T3 Code isn't running, it says exactly that: tell Shawn in one sentence.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mcp_list",
    description:
      "List your own MCP servers (~/.assistant/mcp.json): each one's transport, command or url, whether it's enabled, and whether it connected when your brain last started. Secrets are never shown.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mcp_add",
    description:
      "Give yourself a new capability by adding (or replacing) an MCP server, with no app update: stdio (command + args, optional env) or http (url, optional headers). Its tools are yours from your next turn (your brain restarts, keeping the conversation), named mcp__<name>__<tool>. Run mcp_test on it first or right after. For a secret (an API key or token), never put the value in: use ${VAR} for an environment variable or ${file:C:\\path\\token.txt} for a file, and ask Shawn to set it if it isn't. On Windows, npx and other .cmd commands work as is. Then save a skill (skill_save) saying what it's for. Confirm in a few words.",
    inputSchema: {
      type: "object",
      properties: {
        name: str("Short server name: letters, digits, - or _ (not 'assistant')."),
        type: { type: "string", enum: ["stdio", "http", "sse"], description: "Transport; default stdio, or http when a url is given." },
        command: str("stdio: the program, like npx, uvx, node, or an absolute path."),
        args: { type: "array", items: { type: "string" }, description: "stdio: its arguments." },
        env: { type: "object", description: "stdio: environment variables, values as ${VAR} or ${file:path} for secrets." },
        url: str("http/sse: the server's URL."),
        headers: { type: "object", description: "http/sse: request headers, like {Authorization: 'Bearer ${MY_TOKEN}'}." },
        description: str("One line: what it gives you."),
      },
      required: ["name"],
    },
  },
  {
    name: "mcp_remove",
    description: "Remove one of your MCP servers when Shawn asks (its tools go from your next turn). Confirm in a few words.",
    inputSchema: { type: "object", properties: { name: str("The server's name.") }, required: ["name"] },
  },
  {
    name: "mcp_enable",
    description: "Turn one of your MCP servers back on (kept in mcp.json while off). Applies from your next turn.",
    inputSchema: { type: "object", properties: { name: str("The server's name.") }, required: ["name"] },
  },
  {
    name: "mcp_disable",
    description: "Turn one of your MCP servers off without removing it (for a broken or unwanted one). Applies from your next turn.",
    inputSchema: { type: "object", properties: { name: str("The server's name.") }, required: ["name"] },
  },
  {
    name: "mcp_test",
    description:
      "Test one of your MCP servers: starts it on its own, lists its tools, stops it, and reports what happened (its tools, or exactly why it failed: command not found, a missing secret, an error it printed). Use after mcp_add and when one is reported broken.",
    inputSchema: { type: "object", properties: { name: str("The server's name.") }, required: ["name"] },
  },
  {
    name: "config_get",
    description:
      "Read your own settings (~/.assistant/config.json). Without key, lists every setting you may change, its value now, and when a change applies. With key (dotted, like t3.cliPath or wake.followUpSeconds), that one.",
    inputSchema: { type: "object", properties: { key: str("A dotted key; omit to list them all.") } },
  },
  {
    name: "config_set",
    description:
      "Change one of your own settings when Shawn asks ('wait longer before answering', 'use this path for T3', 'give me twenty seconds for follow-ups'). Only the keys config_get lists; the value is checked first, so a bad one is refused with why. The result says when it applies (now, your next turn, or after Assistant restarts): say that in a few words. A null or 'default' value clears a key that allows it.",
    inputSchema: {
      type: "object",
      properties: {
        key: str("The dotted key, like t3.cliPath."),
        value: { description: "The new value: a number, true/false, text, or a list of words." },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "update_status",
    description: "Which version of Assistant (you) is running, which channel (Stable or Nightly) it updates from, and what the app's updater is doing. The only source of truth about an update.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "update_check",
    description: "Check for an update to Assistant (you) on its channel, through the app's own updater (the same as Settings › Updates). Says the newest release and whether it's this one.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "update_install",
    description:
      "Update Assistant (you), when Shawn asks: the app's own updater (the same as Settings › Updates' Update button) checks, downloads, verifies, and restarts you into the new version. Call it straight away, without speaking first; it returns as soon as the install starts (or says there's nothing to install, or the updater's reason it failed). Then follow what it returns. You announce yourself automatically once you're back. channel installs that channel's release (and switches to it).",
    inputSchema: { type: "object", properties: { channel: { type: "string", enum: ["stable", "nightly"], description: "Install from this channel (also switches to it)." } } },
  },
  {
    name: "update_channel",
    description: "Switch the channel Assistant (you) updates from: stable (tested releases) or nightly (every change). Saved; then checks it.",
    inputSchema: { type: "object", properties: { channel: { type: "string", enum: ["stable", "nightly"], description: "The channel." } }, required: ["channel"] },
  },
  {
    name: "skill_list",
    description: "List your skills (what you've set up and learned, saved for good). Your prompt already has them; use this to check after changes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "skill_read",
    description: "Read one skill in full: what it's for, its exact commands, where its config and auth live.",
    inputSchema: { type: "object", properties: { name: str("The skill's name.") }, required: ["name"] },
  },
  {
    name: "skill_save",
    description:
      "Save a skill (create, or update one: fields left out keep their values), so you remember a capability for good, across restarts, app updates and prompt edits. Use it when Shawn teaches you something to do or a preference ('remember that...', 'from now on, when I ask X, do Y'), after you've set something up and checked it works, or to fix a skill that's wrong. body: what it's for, the exact commands (one per line, with what they print), and where its config and auth live. commands: the programs run_command may run for it (names on PATH or absolute paths). Applies from the next turn; run_command may use new commands at once.",
    inputSchema: {
      type: "object",
      properties: {
        name: str("Short name, like free-mail or hue-lights."),
        description: str("One sentence: what it lets you do."),
        body: str("Markdown: what it's for, exact commands, config and auth locations, anything to watch out for."),
        commands: { type: "array", items: { type: "string" }, description: "Programs run_command may run for this skill, like ['freemail']." },
        interactive: {
          type: "array",
          items: { type: "string" },
          description: "Command lines that wait on Shawn (a browser login, a device button), like ['freemail auth login']; ['*'] for all. run_command runs them in the background at once and reports when they end.",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "skill_remove",
    description: "Remove a skill when Shawn asks you to forget it (it's kept in skills/.removed, so it can be restored by hand). Confirm first.",
    inputSchema: { type: "object", properties: { name: str("The skill's name.") }, required: ["name"] },
  },
  {
    name: "skill_setup",
    description:
      "Set up a new capability that needs installing or configuring ('set up my Free Mail CLI so you can read my email', 'add control of my Hue lights'). Starts a background Claude Code job (full permissions) that installs and configures it, checks it works, and writes the skill file itself; Shawn gets a chime when it's done and you have the skill from the next turn. For something that's already installed and needs no setup, save it directly with skill_save instead. For a whole new software project, use a T3 thread (see the preferences skill).",
    inputSchema: {
      type: "object",
      properties: {
        goal: str("What to set up and what you should be able to do with it, self-contained."),
        name: str("Skill name, like free-mail."),
        details: str("Anything Shawn said that helps: where it lives, accounts, which machine."),
        cwd: str("Working folder for the job. Defaults to D:\\dev."),
      },
      required: ["goal"],
    },
  },
  {
    name: "run_command",
    description:
      "Run a program one of your skills declares (its commands), directly, no shell, and get its output: the fast way to use a skill (read mail, list lights, check a status). command is a plain command line (quotes group words; no pipes, redirects or &&). Gives up after timeout_seconds (default 60). One still running after a few seconds (or one its skill marks interactive, such as a browser login) goes on in the background, whatever happens to this turn; you get its output, and Shawn a chime, when it ends. Failures come back with their stderr: tell him the reason it gives. Confirm out loud first if the command changes or sends anything. A program no skill declares is refused: add it to a skill with skill_save first, or delegate.",
    inputSchema: {
      type: "object",
      properties: {
        command: str("The command line, like: freemail list --unread --limit 10"),
        cwd: str("Working folder (optional)."),
        stdin: str("Text to pass on standard input (optional)."),
        timeout_seconds: { type: "number", description: "Default 60, at most 3600 (interactive ones get at least jobs.interactiveTimeoutSeconds)." },
      },
      required: ["command"],
    },
  },
  {
    name: "read_system_prompt",
    description: "Read your own system prompt (~/.assistant/system-prompt.md).",
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
    name: "set_name",
    description:
      "Change your names (personas: each name wakes you and has its own voice). name alone renames the persona he's talking to ('call yourself Nova'); from+name renames another ('rename Buzz to Rex'); name+add:true adds one ('add a persona called Max with the Optimus voice': voice is a voice name or id, style an optional short manner); name+remove:true removes one. Names are one word. Applies at once as a wake word, and from the next turn in your prompt. Confirm in a few words.",
    inputSchema: {
      type: "object",
      properties: {
        name: str("The (new) name, one word, like Nova."),
        from: str("Rename this persona instead of the one he's talking to."),
        add: bool("Add name as a new persona."),
        remove: bool("Remove the persona called name."),
        voice: str("With add: its voice (a voice name or id)."),
        style: str("With add: an optional short manner, like 'a dry, courteous English butler'."),
      },
      required: ["name"],
    },
  },
  {
    name: "switch_persona",
    description:
      "Hand the conversation to another of your personas when Shawn asks for one without saying its name as a wake word ('let me talk to Alfred', 'put Jarvis on', 'back to Vera'). It answers from now on, this turn included, until he names or asks for another; it never changes by itself. Then speak as that persona.",
    inputSchema: { type: "object", properties: { name: str("The persona's name.") }, required: ["name"] },
  },
  {
    name: "set_wake",
    description:
      "Change what wakes a persona, or turn one off or on, when Shawn asks ('turn off Tony', 'let hey Tony wake you', 'stop answering to just Vera', 'answer to plain Jarvis too'). Each persona wakes to its phrases (by default 'hey <name>'); bare_name:true lets the name alone wake it too. A persona that's off never wakes or answers. The first persona can't be turned off this way (Settings can). Applies at once, saved. Confirm in a few words.",
    inputSchema: {
      type: "object",
      properties: {
        persona: str("Which persona; leave out for the one he's talking to."),
        enabled: bool("false turns the persona off, true on."),
        bare_name: bool("Whether the name alone wakes it ('Tony, ...'), beside its phrases."),
        add_phrase: str("A wake phrase to add, like 'hey Tony' or 'okay Vera'."),
        remove_phrase: str("A wake phrase to remove."),
        phrases: { type: "array", items: { type: "string" }, description: "Replace all its wake phrases." },
      },
    },
  },
  {
    name: "set_voice",
    description:
      "List voices or change them. No args: lists the voices and which persona uses which. persona+voice: gives that persona its own voice ('make Jarvis use the Eli voice'). voice alone: an override every persona speaks in, for auditioning ('switch to Eli', 'try the next voice': 'next' / 'previous' step through them); voice 'default' clears the override so each persona speaks in its own voice again ('use your normal voices'). Applies from your next speak line, so after a switch say a short line in the new voice. Saved.",
    inputSchema: {
      type: "object",
      properties: {
        voice: str("A voice name or id, 'next', 'previous', or 'default' (clear the override). Leave out to list."),
        persona: str("Give this persona the voice (its own, not an override)."),
      },
    },
  },
  {
    name: "set_brain",
    description:
      "Switch the harness that runs you, its model, or its effort, when Shawn asks (for example 'use Codex', 'switch to Claude', 'use opus', 'think harder'). Leave out harness to keep the current one and change only the model or effort. Applies from the next turn; this conversation's recent lines carry over. Confirm the switch in a few words first.",
    inputSchema: {
      type: "object",
      properties: {
        harness: { type: "string", enum: ["claude-code", "codex"], description: "Which harness; leave out to keep the current one." },
        model: str("Optional model, like sonnet, opus, haiku, or a Codex model id."),
        effort: str("Optional reasoning effort: low, medium, high (Claude also takes max; Codex also minimal)."),
      },
    },
  },
]
