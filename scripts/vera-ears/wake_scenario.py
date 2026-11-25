"""Builds a wake-word scenario: many short "Vera" phrases from both SAPI
voices at several speaking rates, separated by 2 s gaps, optionally with
kitchen-like reverb and noise.

python scripts/vera-ears/wake_scenario.py <out.wav> [--reverb] [--noise DBFS]

Writes <out.wav> and <out.json> for run_scenario.py.
"""
import json
import os
import subprocess
import sys
import tempfile
import wave

import numpy as np

RATE = 16000
PHRASES = [
    "Vera.",
    "Hey Vera.",
    "Okay Vera, what's new?",
    "Vera what time is it",
    "Vera, are you there?",
    "Hey Vera, check my threads.",
    "Vera, pause the music.",
    "Thanks Vera.",
]
VOICES = [("Microsoft Zira Desktop", 0), ("Microsoft David Desktop", 0),
          ("Microsoft Zira Desktop", 3), ("Microsoft David Desktop", -2)]


def speak(text, voice, rate, path):
    script = (
        "Add-Type -AssemblyName System.Speech;"
        "$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,"
        "[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);"
        f"$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$s.SelectVoice('{voice}');$s.Rate={rate};"
        f"$s.SetOutputToWaveFile('{path}',$f);$s.Speak('{text.replace(chr(39), chr(39) * 2)}');$s.Dispose()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", script], check=True)
    with wave.open(path, "rb") as w:
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    loud = np.nonzero(np.abs(audio) > 0.01)[0]
    return audio[max(loud[0] - 160, 0): loud[-1] + 160]


def main():
    out = sys.argv[1]
    reverb = "--reverb" in sys.argv
    noise_db = float(sys.argv[sys.argv.index("--noise") + 1]) if "--noise" in sys.argv else None
    rng = np.random.default_rng(3)
    if reverb:
        # A small hard room: exponential decay, RT60 about 0.5 s.
        n = int(0.5 * RATE)
        ir = rng.standard_normal(n).astype(np.float32) * np.exp(-6.9 * np.arange(n) / n)
        ir[0] = 1.0
        ir /= np.sqrt(np.sum(ir**2))
    parts, expected, position = [np.zeros(RATE * 2, np.float32)], [], RATE * 2
    tmp = tempfile.mkdtemp()
    for vi, (voice, rate) in enumerate(VOICES):
        for pi, text in enumerate(PHRASES):
            clip = speak(text, voice, rate, os.path.join(tmp, f"{vi}_{pi}.wav")) * 0.5
            if reverb:
                clip = np.convolve(clip, ir)[: len(clip) + RATE // 4].astype(np.float32)
            expected.append({"text": text, "voice": voice, "rate": rate,
                             "start_ms": position * 1000 // RATE, "end_ms": (position + len(clip)) * 1000 // RATE})
            parts += [clip, np.zeros(RATE * 2, np.float32)]
            position += len(clip) + RATE * 2
    audio = np.concatenate(parts)
    if noise_db is not None:
        audio += rng.standard_normal(len(audio)).astype(np.float32) * 10 ** (noise_db / 20)
    else:
        audio += rng.standard_normal(len(audio)).astype(np.float32) * 10 ** (-62 / 20)
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
    json.dump({"duration_ms": len(audio) * 1000 // RATE, "utterances": expected},
              open(out.rsplit(".", 1)[0] + ".json", "w"), indent=1)
    print(f"{out}: {len(audio) / RATE:.0f} s, {len(expected)} phrases")


main()
