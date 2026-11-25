# @vera/core

Vera's daemon: the wake-word gate, the brain (Claude Code or Codex, headless),
the Vera MCP server the brain gets its tools from, background jobs, T3 Code
relay, the inbox, and the panel. Design and contracts: [`../../VERA.md`](../../VERA.md).

## Run

```sh
cd vera
pnpm install
pnpm start        # daemon on http://127.0.0.1:7313 + panel as an Edge/Chrome --app window
pnpm dev          # daemon only
pnpm test         # unit tests (gate, inbox, prompt history, job summaries)
```

First run seeds `~/.vera/` (`config.json`, `system-prompt.md` from
`prompts/system.md`, and `prompt-history/`, `jobs/`, `logs/`, `brain/`).
`VERA_HOME=<dir>` points everything at another folder (tests, benches).

Talk to it without Ears:

```sh
curl -X POST http://127.0.0.1:7313/api/utterance -H "content-type: application/json" \
  -d '{"text":"Vera, what is fifteen percent of eighty?","wait":true}'
```

`direct:true` skips the wake word; `wait:true` answers when the turn ends,
with what was spoken and the latency.

## Config (`~/.vera/config.json`)

Only the keys you set override the defaults in `src/config.ts`.

```json
{
  "brain": {
    "harness": "claude-code",
    "claude-code": { "model": "sonnet", "effort": "low" },
    "codex": { "model": "gpt-6.2-sol", "effort": "low" }
  },
  "wake": { "words": [], "followUpSeconds": 8, "maxLeadingWords": 3 },
  "ears": { "command": null, "tailMs": 400 },
  "mouth": { "module": "auto", "options": {} },
  "jobs": { "defaultCwd": "D:\\dev", "waitTimeoutSeconds": 90, "claude": {}, "codex": {}, "grok": {} },
  "t3": { "pollSeconds": 10 },
  "panel": { "open": true }
}
```

- `ears.command`: argv of any process speaking the Ears JSON-lines protocol,
  for example `["D:\\dev\\vera-voice\\target\\release\\hex.exe", "ears"]`.
  `null` means no microphone (panel text box and API only).
  `scripts/fake-ears.mjs` is a scripted stand-in for testing.
- `mouth.module`: `"auto"` loads `@vera/mouth` (as a dependency, or the
  sibling `vera/mouth` package) and falls back to Windows SAPI; `"sapi"`
  (options: `volume`, `rate`, `voice`); `"stub"` logs only.
- `brain`: also switchable by voice (`set_brain`) or `POST /api/brain`.

## Measured latency (utterance in → first `speak` call)

Warm = median of three turns after the first. Daemon, harness and Vera MCP
server all local; 2026-11-24, Windows 11. `pnpm bench` reproduces it.

| brain | cold (ms) | warm median (ms) | warm range (ms) |
|---|---|---|---|
| claude-code haiku / low | 1521 | 865 | 824–898 |
| **claude-code sonnet / low (default)** | 1737 | 1022 | 932–1072 |
| claude-code opus / low | 3281 | 2220 | 2168–2866 |
| codex gpt-6.2-sol / low | 3435 | 2120 | 1712–2835 |
| codex gpt-6-luna / low | 2430 | 1779 | 1709–39073 (one stall) |

Turns that call a tool first (search, T3, jobs) take about 2 to 3 s to the
first word; web searches 5 to 10 s.

## How it fits together

- `src/vera.ts`: the loop. Gate → brain turn → tools → Mouth. Owns the
  follow-up window, half-duplex, the queue, stop, inbox digest, recaps.
- `src/gate.ts`: wake word (fuzzy: vera, vara, vira, bera, veera…; never
  "very"/"were"/"era"), fillers ("hey", "okay"), trailing vocative, stop
  phrases. Pure functions.
- `src/brain/`: `claude.ts` (one persistent `claude -p` stream-json process),
  `codex.ts` (`codex app-server` JSON-RPC, one thread), `index.ts` (registry;
  add grok/gemini here).
- `src/mcp/server.ts` + `defs.ts`: the stdio MCP server the harness spawns;
  every call is forwarded to `POST /api/tool` with a per-run token.
  `src/tools.ts` implements them.
