"""Turn someone's recording into a cloning reference: Qwen3-TTS Base clones best from about
10-15 s of one clean speaker, cut between sentences.

`pick_span` finds that stretch in a long clip (minutes are fine) without a model:

- an energy VAD (relative to the clip's own speech level and noise floor) marks speech,
  with short gaps filled in;
- pauses of 300 ms or more are the sentence boundaries a span may start and end at;
- each candidate span is scored for cleanliness (how quiet its pauses are next to its
  speech: music or noise under the voice keeps the floor up), a natural speech ratio
  (continuous sound with no pauses is more likely music), one steady speaker (the spread
  of per-phrase median pitch), no clipping, and a length near 12 s.

`prepare` trims the chosen span, high-passes it, levels it and caps its peak.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import signal

SR = 24000
MIN_S, MAX_S, IDEAL_S = 6.0, 15.0, 12.0
HOP_S = 0.01


@dataclass
class Span:
    start: float
    end: float
    score: float
    why: str

    @property
    def seconds(self) -> float:
        return self.end - self.start


def load(path: str) -> np.ndarray:
    """Any file soundfile reads (WAV, FLAC, Ogg, MP3 with libsndfile 1.1+), else librosa
    (ffmpeg), as mono float32 at 24 kHz."""
    try:
        import soundfile as sf
        x, sr = sf.read(path, dtype="float32", always_2d=True)
        x = x.mean(axis=1)
    except Exception:
        import librosa
        x, sr = librosa.load(path, sr=None, mono=True)
    if sr != SR:
        g = np.gcd(int(sr), SR)
        x = signal.resample_poly(x, SR // g, int(sr) // g)
    return np.asarray(x, np.float32)


def _frames_db(x: np.ndarray, sr: int) -> np.ndarray:
    hop, win = int(HOP_S * sr), int(0.03 * sr)
    if len(x) < win:
        return np.full(1, -120.0)
    n = 1 + (len(x) - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    rms = np.sqrt(np.mean(x[idx] ** 2, axis=1) + 1e-12)
    return 20 * np.log10(rms)


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]))


def speech_mask(db: np.ndarray) -> tuple[np.ndarray, float, float]:
    level, floor = np.percentile(db, 95), np.percentile(db, 10)
    thr = max(floor + 10, level - 30)
    m = db > thr
    for a, b in _runs(~m):  # fill gaps under 150 ms
        if b - a < 15 and a > 0 and b < len(m):
            m[a:b] = True
    for a, b in _runs(m):   # drop blips under 100 ms
        if b - a < 10:
            m[a:b] = False
    return m, level, floor


def _pitch(x: np.ndarray, sr: int) -> np.ndarray:
    """Frame pitch (Hz) on the HOP_S grid; NaN where unvoiced."""
    import librosa
    y = signal.resample_poly(x, 1, 3) if sr == SR else x  # 8 kHz is plenty for F0
    f0 = librosa.yin(y, fmin=60, fmax=400, sr=8000, frame_length=512, hop_length=80)
    return f0


def pick_span(x: np.ndarray, sr: int = SR) -> Span:
    """The best 6-15 s stretch of `x` to clone from (the whole clip if it's short)."""
    total = len(x) / sr
    db = _frames_db(x, sr)
    m, level, _ = speech_mask(db)
    phrases = [(a, b) for a, b in _runs(m)]
    if not phrases:
        raise ValueError("no speech found in the clip")
    # sentence boundaries: pauses of 300 ms or more split phrases into sentence groups
    groups: list[list[int]] = [[*phrases[0]]]
    for a, b in phrases[1:]:
        if a - groups[-1][1] >= 30:
            groups.append([a, b])
        else:
            groups[-1][1] = b
    f0 = _pitch(x, sr)
    n = min(len(f0), len(db))
    f0 = f0[:n]
    clip_frames = _frames_db((np.abs(x) > 0.985).astype(np.float32), sr) > -60  # frames with clipped samples

    def score(i: int, j: int) -> tuple[float, str]:
        a, b = groups[i][0], groups[j][1]
        seg_db, seg_m = db[a:b], m[a:b]
        speech_db = np.percentile(seg_db[seg_m], 90) if seg_m.any() else level
        pause = seg_db[~seg_m]
        floor_rel = (np.percentile(pause, 50) if len(pause) > 5 else np.percentile(seg_db, 5)) - speech_db
        ratio = seg_m.mean()
        meds = []
        for g in groups[i:j + 1]:
            p = f0[g[0]:min(g[1], n)]
            p = p[(p > 61) & (p < 399)]
            if len(p) > 20:
                meds.append(np.median(p))
        spread = float(np.std(12 * np.log2(np.array(meds) / np.median(meds)))) if len(meds) > 1 else 0.0
        clipped = float(clip_frames[a:b].mean()) if b > a else 0.0
        dur = (b - a) * HOP_S
        s = (min(-floor_rel, 50) / 10          # quiet pauses: clean, no music bed
             - 1.0 * spread                    # one steady speaker
             - 8 * max(0.0, ratio - 0.92)      # no pauses at all: likely music
             - 4 * max(0.0, 0.55 - ratio)      # mostly silence
             - 40 * clipped
             - abs(dur - IDEAL_S) / 4)
        why = (f"pause floor {floor_rel:.0f} dB under speech, speech {100 * ratio:.0f}%, "
               f"pitch spread {spread:.1f} st over {len(meds)} sentences")
        return s, why

    best: Span | None = None
    for i in range(len(groups)):
        for j in range(i, len(groups)):
            dur = (groups[j][1] - groups[i][0]) * HOP_S
            if dur > MAX_S:
                break
            if dur < MIN_S and not (i == 0 and j == len(groups) - 1):
                continue
            s, why = score(i, j)
            if best is None or s > best.score:
                best = Span(groups[i][0] * HOP_S, groups[j][1] * HOP_S, s, why)
    if best is None:
        # one long run with no sentence breaks: take the cleanest IDEAL_S window inside it
        w = int(IDEAL_S / HOP_S)
        step = max(1, w // 4)
        cands = range(0, max(1, len(db) - w), step)
        k = max(cands, key=lambda k: m[k:k + w].mean() - np.std(db[k:k + w]) / 20)
        best = Span(k * HOP_S, min(total, (k + w) * HOP_S), 0.0, "no sentence breaks found; cut a 12 s window")
    pad = 0.12
    best.start, best.end = max(0.0, best.start - pad), min(total, best.end + pad)
    return best


def prepare(x: np.ndarray, sr: int = SR, peak_db: float = -1.5, target_lufs: float = -23.0) -> np.ndarray:
    """High-pass at 70 Hz, level to about -23 LUFS, cap the peak, and fade the edges."""
    from .dsp import loudness_lufs
    y = signal.sosfilt(signal.butter(2, 70, "highpass", fs=sr, output="sos"), x.astype(np.float64))
    lufs = loudness_lufs(y, sr)
    if np.isfinite(lufs):
        y *= 10 ** ((target_lufs - lufs) / 20)
    pk = np.abs(y).max() + 1e-9
    y *= min(1.0, 10 ** (peak_db / 20) / pk)
    f = min(len(y) // 4, int(0.02 * sr))
    if f:
        y[:f] *= np.linspace(0, 1, f)
        y[-f:] *= np.linspace(1, 0, f)
    return y.astype(np.float32)
