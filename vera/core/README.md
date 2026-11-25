# @vera/core

Vera's brain-side process: the wake-word gate, the brain (Claude Code or
Codex, headless), the Vera MCP server the brain gets its tools from,
background jobs, the T3 Code relay, and the inbox. It runs only as the
hidden **`--stdio` sidecar of the Vera App** (`vera.exe`), which owns the
microphone, speech, the HUD, popups and the tray. Design and contracts:
[`../../VERA.md`](../../VERA.md).

## Run

```sh
cd vera
pnpm install
pnpm --filter @vera/core test         # unit tests + fake-App protocol tests (~40 s, no brain usage)
pnpm --filter @vera/core fake-app     # scripted protocol demo, prints every command
pnpm --filter @vera/core fake-app --real                                 # a few real claude-code turns
pnpm --filter @vera/core exec tsx scripts/brain-check.ts [--brain codex] # real brain: volume routing, answer length
pnpm --filter @vera/core exec tsx scripts/no-console-check.ts --control  # proves no window ever shows
pnpm --filter @vera/core typecheck
```

There is nothing else to run by hand. vera.exe starts Core; started from a
terminal, Core says so and exits 1.

First run seeds `~/.vera/` (`config.json`, `system-prompt.md` from
`prompts/system.md`, and `prompt-history/`, `jobs/`, `logs/`, `brain/`).
An unedited copy of an older stock prompt (`prompts/previous/`) is upgraded
to the current one at startup, keeping any rules appended to it and backing
the old text up, so `revert_system_prompt` undoes it. A prompt edited in the
middle is left alone (and logged). `VERA_HOME=<dir>` points everything at
another folder (tests, brain checks).

## Spawning Core from the App

```
program:  node.exe            Node 22+ (here C:\Program Files\nodejs\node.exe; resolve from PATH)
args:     --import tsx src/main.ts --stdio
cwd:      <repo>\vera\core    tsx resolves from vera/core/node_modules (run `pnpm install` in vera/ once)
env:      inherit; optional VERA_HOME (default ~/.vera), VERA_PORT (HTTP port, default 7313, 0 = any)
process:  CREATE_NO_WINDOW, stdin/stdout/stderr all piped
```

- `--stdio` is accepted and is the only mode.
- **stdout is the protocol and nothing else**: one JSON command per line.
  **stderr is the log**: drain it, or Core blocks once the pipe fills. Core
  also writes its own log to `~/.vera/logs/core-<date>.log`, so the App
  doesn't need to keep stderr.
- **To quit, close Core's stdin.** Core interrupts the brain, kills running
  jobs and its children, and exits 0 within about 2 s (it forces an exit at
  5 s). Put Core in a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
  so a crash of vera.exe can't orphan `claude`/`codex` processes.
- Core runs a loopback HTTP server that serves no pages. The brain's MCP
  server calls tools through it (`POST /api/tool`). If 7313 is taken, Core
  uses a free port; the port in use is in `~/.vera/core-runtime.json`
  (`{pid, port, url}`). Debug and test hooks:
  - `POST /api/utterance {"text":"…","direct":true,"wait":true}`: as if
    Shawn said it (`direct` skips the wake word, `wait` answers once the
    turn ends).
  - `GET /api/state`: a JSON snapshot (HUD, volume, cards, turns, jobs).
  - `POST /api/say {"text":"…"}`: the App says a line, without the brain.
  - `POST /api/chime {"kind":"notify"}`, `POST /api/notify {"title":"…","summary":"…"}`
    (an inbox item, as a finished job makes), `POST /api/brain {"harness":"codex"}`.
- Events the App sends before Core is ready are buffered, not lost.

## Protocol details beyond VERA.md

