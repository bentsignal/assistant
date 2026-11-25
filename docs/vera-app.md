# Vera app (`vera.exe`)

The Vera desktop app from VERA.md, built from this crate as a second
executable. It runs in the background like Hex: a tray icon, Hex's HUD only
while Vera is engaged, a card Vera opens and closes, and a Settings window.
Screens: [`docs/vera-screens/`](vera-screens/).

## Build and run

```sh
scripts/vera-app-build.sh          # target/release/vera.exe
scripts/vera-app-build.sh --dev    # target/ears-dev/vera.exe (fast rebuilds)
```

`Cargo.toml` lists `src/main.rs` as both the `hex` and `vera` bins (Cargo
warns that the file is in two targets; that's expected). `main` sends the
`vera` executable to `src/vera.rs` (`IS_VERA`, from `CARGO_BIN_NAME`).
`build.rs` embeds `resources/windows/vera.ico` and Vera's version info in
`vera.exe` only (`scripts/vera-icon.py` draws the icon).

| Command | What it does |
| --- | --- |
| `vera` | Starts Vera and opens Settings; if Vera already runs, opens its Settings and exits |
| `vera --hidden` | Starts in the tray only (the login launch) |
| `vera quit` | Quits the running Vera and everything it started (exit 3 if none runs) |
| `vera shots <dir> [--tray]` | Renders the screens into `<dir>`; `--tray` also opens the real tray menu for a moment and captures it |

GUI subsystem: no console ever. Child processes start with
`CREATE_NO_WINDOW`, so their own console children inherit a windowless
console and never flash one.

## Identity and coexistence with Hex

- Name, icon, and version info: Vera. Tray entry: its own (`VeraTray`).
- Single instance: `Local\Vera.App.<hash of VERA_HOME>` (Hex's is separate).
- Data: `~/.vera` (or `$VERA_HOME`). Hex internals running inside Vera use
  `~/.vera/app/hex` (`HEX_APPLICATION_SUPPORT_DIR`); speech models are read
  from the installed Hex's folder. Hex's settings and data are never written.
- Start at login: HKCU `Run` value `Vera` = `"<vera.exe>" --hidden`. On by
  default, except that a cargo build (an exe under `target\`) doesn't
  register itself until Settings or `app.startAtLogin: true` asks.
- HUD at the bottom edge by default (`app.hud: "top"` to move it), so it
  never sits on Hex's HUD at the top.
- Stop talking hotkey: `Ctrl+Alt+Space` (`app.stopHotkey`), a plain
  `RegisterHotKey` that Hex's keyboard hook and shortcuts (Right Alt,
  Ctrl+Alt+V, F9, Escape) don't overlap.

## Processes

`src/vera/child.rs` runs Core and the voice service hidden, each started
suspended, put in its own kill-on-close job object, then resumed, so nothing
they start can escape. They restart after 1, 2, 5, 10, then 30 s (the count
resets once a child has run a minute). Quitting closes Core's stdin, waits
1.5 s, then closes the job; a crashed Vera's jobs close with it. Stderr goes
to `~/.vera/logs/core.log` and `voice.log`; the app logs to
`~/.vera/logs/vera-app.log`.

- **Core**: `app.core.command` if set (argv), else
  `node --import tsx <repo>/vera/core/src/main.ts --stdio` in
  `<repo>/vera/core` (`app.core.entry`, `app.core.args` adjust it). Node is
  found on PATH; Core's packages must be installed (`pnpm install` in
  `vera/`). Env: `VERA_APP=1`, `VERA_VOICE_URL`.
- **Voice service**: `app.voiceService.command` if set, else the first of
  `src/server.ts`, `src/main.ts`, `src/index.ts` in `<repo>/vera/voice`, with
  `--port <app.voiceService.port>` (default 7314) and `VERA_VOICE_PORT`. The
  app polls `GET /v1/health` and lists voices from `GET /v1/voices`
  (`{"voices":[{"id","name"}]}`, a list of those, or a list of ids; health's
  `voice` alone otherwise).
- The repo is `app.repo`, else `$VERA_REPO`, else the first folder above
  `vera.exe` with `vera/core/package.json`.

`scripts/vera-fake-core.mjs` and `scripts/vera-fake-voice.mjs` stand in for
both (a scripted turn, a voice list, silence) to try the app alone.

## Protocol routing (VERA.md)

| From Core | To |
| --- | --- |
| `speak`, `stop_speaking`, `chime`, `set_volume` | the audio engine (`set_volume` is also saved as `app.volume`) |
| `hud` | the HUD: listening, thinking, speaking; `idle` lingers 0.7 s then leaves through Hex's done wipe; `working` stays hidden (the tray tooltip says it) |
| `show`, `hide` | the card (`hide` without `card_id` closes any) |
| `badge` | a blue dot on the tray icon and the tooltip |

The engine's `Ready`, `SpeechStart`, `Partial`, `Final`, `SpeechCancel`,
`BargeIn`, and `Playback` go to Core as the contract's events. The app also
shows Speaking as soon as playback starts and Listening on a barge-in,
before Core says so. Tray, Settings, and the hotkey send `ui` events:
`stop_talking`, `mute`/`unmute`, `settings_changed`, and `card_closed`
(with `card_id`). A Core that (re)starts is sent `ready` again, and `mute`
if muted.

## Settings and `~/.vera/config.json`

The app owns the `app` object and writes only these keys besides it, always
re-reading the file first so Core's keys survive: `brain.harness`
(`claude-code` or `codex`), `brain.<harness>.model`, and `wake.sensitivity`
(`strict`, `normal`, `relaxed`; Core decides what they mean), then sends
`settings_changed`.

```json
"app": {
  "microphone": null, "volume": 0.35, "voice": null,
  "startAtLogin": true, "stopHotkey": "Ctrl+Alt+Space", "hud": "bottom",
  "repo": null,
  "core": { "command": null, "entry": "vera/core/src/main.ts", "args": ["--stdio"] },
  "voiceService": { "command": null, "cwd": null, "port": 7314 }
}
```

Recent activity lists what Shawn said only once Core answered it (thinks or
speaks), so overheard speech never shows there. "Edit personality…" opens
`~/.vera/system-prompt.md` in the default editor (Notepad if none), seeding
it from Core's prompt when missing.

## Audio engine seam

`src/vera/audio.rs` is a stub until `vera/duplex` lands; replace that one
file. The app uses exactly:

```rust
VeraAudio::start(AudioConfig { microphone, volume, mic_muted, voice_url, voice })
    -> (VeraAudio, Receiver<AudioEvent>)
.speak(speak_id, text) .stop_playback() .set_volume(f32) .set_mic_muted(bool)
.chime(Chime) .levels() -> (mic_rms, out_rms)
AudioEvent: Ready{mic, engine} | SpeechStart{t} | Partial{text, t}
          | Final{text, start, end, during_playback} | SpeechCancel{reason}
          | BargeIn{speak_id} | Playback{speak_id, state: Started|Finished|Interrupted}
```

A microphone or voice change in Settings drops the engine and starts a new
one. `levels()` feeds the HUD about 30 times a second while it listens or
speaks: linear RMS, the output before Vera's volume.

## HUD

Hex's Dot scope, unchanged in look. `DictationIndicatorEvent::Vera` sets a
look from any state: Listening is Hex's recording braid (warm pearl, the
microphone), Thinking is Hex's processing flow (agent blue), and Speaking is
the recording braid in agent blue following Vera's output
(`Stage::Speaking`). Idle leaves through Hex's done wipe.
