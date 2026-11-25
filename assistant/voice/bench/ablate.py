"""Apply effect variants to already-rendered raw lines (the `raw` preset output, which is
loudness-normalized) so each stage's cost in MOS and WER can be measured.

  python ablate.py <raw_dir> <out_dir>
"""
import pathlib, sys
from dataclasses import replace
import numpy as np, soundfile as sf
from assistant_voice import dsp

raw, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
B = dsp.Preset("x")
V = {
    "rev16": replace(B, reverb_mix=0.16, reverb_rt60=0.75),
    "rev10": replace(B, reverb_mix=0.10, reverb_rt60=0.6),
    "rev07dark": replace(B, reverb_mix=0.07, reverb_rt60=0.6, reverb_hi=3500),
    "rev10dark": replace(B, reverb_mix=0.10, reverb_rt60=0.6, reverb_hi=3500, reverb_predelay=0.025),
    "comb05": replace(B, comb_mix=0.05),
    "comb03": replace(B, comb_mix=0.03),
    "comb03_2ms": replace(B, comb_mix=0.03, comb_ms=2.5),
    "chorus10": replace(B, chorus_mix=0.10),
    "chorus05": replace(B, chorus_mix=0.05),
    "tone": replace(B, deess_db=4.0, presence_db=-1.0),
    "deess": replace(B, deess_db=4.0),
}
for name, p in V.items():
    d = out / name; d.mkdir(parents=True, exist_ok=True)
    for f in sorted(raw.glob("*__*.wav")):
        x, sr = sf.read(f, dtype="float32")
        y = dsp.render(x, sr, replace(p, name=name), gain=1.0)
        sf.write(d / f"{name}__{f.stem.rsplit('__', 1)[1]}.wav", y, sr, subtype="FLOAT")
    print(name, flush=True)