- **Core serializes speech.** It sends one `speak` at a time, and the next
  only after the App reports the previous one ended (`finished` or
  `failed`), so the App needs no speak queue. `speak_id`s are `s1`, `s2`,
  …. The App guarantees every `speak` an end; Core's own deadlines are the
  backstop: no `started` within 14 s, or no end within 8 s + 160 ms per
  character of starting (twice a line's length), and Core sends
  `stop_speaking` (so it can never play late), skips the line, and says
  `error` (`speech`).
- **No stale replies.** When a new turn begins, every line from earlier
  turns, playing or queued, is cut (`stop_speaking`) and dropped. An
  addressed utterance that arrives while a turn is still running supersedes
  it: the turn's speech is cut, anything it says later is dropped ("Not
  spoken"), its brain is interrupted, and the new words run as the next turn
  with a note that the last answer was cut off.
- **Brain deadlines.** A turn that hasn't called `speak` within
  `brain.firstSpeakTimeoutSeconds` (45) or hasn't ended within
  `brain.turnTimeoutSeconds` (150) is interrupted and reported at once
  (`error`, `brain_timeout`); a brain that ignores the interrupt is closed
  after 5 s and starts fresh for the next turn. A brain error is reported as
  `error` (`brain`). An utterance whose `final` never comes stops counting as
  speech after 60 s.
- **`playback failed`** means the voice service couldn't synthesize the
  item (the App plays its own error chime). It may come before or after
  `started`. That item ends and the next queued one is sent as usual. It is
  not an interruption: the turn goes on.
- **Any `playback interrupted` Core didn't ask for** (barge-in, or the App's
  own stop) ends Vera's speech for that turn, and nothing queued is sent.
  After `stop_speaking`, a late `interrupted` for the same id is ignored.
- **`barge_in`** may arrive before or after the matching `playback
  interrupted`; either order works. A `final` with `during_playback: true`
  while Core still thinks Vera is playing also counts as a barge-in. After a
  barge-in, the next `final` needs no wake word. The window stays open 20 s,
  or for a normal follow-up window after `speech_cancel`. A stop phrase
  ("stop", "never mind", "be quiet", "enough", "wait", …) ends the turn with
  no reply. Anything else becomes a turn whose message starts with
  `[Shawn talked over you and you stopped. He heard: "…". You were cut off
  after "…" (of "…"). Never said: "…". …]`. How much of the cut sentence he
  heard is estimated at 15 characters per second of playback.
- **Timestamps:** Core uses `final.start`/`end` when they look like epoch
  ms. Otherwise it uses its own clock (when `speech_start` arrived).
  `speech_start.t`, `partial.t` and `speech_cancel.t` are accepted and not
  needed.
- **HUD** (`hud` is sent only when it changes):
  - `speaking`: from the first `playback started` to the last item's end. A
    200 ms grace keeps two speak calls in a row one stretch.
  - `listening`: while Shawn talks to Vera (a partial with the wake word,
    speech in the follow-up window, or after a barge-in), and during the
    follow-up window (`wake.followUpSeconds`, 8 s).
  - `thinking`: from the final to the first `started`.
  - `working`: when nothing else applies and a background job or a watched
    T3 thread that Vera started is still running.
  - `idle`: otherwise. Any linger is up to the App.
