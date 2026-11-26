# vera-voice

Vera v2's voice: a local TTS service that implements the **Voice service contract**
in [`DESIGN.md`](../../DESIGN.md). It streams calm, natural speech as f32 PCM over HTTP
on `127.0.0.1`, with a gentle plate reverb and a faint synthetic sheen. The App owns
volume. It replaced `vera/mouth` (v1), which has been removed.

**Default: Qwen3-TTS 1.7B on the GPU, voice `isla`, preset `vera`.** About 220 ms to
first audio, UTMOSv2 3.99, Whisper WER 0%, −20 LUFS, peaks under −3 dBFS.

## Setup and running

```powershell
powershell -ExecutionPolicy Bypass -File assistant\voice\scripts\setup.ps1   # once: uv, venv, ~5 GB of models
```

This installs uv if needed, creates `~/.assistant/voice/venv` (uv-managed CPython 3.12, CUDA
12.8 torch, locked by `uv.lock`), and downloads Qwen3-TTS 1.7B Base to
`~/.assistant/models/hf`. Run it again after
pulling changes (`-Dev` installs editable instead).

Start the service. `pythonw` has no console, and the service starts no child processes:

```powershell
& "$HOME\.assistant\voice\venv\Scripts\pythonw.exe" -m assistant_voice serve --port 7314 --parent-pid <App PID>
```

- Port **7314** by default (`voice.port` in `~/.assistant/config.json`, or `--port`).
- `--parent-pid` makes the service exit as soon as that process is gone, so a crashed App
  never leaves 5 GB of VRAM held. `Scripts\pythonw.exe` is the venv launcher: it runs
  the real interpreter as a child in a job object, so killing the launcher kills both.
- It answers `/v1/health` at once with `ready: false`, loads and warms the model
  (about 20 s cold, faster once the files are cached), then reports `ready: true`.
- Logs go to `~/.assistant/logs/voice.log`.

Command line (from a terminal):

```powershell
$py = "$HOME\.assistant\voice\venv\Scripts\python.exe"
& $py -m assistant_voice say "On it. I'll ping you when it's done." [--voice isla] [--preset P] [--out x.wav] [--volume 0.7]
& $py -m assistant_voice voices
& $py -m assistant_voice calibrate                  # re-measure loudness gains (normally automatic)
& $py -m assistant_voice add-voice --id sam --name Sam --clip sam.mp3   # your own voice (see below)
& $py assistant\voice\scripts\test_service.py [--voice eli] [--play]   # against a running service
& $py -m unittest discover -s assistant\voice\tests  # model-free tests: text, DSP, silence shaping
```

`~/.assistant/config.json`, all optional: `{"voice": {"port": 7314, "voice": "isla", "preset": "vera"}}`.

## API

| | |
| --- | --- |
| `GET /v1/health` | `{"ready": true, "voice": "isla", "preset": "vera", "sample_rate": 24000, "engines": ["qwen"], "error": null}` |
| `GET /v1/voices` | `{"default": "isla", "default_preset": "vera", "sample_rate": 24000, "voices": [{"id", "name", "engine", "gender", "accent", "description", "preset", "user", "available"}], "presets": [{"id", "description"}]}`. `preset` is the voice's own (or the default); `user` marks a voice made with `add-voice`. |
| `POST /v1/voices/reload` | Reads the voice list again (user voices added or removed) and answers like `GET /v1/voices`. No restart needed. |
| `POST /v1/speech` | body `{"text": "…", "voice"?: "isla", "preset"?: "vera"}`. Returns 200 with chunked raw **f32le mono** PCM. Headers: `X-Sample-Rate: 24000`, `X-Channels: 1`, `X-Sample-Format: f32le`, `X-Voice`, `X-Preset`. |

- **Streaming.** Text is split into sentences (a long first sentence is cut at a clause).
  Each sentence streams in about 0.5 s chunks as Qwen generates it, at about 3× real
  time, so playback never waits after the first chunk.
