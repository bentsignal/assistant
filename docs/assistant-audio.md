# Vera's audio engine (`assistant::audio`)

One in-process engine for Vera's microphone and speakers, full duplex. The
microphone is never paused: everything it hears is echo-cancelled against
what Vera herself plays, so the user can talk over her at any time. When
they do, she stops within ~300–400 ms (with speakers she ducks first, within ~130 ms), and
what they said arrives as an ordinary `Final` with `during_playback: true`.
Speech to text is v1 Ears (Parakeet Unified through Hex's engine, Silero, the
patient end of turn in `assistant_ears/patience.rs`, "Vera" as vocabulary) running on the cancelled signal. Vera
has her own volume and never touches the system's.

Code: `src/assistant/audio.rs` (the API) and `src/assistant/audio/`:

| File | What it does |
| --- | --- |
| `engine.rs` | the engine thread: real devices around the core |
| `duplex.rs` | the core: alignment → AEC → barge-in → Ears → events (no devices, no threads) |
| `align.rs` | puts playback and the microphone on one clock |
| `echo.rs` | WebRTC AEC3 (`sonora-aec3`) at 16 kHz on 4 ms blocks |
| `barge.rs`, `bands.rs` | the barge-in detector |
| `gate.rs` | holds Ears' events while a suspected barge-in is decided |
| `mixer.rs`, `chime.rs`, `output.rs` | playback: queue, volume, duck, stop, chimes, the cpal stream |
| `voice.rs` | the voice service client (`POST /v1/speech`, streamed f32) |
| `resample.rs` | streaming windowed-sinc resampler, delay-free |
| `sim.rs`, `sim/room.rs` | the simulated room the measurements below come from |
| `simdev.rs` | simulated microphone and speakers for the real app (`ASSISTANT_AUDIO_SIM`, `docs/assistant-soak.md`) |
| `cli.rs` | `hex assistant-audio sim \| live \| say \| chime \| outputs` |

`hex ears` is unchanged; its pieces (`Utterances` over a `Sink`,
`EarsSettings`, `Stt`) are shared with the engine.

## API

```rust
use crate::assistant::audio::{AudioConfig, AudioEvent, ChimeKind, PlaybackState, AssistantAudio};

let (audio, events) = AssistantAudio::start(AudioConfig {
    voice_url: "http://127.0.0.1:7314".into(), // the voice service the App spawned
    volume: saved_volume,                        // 0..=1, default 0.7
    ..AudioConfig::default()
})?;                                            // fails only on a bad model id
audio.speak("s12", "On it. I'll ping you.");    // queued after anything playing
audio.speak_pcm("s13", samples, 24_000);        // mono PCM, no voice service
audio.stop_playback();                          // "stop talking": fades out in ~25 ms, drops the queue
audio.set_volume(0.5);                          // Vera's own gain, ramps over ~60 ms
audio.set_voice(Some("june".into()));           // the next lines' voice; nothing restarts or is cut
audio.set_microphone(None);                     // reopens only the input; Ready names it again
audio.drop_speech("s12");                       // drops one line, playing or queued: it ends failed
audio.set_mic_muted(true);                      // closes the mic (the OS indicator goes out)
audio.chime(ChimeKind::Notify);                 // notify | listening | done | error
let levels = audio.levels();                    // Levels { mic, out }, smoothed RMS 0..=1
audio.speaking(); audio.volume(); audio.mic_muted();
drop(audio);                                    // stops the engine, closes the devices
```

`start` returns at once. Playback works immediately; speech to text loads
in the background (~1 s) and `Ready` says when it listens.

`AudioConfig`: `microphone` / `output` (name fragments; `None` follows the
system default, the mic live, the output each time it opens), `voice_url`
(default `ASSISTANT_VOICE_URL` or `http://127.0.0.1:7314`), `voice`, `preset`,
`volume`, `barge_in` (default on), `stt_source` (default `Hybrid`, see
below), `ears: EarsSettings` (model, pause, vocabulary, … as `hex ears`).

### Events

`AudioEvent` serializes (serde, `"type"` tag, snake_case) as the App ⇄ Core
lines in `DESIGN.md`, so most can be forwarded as they are:

