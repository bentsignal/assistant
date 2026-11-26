"""Loudness steadiness of long replies through the running voice service.

Looks for dips in Vera's level within her speech, and whether they line up with
the boundaries between the streamed chunks (each HTTP chunk the service sends)
or the sentence boundaries:

    python bench/envelope.py [--url http://127.0.0.1:7314] [--voices isla,optimus] [--out dir]

For every voice (with its own preset) it renders the long replies below, then:
- splits the audio into phrases at pauses of 150 ms or more (20 ms frames under
  -50 dBFS);
- measures 400 ms momentary loudness (RMS, dB) across each phrase, stepping 50 ms,
  over the frames that are speech (within 30 dB of the phrase's loudest frame);
- reports the deepest dip of a 400 ms window under its phrase's median, and the
  deepest dip found within 200 ms of a streamed chunk boundary.

A dip that only shows at chunk boundaries would be the stream's fault; dips that
are everywhere are the voice's own prosody. Nothing is played.
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
from pathlib import Path

import numpy as np

LINES = [
    "Sure. I checked the hex thread, and the build finished about ten minutes ago. Two tests failed in "
    "the audio module, both about device recovery. Do you want me to ask Claude to look at them, or should "
    "I start a new thread for it?",
    "Here's what's new. The T3 thread about the settings window is waiting for your input, Grok found three "
    "posts about the release, and the nightly build passed. Nothing else needs you right now, so you can "
    "keep cooking and I'll let you know if anything changes.",
    "The recipe wants the onions softened slowly over low heat for about twenty minutes, stirring now and "
    "then, before the garlic goes in. Add the tomatoes after that and let it all simmer until it thickens, "
    "then season it and taste as you go.",
]


def synth(url: str, text: str, voice: str) -> tuple[np.ndarray, int, list[int]]:
    """The audio and the sample offsets where each streamed chunk began."""
    body = json.dumps({"text": text, "voice": voice}).encode()
    request = urllib.request.Request(f"{url}/v1/speech", data=body, headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        rate = int(response.headers.get("X-Sample-Rate", "24000"))
        data = bytearray()
        starts: list[int] = []
        pending = b""
        last = None
        while True:
            piece = response.read1(1 << 16) if hasattr(response, "read1") else response.read(1 << 16)
            if not piece:
                break
            now = time.monotonic()
            # A gap of 60 ms or more in arrival is a new chunk from the service.
            if last is None or now - last > 0.06:
                starts.append((len(data) + len(pending)) // 4)
            last = now
            pending += piece
            usable = len(pending) - len(pending) % 4
            data += pending[:usable]
            pending = pending[usable:]
    return np.frombuffer(bytes(data), dtype="<f4").astype(np.float64), rate, starts


def db(x: np.ndarray) -> np.ndarray:
    return 10 * np.log10(np.maximum(x, 1e-12))


def analyse(audio: np.ndarray, rate: int, starts: list[int]) -> dict:
    frame = rate // 50  # 20 ms
    frames = len(audio) // frame
    power = (audio[: frames * frame].reshape(frames, frame) ** 2).mean(axis=1)
    level = db(power)
    voiced = level > -50
    # Phrases: runs of frames separated by >= 150 ms (8 frames) of unvoiced.
    phrases: list[tuple[int, int]] = []
    start = None
    quiet = 0
    for i, v in enumerate(voiced):
        if v:
            if start is None:
                start = i
            quiet = 0
        elif start is not None:
            quiet += 1
            if quiet >= 8:
                phrases.append((start, i - quiet + 1))
                start = None
                quiet = 0
    if start is not None:
        phrases.append((start, frames))
    boundaries = [s // frame for s in starts[1:]]
    worst, worst_at_boundary = 0.0, 0.0
    dips = []
    for a, b in phrases:
        if b - a < 30:  # under 600 ms: too short to judge
            continue
        seg = level[a:b]
        peak = seg.max()
        speech = seg > peak - 30
        windows = []
        for w in range(a, b - 20 + 1, 2):  # 400 ms windows every 40 ms
            window_power = power[w : w + 20][speech[w - a : w - a + 20]]
            if len(window_power) >= 10:
                windows.append((w, float(db(window_power.mean()))))
        if len(windows) < 3:
            continue
        median = float(np.median([v for _, v in windows]))
        for w, v in windows:
            dip = median - v
            near = any(abs(w + 10 - bnd) <= 10 for bnd in boundaries)
            worst = max(worst, dip)
            if near:
                worst_at_boundary = max(worst_at_boundary, dip)
            if dip > 3:
                dips.append({"at_s": round((w + 10) * 0.02, 2), "dip_db": round(dip, 1), "near_chunk": near})
    return {
        "seconds": round(len(audio) / rate, 1),
        "chunks": len(starts),
        "phrases": len(phrases),
        "worst_dip_db": round(worst, 1),
        "worst_dip_at_chunk_boundary_db": round(worst_at_boundary, 1),
        "dips_over_3db": dips,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:7314")
    parser.add_argument("--voices", default="")
    parser.add_argument("--out", default="")
    args = parser.parse_args()
    with urllib.request.urlopen(f"{args.url}/v1/voices", timeout=10) as response:
        listing = json.load(response)
    voices = [v["id"] for v in listing["voices"] if v.get("available", True)]
    if args.voices:
        voices = [v for v in args.voices.split(",") if v]
    out = Path(args.out) if args.out else None
    if out:
        out.mkdir(parents=True, exist_ok=True)
    report = {}
    for voice in voices:
        rows = []
        for i, line in enumerate(LINES):
            audio, rate, starts = synth(args.url, line, voice)
            if out:
                import soundfile

                soundfile.write(out / f"{voice}-{i + 1}.wav", audio.astype(np.float32), rate)
            rows.append(analyse(audio, rate, starts))
        report[voice] = rows
        worst = max(r["worst_dip_db"] for r in rows)
        at_chunk = max(r["worst_dip_at_chunk_boundary_db"] for r in rows)
        over = sum(len(r["dips_over_3db"]) for r in rows)
        near = sum(1 for r in rows for d in r["dips_over_3db"] if d["near_chunk"])
        print(f"{voice:<8} worst dip {worst:4.1f} dB, at a chunk boundary {at_chunk:4.1f} dB, "
              f"400 ms windows over 3 dB: {over} ({near} near a chunk boundary)")
    if out:
        (out / "envelope.json").write_text(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
