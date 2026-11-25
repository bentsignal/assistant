"""Design candidate voices with Qwen3-TTS VoiceDesign: several takes of one reference line
per description. The best take becomes a fixed reference clip for cloning with Base.

usage: python qwen_design.py <design_dir> [takes]
"""
import os, sys, pathlib, time
import numpy as np, soundfile as sf, torch
os.environ.setdefault("HF_HOME", str(pathlib.Path.home() / ".vera" / "models" / "hf"))
from faster_qwen3_tts import FasterQwen3TTS

REF = ("Hi, I'm Vera. I keep an eye on your builds and threads, and I'll let you know "
       "when something needs you. Just say my name whenever you want me.")

d = pathlib.Path(sys.argv[1]); takes = int(sys.argv[2]) if len(sys.argv) > 2 else 3
m = FasterQwen3TTS.from_pretrained("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign")
for desc in sorted(d.glob("*.txt")):
    if "__" in desc.stem: continue
    for k in range(takes):
        torch.manual_seed(1000 + k)
        t = time.perf_counter()
        w, sr = m.generate_voice_design(text=REF, instruct=desc.read_text().strip(), language="English")
        out = d / f"{desc.stem}__take{k}.wav"
        sf.write(out, np.asarray(w[0], np.float32), sr)
        out.with_suffix(".txt").write_text(REF)
        print(f"{out.name} {time.perf_counter()-t:.1f}s", flush=True)