```json
{"type":"ready","mic":"Microphone (2- AT2020USB+)","engine":"parakeet_unified_en","backend":"NVIDIA GeForce RTX 5070 Ti (vulkan)"}
{"type":"speech_start","t":1795580684764}
{"type":"partial","text":"wait start a","t":1795580685120}
{"type":"final","text":"Wait, start a new thread for that instead.","start":1795580684764,"end":1795580687100,"during_playback":true}
{"type":"speech_cancel","t":1795580684764,"reason":"no words"}
{"type":"barge_in","speak_id":"s12"}
{"type":"playback","speak_id":"s12","state":"started|finished|interrupted|failed"}
{"type":"error","message":"…","fatal":false}
```

- Times are Unix ms. Every `speech_start` gets exactly one `final` or
  `speech_cancel`, as in Ears.
- Every `speak_id` gets at most one `started` and exactly one terminal
  state: `finished` (its last sample has been *heard*, output latency
  included), `interrupted` (barge-in, `stop_playback`, a failed output), or
  `failed` (the voice service failed; an `error` says why). `failed` is new
  to the contract; Core can treat it as `interrupted`.
- `barge_in` comes before the `interrupted` of the utterance it stopped and
  of anything queued behind it. The user's turn that caused it is the next
  `final`, marked `during_playback: true`.
- `error` with `fatal: true` means speech to text could not load; playback
  still works. Everything else recovers by itself (the mic reopens with
  Hex's backoff, the output reopens on the next sound).
- Nothing in Settings restarts the engine: `set_voice` changes the voice
  for the next fetch (a line already fetching keeps its voice),
  `set_volume` ramps, and `set_microphone` reopens only the input. The App
  still keeps its own ledger (`docs/assistant-app.md`), so a line the engine
  never ends (a restart, a crash, a stall) is ended for it.

## Volume

Vera's volume is a gain in her own mixer, linear in dB over 40 dB: level
`v` is `40 × (v − 1)` dB, so each 0.1 is 4 dB, 1.0 is the voice service's
own level (about −20 LUFS, which is where v1 played), and 0 is silent.

**Default 0.7 = −12 dB, about −32 LUFS**: roughly half as loud as v1, which
Shawn found far too loud, and quiet enough to sit under media. A voice
"quieter" from Core is one step (`set_volume(v − 0.1)`). Chimes peak at
−20 dBFS before the volume, under her voice. The system volume is never
read or written.

## Echo cancellation: what and why

**WebRTC AEC3 through `sonora-aec3` (pure Rust, BSD-3), fed Vera's exact
playback as the reference.** Options weighed:

- **AEC3, pure-Rust port** (chosen): the algorithm every browser ships,
  with a delay estimator that finds the echo up to ~500 ms late and
  re-finds it after changes, a suppressor that takes the residual to the
  noise floor, and transparent handling of headsets. Pure Rust means no
  build risk on Windows, and its lower-level `BlockProcessor` exposes the
  *linear* output (mic minus the adaptive-filter echo estimate), which
  barge-in needs (below). In the simulator it removes 43–48 dB of echo in
  ordinary rooms, 23 dB in a reverberant kitchen with fan noise.
- `webrtc-audio-processing` (C++ bindings): the same AEC3, but a meson/C++
  build of WebRTC under MSVC, and no access to the linear output.
- SpeexDSP: needs the delay given to it exactly, has no delay estimator or
  drift handling, and is weaker at double talk.
- Windows' communications AEC (Voice Capture DSP, the AEC APO, Voice
  Clarity): a black box that depends on the driver or Windows build,
  cancels the whole render endpoint rather than Vera, can't be measured
  offline, and communications-mode capture makes Windows duck every other
  app's audio by default, exactly the "touches system volume" Shawn hated.

The filters are 32 blocks (128 ms) instead of AEC3's 13, which cancels more
of a room's reverberation linearly.

**Alignment** (`align.rs`). cpal stamps both streams on WASAPI's QPC clock
(capture instants; playback = clock position + buffered + stream latency).
Each microphone block captured at `t` is paired with the reference that
played at `t + 30 ms`, so the reference always leads its echo; latency the
device doesn't report (Bluetooth, HDMI) only makes the echo later, which
AEC3's own estimator finds. Each stream's stamps go through a smoothed
timeline (jitter averaged out, drift followed), and the read cursor slews
at most one sample per block, so the reference never jumps. A block waits
up to 80 ms for its reference to be rendered. The output stays open through
a conversation and closes after 3 minutes of silence; the next sound
re-opens the default device. (It used to close after 8 s, so most replies
started on a freshly opened stream, which a wireless headset fades in.)

## Barge-in

