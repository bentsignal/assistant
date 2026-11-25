# @vera/mouth

Vera's voice: local neural text to speech with a light synthetic character,
low-latency playback with instant stop, and soft earcons. Fully local and
free. Implements the **Mouth** contract in [`VERA.md`](../../VERA.md).

```sh
pnpm --filter @vera/mouth run setup        # download the voice to ~/.vera/models (350 MB, once)
pnpm --filter @vera/mouth say "On it. I'll ping you when it's done." [--preset vera|dry|robot+|plain] [--voice af_heart] [--out file.wav] [--timing]
pnpm --filter @vera/mouth say --chime notify
pnpm --filter @vera/mouth say --plan "Text to check normalization"   # no model needed
pnpm --filter @vera/mouth test             # unit tests: splitting, normalization, DSP
pnpm --filter @vera/mouth test:playback    # real speakers: latency, stop, events, orphans
pnpm --filter @vera/mouth samples          # re-render samples/
```

Note `run setup`: `pnpm setup` is a built-in pnpm command, so the bare
`pnpm --filter @vera/mouth setup` form runs pnpm's own setup instead.
`createMouth()` also downloads a missing model on first use
(`autoDownload: true`), so setup is optional.

Requires ffmpeg's `ffplay` on PATH (`scoop install ffmpeg`).

## Using it from Core

```ts
import { createMouth } from "@vera/mouth"

const mouth = await createMouth(config.mouth) // Partial<MouthConfig>, all optional
mouth.on("start", () => ears.pause())
mouth.on("end", () => ears.resumeAfter(tailMs))
await mouth.speak("On it. I've asked Codex to check the build.")
mouth.stop()                // barge-in: silent at once, speak() resolves, queue dropped
await mouth.chime("notify") // inbox ping; does not touch `speaking`
await mouth.close()
```

The package exports TypeScript source (`exports: ./src/index.ts`), so run Core
with `tsx` (or Node ≥ 22.18, or `node --experimental-strip-types` on 22.12).
The code uses only erasable syntax and `.ts` import specifiers.
`pnpm --filter @vera/mouth build` emits plain JS into `dist/` if needed.

`config.mouth` in `~/.vera/config.json` (every field optional):

```json
{
  "engine": "kokoro",
  "voice": "af_heart",
  "speed": 1,
  "preset": "vera",
  "effects": { "flatten": 0.45, "reverb": { "wet": 0.1 } },
  "volume": 1,
  "chimeVolume": 0.4,
  "numThreads": 6,
  "autoDownload": true,
  "player": { "command": "path/to/ffplay.exe", "warm": 2 }
}
```

`effects` overrides any field of the preset (see `src/dsp/effects.ts`). The
CLI reads the same `mouth` section.

### Behavior Core can rely on