- **`chime`:** `listening` for a bare "Vera"; `notify` for a new inbox item
  (held until Shawn finishes his sentence if he's mid-utterance).
- **`error`** `{what, message}`: the brain failed (`brain`), didn't answer
  in time (`brain_timeout`), or a line never ended (`speech`). The App plays
  the error chime, flashes the HUD, and shows it on the tray and in
  Settings.
- **`badge`:** the unread inbox count. Sent at start, on `ready`, and on
  every change.
- **`show`/`hide`:** card ids are `c1`, `c2`, …; markdown is capped at 6000
  characters. A brain `hide` without an id closes every open card (one
  `hide` per id). `{"type":"ui","action":"card_closed","card_id":"c3"}`
  tells Core the App closed a card (no `card_id`: all of them).
- **Volume** uses the App's scale: a level from 0 to 1, where level v is
  40 × (v − 1) dB. So 1 is the voice service's own level, each 0.1 is 4 dB,
  and 0 is silent. The default is 0.7. "Quieter" and "louder" step by 0.15
  (6 dB), or 0.3 (12 dB) with `a_lot`, and stay within 0.1 to 1 (a step
  never goes the wrong way). An exact `level` can be anything from 0 to 1
  (30 means 30%). Levels are rounded to 2 decimals. `set_volume` is sent
  before Vera answers. The App owns and persists the real value. Core keeps
  the last level in `~/.vera/core-state.json` only to work out steps, and
  adopts the App's: `volume` on `ready` (`{mic, engine, volume}`) and on
  `ui settings_changed`.
- **`ui`:** `stop_talking` acts like "stop" (cut speech, interrupt the brain,
  clear the queue); `mute` ignores finals until `unmute`;
  `settings_changed` rereads `~/.vera/config.json`.
- Unknown event types and non-JSON lines are logged and ignored.

## Config (`~/.vera/config.json`)

Only the keys you set override the defaults in `src/config.ts`. The App
keeps its own settings in the same file, under `app`.

```json
{
  "port": 7313,
  "brain": {
    "harness": "claude-code",
    "claude-code": { "model": "sonnet", "effort": "low" },
    "codex": { "model": "gpt-6.2-sol", "effort": "low" }
  },
  "wake": { "words": [], "soft": true, "warmSeconds": 120, "followUpSeconds": 8, "maxLeadingWords": 3 },
  "jobs": { "defaultCwd": "D:\\dev", "waitTimeoutSeconds": 90, "claude": {}, "codex": {}, "grok": {} },
  "t3": { "pollSeconds": 10 },
  "voice": { "defaultVolume": 0.7 }
}
```

- `wake.soft`: accept a misheard "Vera" ("Variable,", "Sarah,");
  `warmSeconds`: how long after Vera spoke "Hey there," still wakes her.
- `jobs.<agent>.command`: an argv to run instead of the agent's CLI (tests
  use `scripts/fake-job.mjs`).
- `brain.harness: "script"` is the scripted test brain
  (`src/brain/script.ts`, rules in `<VERA_HOME>/brain/script-brain.json`;
  `fail`, `throw`, and `hang` steps fake a broken brain).
  `brain` can also be switched by voice (`set_brain`) or `POST /api/brain`.
- `voice.defaultVolume` only matters until the App reports its level.
- Keys from v1 (`ears`, `mouth`, `panel`) are ignored.

## Tests

- `test/protocol.test.ts` drives Core through `scripts/fake-app.ts`, which
  spawns it exactly as vera.exe does, with the scripted brain and a fake job
  agent. It covers: wake word → thinking → speak → playback → follow-up
  without the wake word → idle; one speak at a time; barge-in mid-speech
  (rest of the turn dropped, the brain told what was heard, the reply needs
  no wake word); barge-in then "stop" / "never mind" / "be quiet" (no reply,
  never reaches the brain); tray Stop talking; "you're way too loud" from
  the App's 0.5 → `set_volume` 0.2 before the answer and no job; volume
  steps from the default and their limits; `playback failed` (the next item
  is still sent); show → hide → `card_closed`; a background job → `working`
  → `chime notify` + `badge 1` with no speech, and the digest on the next
  turn; an inbox chime held while Shawn talks; a bare wake word; mic mute;
  the `/api/utterance` hook.
- `test/app.test.ts`: the stdio link and the App mouth on their own.
- `scripts/brain-check.ts`: real brain turns with fake job agents, so
  nothing on the computer changes.
- `scripts/no-console-check.ts`: a WinEvent hook (`scripts/watch-windows.ps1`)
  reports every window shown while Core runs the claude brain (and the node
  MCP server it spawns), claude, codex and grok jobs, the T3 CLI, and a
  cancel (taskkill). `--control` first opens one console on purpose, to
  prove the hook sees it.

## How it fits together

- `src/main.ts`: the stdio sidecar; HTTP server; shutdown on stdin close.
- `src/app.ts`: the App protocol: `AppLink` (JSON lines in and out) and
  `AppMouth` (speak ids, one at a time, playback events, cuts).
- `src/vera.ts`: the loop. Gate → brain turn → tools → speech. Owns the
  follow-up window, barge-in, the HUD and badge, cards, volume, the queue,
  stop, the inbox digest, and recaps.