Two signals come out of AEC3 every 4 ms. The **suppressed** output sits at
the noise floor while only Vera is in the room and rises 25–45 dB within
~60 ms of the user starting to talk. The **linear** output has the user
intact plus a residual of Vera; `bands.rs` compares it with her reference
in 14 bands (200 Hz–7 kHz), because band by band the user stands out where
Vera's voice leaves gaps, against three learned bounds per band: its noise
floor, its leak against Vera's level in that band (held for 160 ms, then
decaying at 75 dB/s), and its leak against her total level (small speakers'
distortion).

1. **Suspect.** 10 of the last 15 blocks are candidates (suppressed output
   15 dB over its floor, or ≥ 4 bands over their bounds). If what triggered
   can't be Vera's echo (below), the suspicion is *silent*: no duck at all,
   and step 2 is the speech detector alone. Otherwise Vera ducks at once
   (−20 dB) and the duck is the test.
2. **Probe with the duck.** Echo falls with the duck once it has come back
   through the room (AEC3's delay estimate says when); the user doesn't.
   After that point, the bands must still show the user for 10 blocks
   (their bounds hold Vera's pre-duck level through her reverberation, so
   her own tail can never pass), the loudest 20 ms since the duck must not
   have fallen by 12 dB, and Silero must hear speech in the cleanest audio
   there is (suppressed before the duck took effect, linear after). The
   suppressed output can trigger a duck but never confirms one: AEC3 can
   let Vera's *ducked* echo through.
3. **Confirmed → stop.** Playback fades out, the queue is dropped,
   `barge_in` and `interrupted` go out. The user's utterance is restarted
   where their voice began (including a false alarm their first word
   caused just before), over the linear output, so the opening words
   ("Stop,", "Wait,") survive.
4. **Rejected → restore** (150 ms ramp) and learn: echo that triggered
   raises that band's leak at once; steady noise raises the floor.

**Silent suspicions (a headset).** The detector learns Vera's *coupling*:
how far over its own floor the raw microphone gets against her reference
envelope (95th percentile of the last 2 s of echo-only blocks, learned only
where nothing stirred for 60 ms, forgotten when the canceller's delay
changes, i.e. another device). A suspicion is echo-free when the raw
microphone is 10 dB over the loudest echo that coupling allows and the
canceller is removing less than 6 dB of it. Then Vera plays on at full
level and Silero, over the linear output, decides: asked once there is
100 ms of sound, every 80 ms after, and once more over all of it when the
sound has stopped for 120 ms (so a short "Stop." is heard whole); six
refusals, 800 ms, or the sound ending unheard dismiss it. Breathing, clicks,
a knock or a fan in a headset never dip her voice; only speech stops her.
**A headset never ducks.** The coupling needs a converged canceller, and
Shawn's CORSAIR headset gives it nothing to converge on (digital silence
between sounds, no echo), so his suspicions kept falling back to ducking
(his log: 9 ducks, 9 restores, 53 silent suspicions, 46 dismissed). The
detector now also measures the *echo return* without the canceller: the
raw microphone's 20th-percentile level while Vera has been loud for 300 ms,
against its level while nothing of hers played for 300 ms (or only her
pauses, 30 dB under her peak), over the same last 6 s. Speakers measure 10
to 40 dB; a headset about 0. Under 3 dB (back over 6 dB) every suspicion is
silent: no duck, only speech the detector hears stops her. Her echo showing
up in her last 200 ms of loud playback (10 dB over the silent level: the
headset taken off) ends that at once. The duplex log line reports
`echo_return_db` and `headset`.

**A gated microphone.** His headset's microphone gates itself: digital
silence (under −90 dBFS) between sounds, its own hiss (about −80) for a
moment after one. That level is bimodal, so the percentiles above landed on
silence or on hiss at random and read as echo coming and going: on
2026-11-26 `headset` flipped 26 times in four minutes (`echo_return_db`
from −9.7 to 27.6) and 11 ducks got through during Tony's replies. Digital
silence is now left out of both levels and counted on its own: 100 ms of it
while she was loud, in the last 6 s, means none of her reaches the
microphone, so it's a headset whatever else the measurement says; and a
gated microphone's quiet level is its open level (hiss), never its
silence. Her echo holding the gate open through her loud playback (the
headset taken off) ages that out, and the measurement takes over again.

