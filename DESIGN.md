# Assistant: design and contracts (v2)

Assistant is a hands-free voice front end for the coding agents Shawn already
pays for. She's called Vera by default (her name is a setting, below). You
talk, she listens locally, a thin "brain" agent decides what to do,
hands real work off to existing harnesses (T3 Code, Claude Code, Codex, Grok),
and talks back in a calm local voice. It's built for working in the kitchen:
hands busy and dirty, eyes and voice free.

This repo is a fork of [Hex](https://github.com/anomalyco/hex) (MIT). The
upstream remote is `upstream`, and our branch is `main`.

## What Shawn said about v1 (2026-11-25): the quality bar

v1 worked technically but was a bad experience. Don't repeat these mistakes:

- **No browser app, no terminal windows, no taskbar icon.** v1 opened an Edge
  `--app` window and left a console open. Vera must be a **background desktop
  app**: a Windows tray icon (the ^ overflow menu) with a small menu and a
  settings window, plus a **small HUD on screen only while Vera is engaged**,
  like Hex's visualizer. Otherwise nothing is on screen. No console window may
  ever flash, including for Vera's child processes (Node, `claude`, `codex`,
  `grok`, `t3.cmd`).
- **The UI must look like Hex.** Hex's UI is beautiful, and v1's panel was
  enormous, cluttered, and ugly. Reuse Hex's Rune UI, its theme, its HUD
  (`src/rune_hud`), and its tray and settings patterns. Keep things minimal,
  with nothing that isn't needed.
- **Vera can show things in a popup** (a small Hex-styled card window) that it
  opens when there's something to see, and **can close it itself** ("close
  that").
- **Always interruptible.** Shawn must be able to talk over Vera at any time
  and have it stop at once. That means full-duplex audio with echo
  cancellation. Half-duplex is gone.
- **Volume is Vera's own.** v1 was far too loud, and when asked to be quieter
  it turned down the Windows master volume. Vera has its own output volume
  (and a sensible, quieter default), adjustable by voice and in settings, and
  it never touches system volume.
- **The voice was bad on the ears.** Shawn now wants **a bit more human-like,
  natural speech, but calm and low on emotion**, keeping a *subtle* robotic
  tint and some reverb (he liked that part). v1's quality was poor: harsh,
  artifacty, loud.

## Her name