- **Cancel** by closing the connection. Synthesis stops at the next chunk, and the next
  request's first audio arrives in about 500 ms.
- **Errors.** An unknown voice or preset returns 400 `{"error"}`. A request made before
  the service is ready returns 503. Text with nothing speakable (only a code block)
  returns 200 with an empty body.
- One synthesis runs at a time on the GPU, and concurrent requests queue.
- **Levels.** Output is about −20 LUFS integrated, true peak under −3 dBFS (sample
  ceiling −3.8). The volume is the App's to apply. Pauses between sentences are fixed
  at 220 ms, and leading silence is trimmed to 15 ms. A short-window leveler
  (`dsp.Leveler`) evens out loudness within a reply: it pulls a gated ~300 ms level
  toward the mean level of the reply so far, boosting up to 6 dB and cutting up to 3 dB
  (time constants 50 ms down, 150 ms up), plus a 0.8 dB make-up for the level that evening
  out costs. Pauses, breaths and room noise (20 dB under that mean)
  neither move it nor get boosted. It runs on every streamed chunk with state carried
  across sentences, after the voice's calibrated gain, so each voice still sits at
  −20 LUFS overall. Calibration is measured without it.
- **Degeneration guard** (`guard.py`). Qwen3-TTS sometimes never ends a sentence: it
  stutters on one sound, then babbles in something that isn't speech, until its context
  is full (a minute of audio; it happened to Tony on "approval-required"). Each sentence
  is capped at `1.5 s + 0.1 s × characters` of audio (a digit counts as four), and while it streams the service
  watches for the codec tokens looping or recurring (a stutter), the audio running past that
  budget, and the voicing collapsing (under 20% of 40 ms frames pitched over the last
  2 s). The newest audio of each sentence is held back from the client, up to half of
  what the client already has buffered (2.5 s at most), so the first audio still goes
  out at once and a caught sentence usually never reaches the speaker. A caught sentence
  is dropped and said again with safer sampling (temperature 0.45, top-k 20, top-p 0.85,
  repetition penalty 1.1, another seed), then in the voice's base voice (`base` in
  `voice.json`, else Eli or Isla by gender), then skipped. If some of it had already
  played, it restarts after a 300 ms pause. Every catch is a `WARNING` in `voice.log`
  ("degenerate speech caught …" with the reason and the sentence), and the request's
  `spoke …` line counts the sentences regenerated. Nothing chimes.
- **Text shaping** (`text.py`): markdown and fenced code are stripped, URLs become
  "a link", a few acronyms are respelled (`T3` → "T three", `CLI`, `JSON`, `PR`…), and
  hyphens between words become spaces ("approval-required" → "approval required").
  Qwen reads numbers, times, and versions well on its own.

## Voices

| id | | preset | notes |
| --- | --- | --- | --- |
| **isla** (default) | British, female, calm | `vera` | Vera's voice; best scores, softest top end |
| alfred | British, older male butler: low, warm, unhurried, dry wit | `vera` | |
| jarvis | British male assistant: smooth mid-low, precise, faintly wry | `sheen` | |
| optimus | American, very deep, slow, grave and noble | `robot` | subtly mechanical; still 0% WER |
| buzz | American, earnest heroic mid-baritone, can-do bravado | `vera` | |
| saul | American, fast-talking slick salesman, slightly nasal | `vera` | |
| eli | American, male, calm | `vera` | |

Every voice is Qwen3-TTS and needs a CUDA GPU. Without one, `/v1/voices` marks them
`available: false` and `/v1/health` reports why. (The Kokoro CPU fallback was removed with
its two voices; nora and june were removed too.)

**Presets per voice.** A voice may name its own effects preset in `voices.json`
(`"preset": "robot"`). A request's `preset` wins, then the voice's own, then the service
default (`vera`, or `voice.preset` in config). `/v1/voices` reports each voice's
resolved `preset`.

