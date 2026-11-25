"""Builds a Vera Ears test scenario WAV from SAPI phrase WAVs.

python scripts/assistant-ears/build_scenario.py <voices dir> <out.wav>

Writes <out.wav> (16 kHz mono s16) and <out.json>, the expected utterances
with their start/end in ms. A -62 dBFS room noise runs under everything;
one stretch holds louder fan-like noise with no speech, and the last phrase
is spoken over noise.
"""
import json
import sys
import wave

import numpy as np

RATE = 16000
rng = np.random.default_rng(7)


def read(path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == RATE and w.getnchannels() == 1
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    audio = data.astype(np.float32) / 32768.0
    # Trim SAPI's own leading/trailing silence so the gaps below are exact.
    loud = np.nonzero(np.abs(audio) > 0.01)[0]
    return audio[max(loud[0] - 160, 0): loud[-1] + 160]


def noise(ms, dbfs, color="white"):
    n = ms * RATE // 1000
    white = rng.standard_normal(n).astype(np.float32)
    if color == "brown":
        white = np.cumsum(white)
        white -= np.convolve(white, np.ones(400) / 400, mode="same")
    rms = np.sqrt(np.mean(white**2)) or 1.0
    return white / rms * 10 ** (dbfs / 20)


def main():
    voices, out = sys.argv[1], sys.argv[2]
    plan = [
        ("gap", 2000),
        ("say", "p1_status_zira", "Vera, what's the status of my T3 threads?"),
        ("gap", 1200),
        ("say", "p2_followup_zira", "Also, can you tell me which one finished last?"),
        ("gap", 3000),
        ("fan", 4000),
        ("gap", 1500),
        ("say", "p3_heyvera_david", "Hey Vera, start a new thread in the hex project."),
        ("gap", 2000),
        ("say", "p4_vera_zira", "Vera."),
        ("gap", 2000),
        ("say", "p5_long_david", "Vera, I want you to check on the build, and then, when it is done, tell me how long it took."),
        ("gap", 2000),
        ("noisy", "p6_noprefix_zira", "Set a timer for ten minutes please."),
        ("gap", 4000),
    ]
    parts, expected, position = [], [], 0
    for step in plan:
        if step[0] in ("gap",):
            clip = np.zeros(step[1] * RATE // 1000, dtype=np.float32)
        elif step[0] == "fan":
            clip = noise(step[1], -38, "brown")
        else:
            clip = read(f"{voices}/{step[1]}.wav") * 0.5
            if step[0] == "noisy":
                clip = clip + noise(len(clip) * 1000 // RATE + 1, -40)[: len(clip)]
            expected.append({"text": step[2], "start_ms": position * 1000 // RATE,
                             "end_ms": (position + len(clip)) * 1000 // RATE})
        parts.append(clip)
        position += len(clip)
    audio = np.concatenate(parts)
    audio = audio + noise(len(audio) * 1000 // RATE + 1, -62)[: len(audio)]
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    with open(out.rsplit(".", 1)[0] + ".json", "w") as f:
        json.dump({"duration_ms": len(audio) * 1000 // RATE, "utterances": expected}, f, indent=1)
    print(f"{out}: {len(audio) / RATE:.1f} s, {len(expected)} utterances")


main()
