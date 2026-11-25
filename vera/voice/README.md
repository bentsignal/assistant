# vera-voice

Vera v2's voice: a local TTS service that implements the **Voice service contract**
in [`VERA.md`](../../VERA.md). It streams calm, natural speech as f32 PCM over HTTP
on `127.0.0.1`, with a gentle plate reverb and a faint synthetic sheen. The App owns
volume. It replaces `vera/mouth` (v1), which is still there for reference.

**Default: Qwen3-TTS 1.7B on the GPU, voice `isla`, preset `vera`.** About 220 ms to
first audio, UTMOSv2 3.99, Whisper WER 0%, −20 LUFS, peaks under −3 dBFS.

## Setup and running

```powershell
powershell -ExecutionPolicy Bypass -File vera\voice\scripts\setup.ps1   # once: uv, venv, ~5 GB of models
```

This installs uv if needed, creates `~/.vera/voice/venv` (uv-managed CPython 3.12, CUDA
12.8 torch, locked by `uv.lock`), and downloads Qwen3-TTS 1.7B Base to
`~/.vera/models/hf` and Kokoro to `~/.vera/models/kokoro-onnx`. Run it again after
pulling changes (`-Dev` installs editable instead).

Start the service. `pythonw` has no console, and the service starts no child processes:

```powershell
& "$HOME\.vera\voice\venv\Scripts\pythonw.exe" -m vera_voice serve --port 7314 --parent-pid <App PID>
```

- Port **7314** by default (`voice.port` in `~/.vera/config.json`, or `--port`).
- `--parent-pid` makes the service exit as soon as that process is gone, so a crashed App
  never leaves 5 GB of VRAM held. `Scripts\pythonw.exe` is the venv launcher: it runs
  the real interpreter as a child in a job object, so killing the launcher kills both.
- It answers `/v1/health` at once with `ready: false`, loads and warms the model
  (about 20 s cold, faster once the files are cached), then reports `ready: true`.
- Logs go to `~/.vera/logs/voice.log`.

Command line (from a terminal):

```powershell
$py = "$HOME\.vera\voice\venv\Scripts\python.exe"
& $py -m vera_voice say "On it. I'll ping you when it's done." [--voice isla] [--preset vera] [--out x.wav] [--volume 0.35]
& $py -m vera_voice voices
& $py -m vera_voice calibrate                  # re-measure loudness gains (normally automatic)
& $py vera\voice\scripts\test_service.py [--voice eli] [--play]   # against a running service
& $py -m unittest discover -s vera\voice\tests  # model-free tests: text, DSP, silence shaping
```

`~/.vera/config.json`, all optional: `{"voice": {"port": 7314, "voice": "isla", "preset": "vera"}}`.

## API

| | |
| --- | --- |
| `GET /v1/health` | `{"ready": true, "voice": "isla", "preset": "vera", "sample_rate": 24000, "engines": ["qwen"], "error": null}` |
| `GET /v1/voices` | `{"default": "isla", "default_preset": "vera", "sample_rate": 24000, "voices": [{"id", "name", "engine", "gender", "accent", "description", "available"}], "presets": [{"id", "description"}]}` |
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
  at 220 ms, and leading silence is trimmed to 15 ms.
- **Text shaping** (`text.py`): markdown and fenced code are stripped, URLs become
  "a link", and a few acronyms are respelled (`T3` → "T three", `CLI`, `JSON`, `PR`…).
  Qwen reads numbers, times, and versions well on its own.

## Voices

| id | engine | | first audio | notes |
| --- | --- | --- | --- | --- |
| **isla** (default) | Qwen3-TTS | British, female, calm | 220 ms | best scores, softest top end |
| **nora** | Qwen3-TTS | American, female, low and matter-of-fact | 225 ms | the flattest pitch of the Qwen voices |
| june | Qwen3-TTS | American, female, warm and a little brighter | 220 ms | |
| **eli** | Qwen3-TTS | American, male, calm | 225 ms | |
| heart | Kokoro (CPU) | v1's `af_heart`, without v1's processing | 165 ms | fallback; ~0.9 s on first use (loads Kokoro) |
| river | Kokoro (CPU) | `af_river`, very even | 155 ms | fallback |