**How the voices were made.** Qwen3-TTS VoiceDesign (1.7B) builds a voice from a text
description. The descriptions are in `assistant_voice/voices/*.design.txt`, and they
describe only timbre, age, accent and delivery: an archetype, never a real person, and
no recording of anyone was used. Isla, Eli, and the old voices asked for a calm, even,
low-emotion delivery; the persona voices (alfred, jarvis, optimus, buzz, saul) ask for
their character. For each persona voice, two descriptions × two to three seeds were
rendered on a reference line in its own register (`*.txt`), the takes measured for pitch
and pace, a shortlist cloned over five varied lines, and the take with the most
consistent pitch across lines and 0% Parakeet WER kept as the ~10 s reference clip
(`voices/*.wav`). At runtime Qwen3-TTS **Base** clones that clip, so the voice is
identical on every call. Sampling is seeded per sentence, so the same text is always read
the same way. Adding a built-in voice means dropping a clip and transcript in `voices/`
and listing it in `voices.json`; for your own voices see "Your own voices" below.

Persona voices through the service (five lines each, own preset, Parakeet via
`hex transcribe`, 2026-11-25):

| voice | preset | WER | LUFS | F0 median | pitch spread | words/s |
| --- | --- | --- | --- | --- | --- | --- |
| isla | vera | 1.2% (Codex → "Todex") | −20.7 | 182 Hz | 3.1 st | 3.5 |
| alfred | vera | 0% | −20.7 | 83 Hz | 3.6 st | 3.2 |
| jarvis | sheen | 0% | −19.5 | 91 Hz | 3.8 st | 3.2 |
| optimus | robot | 0% | −20.3 | 89 Hz | 3.3 st | 2.7 |
| buzz | vera | 0% | −20.9 | 130 Hz | 3.7 st | 3.8 |
| saul | vera | 0% | −20.1 | 175 Hz | 4.5 st | 3.7 |

## Your own voices (`add-voice`)

```powershell
& $py -m assistant_voice add-voice --id sam --name Sam --clip D:\clips\sam.mp3 [--text "what it says"] [--start 62.5 --end 75] [--preset natural]
```

