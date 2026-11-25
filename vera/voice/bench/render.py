"""Render the bench lines through the real service pipeline (sentence streaming, effects,
loudness) for voices x presets, with warm latency. Run with the service venv:

  ~/.vera/voice/venv/Scripts/python vera/voice/bench/render.py <outdir> --voices isla nora heart --presets vera natural synthetic
"""
import argparse, json, pathlib, statistics, time
import numpy as np, soundfile as sf
from vera_voice.synth import Synth

HERE = pathlib.Path(__file__).parent
LINES = json.loads((HERE / "lines.json").read_text())

ap = argparse.ArgumentParser()
ap.add_argument("out")
ap.add_argument("--voices", nargs="+", required=True)
ap.add_argument("--presets", nargs="+", default=["vera", "natural", "synthetic"])
ap.add_argument("--chunk", type=int, default=None, help="qwen streaming chunk (codec steps)")
a = ap.parse_args()

s = Synth(a.voices[0], a.presets[0])
for v in a.voices:
    if a.chunk and s.voice(v).engine == "qwen":
        s.engines.get("qwen").chunk_steps = a.chunk
    for _ in s.stream("Warming up.", v, a.presets[0]):
        pass
    for p in a.presets:
        s.gain(s.voice(v), s.preset(p))
    # warm latency: time to the first processed chunk, over the two sample lines and "On it."
    lat = {}
    for key, text in (("on_it", "On it."), ("line0", LINES[0]), ("line1", LINES[1])):
        xs = []
        for _ in range(3):
            t = {}
            for _chunk in s.stream(text, v, a.presets[0], timing=t):
                pass
            xs.append(t["first_audio_ms"])
        lat[key] = statistics.median(xs)
    for p in a.presets:
        d = pathlib.Path(a.out) / f"{v}-{p}"
        d.mkdir(parents=True, exist_ok=True)
        tot_t = tot_a = 0.0
        for i, line in enumerate(LINES):
            t0 = time.perf_counter()
            pcm = s.render(line, v, p)
            tot_t += time.perf_counter() - t0; tot_a += len(pcm) / 24000
            sf.write(d / f"{v}-{p}__{i}.wav", pcm, 24000, subtype="FLOAT")
        (d / "timing.json").write_text(json.dumps(dict(lat, rtf=tot_t / tot_a)))
        print(f"{v}-{p}: first audio {lat['on_it']:.0f}/{lat['line0']:.0f}/{lat['line1']:.0f} ms, RTF {tot_t / tot_a:.2f}", flush=True)