The Qwen voices need a CUDA GPU. Without one, `/v1/voices` marks them
`available: false` and the default falls back to `heart`.

**How the Qwen voices were made.** Qwen3-TTS VoiceDesign (1.7B) builds a voice from a
text description. Each prompt asked for a calm, even, low-emotion voice (the prompts
are in `vera_voice/voices/*.design.txt`). I rendered three takes of one reference line
per prompt, scored them, and kept the best take as a fixed ~10 s reference clip
(`voices/*.wav`, with its transcript in `*.txt`). At runtime Qwen3-TTS **Base** clones
that clip, so the voice is identical on every call. Sampling is seeded per sentence, so
the same text is always read the same way. Adding a voice means dropping a clip and
transcript in `voices/` and listing it in `voices.json`.

## Samples (`samples/`)

Line 1: "On it. I've asked Codex to check the build, I'll ping you when it's done."
Line 2: "Your T3 thread on the hex fork needs an answer: should it keep the old shortcut?"

`<voice>-<preset>-<line>.mp3`, for example `isla-vera-1.mp3`. There are 18 files for
isla, nora, and eli × vera, natural, and synthetic, plus `heart-vera-*` for comparison
with v1's voice.

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

**Runner-ups.** nora has the flattest pitch (2.9 st) and an American accent; pick it if
isla's British accent isn't wanted. eli is the best male option (UTMOSv2 4.03), though
his pitch is livelier (4.9 st). Switch with `"voice"` in the request or in config.

## Engine survey

These are raw engine outputs (no effects) on the same six lines, measured on this
machine (RTX 5070 Ti, Ryzen 9 9900X). Latency is warm and non-streaming: the full
synthesis time for "On it." and for one 9-word sentence.

| engine (licence) | best voice | UTMOS | UTMOSv2 | WER | "On it." / sentence | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **Qwen3-TTS 1.7B Base, designed + cloned** (Apache 2.0) via faster-qwen3-tts (MIT, CUDA graphs) | gb_f → isla | 4.47 | 3.96 | 0% | 239 / 1190 ms (streams: ~220 ms to first audio) | **chosen**: most natural, calm by prompt, streams |
| Kokoro-82M v1.0 (Apache 2.0) | af_heart | 4.50 | 3.82 | 0% | 157 / 395 ms (CPU) | kept as the CPU fallback; brighter and harsher, a little "TTS" |
| Qwen3-TTS CustomVoice presets | Aiden / Vivian | 4.43 / 4.49 | 3.60 / 3.52 | 0% | 790 / 4490 ms (plain HF) | the English preset speakers are expressive (Aiden 5.7 st), and the female ones are Chinese-native |
| Chatterbox Turbo 350M (MIT) | built-in | 4.33 | 3.66 | 2.1% | 273 / 734 ms | Turbo has no exaggeration control; flat delivery but lower quality, quiet output |
| Chatterbox 0.5B, exaggeration 0.25, cfg 0.4 (MIT) | built-in | see `bench/` | | | | the explicit emotion knob, set low; slower than Turbo |
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
spectrum, and prosody. They run from their own venvs under `~/.vera/voice/bench/`;
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

These came from an ablation on isla. The first draft of `vera` (reverb 0.16 / 0.75 s,
comb 5%, chorus 10%) cost −0.48. Reverb was most of that: 0.16 wet cost −0.5 on its
own, 0.10 cost −0.1, and 0.07 cost nothing. The tint stages at 3–5% cost about −0.1
each. If Shawn wants more character, `synthetic` is the place for it, and every field
of a preset is in one dataclass.

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
- **Kokoro latency.** Kokoro voices synthesize a whole sentence before streaming it, so
  a long first clause takes about 400 ms. The first Kokoro request also loads the model
  (about 0.9 s).
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