- **Any length.** A clip over about 15 s (minutes are fine) is cut automatically to its
  cleanest 6–15 s stretch, preferring about 12 s. An energy VAD marks speech; the span
  starts and ends at pauses of 300 ms or more (sentence boundaries); candidates are
  scored for quiet pauses (music or noise under the voice keeps the floor up), a natural
  amount of pausing (wall-to-wall sound is likely music), one steady speaker (the spread
  of each sentence's median pitch), and no clipping. It prints the span it chose and why;
  `--start/--end` (seconds) override it. A short clip is used whole, with silence trimmed.
- The span is high-passed, levelled to about −23 LUFS with a −1.5 dBFS peak cap, and
  saved as 16-bit 24 kHz WAV.
- **Transcript.** Without `--text`, Parakeet transcribes the span through Hex's CLI
  (`hex transcribe`; found via `--hex`, `$ASSISTANT_HEX`, `PATH`, or the installed copy
  under `%APPDATA%\hex\versions`). Cloning needs the transcript to match the audio, so
  check the printed text and pass `--text` if it's off.
- **Where it goes.** `~/.assistant/voices/<id>/`: `ref.wav`, `ref.txt`, `voice.json`
  (name, description, optional preset, the clip's hash and source span) and
  `calibration.json` (the loudness gains for every preset, measured on the spot, so
  it plays at −20 LUFS like the built-in voices). Never in the repo.
- **Overrides.** A user voice with a built-in id (say `alfred`) replaces the built-in
  one; delete its folder to get the built-in back. Its calibration is keyed by the clip's
  hash, so replacing a clip never reuses old gains.
- **Picking it up.** The service loads user voices at startup, and `add-voice` calls
  `POST /v1/voices/reload` on the running service when it's done (`--no-reload` skips
  that). Removing a folder takes effect at the next reload.
- Use recordings you have the right to clone. The service only reads what you give it.

Tested on 2026-11-25 with a 36 s clip built from Isla lines (8 s of music, two sentences
over a music bed, three clean sentences, more music): it chose 0:18.9–0:29.5, exactly
the three clean sentences; Parakeet's transcript was word for word; the cloned voice
read a new line at −20.6 LUFS and came back from Parakeet word for word.

## Samples (`samples/`)

Line 1: "On it. I've asked Codex to check the build, I'll ping you when it's done."
Line 2: "Your T3 thread on the hex fork needs an answer: should it keep the old shortcut?"

`<voice>-<preset>-<line>.mp3`, for example `isla-vera-1.mp3`, for isla and eli × vera,
natural, and synthetic. (The tables below are from before the persona voices and still list
the removed nora and heart for comparison.)

Numbers are means over six lines rendered through the real service pipeline (the two
above plus four more in `bench/lines.json`). First audio is warm and measured from the
request to the first processed chunk, for "On it." / line 1 / line 2. RTF is synthesis
time divided by audio length.

| voice | preset | UTMOS | UTMOSv2 | WER | LUFS | true peak | pitch spread | 2–5 kHz / 5–10 kHz energy | first audio | RTF |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **isla** | **vera** | 4.42 | **3.99** | 0.0% | −20.9 | −3.4 | 3.2 st | 1.1% / 0.8% | 219 / 224 / 218 ms | 0.37 |
| isla | natural | 4.46 | 4.09 | 0.0% | −19.9 | −3.4 | 3.3 st | 1.1% / 0.8% | 219 / 224 / 218 ms | 0.38 |
| isla | synthetic | 4.24 | 3.72 | 0.0% | −19.7 | −3.4 | 3.2 st | 1.1% / 0.7% | 219 / 224 / 218 ms | 0.36 |
| nora | vera | 4.43 | 3.70 | 0.0% | −20.7 | −3.3 | 2.9 st | 2.1% / 0.7% | 212 / 224 / 232 ms | 0.37 |
| nora | natural | 4.47 | 3.96 | 0.0% | −20.7 | −3.3 | 2.9 st | 2.1% / 0.7% | 212 / 224 / 232 ms | 0.37 |
| nora | synthetic | 4.30 | 3.39 | 0.0% | −20.8 | −3.3 | 2.9 st | 2.1% / 0.7% | 212 / 224 / 232 ms | 0.35 |
| eli | vera | 4.44 | 4.03 | 0.0% | −19.8 | −3.3 | 4.9 st | 1.8% / 0.5% | 222 / 223 / 224 ms | 0.36 |
| eli | natural | 4.47 | 4.09 | 0.0% | −19.8 | −3.3 | 4.8 st | 1.8% / 0.5% | 222 / 223 / 224 ms | 0.36 |
| eli | synthetic | 4.35 | 3.74 | 0.0% | −19.9 | −3.3 | 5.0 st | 1.8% / 0.5% | 222 / 223 / 224 ms | 0.34 |
| heart | vera | 4.43 | 3.69 | 2.1% | −19.7 | −3.1 | 2.9 st | 2.7% / 2.7% | 165 / 165 / 405 ms | 0.14 |
| *isla* | *raw (no effects)* | 4.46 | 4.06 | 0.0% | −19.6 | −3.3 | 2.8 st | 1.3% / 1.1% | | |
| *heart* | *raw (no effects)* | 4.49 | 4.12 | 2.1% | −19.7 | −3.2 | 3.0 st | 3.1% / 4.0% | | |

How the columns were measured:

- **UTMOS** is `utmos22_strong` (SpeechMOS) and **UTMOSv2** is the 2024 model. Both
  predict a 1–5 naturalness MOS. Modern TTS saturates UTMOS near 4.5, so UTMOSv2
  separates the candidates better. Both penalize reverb hard, because they're trained to
  reward clean, dry speech, so read the preset rows as *the cost of the effect* and
  compare against the voice's raw row.
- **WER** is Whisper large-v3 on the processed output. heart's 2.1% is one word:
  Kokoro's "pasta's" is heard as "pasta is".
- **LUFS** is BS.1770 integrated loudness. **True peak** is measured at 4× oversampling.
- **Pitch spread** is the standard deviation of voiced F0 in semitones (pyin). Lower is
  more even-keeled.
- **2–5 kHz / 5–10 kHz energy** is the share of spectral energy in the harshness and
  sibilance bands. Lower is gentler on the ears.

### Why isla + vera is the default

- **It sounds the most human of everything measured.** isla has the highest UTMOSv2 of
  any voice once effects are on (3.99), and with no effects (4.06) it beats Kokoro
  af_heart's raw output in v1's setup (3.82, measured the same way without the service
  pipeline; see the engine survey).
- **It's the gentlest on the ears.** It has the lowest energy of every voice in the
  harshness band (1.1%) and low sibilance (0.8%). af_heart has 2.5× and 3.4× as much.
  v1's harshness came mostly from the top end and from the pitch processing.
- **It's calm.** Its pitch spread is 3.2 semitones, close to af_heart's 2.9, without any
  pitch processing. The prompt asked for "calm, measured and even, low emotional
  intensity", and the scores bear that out.
- **The vera preset costs it almost nothing:** −0.07 UTMOSv2 and no WER. The same preset
  costs nora −0.24 and heart −0.43.
- 0% WER, about 220 ms to first audio, and −20.9 LUFS / −3.4 dBTP, all within the
  contract.

**Runner-ups (at the time).** nora (since removed) had the flattest pitch (2.9 st) and an American accent; it suited
isla's British accent isn't wanted. eli is the best male option (UTMOSv2 4.03), though
his pitch is livelier (4.9 st). Switch with `"voice"` in the request or in config.

## Engine survey

These are raw engine outputs (no effects) on the same six lines, measured on this
machine (RTX 5070 Ti, Ryzen 9 9900X). Latency is warm and non-streaming: the full
synthesis time for "On it." and for one 9-word sentence.

| engine (licence) | best voice | UTMOS | UTMOSv2 | WER | "On it." / sentence | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **Qwen3-TTS 1.7B Base, designed + cloned** (Apache 2.0) via faster-qwen3-tts (MIT, CUDA graphs) | gb_f → isla | 4.47 | 3.96 | 0% | 239 / 1190 ms (streams: ~220 ms to first audio) | **chosen**: most natural, calm by prompt, streams |
| Kokoro-82M v1.0 (Apache 2.0) | af_heart | 4.50 | 3.82 | 0% | 157 / 395 ms (CPU) | was the CPU fallback (removed); brighter and harsher, a little "TTS" |
| Qwen3-TTS CustomVoice presets | Aiden / Vivian | 4.43 / 4.49 | 3.60 / 3.52 | 0% | 790 / 4490 ms (plain HF) | the English preset speakers are expressive (Aiden 5.7 st), and the female ones are Chinese-native |
| Chatterbox Turbo 350M (MIT) | built-in | 4.33 | 3.66 | 2.1% | 273 / 734 ms | Turbo has no exaggeration control; flat delivery but lower quality, quiet output |
| Chatterbox 0.5B, exaggeration 0.25, cfg 0.4 (MIT) | built-in | 4.43 | 3.56 | 0% | 1440 / 3179 ms (RTF 0.98) | the explicit emotion knob set low, but still lively (4.5 st), harsh top end (5.6% in 2–5 kHz), too slow |
| Pocket TTS 100M (Kyutai; code MIT, weights CC-BY 4.0) | mary / jane | 4.40 / 4.45 | 3.55 / 3.32 | 1.4% | 262 / 694 ms (CPU) | good for CPU, below Kokoro and Qwen |

I also looked at, but didn't benchmark:

- **Orpheus 3B**: built for emotion, with laugh and sigh tags, the opposite of what we
  want, and heavy.
- **IndexTTS-2.5**: has an emotion vector, but its bilibili licence restricts use.
- **Fish Audio S2 Pro**: research licence and 24 GB VRAM.
- **F5-TTS and XTTS-v2**: non-commercial weights.
- **Dia, CosyVoice 3, VibeVoice**: research-only or cloning-first.
- **Supertonic 3**: OpenRAIL use limits, and its quality is around Kokoro's.

Qwen3-TTS through plain Hugging Face `generate` runs at RTF 1.6 here, which is too slow.
faster-qwen3-tts captures the decode step as CUDA graphs and brings it to RTF 0.31 with
real streaming. That's what makes the 1.7B model conversational.

The bench scripts are in `bench/`. `gen.py` renders an engine's voices, `qwen_design.py`
designs reference voices, `render.py` renders through the service pipeline, `ablate.py`
measures each effect stage, and `score.py` computes UTMOS, UTMOSv2, WER, loudness,
spectrum, and prosody. They run from their own venvs under `~/.assistant/voice/bench/`;
nothing is committed but the scripts.

## Effects (`dsp.py`)

There is no pitch processing at all. v1's PSOLA pitch flattening was the likeliest
cause of its artifacts, and the calm now comes from the voice itself. The chain is
causal and stateful, so sub-sentence chunks process the same as whole clips (a test
checks this):

1. High-pass at 70 Hz.
2. Tone: −1 dB at 3.2 kHz, and a split-band **de-esser** above 5 kHz (up to 3–4 dB,
   only when that band dominates).
3. **Tint**: a 3 ms feedback comb (a faint metallic resonance, band-limited to
   400 Hz–6 kHz) plus a slow, shallow chorus copy (9 ms ± 0.25 ms, 0.3 Hz).
4. **Loudness**: a fixed per-voice gain to −20 LUFS. It's calibrated once per
   voice × preset over three sentences and shipped in `voices/calibration.json`, so
   levels never pump between or within sentences.
5. **Plate reverb**: convolution with a synthetic plate (dense noise, darker as it decays,
   16 ms predelay, wet band 250 Hz–6 kHz). The tail carries across sentences and is
   faded out at the end.
6. A lookahead peak limiter with a −3.8 dBFS ceiling.

| preset | reverb (wet / RT60) | comb | chorus | measured cost (isla, UTMOSv2) |
| --- | --- | --- | --- | --- |
| `natural` | 0.06 / 0.5 s, darker | — | — | +0.03 |
| `vera` (default) | 0.10 / 0.6 s | 4% | 6% | −0.07 |
| `synthetic` | 0.14 / 0.8 s | 9%, more feedback | 12%, deeper | −0.34 |
| `sheen` (jarvis) | 0.10 / 0.6 s | 8%, 2 ms (brighter) | 9% | not scored |
| `robot` (optimus) | 0.13 / 0.8 s | 12%, 5 ms, more feedback | 6% | not scored; plus a 16% ring modulator at 55 Hz and +1.5 dB warmth |

These came from an ablation on isla. The first draft of `vera` (reverb 0.16 / 0.75 s,
comb 5%, chorus 10%) cost −0.48. Reverb was most of that: 0.16 wet cost −0.5 on its
own, 0.10 cost −0.1, and 0.07 cost nothing. The tint stages at 3–5% cost about −0.1
each. If Shawn wants more character, `synthetic` is the place for it, and every field
of a preset is in one dataclass.

## Pronunciation (`lexicon.py`)

Every line goes through `text.normalize`, which applies the lexicon before
sentences are cut: tech terms, names, and acronyms the way Shawn says them
(T3 is "T three", GitHub "Git Hub", JSON "Jason", npm "N P M", CLI "C L I",
Qwen "Kwen", ID "I D" but never I'd), units after numbers ("200 ms" is "200
milliseconds"), and heteronyms only where their company makes the meaning
certain ("lead pipes", "lead azide", "made of lead.", "have read", "live
music", "wind up the cord", "tear down", "bass guitar", "close to"). A bare
"lead" or "read" is left alone: the brain is told to respell heteronyms by
meaning itself (the `speak` tool and `prompts/system.md`), and a wrong guess
here would be worse than none. `~/.assistant/voice/lexicon.json`
(`{"Word": "how to say it"}`) adds or overrides whole-word terms, no restart
needed.

**Checking it** (`scripts/pronunciation_check.py --url <service> --hex
target/ears-dev/hex.exe --out <dir>`): synthesizes test lines and runs them
through Vera's own ears (`hex assistant-audio transcribe`, Parakeet). That's an
imperfect check: speech to text writes what it thinks was *meant*, so "the
lead pipes" comes back "lead" however it was said. So heteronyms are checked
in rhyming carriers, where the recognizer spells what it hears ("bed, led,
and fed" comes back "led" only for /lɛd/), sentences are checked word for
word (accepting either spelling of the heteronym, so a respelling never
garbles a line), and terms against their accepted forms. Results on
2026-11-25 (isla, `vera` preset): 25 checked, 24 pass, 5 informational.

- Respellings confirmed by sound: "led" (bed, led, fed comes back "led";
  bead, lead, feed comes back "lead"; Shawn's "led azide detonation" line came
  back "led"), "base", "tare" (heard "tear", care/bare rhyme), "kloce".
- Two respellings were changed because of it: "wynd" was heard as "win",
  and "clohss" as "closed"; "wined" and "kloce" come back right. Plain "close
  to the end" was itself said as the verb ("closed to"), so the lexicon
  respells "close to" and friends.
- Informational (the recognizer spells both sounds the same): "red" (comes
  back "read"), "lyve" ("live"), "wined" ("wind"), "woond" ("wound"),
  "duv" ("duve").
- The one failure is a real limit: the voice says plain "bass" as "base" even
  for the fish ("we caught a base in the lake"), and no respelling tried
  ("bas", "bahs", "bas-fish") fixed it in a sentence; only "sea bass" comes
  out right. The prompt says so.
- Terms all pass (T3, GitHub, JSON, npm, CLI, Codex, "Shawn" heard as
  "Sean", "Vera", "200 milliseconds").

## Known issues

- **GPU memory.** The service holds about 5.5 GB of VRAM and about 3 GB of RAM while
  running (the 1.7B model, CUDA graphs, and a 1024-token cache). That fits beside Ears'
  Parakeet on the 16 GB card. If it ever doesn't, the 0.6B Base model would roughly
  halve it, at some cost in quality.
- **First request after idle.** The first request after the GPU has been idle can take
  about 350 ms instead of 220 ms while clocks ramp up.
- **Short utterances are quieter.** One-word utterances such as "Okay." measure about
  −25 LUFS. That's normal for a single word under gated loudness; they sound level with
  the rest.
- **Cancel latency.** Cancelling takes effect at the next chunk (up to about 0.5 s of
  GPU work), so a new request right after a cancel waits that long.
- **Prosody varies between texts.** Qwen is a sampling model. Seeding makes each text
  deterministic, but prosody still varies a little from one text to another. It isn't
  as rigidly even as v1's flattened pitch, and that's on purpose.
- **Dependencies.** `qwen-tts-hf` pulls in gradio and onnxruntime, which the service
  never imports at runtime. It also imports `sox`, which shells out to `sox -h` on
  import; the service stubs that module out and also forces `CREATE_NO_WINDOW` on any
  child process, so no console can flash.
- **transformers is pinned to 5.15.1.** 5.24 breaks the Qwen tokenizer (an
  `upsample` property error).
- **Unofficial runtime.** faster-qwen3-tts is a community project (MIT), not Qwen's.
- **Measured, not listened to.** The scores come from MOS predictors and ASR. Nobody
  listened to these voices during development, so Shawn's ears are the real test: the
  samples are there for that.
