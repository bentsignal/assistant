# @vera/core

Vera's brain-side process: the wake-word gate, the brain (Claude Code or
Codex, headless), the Vera MCP server the brain gets its tools from,
background jobs, the T3 Code relay, and the inbox. In v2 it runs as a
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
pnpm start        # v1 standalone daemon (own Ears + Mouth, debug panel on :7313; opens no window)
```

First run seeds `~/.vera/` (`config.json`, `system-prompt.md` from
`prompts/system.md`, and `prompt-history/`, `jobs/`, `logs/`, `brain/`).
An unedited copy of an older stock prompt (`prompts/previous/`) is upgraded
to the current one at startup, keeping any rules appended to it and backing
the old text up, so `revert_system_prompt` undoes it. A prompt edited in the
middle is left alone (and logged). `VERA_HOME=<dir>` points everything at
another folder (tests, benches).

## Spawning Core from the App

```
program:  node.exe            Node 22+ (here C:\Program Files\nodejs\node.exe; resolve from PATH)
args:     --import tsx src/main.ts --stdio
cwd:      <repo>\vera\core    tsx resolves from vera/core/node_modules (run `pnpm install` in vera/ once)
env:      inherit; optional VERA_HOME (default ~/.vera), VERA_PORT (HTTP port, default 7313, 0 = any)
process:  CREATE_NO_WINDOW, stdin/stdout/stderr all piped
```

- **stdout is the protocol and nothing else**: one JSON command per line.
  **stderr is the log**: drain it, or Core blocks once the pipe fills. Core
  also writes its own log to `~/.vera/logs/core-<date>.log`, so the App
  doesn't need to keep stderr.
- **To quit, close Core's stdin.** Core interrupts the brain, kills running
  jobs and its children, and exits 0 within about 2 s (it forces an exit at
  5 s). Put Core in a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
  so a crash of vera.exe can't orphan `claude`/`codex` processes.
- The loopback HTTP server stays up in `--stdio` mode, because the brain's
  MCP server calls tools through it. If 7313 is taken, Core uses a free
  port; the port in use is in `~/.vera/core-runtime.json` (`{pid, port,
  url}`). Debug hook: `POST /api/utterance {"text":"…","direct":true,"wait":true}`.
  `GET /api/state` returns a JSON snapshot (HUD, volume, cards, turns, jobs).
- Events the App sends before Core is ready are buffered, not lost.

## Protocol details beyond VERA.md

- **Core serializes speech.** It sends one `speak` at a time, and the next
  only after the App reports `playback finished` for the previous one, so
  the App needs no speak queue. `speak_id`s are `s1`, `s2`, …. If no
  `started` arrives within 20 s, Core skips the item. If no `finished`
  arrives, Core assumes it after 30 s + 150 ms per character.
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
  (held until Shawn finishes his sentence if he's mid-utterance); `error`
  when a brain turn fails.
- **`badge`:** the unread inbox count. Sent at start, on `ready`, and on
  every change.
- **`show`/`hide`:** card ids are `c1`, `c2`, …; markdown is capped at 6000
  characters. A brain `hide` without an id closes every open card (one
  `hide` per id). `{"type":"ui","action":"card_closed","card_id":"c3"}`
  tells Core the App closed a card (no `card_id`: all of them).
- **Volume:** Core keeps Vera's last level in `~/.vera/core-state.json`
  (default 0.35), only to work out relative steps; the App owns and persists
  the real value. Core also reads two optional extras so its steps start from
  the App's level: `ready.volume`, and `volume` on `ui settings_changed`.
  Quieter and louder divide or multiply by 1.4 (by 2 with `a_lot`), with a
  floor of 0.05. `set_volume` is sent before Vera answers.
- **`ui`:** `stop_talking` acts like "stop" (cut speech, interrupt the brain,
  clear the queue); `mute` ignores finals until `unmute`;
  `settings_changed` rereads `~/.vera/config.json`.
- Unknown event types and non-JSON lines are logged and ignored.

## Config (`~/.vera/config.json`)

Only the keys you set override the defaults in `src/config.ts`.

```json
{
  "brain": {
    "harness": "claude-code",
    "claude-code": { "model": "sonnet", "effort": "low" },
    "codex": { "model": "gpt-6.2-sol", "effort": "low" }
  },
  "wake": { "words": [], "soft": true, "warmSeconds": 120, "followUpSeconds": 8, "maxLeadingWords": 3 },
  "jobs": { "defaultCwd": "D:\\dev", "waitTimeoutSeconds": 90, "claude": {}, "codex": {}, "grok": {} },
  "t3": { "pollSeconds": 10 },
  "voice": { "defaultVolume": 0.35 },
  "ears": { "command": "auto", "args": [], "tailMs": 300, "chimeTailMs": 150, "bargeIn": true },
  "mouth": { "module": "auto", "options": {} }
}
```

- `wake.soft`: accept a misheard "Vera" ("Variable,", "Sarah,");
  `warmSeconds`: how long after Vera spoke "Hey there," still wakes her.
- `jobs.<agent>.command`: an argv to run instead of the agent's CLI (tests
  use `scripts/fake-job.mjs`).
- `brain.harness: "script"` is the scripted test brain
  (`src/brain/script.ts`, rules in `<VERA_HOME>/brain/script-brain.json`).
  `brain` can also be switched by voice (`set_brain`) or `POST /api/brain`.
- `ears` and `mouth` only matter in standalone mode (below).

## Tests

- `test/protocol.test.ts` drives Core through `scripts/fake-app.ts`, which
  spawns it exactly as vera.exe does, with the scripted brain and a fake job
  agent. It covers: wake word → thinking → speak → playback → follow-up
  without the wake word → idle; one speak at a time; barge-in mid-speech
  (rest of the turn dropped, the brain told what was heard, the reply needs
  no wake word); barge-in then "stop" / "never mind" / "be quiet" (no reply,
  never reaches the brain); tray Stop talking; "you're way too loud" →
  `set_volume` 0.25 before the answer and no job; show → hide →
  `card_closed`; a background job → `working` → `chime notify` + `badge 1`
  with no speech, and the digest on the next turn; an inbox chime held while
  Shawn talks; a bare wake word; mic mute; the `/api/utterance` hook.
- `test/app.test.ts`: the stdio link and the App mouth on their own.
- `scripts/brain-check.ts`: real brain turns with fake job agents, so
  nothing on the computer changes.
- `scripts/no-console-check.ts`: a WinEvent hook (`scripts/watch-windows.ps1`)
  reports every window shown while Core runs the claude brain (and the node
  MCP server it spawns), claude, codex and grok jobs, the T3 CLI, and a
  cancel (taskkill). `--control` first opens one console on purpose, to
  prove the hook sees it.

## How it fits together

- `src/main.ts`: `--stdio` or standalone; HTTP server; shutdown on stdin close.
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
- `src/jobs.ts`: `ask_claude|codex|grok` as headless CLI runs with full
  permissions; transcripts in `~/.vera/jobs/<id>.jsonl`, state in `<id>.json`.
- `src/t3.ts`: T3 Code via its CLI plus two read-only HTTP endpoints, and the
  thread watcher.
- `src/proc.ts`: every child process goes through here or sets
  `windowsHide: true` itself; `.cmd` shims are parsed and their target run
  directly, never through a console.
- Standalone only: `src/ears.ts`, `src/mouth.ts`, `panel/`.

## v2 prompt

`prompts/system.md` (v1 is in `prompts/previous/`): short and plain (one
sentence, two at most, about 25 words; acknowledgements of one to three
words; no filler, enthusiasm, restating, offers, sign-offs, or explaining
how), popups only for things worth seeing and closed on "close that",
`set_volume` for any "you're too loud" or "speak up" (never the computer's
volume unless he names the computer or an app), the routing rules from
VERA.md, and how to treat interruption notes and "Not spoken".

## v1 standalone mode (`pnpm start`)

Without `--stdio`, Core is the v1 daemon: it spawns Ears (`hex ears`) and
Mouth (`@vera/mouth`, else SAPI) itself, runs half-duplex with the v1
"Vera, stop" barge-in, and serves the debug panel on
http://127.0.0.1:7313. It no longer opens an Edge window. The real-audio
end-to-end test (`scripts/e2e/run.mjs`) uses this mode.

- `ears.command`: `"auto"` (default) runs this repo's
  `target/release/hex.exe ears` (else `target/ears-dev/hex.exe`) plus
  `ears.args` (e.g. `["--device", "AT2020"]`). An argv runs any process
  speaking the Ears JSON-lines protocol (`scripts/fake-ears.mjs` is a
  scripted stand-in). `null` means no microphone.
- `ears.bargeIn`: keep listening while Vera talks, only for "Vera, stop".
  `false` pauses Ears instead.
- `mouth.module`: `"auto"` loads `@vera/mouth` and falls back to Windows
  SAPI; `"sapi"` (options: `volume`, `rate`, `voice`); `"stub"` logs only.

## Measured latency (v1 standalone; utterance in → first `speak` call)

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

## End-to-end test (v1 standalone, real audio, no human)

```sh
powershell -File scripts/e2e/make-phrases.ps1 -Out <dir>                # SAPI phrases as "Shawn"
pnpm --filter @vera/mouth say "<a long sentence>" --out <dir>/echo.wav  # Vera's voice as echo
node scripts/e2e/run.mjs <dir> [--barge-in] [--no-echo] [--loud]
```

It mixes the phrases into one scenario WAV, runs Core in a throwaway
`VERA_HOME` on port 7399 with the scenario as the microphone of the real
`hex ears` (`HEX_AUDIO_FIXTURE`), the real brain, and `@vera/mouth` playing
silently (`SDL_AUDIODRIVER=dummy` keeps ffplay's real-time pacing), and
checks: a remark without the wake word is ignored, "Vera, what time is it?"
is answered, the follow-up without the wake word is answered, a late remark
after the window is ignored, "Variable, ..." wakes, inbox notifications
arrive (one deferred while speech is in progress), and "Vera, stop" during a
long answer (stops her with `--barge-in --no-echo`; heard as nothing over
echo or with barge-in off).

Measured 2026-11-25 (Claude Code Sonnet 5.5 low, RTX 5070 Ti): **end of
speech to Vera's first audio 1.8 to 2.8 s for short answers, about 2.1 s
typical; about 3 s for a long one.** That is Ears' 700 ms end-of-speech
pause (transcription adds 0 ms: it ran speculatively during the pause), the
brain's 0.9 to 1.7 s to its `speak` call, and Mouth's 0.2 to 0.3 s to the
first audio. `"args": ["--pause-ms", "550"]` would save 150 ms at the risk of
cutting into mid-sentence pauses.

## Decisions

- **Turns are queued, not dropped.** One brain turn at a time; utterances that
  pass the gate meanwhile are joined into the next turn. "Vera, stop" /
  "never mind" never queues: it stops speech, interrupts the turn, and clears
  the queue.
- **Follow-up window** opens when Mouth finishes (after `ears.tailMs`) and
  stays open `followUpSeconds`, measured against the utterance's `start` time.
  While Vera is speaking the window counts as open too (barge-in when
  half-duplex is off). A bare "Vera" chimes and opens the window.
- **Half-duplex (standalone):** with `ears.bargeIn: false`, Ears get `pause` on Mouth
  `start` and `resume` after `end` + `tailMs` (300 ms; Mouth's `end` already
  trails the sound by 150 to 200 ms). Chimes always pause them
  (`chimeTailMs` 150 ms after the chime ends), except an inbox chime while
  Shawn is mid-utterance, which waits for his final or `speech_cancel`
  (pausing would drop his sentence). Any transcript overlapping a deaf
  stretch is dropped as echo. Ears' extra lines (`speech_cancel`, `paused`,
  `resumed`, `latency_ms`) are handled; unknown line types are ignored.
- **v1 barge-in (standalone,** `ears.bargeIn`, default on): while Vera talks, Ears keep
  running and every partial and final is checked for the strict wake word
  followed by a stop phrase ("Vera, stop", "Vera, be quiet", "Vera, enough")
  that isn't in what she's saying (`findBargeIn` in `src/gate.ts`). A hit
  stops speech and the turn; everything else from that stretch is dropped,
  and Ears are reset when she finishes so her echo doesn't run into the next
  utterance. Tested with WAV fixtures: reliable with no echo (a headset);
  with her own voice mixed in at about -12 dB (a loudspeaker), Parakeet
  drops the overlapping "Vera, stop" entirely, so there barge-in never fires
  (and never false-fires: the echo is dropped). Real fix: echo cancellation
  with Mouth's output as the reference.
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
