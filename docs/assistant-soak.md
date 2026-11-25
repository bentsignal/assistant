# Vera's soak test

`scripts/assistant-soak/soak.mjs` proves Vera holds up end to end: the **real**
`assistant.exe`, the real Core (Node), the real voice service (Qwen3-TTS on the
GPU), and the real speech to text (Parakeet, Silero), with only the
microphone, the speakers, and the brain stood in for.

```sh
node scripts/assistant-soak/soak.mjs --exe target/release/assistant.exe --runs 3
```

It needs the voice service's venv and models (`assistant\voice\scripts\setup.ps1`),
Core's packages, and Hex's Parakeet model, as Vera does. Nothing plays
through the speakers. It runs in a throwaway `ASSISTANT_HOME` under `%TEMP%\assistant-soak`
(its own config, logs, single instance, Core port, and voice service on port
7315), never touches `~/.assistant` or the Run key, and deletes the home of a run
that passed (`--keep` keeps it). Vera's HUD and a second tray icon do show
while it runs, and the voice service needs about 5.5 GB of VRAM beside
Shawn's.

## How it drives the app

- `ASSISTANT_AUDIO_SIM` (`src/assistant/audio/simdev.rs`) gives the audio engine a
  simulated microphone and speakers, at real-time pace on the same clock
  cpal uses: the microphone hears a −75 dBFS noise floor, Vera's own output
  as an echo (−30 dB, 60 ms late), and whatever the test says into it; the
  speakers render the mixer into nothing and report each stretch of audible
  output.
- `ASSISTANT_SIM_CONTROL` (`src/assistant/sim.rs`) is a loopback port: `mic <gain_db>
  <wav>` says a WAV into the microphone, and `voice`, `volume`,
  `microphone`, `mute`, and `stop` do what Settings and the hotkey do.
- `ASSISTANT_TRACE` (`src/assistant/trace.rs`) records every line to and from Core,
  the HUD's looks, chimes, alerts, the status line, the tray, child
  processes, the engine's lifetime, and audible output, as JSON lines.
- "Shawn" is Windows SAPI (David), made once by
  `scripts/assistant-soak/make-utterances.ps1`.
- The brain is Core's scripted brain (`brain.harness: "script"`), so each
  request has one known answer and faults can be injected (`fail`, `hang`).
  `brain.firstSpeakTimeoutSeconds` is 8 s here (45 s for real).

## What one run does (34 addressed turns)

1. Wake word then the request ("Hey Vera, what time is it?").
2. A bare "Hey Vera." (the listening chime and look), then the request
   without the wake word.
3. Follow-ups without the wake word, twice.
4. Speech not addressed to Vera, after the follow-up window: ignored, the
   HUD stays hidden.
5. Rapid back-to-back turns: a second request before the first is answered
   (the first answer must never be sent), then a request while an answer is
   still playing (it must be cut).
6. A barge-in mid-reply ("Actually, what's two plus two?"): Vera stops, the
   rest of her answer is dropped, the new question is answered; then "Stop."
   over a reply: she stops and says nothing.
7. Switching the voice twice mid-reply: the line plays on to its end, the
   engine never restarts, the next line uses the new voice.
8. Changing the volume mid-reply: the line plays on.
9. Killing the voice service mid-reply: the line ends, the alert shows
   (error chime, HUD error look, red status, tray), a turn while it's down
   fails at once with the error chime, the service comes back by itself, and
   the next turn plays.
10. Killing Core mid-turn: the alert, the HUD hidden, Core restarts, the
    dead turn never speaks, the next turn plays.
11. A brain error, and a brain that never answers: each alerts (the timeout
    within 8 s), and the next turn works.
12. Renaming her by voice, live: "Vera, call yourself Nova." (Core's
    `set_name`; the App applies it, nothing restarts, the tray says Nova),
    then "Vera, ..." is ignored and "Nova, ..." answered, then back to Vera.
13. More ordinary turns.

**Checked on every turn:** the reply starts within 6 s of the end of what
Shawn said and plays audibly to its end, and the HUD is back to hidden
within 15 s. **Across the run:** every `speak` got exactly one end (unless
its Core was killed), no reply started after a newer request was heard,
the HUD ends hidden, and `assistant.exe` never crashed.

## Results (2026-11-25, the stability pass)

Release `assistant.exe`, `--runs 3`: **3 of 3 passed in a row**, each 31 addressed
turns (34 utterances), 162 checks, about 6 minutes.

- First audio after the end of the fixture's audio: median 192–200 ms, p90
  223–234 ms, max 250 ms. The SAPI fixtures end with about 785 ms of
  silence, so from the end of the actual speech that's about 1.0 s, with a
  brain that answers instantly (Claude Sonnet adds about 1 s: its first
  `speak` comes 1.0–1.5 s into a turn).
- Barge-in: confirmed within 1.5 s of "Shawn" starting to talk, every run.
- The voice service, killed mid-reply, was answering again 13 s later, by
  itself; the line it was saying ended `failed` within 40 ms, with the alert.
- Core, killed mid-turn, was back and answering within about 3 s.

What earlier runs caught, now fixed: an answer "played" with no audio when
the voice service was still loading (its fetch failed with 503, but the
line was marked ended, so the mixer reported an empty line as finished: a
silent failure). A failed fetch is now dropped and reported `failed`, and
the mixer reports a line that ends with no audio as `Empty`, never played.

Limits: the brain is scripted (`scripts/brain-check.ts` runs real brain
turns, including the volume and heteronym rules); the echo is a simple
delayed copy, not a room (`hex assistant-audio sim` measures rooms); "Shawn" is a
clean synthetic voice at a comfortable level; and nothing here exercises
real devices (a microphone unplugged mid-utterance, the default output
changing).