- `src/gate.ts`: wake word (fuzzy: vera, vara, vira, bera, veera…; never
  "very"/"were"/"era"), fillers ("hey", "okay"), trailing vocative, stop
  phrases. Pure functions.
- `src/brain/`: `claude.ts` (one persistent `claude -p` stream-json
  process), `codex.ts` (`codex app-server` JSON-RPC, one thread),
  `script.ts` (tests), `index.ts` (registry; add grok/gemini here).
- `src/mcp/server.ts` + `defs.ts`: the stdio MCP server the harness spawns
  (`node --import tsx`, one process); every call is forwarded to
  `POST /api/tool` with a per-run token. `src/tools.ts` implements them.
- `src/server.ts`: the loopback HTTP server (tools and debug hooks).
- `src/jobs.ts`: `ask_claude|codex|grok` as headless CLI runs with full
  permissions; transcripts in `~/.vera/jobs/<id>.jsonl`, state in `<id>.json`.
- `src/t3.ts`: T3 Code via its CLI plus two read-only HTTP endpoints, and the
  thread watcher.
- `src/proc.ts`: every child process goes through here or sets
  `windowsHide: true` itself; `.cmd` shims are parsed and their target run
  directly, never through a console.

## v2 prompt

`prompts/system.md` (earlier stock prompts are in `prompts/previous/`, so an
unedited copy upgrades): short and plain (one sentence, two at most, about
25 words; acknowledgements of one to three words; no filler, enthusiasm,
restating, offers, sign-offs, or explaining how), heteronyms respelled by
meaning (lead the metal "led", read in the past "red", live the adjective
"lyve", wind the verb "wined", close as in near "kloce", ...), popups only
for things worth seeing and closed on "close that", `set_volume` only when
Shawn explicitly asks for louder or quieter (never on its own: not for "can
you hear me?", "hello?", or frustration; never the computer's volume unless
he names the computer or an app), the routing rules from VERA.md, and how
to treat interruption notes and "Not spoken".

## Latency

Historical (v1, 2026-11-24): utterance in to the brain's first `speak` call
was about 1.0 s warm with claude-code sonnet/low (haiku 0.9 s, opus 2.2 s,
codex 1.8 to 2.1 s). Each turn's `firstSpeakMs` and `endToAudioMs` in
`GET /api/state` measure it now.

## Decisions

- **Turns are queued, not dropped.** One brain turn at a time; utterances that
  pass the gate meanwhile are joined into the next turn. "Vera, stop" /
  "never mind" never queues: it stops speech, interrupts the turn, and clears
  the queue.
- **Follow-up window** opens when Vera's speech ends (the last item's end,
  after the 200 ms grace) and stays open `followUpSeconds`, measured against
  the utterance's `start` time. While Vera is speaking the window counts as
  open too, so talking over her needs no wake word. A bare "Vera" chimes and
  opens the window.
- **Barge-in belongs to the App.** It hears Shawn over Vera (echo-cancelled
  microphone), stops playback itself, and tells Core. Core only cuts the
  rest of the turn and tells the brain what was heard (see above).
- **Wake word tuning** (from a noisy-kitchen simulation where "Vera" came
  out as "Hey there", "Okay there", "Hey girl", "Variable", "Vera of",
  "Mirror", "Sarah"): "Variable", "Mirror", "Sarah"/"Sara" count only as the
  first word followed by a comma, question mark or nothing ("Variable, what
  time is it?" wakes; "variable names are long" doesn't). "Hey there,",
  "Okay there,", "Hey girl," additionally need Vera to have spoken or woken
  within `warmSeconds` (120 s), so a TV greeting an hour later never wakes
  her. "Vera of ..." and "Vera, uh, ..." drop the hanger-on. Turn the soft
  matches off with `wake.soft: false`.
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
- **Security:** loopback only, no pages; POSTs must be JSON and same-origin;
  `/api/tool` needs the per-run token only the brain's MCP server gets.

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