A first word followed by a pause ("Wait, … start a new thread") keeps Vera
ducked for up to 800 ms until the next word confirms (with speakers; in a
headset the first word stops her). Nothing is confirmed
until the canceller has converged (its delay estimate steady for 1 s of
Vera's audio): Vera's first second of speech after launch, or after the echo
path changes, is not interruptible. While AEC3 isn't actually cancelling
(measured: its linear output within 6 dB of the raw mic where Vera is
audible), only the suppressed output can trigger, and confirmation needs
both signals.

**Ears during playback.** While Vera's voice (or its 300 ms tail) is in the
room and nobody is suspected of talking, the endpointer starts nothing, so
her echo never becomes an utterance; `gate.rs` holds any utterance that
starts during a suspicion until it is decided. `stt_source` picks what Ears
hears: `Hybrid` (default: the suppressed output, switching to the linear one
from a suspicion until Vera's echo has gone), `Suppressed`, or `Linear`.

## Measurements

`hex assistant-audio sim` closes the loop: the real mixer (volume, ducks, stops)
→ a soft-clipping speaker → a synthetic room impulse response → a
microphone that also hears the user (same room, further away) and noise, on
a drifting clock, with reported and unreported latencies → the real core
and real Parakeet/Silero. Vera was Kokoro (v1 Mouth, "vera" preset) for these numbers; `make-voices.ps1` now uses the running voice service (Qwen3-TTS isla), the
user is SAPI David and Zira. Five rooms, Vera at the default 0.7, echo
louder than the user at the mic:

| Room | Setup |
| --- | --- |
| desk | speakers 0.8 m, RT60 0.35 s, echo +6 dB over the user, 60 ppm drift |
| laptop | DRR +10 dB, hard-driven small speaker, echo +10 dB |
| kitchen | RT60 0.6 s, DRR −2 dB, fan at −50 dBFS, echo +8 dB, user at −38 dBFS |
| bluetooth | desk + 190 ms unreported output latency, 120 ppm drift |
| headset | no echo (−40 dB) |
| gated | no echo; a noise-gated mic (digital silence under −72 dBFS, open 400 ms after a sound, −82 dBFS hiss) and small non-speech sounds several times a second |

The gated room (added 2026-11-26) reproduces his headset: before the fix,
`headset` flipped 10 times and one rustle ducked her in the barge plan;
after, no flips, no ducks in any plan, and 12 of 12 barge-ins still stop
her (`--room gated --no-stt`).

Results (2026-11-25, `hex assistant-audio sim --voices <dir>`):

- **False barge-ins on echo alone: 0** in 1,028 s of Vera-only playback
  across all rooms and plans. **Echo transcribed as speech: 0.**
- False ducks (a brief dip, restored): 0.7 per minute of Vera's speech,
  mostly in her first seconds.
- Echo loss once converged: suppressed 43–48 dB (desk, laptop, Bluetooth),
  23 dB (kitchen); linear 13–26 dB.
- Barge-ins detected: 53 of 60. After the canceller has converged: 53 of
  55 (96%); the two misses are in the kitchen. The five cold misses are
  each room's first case, 1 s into the first audio Vera ever played.
- Latency from the user's first sound: duck median 130 ms (p90 210);
  stop median 400 ms, 34 of 53 under 500 ms. The slow tail (1–1.4 s) is a
  first word and a pause, which Vera stays ducked through.
- Speech to text of the interrupting words: WER 0.025 over detected
  barge-ins, against 0.017 with no playback at all; 45 of 53 word-perfect. Right after Vera finishes: WER 0.015, no barge-ins.
- AEC3 found every delay (36–220 ms), the reference cursor never resynced,
  and no block missed its reference.

**On this machine, live** (`hex assistant-audio live`, quiet, ~10 s runs):

- Default devices (the CORSAIR wireless headset): output and mic open,
  `playback finished` lands at the line's exact length (7.66 s), no ducks.
  The headset mic delivered digital silence (muted), so nothing to cancel.
- Monitor speakers (DELL S2721DS over HDMI) into the AT2020USB+: Vera's
  echo reached the mic at only −84 dBFS against a −96 dBFS floor, about
  390 ms late (HDMI's unreported latency), too weak for AEC3 to lock its
  delay; its suppressor still held the cancelled output at −94 dBFS. No
  barge-ins and no finals from Vera's voice; the ducks that occurred were
  non-echo room sounds (raw and cancelled peaks equal), each rejected by
  Silero. A "user" played on a separate stream through the same speakers
  arrived at −73 dBFS, below what Silero accepts, so a live barge-in
  couldn't be confirmed without turning the system volume up, which this
  test doesn't do.

## Wiring it into the App

This is how `assistant.exe` wires it (`src/assistant/runtime.rs`; `docs/assistant-app.md`):

- Start once at launch, keep for the app's life:
  `AssistantAudio::start(AudioConfig { voice_url, volume: settings.volume, microphone, output, .. })`.
  Read `events` on a thread of its own and forward each to Core as a JSON
  line (`serde_json::to_string(&event)`); the shapes already match.
- Core → engine: `speak` → `audio.speak(speak_id, text)`; `stop_speaking`
  and the tray's Stop talking and the hotkey → `audio.stop_playback()`;
  `set_volume` → `audio.set_volume(level)` (and persist it); `chime` →
  `audio.chime(kind.parse()?)`.
- Tray Mute microphone → `audio.set_mic_muted(true/false)`.
- HUD: poll `audio.levels()` at the frame rate (`mic` is the user after
  echo cancellation, `out` is Vera before her volume); `listening` while a
  `speech_start` is open, `speaking` between `playback started` and its
  terminal state.
- The engine spawns no processes and writes nothing. Its logs are
  `tracing` lines (`hex::assistant::audio`); every 2 s while the output is open
  it logs the AEC delay, raw and cancelled mic peaks, and duck/barge-in
  counters.

## Known limits

- Not interruptible in Vera's first second of speech after launch (or after
  the echo path changes), by design: an unconverged canceller hasn't removed
  her echo at all.
- A user much quieter than Vera's echo in a loud, reverberant, noisy room
  (the kitchen case) is missed about 1 time in 5; lowering Vera's volume
  helps directly.
- Stop latency is ~400 ms median; a first word followed by a pause keeps
  Vera ducked, not stopped, until the next word (up to 800 ms).
- A barge-in's first word is sometimes still lost (about 1 in 10 in the
  sim), when its first suspicion came more than 600 ms before the
  confirmation.
- Weak, late echo (HDMI monitor speakers) leaves AEC3 unlocked; barge-in
  then rests on AEC3's suppressed output, which has only been checked live
  at low levels.
- Someone else talking in the room interrupts Vera too: any speech does.
- With speakers, a noise at the microphone about as loud as Vera's echo
  (or louder, within 10 dB over it) still ducks her for the probe; only
  echo-free suspicions are silent.
- A silent suspicion trusts the coupling learned a moment before. If her
  echo suddenly reaches the microphone along the same delay (a headset put
  down next to its own mic) before the canceller notices, her own voice
  could stop her once. A new device changes the delay, which resets it.
- If the user starts talking while a `speak` is still being synthesized,
  Vera will start over them; Core can `stop_speaking` on `speech_start`.
- Windows only for now; the code is platform-neutral except `now_ns` (QPC)
  and the default-output lookup.

## Tools

```sh
powershell -File scripts/assistant-audio/make-voices.ps1 -Out <dir> [-VoiceUrl http://127.0.0.1:7314]
hex assistant-audio sim --voices <dir> [--room desk,kitchen] [--plan echo,barge,after,clean] [--no-stt] [--json out.json]
hex assistant-audio live --voices <dir> [--lines 1] [--volume 0.45] [--output S2721DS] [--mic AT2020] [--user-wav u.wav --user-at 2.5 --user-gain-db=-12]
hex assistant-audio say "On it." [--voice-url http://127.0.0.1:7314] [--stop-after 1.5]
hex assistant-audio chime notify
hex assistant-audio outputs
```

`hex assistant-audio transcribe <wav>...` runs files through the same speech to
text (the pronunciation check, `assistant/voice/README.md`).

Environment: `ASSISTANT_AUDIO_SIM` (simulated devices: `1` or
`echo_db=-30,delay_ms=60,noise_db=-75`), `ASSISTANT_VOICE_URL` (default voice service), `HEX_EARS_LOG`
(`hex::assistant=debug` shows each rejected suspicion and why),
`ASSISTANT_SIM_TRACE=<dir>` (the simulator writes per-block CSVs and the audio),
the live `duplex` log line counts `ducks`, `restores`, silent `suspicions`
and those `dismissed`, and `barge_ins`,
`ASSISTANT_AUDIO_DUMP=<dir>` (the live engine writes its mic, reference, and
cancelled audio on exit). `hex assistant-audio` isolates its data folder like
`hex ears` (`~/.assistant/ears/hex`) and reads the installed Hex's models.

Build and test as Ears does (`docs/assistant-ears.md`):
`scripts/assistant-ears-build.sh --dev`, then
`cargo test --profile ears-dev --bin hex vera`.
