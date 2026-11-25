"""Score a folder of TTS wavs: UTMOS (MOS predictor), Whisper WER, loudness, peaks, spectrum.

usage: python score.py <dir> [<dir> ...]   (wav names: <anything>__<lineindex>.wav)
writes <dir>/scores.json and prints a summary per folder.
"""
import json, os, re, sys, pathlib
import numpy as np, soundfile as sf, torch, librosa, pyloudnorm as pyln, jiwer

HERE = pathlib.Path(__file__).parent
LINES = json.loads((HERE / "lines.json").read_text())

_utmos = None
def utmos(wav, sr):
    global _utmos
    if _utmos is None:
        _utmos = torch.hub.load("tarepan/SpeechMOS:v1.2.0", "utmos22_strong", trust_repo=True).cuda().eval()
    x = librosa.resample(wav, orig_sr=sr, target_sr=16000) if sr != 16000 else wav
    with torch.no_grad():
        return float(_utmos(torch.from_numpy(x).float().cuda()[None], 16000).item())

_utmos2 = None
def utmos2(path):
    global _utmos2
    if _utmos2 is None:
        import utmosv2
        _utmos2 = utmosv2.create_model(pretrained=True, device="cuda")
    return float(_utmos2.predict(input_path=str(path), device="cuda", verbose=False, num_workers=0))

def prosody(wav, sr, text):
    """Pitch spread (std of voiced F0, semitones), speaking rate (words per second of speech)."""
    x = librosa.resample(wav, orig_sr=sr, target_sr=16000) if sr != 16000 else wav
    f0, vflag, _ = librosa.pyin(x, fmin=60, fmax=500, sr=16000, frame_length=1024)
    f0 = f0[vflag & np.isfinite(f0)]
    st = 12 * np.log2(f0 / np.median(f0)) if len(f0) else np.array([0.0])
    rms = librosa.feature.rms(y=x, frame_length=512, hop_length=160)[0]
    speech_s = (rms > rms.max() * 0.05).sum() * 0.01
    return {"f0_med": float(np.median(f0)) if len(f0) else 0.0, "f0_st": float(np.std(st)),
            "wps": len(text.split()) / max(speech_s, 0.1)}

_asr = None
def transcribe(wav, sr):
    global _asr
    if _asr is None:
        from faster_whisper import WhisperModel
        _asr = WhisperModel("large-v3", device="cuda", compute_type="float16")
    x = librosa.resample(wav, orig_sr=sr, target_sr=16000) if sr != 16000 else wav
    segs, _ = _asr.transcribe(x.astype(np.float32), language="en", beam_size=5, condition_on_previous_text=False)
    return " ".join(s.text for s in segs).strip()

NUM = {"twelve": "12", "two": "2", "three": "3"}
def norm(t):
    t = t.lower().replace("’", "'")
    t = re.sub(r"[^a-z0-9' ]+", " ", t)
    words = [NUM.get(w, w) for w in t.split()]
    return " ".join(words).replace("t 3", "t3")

def spectrum(wav, sr):
    f, p = np.fft.rfftfreq(4096, 1 / sr), None
    S = np.abs(librosa.stft(wav, n_fft=4096, hop_length=1024)) ** 2
    p = S.mean(axis=1)
    tot = p[(f > 80)].sum()
    band = lambda a, b: float(p[(f >= a) & (f < b)].sum() / tot)
    return {"harsh_2_5k": band(2000, 5000), "sib_5_10k": band(5000, min(10000, sr / 2))}

def true_peak_db(wav, sr):
    up = librosa.resample(wav, orig_sr=sr, target_sr=sr * 4)
    return float(20 * np.log10(np.max(np.abs(up)) + 1e-12))

def score_file(path):
    wav, sr = sf.read(path, dtype="float32")
    if wav.ndim > 1: wav = wav.mean(axis=1)
    tag = pathlib.Path(path).stem.rsplit("__", 1)[1]
    txt = pathlib.Path(path).with_suffix(".txt")
    idx = int(tag) if tag.isdigit() else -1
    ref = txt.read_text().strip() if txt.exists() else LINES[idx]
    hyp = transcribe(wav, sr)
    meter = pyln.Meter(sr)
    r = {
        "file": pathlib.Path(path).name, "line": idx,
        "utmos": utmos(wav, sr),
        "wer": jiwer.wer(norm(ref), norm(hyp)), "hyp": hyp,
        "lufs": float(meter.integrated_loudness(wav.astype(np.float64))),
        "peak_db": float(20 * np.log10(np.max(np.abs(wav)) + 1e-12)),
        "true_peak_db": true_peak_db(wav, sr),
        "dur": len(wav) / sr,
    }
    r.update(spectrum(wav, sr))
    r.update(prosody(wav, sr, ref))
    if os.environ.get("UTMOS2", "1") == "1":
        r["utmos2"] = utmos2(path)
    return r

def main():
    for d in sys.argv[1:]:
        d = pathlib.Path(d)
        rows = [score_file(p) for p in sorted(d.glob("*__*.wav"))]
        (d / "scores.json").write_text(json.dumps(rows, indent=1))
        groups = {}
        for r in rows: groups.setdefault(r["file"].rsplit("__", 1)[0] if r["line"] >= 0 else r["file"][:-4], []).append(r)
        for g, rs in sorted(groups.items()):
            m = lambda k: np.mean([r[k] for r in rs])
            m2 = f"{m('utmos2'):.2f}" if "utmos2" in rs[0] else "  - "
            print(f"{g:22s} MOS {m('utmos'):.2f} MOS2 {m2}  F0sd {m('f0_st'):.2f}st  {m('wps'):.2f}w/s  WER {100*m('wer'):4.1f}%  LUFS {m('lufs'):6.1f}  "
                  f"TP {max(r['true_peak_db'] for r in rs):5.1f}  2-5k {100*m('harsh_2_5k'):4.1f}%  sib {100*m('sib_5_10k'):4.1f}%")
            for r in rs:
                if r["wer"] > 0: print(f"    [{r['line']}] {r['hyp']}")

if __name__ == "__main__":
    main()