- `src/jobs.ts`: `ask_claude|codex|grok` as headless CLI runs with full
  permissions; transcripts in `~/.vera/jobs/<id>.jsonl`, state in `<id>.json`.
- `src/t3.ts`: T3 Code via its CLI plus two read-only HTTP endpoints, and the
  thread watcher.
- `src/mouth.ts`: the Mouth interface, `@vera/mouth` loader, SAPI and stub.
- `src/ears.ts`: the Ears process and protocol.
- `panel/`: vanilla HTML/JS, state over `/ws`.

## Decisions

- **Turns are queued, not dropped.** One brain turn at a time; utterances that
  pass the gate meanwhile are joined into the next turn. "Vera, stop" /
  "never mind" never queues: it stops speech, interrupts the turn, and clears
  the queue.
- **Follow-up window** opens when Mouth finishes (after `ears.tailMs`) and
  stays open `followUpSeconds`, measured against the utterance's `start` time.
  While Vera is speaking the window counts as open too (barge-in when
  half-duplex is off). A bare "Vera" chimes and opens the window.
- **Half-duplex:** Ears get `pause` on Mouth `start` and `resume` after `end` +
  `tailMs`. Ears segments that start while Vera talks (or within the tail) are
  dropped as echo. Consequence: "Vera, stop" can't be heard while she's
  talking; use the panel's Stop (or Esc) until Ears can barge in.
- **Inbox digest** rides on the front of the next user turn, once, with an
  instruction not to bring it up unless asked. Jobs the brain waited for
  (`wait:true`) don't create inbox items.
- **Prompt edits** apply on the next turn: Claude restarts with `--resume`
  (same session, new prompt, `--system-prompt-snapshot off`); Codex starts a
  new thread and gets a recap of recent lines. Same for `set_brain`.
- **The brain is thin.** Claude: `--tools WebSearch,WebFetch`,
  `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands`,
  `--permission-prompts none`. Codex: read-only sandbox, `approval_policy
  never`, the user's MCP servers disabled per process, extra features off.
- **Security:** loopback only; POSTs must be JSON and same-origin; `/api/tool`
  needs the per-run token only the brain's MCP server gets.

## CLI quirks found

- **Claude Code** `-p` stream-json: the `system/init` event only appears with
  the first user message. Interrupt is a `control_request` `{subtype:
  "interrupt"}` on stdin. `--system-prompt-file` works (not in `--help`).
- **Codex app-server**:
  - `-c mcp_servers=...` merges into the user's table rather than replacing
    it, so Vera disables each of the user's servers with
    `mcp_servers.<name>.enabled=false` (names read from `~/.codex/config.toml`).
  - MCP tools need `default_tools_approval_mode="approve"`, or every call fails
    with "requires approval, but approval policy is never".
  - Newer models expose tools through "code mode" (a JS `exec` tool).
    `omit_tools_from=["code_mode","deferred"]` on the Vera server makes `speak`
    a direct function call. Don't disable `code_mode_host`: the web search tool
    lives inside it.
  - `--disable multi_agent` doesn't remove `spawn_agent` and friends (the
    feature is deprecated); harmless with a read-only sandbox.
- **Grok** headless: `grok -p --output-format json --always-approve --cwd
  <dir>`, prompt on stdin, prints one JSON object with `text`, `sessionId`,
  `usage`. The npm shim is a `.cmd`; Vera runs its `bin/grok` with node.
  Results often open with a plan paragraph; `cleanResult` trims it.
- **T3 Code** has no `project list`. Vera mints a read-only bearer token once
  (`t3 auth session issue --token-only --scope orchestration:read --ttl 30d`,
  cached in `~/.vera/t3-token.json`) and calls the running server:
  `GET /api/projects` and `GET /api/orchestration/shell` (header
  `x-t3-orchestration-protocol: 2`), with the origin from
  `<T3CODE_HOME>/userdata/server-runtime.json`. Threads are started, sent
  to, and read through the CLI (`--json`, message on stdin via `-`). The
  `t3.cmd` launcher is parsed so Vera runs the Electron binary directly
  (no cmd.exe quoting). Thread ids can look like `mcp:<uuid>`.
- **Windows**: CLIs are spawned without a shell; `.cmd` shims are read and
  their target run directly (`src/proc.ts`).
