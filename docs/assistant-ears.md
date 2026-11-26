# Vera Ears (`hex ears`)

Always-on local speech to text for Vera, built into this fork's `hex.exe`.
It opens the microphone, listens hands-free, cuts speech into utterances at
pauses, transcribes each one on Hex's own engine (Parakeet Unified English on
the GPU through Vulkan), and speaks the Ears JSON-lines contract from
[`DESIGN.md`](../DESIGN.md). Core does the wake-word gating; Ears transcribes
everything it hears.

Vera v2 runs these same ears inside its duplex audio engine, on the
echo-cancelled microphone: see [`assistant-audio.md`](assistant-audio.md). Nothing
spawns `hex ears` as a process any more (that was v1's Core); it stays as a
tool for trying speech to text on its own.

Code: `src/assistant_ears.rs` (microphone, engine, stdin/stdout),
`src/assistant_ears/endpointer.rs` (where utterances start and end),
`src/assistant_ears/utterances.rs` (what gets announced and when),
`src/assistant_ears/protocol.rs` (the lines). Windows only for now; the code is
platform-neutral and Linux would need only the CLI wiring.

## Spawning it

```sh
C:\path\to\vera-voice\target\release\hex.exe ears
```

No arguments or environment are needed. stdout carries only JSON lines,
stderr carries logs (`HEX_EARS_LOG=hex=debug` for more). Closing stdin ends
it, as does `{"cmd":"shutdown"}`; it exits 0 within about 100 ms (up to 3 s
while a transcript is still on its way, which is then printed first).

| Flag | Default | Meaning |
| --- | --- | --- |
| `--device <fragment>` | system default, followed live | microphone by name fragment (`hex.exe ears --list-devices` lists them) |
| `--model`, `--language` | `parakeet_unified_en`, `en` | any installed Hex model, e.g. `parakeet_v3` |
| `--finished-ms` | 700 | silence that ends a question or exclamation (the endpointer's own pause) |
| `--pause-ms` | 1200 | silence that ends any other clean ending ("Check the hex thread.") |
| `--hesitation-ms` | 5000 | a transcript that trails off ("um", "and", "the", a comma) waits this long after its speech for more |
| `--max-wait-ms` | 8000 | the longest any of those waits (never over 15 s) |
| `--min-speech-ms` | 120 | speech needed before an utterance starts |
| `--pre-roll-ms` | 300 | audio kept from before the onset |
| `--max-utterance-ms` | 30000 | longer utterances end at the next 300 ms pause (hard cut at 2×) |
| `--no-partials` | | no `partial` lines |
| `--vocabulary <a,b>` | `Vera` | Parakeet vocabulary bias; `--vocabulary ""` turns it off |
| `--vocabulary-boost` | `normal` | `off`, `light`, `normal`, `strong` |
| `--no-speech-check` | | skip Silero; announce every level-cut clip |

Environment, all optional: `HEX_EARS_MODELS_DIR` (default: the installed
Hex's `%LOCALAPPDATA%\hex\models`), `HEX_EARS_DATA_DIR` (default
`~/.assistant/ears/hex`), `HEX_AUDIO_FIXTURE=<wav>` (play a WAV as the microphone,
looping, at real-time pace; for tests).

## Lines

The contract's lines, plus a few extras a parser that ignores unknown types
or fields loses nothing by:

```json
{"type":"ready","engine":"hex","model":"parakeet_unified_en","language":"en","device":"Headset Microphone (…)","backend":"NVIDIA GeForce RTX 5070 Ti (vulkan)","partials":true,"pause_ms":700}
{"type":"speech_start","t":1795580684764}
{"type":"partial","text":"Hey Vera, start a new","t":1795580686394}
{"type":"final","text":"Hey Vera, start a new thread in the hex project.","start":1795580684764,"end":1795580687764,"latency_ms":0}
{"type":"speech_cancel","t":1795580722782,"reason":"paused"}
{"type":"paused","t":1795580724292}
{"type":"resumed","t":1795580727792}
{"type":"error","message":"could not open the microphone (retrying): …"}
```

- `ready` comes once the model is loaded and the microphone delivered its
  first audio.
- `speech_start.t` and `final.start` are the speech onset; `final.end` is
  where the speech stopped (not when the pause ran out). `final.latency_ms`
  is from the pause running out to the line.
- Every `speech_start` is followed by exactly one `final` or one
  `speech_cancel` (reasons: `paused`, `microphone interrupted`,
  `microphone unavailable`, `no words`, `no speech`, `shutdown`). A final's
  text is never empty.
- `partial` comes every ~400 ms while an announced utterance goes on; each
  replaces the last.
- `error` is never fatal except right before the process exits with status 1
  (model missing, bad flags). Microphone failures retry on their own.
- `pause` drops the utterance being spoken (`speech_cancel`, reason
  `paused`) and ignores all audio until `resume`; transcripts of utterances
  that had already ended still arrive. `paused`/`resumed` acknowledge.

## How it decides

1. **Endpointing** (`endpointer.rs`): 20 ms frames against Hex's adaptive
   noise floor (`SpeechFrames`, from the meeting pause segmenter). An
   utterance starts after 120 ms of speech frames and ends after 700 ms
   (`--finished-ms`) without one. The clip is onset − 300 ms to speech end + 240 ms.
2. **Speech check**: `speech_start` waits until Silero (Hex's
   `speech_detector`, on the CPU) hears speech in the audio so far, checked
   every 160 ms; until then nothing is announced. A fan, a door, or music
   that passes the level gate but not Silero produces no lines at all.
   Typical delay from onset to the `speech_start` line: 150–300 ms (its `t`
   is still the onset).
3. **Speculative final**: 280 ms into a silence the clip is already complete
   (the tail is in hand), so it is transcribed right then, on the whole clip.
   If the pause runs out with no more speech, that transcript is the final,
   usually already back: `latency_ms` is 0 in every fixture run. Speech that
   resumes makes it stale and it is dropped.
4. **Patience** (`patience.rs`): the transcript decides how long the pause
   must run before the `final`, counted from the end of speech. A question
   or exclamation ("What's new?"): 700 ms. Any other clean ending ("Check
   the hex thread.", "Hey Vera"): 1200 ms, since Parakeet puts a full stop
   after almost every clip and can drop a spoken "um". A transcript that
   trails off (a filler like "um", "uh", "hmm", "like"; a conjunction,
   article, preposition or possessive like "and", "the", "to", "my", with
   or without the model's full stop; a trailing comma, dash or ellipsis):
   5 s. Every wait is capped at 8 s. Speech that starts inside the wait
   continues the same utterance: the transcripts are joined ("So I was
   thinking about the, um" + "hex thread" → one final, `start` from the
   first, the fragment's stray full stop dropped). Nothing is printed in
   between, so the caller keeps showing him listening. Shawn's complaint
   that set these: a 3 s "um" got answered. The App reads the same waits
   from `~/.assistant/config.json`'s `turn` (`finishedMs`, `pauseMs`,
   `unfinishedMs`, `maxMs`).
5. **Partials** are whole-clip runs of the clip so far every 400 ms (one in
   flight at a time, utterances under 20 s). A few seconds of audio takes
   tens of ms on the GPU, and unlike Hex's live streams they never compete
   with the final for the model (the engine closes a live stream whenever
   another clip runs).

## Coexisting with the installed Hex

`hex ears` sets its own data folder (`~/.assistant/ears/hex`) before anything
reads one, never takes Hex's instance lock, never writes Hex's logs,
settings, or History, and only reads the installed Hex's models
(`%LOCALAPPDATA%\hex\models\parakeet-unified-en-0.6b-Q8_0.gguf` and
`silero-vad-v6.2-F32.gguf`). Nothing downloads. Both processes capture the
same microphone through WASAPI shared mode, and each holds its own copy of
the model on the GPU (about 0.7 GB of VRAM).

## Building

```sh
scripts/assistant-ears-build.sh          # target/release/hex.exe
scripts/assistant-ears-build.sh --dev    # target/ears-dev/hex.exe, fast rebuilds
```

From Git Bash. It needs the Vulkan SDK: installed without admin rights or
any system change at `D:\dev\tools\VulkanSDK` with
`vulkan_sdk.exe --root D:\dev\tools\VulkanSDK --accept-licenses --default-answer --confirm-command install copy_only=1`
(override with `VULKAN_SDK`), plus Visual Studio 2022's CMake and Ninja,
which the script finds. `ears-dev` is a Cargo profile that builds every
dependency (ggml included) optimized and Hex's own crate incrementally at
`-O0`. It's the same `hex.exe` as the app: `hex.exe` with no arguments still
opens the normal Hex window.

Tests: `cargo test --profile ears-dev --bin hex assistant_ears` (same
environment as the script).

## Measuring without a human

`scripts/assistant-ears/`:

- `make-voices.ps1 -Out <dir>` speaks the test phrases with Windows SAPI.
- `build_scenario.py <voices> <out.wav>`: six requests with gaps, a fan-noise
  stretch, and one phrase over noise.
- `wake_scenario.py <out.wav> [--reverb] [--noise -42]`: 32 short "Vera"
  phrases, two voices, three speaking rates.
- `hesitation_scenario.py <out.wav>`: requests broken by thinking pauses.
- `run_scenario.py <hex.exe> <scenario.wav> [--pause-at S --resume-at S] [-- ears flags]`
  plays it as the microphone and lines up each expected utterance with its
  final.
- `live_smoke.py <hex.exe> [seconds]`: the real microphone.