The product is **Assistant** (`assistant.exe`, `~/.assistant`, the
`assistant/` workspace, `ASSISTANT_*` variables). The persona's name is
`assistant.name` in `config.json`, default **Vera**, set at the top of
Settings (Enter applies it) or by voice ("Vera, call yourself Nova": the
brain's `set_name` tool). It applies live, nothing restarts:

- **Wake word** (`assistant/core/src/gate.ts`): the name itself wakes her
  anywhere in a sentence; a near miss (one letter off a name of four letters
  or more, starting alike, not a common word) wakes her only as the first or
  last word. Vera keeps her tuned list (vara, veera, bera, ..., "Variable,",
  "Hey there,") and only Vera does.
- **Speech to text** leans toward the name (the engine's vocabulary, from the
  next utterance).
- **The prompt**: the stock prompt says `{{name}}`, filled in when the brain
  starts; a rename restarts the brain before the next turn (Claude resumes its
  session). A custom prompt with the name written out keeps working as is.
- **The App**: the tray tooltip and menu, Settings' copy, alerts.
- **The voice**: `assistant.sayAs` respells the name when it's said wrong.

**Personas.** She has several names, `assistant.personas` in `config.json`:
`[{name, voice, style?}]`, by default Vera (`isla`), Alfred (`alfred`, a dry,
courteous English butler), Jarvis (`jarvis`), Optimus (`optimus`), Buzz
(`buzz`), Saul (`saul`) and Tony (`tony`); `assistant.name` is always the
first. Any name wakes her, each with its own fuzzy variants (Vera's tuned
list stays Vera's), and the gate says which one did. That persona answers:
each turn the brain gets is tagged `[Shawn is talking to Alfred]`, the prompt
lists the personas (`{{personas}}`, with their manner) so she lightly takes
one on, and every `speak` carries that persona's `voice`. Follow-ups, with no
name, stay with the last persona. Who answers changes only when he says a
persona's name as itself or asks for one (`switch_persona`); mishearings
that still wake her ("Vara", "Hey there,"), timeouts, and new sessions or a
restarted Core never switch it (it's kept in `core-state.json`). It's one agent with one conversation and
one memory; only the voice and manner change. `app.voice` is an explicit
override every persona speaks in (`set_voice` with a voice alone, or
Settings); `set_voice` "default" clears it. By voice: `set_name` renames,
adds or removes a persona ("add a persona called Max with the Optimus
voice"), and `set_voice` with a persona gives it its own voice ("make Jarvis
use the Eli voice"). A change to the personas restarts the brain before the
next turn, and Core tells the App with `name`.

The old data folder `~/.vera` is moved to `~/.assistant` on the first launch
of `assistant.exe` (an old `vera.exe` still running is asked to quit first),
and its old start-at-login entry is removed.

## Architecture

```ts
assistant.exe   (Rust, from this fork; Windows GUI subsystem, single instance, start at login)
 ├─ tray icon + menu:  Settings…  ·  Mute microphone  ·  Stop talking  ·  Quit
 ├─ HUD overlay        (Hex's rune_hud look; visible only while engaged)
 ├─ card popup         (Rune window; Vera opens and closes it)
 ├─ settings window    (Rune, Hex style, minimal)
 ├─ audio engine       mic ─▶ AEC (reference = Vera's own playback) ─▶ VAD/segmenter ─▶ Parakeet STT
 │                     TTS PCM ─▶ Vera volume ─▶ speakers   (+ barge-in: user speech stops playback)
 ├─ spawns, hidden ─▶ voice service   (text ─▶ PCM, local; see Voice)
 └─ spawns, hidden ─▶ assistant-core  (Node: wake gate, brain, MCP tools, jobs, T3), stdio JSON lines
                          └─ brain harness (claude -p / codex app-server, hidden) ─▶ Vera MCP tools
```

The installed Hex (3.4.0) keeps running beside Vera. Vera has its own app
identity, name, icon, tray entry, data dir (`~/.assistant/`), and single-instance
lock, and it never changes Hex's settings or data. It reads Hex's downloaded
models.

### HUD states

`idle` (hidden) → `listening` (after the wake word, or in the follow-up
window: shows his voice level) → `thinking` → `speaking` (shows Vera's output
level) → back to hidden after a short linger. `working` is a subtle state for
when a background job Vera started is running, if it fits Hex's style;
otherwise it stays hidden. An inbox item gets a chime and a tray badge, not a
spoken message.

### Barge-in

The mic stays live while Vera speaks. Its signal is echo-cancelled against
Vera's own playback. When something that could be the user is heard during
playback and it can't be Vera's echo (a headset), Vera plays on at full
level and stops only once the speech detector hears speech (about
300–400 ms); breathing and clicks never dip her. Where her echo reaches the
mic (speakers), the app ducks her at once to tell the two apart, and stops
playback once the speech is confirmed (about 250–300 ms) or restores the
volume if it was a false alarm. It then tells Core
`barge_in`. The transcript that follows is treated as an in-conversation turn,
so no wake word is needed. The tray "Stop talking" item and a global hotkey
also stop speech.

## App ⇄ Core protocol (stdio, JSON lines)

`assistant.exe` spawns Core (`node … assistant/core/src/main.ts --stdio`), hidden.

app → core:

```json
{"type":"ready","mic":"…","engine":"parakeet_unified_en","volume":0.7}
{"type":"speech_start","t":0}
{"type":"partial","text":"vera can you","t":0}
{"type":"final","text":"Vera, can you check on the hex thread?","start":0,"end":0,"during_playback":false}
{"type":"speech_cancel","t":0,"reason":"…"}
{"type":"barge_in","speak_id":"s12"}
{"type":"playback","speak_id":"s12","state":"started|finished|interrupted|failed"}
{"type":"ui","action":"stop_talking|mute|unmute|settings_changed|card_closed","card_id"?:"c3","volume"?:0.7}
```

core → app:

```json
{"cmd":"speak","speak_id":"s12","text":"On it. I'll ping you.","voice":"alfred"}
{"cmd":"stop_speaking"}
{"cmd":"hud","state":"idle|listening|thinking|speaking|working"}
{"cmd":"chime","kind":"notify|listening|done|error"}
{"cmd":"show","card_id":"c3","title":"…","markdown":"…"}
{"cmd":"hide","card_id":"c3"}
{"cmd":"set_volume","level":0.55}
{"cmd":"badge","count":2}
{"cmd":"error","what":"brain|brain_timeout|speech","message":"…"}
{"cmd":"name","name":"Nova"}
{"cmd":"voice","voice":"eli"}            (or null: each persona's own voice again)
```

**Nothing is ever left hanging** (v2's live test failed this way: an engine
restart dropped a playing line with no end, Core waited 35 s, and stale
replies piled up behind it):

- Every `speak` gets exactly one terminal `playback` (`finished`,
  `interrupted`, or `failed`), whatever happens: the App keeps a ledger of
  every line, ends each one past its deadline (12 s to start, 6 s + 0.15 s
  per character to play), and ends all of them when the audio engine stops.
  Speak ids are scoped to the Core that sent them, so a restarted Core never
  hears the old one's ends.
- Every `speech_start` gets its `final` or `speech_cancel`.
- Settings never restart the audio engine: a voice applies to the next
  `speak`, a volume at once, a microphone reopens only the input.
- **Never make him rush.** His turn ends on a pause that depends on how
  his words end: 0.7 s after a question, 1.2 s after any other clean
  ending, 5 s when they trail off ("um", "and", "the", a comma), never over
  8 s (`turn.finishedMs`, `pauseMs`, `unfinishedMs`, `maxMs` in
  config.json; Ears applies them, `src/assistant_ears/patience.rs`). Speech
  inside the wait is the same turn, and the HUD stays on listening. If he
  goes on after that but before any of her answer has played (within
  `turn.mergeSeconds`, 12 s, of his last words), Core holds her answer
  back; his new words, unless they wake her afresh with her name, join that
  turn and the answer to the first half is dropped (`assistant/core/src/turns.ts`).
  If she had only just begun (a barge-in within `turn.bargeMergeSeconds`,
  2 s, of her first audio), she stops and the same merge happens.
- When a new user turn starts, Core drops every line left from earlier
  turns (playing or queued), and a turn still running is cut and its brain
  interrupted. No reply ever plays after a newer question.
- A line Core sends while the voice service is still loading (the ~10 s
  after launch, or a restart) is held until the voice is ready, for up to
  20 s, and only then fails.
- Every failure is heard and seen (the App's `alerts`): the soft error
  chime, the HUD's coral error look, a coral dot and tooltip on the tray, and
  a red line at the top of Settings for a minute (or until fixed). Core says
  `error` for its own (the brain failed, or didn't answer within 45 s).
  Children restart with backoff (1, 2, 5, 10, 30 s), the audio engine too,
  and Settings says it's restarting. Only real failures alert (a device
  that goes away, a stream error, a child down, the brain failing): a
  microphone sending digital silence is not one (some headsets send zeros
  whenever nobody talks), so it gets at most a grey hint by the microphone
  picker after minutes of zeros with no speech heard since launch.
- The HUD leaves every look: Core's states all have exits, and the App
  hides a look that outstays its cap (listening 30 s after the last speech
  heard, never mid-utterance; thinking 100 s; speaking once nothing plays).

Volume level is 0–1 and is Vera's own output gain; the app owns and persists
it (`app.volume`) and sends it to Core on `ready` and `settings_changed`. The
scale is the audio engine's: level `v` is `40 × (v − 1)` dB under the voice
service's own level, so each 0.1 is 4 dB and 0 is silent. The default, 0.7
(−12 dB, about −32 LUFS), is roughly half as loud as v1. "Quieter" and
"louder" are steps of 0.15 (6 dB), 0.3 with "a lot". `failed` means the voice
service couldn't speak that line (the app chimes an error); Core treats it as
done, not as an interruption. The brain changes the volume only when Shawn
explicitly asks for louder or quieter, never on its own (not for "can you
hear me?", "hello?", or frustration).
Logs go to stderr, and the app writes them to `~/.assistant/logs/`. In
`--stdio` mode Core runs no web panel; a debug HTTP hook
(`POST /api/utterance`) may stay on localhost for tests.

## Voice service contract

A local process the app spawns (hidden), listening on `127.0.0.1`:

- `GET /v1/health` returns `{"ready":true,"voice":"…","sample_rate":24000}`
- `POST /v1/speech {"text":"…","voice"?:"…","preset"?:"…"}` streams raw
  little-endian f32 mono PCM, starting with the first sentence as soon as it's
  ready. The `X-Sample-Rate` response header gives the rate. Character effects
  (reverb, tint) are applied in the service. Volume is **not**; the app owns it.
  Output is loudness-normalized (about −20 LUFS) with peaks under −3 dBFS.
- `GET /v1/voices` returns `{"default", "voices": [{"id","name","engine","gender","accent","description","available"}], "presets": [{"id","description"}]}` for the settings window.
- `POST /v1/speech/warm {"items":[{"text","voice"?}]}` renders short lines (48
  characters at most) in the background and keeps them, so a later
  `/v1/speech` for the same voice, preset and text plays at once; any short line
  rendered in full is kept too (`phrases.py`). Core warms the personas'
  acknowledgements this way.
- Closing the speech connection cancels synthesis. Unknown voice or preset: 400.
- Implemented in `assistant/voice` (see its README). Setup: `assistant\voice\scripts\setup.ps1`.
  Spawn: `~\.assistant\voice\venv\Scripts\pythonw.exe -m assistant_voice serve --port 7314
  --parent-pid <app pid>` (no console; exits when the App does). Default voice `isla`,
  preset `vera` (others: `natural`, `synthetic`).

## Rules that shape the experience

- **Only the `speak` tool makes sound with words.** The brain's ordinary text
  is never spoken.
- **Words said right.** The voice reads text literally, so the brain respells
  heteronyms by meaning (lead the metal is "led", read in the past is "red",
  live the adjective "lyve", wind the verb "wined", close as in near "kloce"),
  and the voice service's lexicon (`assistant/voice/assistant_voice/lexicon.py`, plus
  `~/.assistant/voice/lexicon.json`) says tech terms, names, and acronyms the way
  Shawn does (T3, GitHub, JSON, npm, CLI, ...).
- **No dead air.** When a turn's first action is a slow tool, or nothing is
  spoken `turn.acknowledgeMs` (1.2 s) after Shawn stopped, Core says a short
  line for her in the persona's voice and manner ("One sec.", "One moment,
  sir."; `assistant/core/src/ack.ts`). Never on a quick answer or a turn that
  ends silently ("thanks"); her own opening "checking" is then dropped and the
  next tool result tells her. Barge-in cuts it like any line.
- **No unprompted talking.** Finished background work or a T3 thread that
  needs input gets a chime, an inbox item, and a tray badge. Threads she starts
  or sends to are watched on whichever machine they're on; a watched thread
  that finishes, fails or waits always notifies once, and one that can't be
  checked (machine unreachable, thread gone) is logged and reported once. Vera speaks only
  when asked ("Vera, what's new?"). The inbox digest goes to the brain with
  the next user turn.
- **Wake word** "Vera" (fuzzy matching; see `assistant/core/src/gate.ts`), or the
  follow-up window after Vera speaks, or a barge-in.
- **Thin brain.** The brain doesn't edit files and has no shell; it
  delegates. It runs programs only through its skills (`run_command`: a
  program some skill lists, no shell, bounded time and output) and uses the
  tools of the MCP servers she added herself.
- **Capabilities are config, never a rebuild.** Skills (CLIs), MCP servers
  (`mcp.json`) and her settings (`config.json`'s allowlisted keys) are all
  hers to add, remove and check by voice at runtime.
- **Never touches system settings** such as master volume unless explicitly
  asked to change that system setting.

## Routing (goes in the system prompt)

- Coding work in a project: start or continue a **T3 Code** thread (Shawn
  watches T3 side by side). Quick one-off file edits or questions about local
  code: `ask_claude`. Sends steer a running turn and start a turn on an idle
  thread by default (T3's mode `auto`; queue only when he asks), through T3's own MCP endpoint; threads on his other machines are
  reached by environment id. Feedback about Vera herself goes to the
  orchestrator thread (`t3.orchestratorThread` in `config.json`, Winserve's
  by default) with `send_feedback`.
- **Using the computer** (desktop apps, clicking around, browser automation):
  `ask_codex`. OpenAI models are best at computer use.
- **Searching X/Twitter**, or what people are saying right now: `ask_grok`.
- General web search: the brain's own web search tool.
- Vera's own volume: `set_volume`. Showing or closing visuals: `show` / `hide`.
- Confirm out loud before anything destructive or outward-facing.
- **Figure it out.** She looks projects and threads up herself (every linked
  machine, Winserve included) and acts; a short question only when it's truly
  ambiguous, and never "do it yourself" when a tool can.

## T3 access

Core's T3 MCP session is **full-access**: whatever Shawn can do in T3 Code,
she can (`t3_tools` lists T3's tools, `t3_tool` calls any of them). T3 caps
a session the CLI issues (`auth session issue --subject mcp-client`) at
approval-required, and only its OAuth approval sets a broader ceiling, so
Core runs that approval itself as Shawn: a five-minute session from his own
`t3` CLI approves Assistant's OAuth client (`/oauth/mcp/register`,
`/approval`, `/decision` with `browser-session` at `full-access`,
`/token`), as Approve on T3's agent sign-in page would. The session is cached
in `~/.assistant/t3-mcp-token.json` (30 days) and shows under Authorized
clients in T3's Settings › Sharing & access. If the grant fails, Core falls
back to an approval-required session; a cached session not marked
full-access is always replaced once a grant works (tried again on use, at
most every ten minutes). Every refusal tells her the one thing that fixes it
(`t3_reauthorize`, or re-linking a machine with `--access full-access`),
which she says plainly. `t3_reauthorize` ("fix your T3 access") finds the
`t3` CLI again (config `t3.cliPath`, `$T3CODE_CLI_PATH`, PATH, T3 Code's
`~/.t3/bin/t3.cmd`, then T3 Code's own app run as Node), drops the cached
session, re-runs the grant, and reports the access level, or exactly what's
missing. Work on a
linked machine is also capped by that link's access.

## Skills

Her skills are `~/.assistant/skills/<name>.md`: front matter (`name`,
`description`, `commands`: the programs `run_command` may run) and a body
(what it's for, exact commands, where config and auth live). All of them go
into the system prompt at `{{skills}}` (or at the end of a prompt without
it), so they survive app updates and prompt edits; a change restarts the
brain before the next turn. Tools: `skill_list`, `skill_read`,
`skill_save`, `skill_remove` (moves it to `skills/.removed`),
`skill_setup` (a background Claude Code job installs, checks, and writes the
skill file itself), and `run_command`. Core seeds `shawns-preferences` once
(where projects, coding, computer use and searches go); a removed seed stays
removed.

## MCP servers, settings and updates by voice

Her own MCP servers are `~/.assistant/mcp.json`, Claude Code's `mcpServers`
shape (stdio `command`/`args`/`env`, or `http`/`sse` `url`/`headers`, plus
`disabled` and `description`), merged after the Assistant server into the
brain's MCP config: Claude's `--mcp-config` (each one allowed by
`--allowedTools mcp__<name>`) and Codex's `-c mcp_servers.<name>=…` (no SSE
there). Secrets are references, `${VAR}` or `${file:path}`, resolved only
into the brain's owner-only config file, never shown or logged. A change
(hers, a job's, or by hand) restarts the brain before the next turn, keeping
the conversation. A server that's malformed, whose command isn't found, or
whose secret doesn't resolve is left out, and one the harness reports failed
is noted; either way she tells Shawn once. Tools: `mcp_list`, `mcp_add`,
`mcp_remove`, `mcp_enable`, `mcp_disable`, `mcp_test` (starts it, lists its
tools, stops it).

`config_get` / `config_set` read and change `config.json` keys from an
allowlist with a schema each (`src/settings.ts`): wake, turn, timeouts, job
models, `t3.*`, `app.updates.*`. The port, harness, names, voice and every
argv are refused. Each key says when it applies: now, at the brain's next
start, or when the App restarts.

Updates go through the installed launcher's CLI (`assistant update`,
`--install`, `--channel`): `update_status`, `update_check`, `update_channel`
(saves `app.updates.channel`), and `update_install`, which she announces
first because it restarts her. The install is started through WMI so it
outlives the App's job when the App quits; its output is
`logs/update-voice.log`. A repo build has no install and says so.

## User state (`~/.assistant/`, never in the repo)

`config.json`, `mcp.json`, `skills/`, `t3-mcp-token.json`, `system-prompt.md` (+ `prompt-history/`; Settings › General ›
Personality edits it in place, with Save and Revert to default, and Core picks
up the change from the next turn), `logs/`, `jobs/`,
`models/`, `ears/`.
