# Vera Ears (`hex ears`)

Always-on local speech to text for Vera, built into this fork's `hex.exe`.
It opens the microphone, listens hands-free, cuts speech into utterances at
pauses, transcribes each one on Hex's own engine (Parakeet Unified English on
the GPU through Vulkan), and speaks the Ears JSON-lines contract from
[`VERA.md`](../VERA.md). Core does the wake-word gating; Ears transcribes
everything it hears.

Code: `src/vera_ears.rs` (microphone, engine, stdin/stdout),
`src/vera_ears/endpointer.rs` (where utterances start and end),
`src/vera_ears/utterances.rs` (what gets announced and when),
`src/vera_ears/protocol.rs` (the lines). Windows only for now; the code is
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
| `--pause-ms` | 700 | silence after speech that ends an utterance |
| `--hesitation-ms` | 1400 | a transcript that trails off mid-phrase waits this long after its speech for more (0: off) |
| `--min-speech-ms` | 120 | speech needed before an utterance starts |
| `--pre-roll-ms` | 300 | audio kept from before the onset |
| `--max-utterance-ms` | 30000 | longer utterances end at the next 300 ms pause (hard cut at 2×) |
| `--no-partials` | | no `partial` lines |
| `--vocabulary <a,b>` | `Vera` | Parakeet vocabulary bias; `--vocabulary ""` turns it off |
| `--vocabulary-boost` | `normal` | `off`, `light`, `normal`, `strong` |
| `--no-speech-check` | | skip Silero; announce every level-cut clip |

Environment, all optional: `HEX_EARS_MODELS_DIR` (default: the installed
Hex's `%LOCALAPPDATA%\hex\models`), `HEX_EARS_DATA_DIR` (default
`~/.vera/ears/hex`), `HEX_AUDIO_FIXTURE=<wav>` (play a WAV as the microphone,
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
   without one. The clip is onset − 300 ms to speech end + 240 ms.
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
4. **Hesitation joins**: a final whose text trails off mid-phrase (ends in a
   comma, or in words like "the", "and", "my", "Vera"; see
   `endpointer::trails_off`) is held until 1400 ms after its speech. Speech
   that starts inside that window continues the same utterance: the two
   transcripts are joined ("Vera, can you check on the" + "Hex thread for
   me" → one final, `start` from the first). A complete sentence is never
   held. Cost: a bare "Vera" or "Hey Vera" with nothing after it arrives
   1400 ms after its speech instead of 700 ms.
5. **Partials** are whole-clip runs of the clip so far every 400 ms (one in
   flight at a time, utterances under 20 s). A few seconds of audio takes
   tens of ms on the GPU, and unlike Hex's live streams they never compete
   with the final for the model (the engine closes a live stream whenever
   another clip runs).

## Coexisting with the installed Hex

`hex ears` sets its own data folder (`~/.vera/ears/hex`) before anything
reads one, never takes Hex's instance lock, never writes Hex's logs,
settings, or History, and only reads the installed Hex's models
(`%LOCALAPPDATA%\hex\models\parakeet-unified-en-0.6b-Q8_0.gguf` and
`silero-vad-v6.2-F32.gguf`). Nothing downloads. Both processes capture the
same microphone through WASAPI shared mode, and each holds its own copy of
the model on the GPU (about 0.7 GB of VRAM).

## Building

```sh
scripts/vera-ears-build.sh          # target/release/hex.exe
scripts/vera-ears-build.sh --dev    # target/ears-dev/hex.exe, fast rebuilds
```

From Git Bash. It needs the Vulkan SDK: installed without admin rights or
any system change at `D:\dev\tools\VulkanSDK` with
`vulkan_sdk.exe --root D:\dev\tools\VulkanSDK --accept-licenses --default-answer --confirm-command install copy_only=1`
(override with `VULKAN_SDK`), plus Visual Studio 2022's CMake and Ninja,
which the script finds. `ears-dev` is a Cargo profile that builds every
dependency (ggml included) optimized and Hex's own crate incrementally at
`-O0`. It's the same `hex.exe` as the app: `hex.exe` with no arguments still
opens the normal Hex window.

Tests: `cargo test --profile ears-dev --bin hex vera_ears` (same
environment as the script).

## Measuring without a human

`scripts/vera-ears/`:

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