- `speaking` turns true when the first audio goes to the player (about 50 ms
  before it's audible) and false when the player process exits, which is
  25 to 75 ms after the sound ends. A 120 ms silent pad sits after the reverb
  tail, so `end` never fires while sound is still coming out.
- `start` and `end` fire once per speaking stretch. `speak()` calls made while
  speaking are queued and play back to back as one stretch.
- `stop()` is synchronous: `speaking` is false and `end` has fired by the time
  it returns. The current and queued `speak()` promises resolve (they don't
  reject). A synthesis already running finishes in the background and is
  thrown away.
- Text that normalizes to nothing (only a code block, say) resolves at once
  with no events.
- `chime()` plays on its own player, can overlap speech, and doesn't change
  `speaking`. If Ears should not hear chimes, pause them around `await chime()`.
- Extras beyond the contract (`VeraMouth`): `render(text)` returns processed
  PCM without playing it; `plan(text)` returns the chunks; `lastTiming` holds
  the latency of the last `speak()`; `sampleRate`; `config`.

## Decisions (made overnight, without Shawn)

**Engine: Kokoro-82M v1.0 (fp32) through `sherpa-onnx-node`, pinned to 1.13.8.**
I benchmarked Kokoro (fp32 and int8), KittenTTS v0.8 (mini and nano), and
three Piper voices on this machine (Ryzen 9 9900X):

| engine             | "On it." | one sentence | RTF  | quality |
| ------------------ | -------- | ------------ | ---- | ------- |
| Kokoro fp32, 6 thr | 150 ms   | 260 ms       | 0.15 | best    |
| Kokoro int8        | 670 ms   | 1170 ms      | 0.72 | same    |
| Kitten mini v0.8   | 430 ms   | 850 ms       | 0.38 | below Kokoro |
| Piper medium       | 15 ms    | 40 ms        | 0.02 | clearly more robotic in the bad way |

Kokoro is the best-sounding small model and still fast enough on the CPU.
int8 is *slower* on x64 (dynamic quantization of the convolutions), so it uses
fp32. sherpa-onnx-node installs with prebuilt Windows binaries (no build
step). **It must stay on 1.13.x**: 2.0 removed the bundled espeak-ng
phonemizer, and its Kokoro silently drops every word missing from the
lexicon, including "Vera", "kubectl", and possessives like "Shawn's". Piper
stays supported (`engine: "piper"`) as a very light fallback.

**Voice: `af_heart`.** It's Kokoro's highest-graded voice. A rough
intelligibility check (Windows' built-in recognizer, `scripts/intelligibility.ts`)
scored it best: 20% word error raw and 28% with the `vera` preset, against
37% for `bf_emma` and 61% for `am_michael`. That recognizer is old and
US-accent biased, so only the ranking means anything. `bf_emma` has naturally
the flattest delivery (2.2 semitones of pitch spread vs 3.1) and is the
runner-up if Shawn prefers a British, calmer voice: set `"voice": "bf_emma"`.

**Character, default preset `vera`:**

- Pitch flattening with TD-PSOLA in TypeScript (`src/dsp/psola.ts`): each
  pitch period is pulled 45% of the way (in log frequency) toward the voice's
  own median, measured once at load. Timing and formants are untouched, so
  it sounds like the same voice, just calmer and steadier. Pitch spread on the
  test sentence goes from 3.1 to 1.75 semitones. With no change requested the
  algorithm reconstructs the input at better than 40 dB SNR, so it isn't
  smearing anything.
- A metallic tint: a 4.5 ms feedback comb blended in at 12%.
- A small, bright, short room (Freeverb, rescaled to 24 kHz, 14 ms predelay,
  wet band-limited to 350 Hz to 6 kHz) at a low level. The first version was
  wetter, and the recognizer measurably lost words (39% → 28% WER after
  trimming it), so it was cut back for kitchen use.
- Clarity EQ (high-pass 90 Hz, -2 dB at 280 Hz, +3 dB at 3 kHz), per-sentence
  leveling to -18 dBFS RMS, and a lookahead limiter plus soft clip so nothing
  ever exceeds 0.99.

Other presets: `dry` (same character with no room: the most intelligible over
noise), `robot+` (85% flattening, half a semitone lower, stronger comb, a 70 Hz
ring-mod tint, a slightly bigger plate), and `plain` (only leveling and the
limiter).

**Latency.** Text is normalized, split into sentences (a long first sentence
is cut at a clause), and the first chunk plays while the rest synthesize on
sherpa's native thread. Measured on this machine: 160 to 200 ms from `speak()`
to the first PCM written for a short sentence, so about 210 to 250 ms to
sound. RTF is about 0.15.

**Playback: ffplay over stdin, pre-warmed.** A cold ffplay takes ~700 ms to
start on Windows, so the pool keeps two parked ffplay processes (about 27 MB
each) blocked on an empty stdin. Taking one makes sound in ~50 ms; `stop()`
kills it outright. The pool refills 1.5 s later so the spawn doesn't compete
with synthesizing the first sentence. Scoop's `ffplay.exe` is a shim that
runs the real binary as a child (killing the shim would orphan it), so Mouth
reads the `.shim` file and spawns the real exe. No orphans: `close()` kills
every player, a process `exit` hook kills any left, and if Node is killed
hard, parked players exit on stdin EOF and a playing one exits once it has
played what it already had (the live test checks all three).

**Chimes** are synthesized at load (`src/chimes.ts`): soft bell and marimba
partials, low-passed, with a touch of room, peak-normalized to `chimeVolume`.
`notify` is a rising G5 to E6 bell (friendly, "something's ready"),
`listening` a quick upward blip, `done` a falling E6 to A5 marimba, and
`error` two muted low notes, a minor third down, deliberately not alarming.

**Text normalization** (`src/text/normalize.ts`): markdown is stripped, fenced
code is never read, URLs become "a link", paths read as "audio dot R S in
dictation", identifiers are split (`createMouth` → "create Mouth"), acronyms
are spelled unless they're words (CLI → "C L I", JSON → "jason"), and
numbers, times, money, percentages, units, versions, ordinals, and years are
spoken naturally.

## Known issues

- Kokoro mispronounces some names and jargon its lexicon doesn't know (espeak
  guesses them). `RESPELL` in `normalize.ts` is the place to fix specific
  words.
- RAM: about 600 MB resident with Kokoro loaded.
- The intelligibility numbers come from Windows' old SAPI recognizer, which
  can't hear anything at a 5 dB kitchen SNR. They rank presets; they aren't
  absolute.
- `stop()` can't abort a synthesis already running inside sherpa (at most
  about half a second). It's discarded, but the next `speak()` waits for it.
- If Node is killed hard while speaking, the playing ffplay finishes the audio
  it already has before exiting (whole sentences are written ahead).
- Only English voices are wired up.
