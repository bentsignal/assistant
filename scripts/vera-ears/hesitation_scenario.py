"""Builds a scenario of requests broken by thinking pauses.

python scripts/vera-ears/hesitation_scenario.py <out.wav>

Each request is spoken in pieces with a gap between them. Requests whose
first piece trails off ("…check on the") should come out as one `final`;
complete sentences separated by the same gap should come out as two.
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
# (pieces, gap after each piece but the last in ms, expected finals)
PLAN = [
    (["Vera, can you check on the", "hex thread for me?"], 1000, 1),
    (["Vera,", "what's the weather tomorrow?"], 900, 1),
    (["Hey Vera", "start a new thread"], 1100, 1),
    (["Vera, open the browser and", "search for pasta recipes."], 1000, 1),
    (["Vera, stop the timer.", "Thanks."], 1000, 2),
    (["What time is it?", "Also, is it raining?"], 900, 2),
]


def speak(text, path, voice="Microsoft Zira Desktop"):
    script = (
        "Add-Type -AssemblyName System.Speech;"
        "$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,"
        "[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);"
        f"$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;$s.SelectVoice('{voice}');"
        f"$s.SetOutputToWaveFile('{path}',$f);$s.Speak('{text.replace(chr(39), chr(39) * 2)}');$s.Dispose()"
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", script], check=True)
    with wave.open(path, "rb") as w:
        audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    loud = np.nonzero(np.abs(audio) > 0.01)[0]
    return audio[max(loud[0] - 160, 0): loud[-1] + 160] * 0.5


def main():
    out = sys.argv[1]
    tmp = tempfile.mkdtemp()
    parts, expected, position = [np.zeros(RATE * 2, np.float32)], [], RATE * 2
    for index, (pieces, gap, finals) in enumerate(PLAN):
        voice = "Microsoft Zira Desktop" if index % 2 == 0 else "Microsoft David Desktop"
        start = position
        piece_bounds = []
        for number, piece in enumerate(pieces):
            clip = speak(piece, os.path.join(tmp, f"{index}_{number}.wav"), voice)
            piece_bounds.append((position, position + len(clip), piece))
            parts.append(clip)
            position += len(clip)
            if number < len(pieces) - 1:
                parts.append(np.zeros(gap * RATE // 1000, np.float32))
                position += gap * RATE // 1000
        if finals == 1:
            expected.append({"text": " ".join(pieces), "start_ms": start * 1000 // RATE,
                             "end_ms": position * 1000 // RATE})
        else:
            for s, e, text in piece_bounds:
                expected.append({"text": text, "start_ms": s * 1000 // RATE, "end_ms": e * 1000 // RATE})
        parts.append(np.zeros(RATE * 3, np.float32))
        position += RATE * 3
    audio = np.concatenate(parts)
    audio += np.random.default_rng(5).standard_normal(len(audio)).astype(np.float32) * 10 ** (-62 / 20)
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
    json.dump({"duration_ms": len(audio) * 1000 // RATE, "utterances": expected},
              open(out.rsplit(".", 1)[0] + ".json", "w"), indent=1)
    print(f"{out}: {len(audio) / RATE:.0f} s, {len(expected)} expected finals")


main()
