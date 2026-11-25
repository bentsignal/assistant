"""Vera's character effects: a gentle plate reverb, a subtle synthetic tint, de-essing,
loudness normalization (about -20 LUFS) and a peak limiter (under -3 dBFS).

`Chain` is causal and stateful, so audio can be fed in any chunk sizes (sub-sentence
streaming) and the result is the same as processing it in one piece, apart from the
limiter's 3 ms lookahead at chunk edges. The reverb tail carries over between chunks;
`flush()` returns what's left at the end of an utterance.

No pitch processing: the voice's own prosody is left alone (v1's pitch flattening was a
big part of what made it unpleasant).
"""
from __future__ import annotations

from dataclasses import dataclass
import numpy as np
from scipy import signal
from scipy.ndimage import maximum_filter1d


@dataclass(frozen=True)
class Preset:
    name: str
    description: str = ""
    # reverb: a smooth synthetic plate, convolved
    reverb_mix: float = 0.0       # wet amplitude relative to dry (both unit energy)
    reverb_rt60: float = 0.6      # seconds in the lows; mids and highs decay faster
    reverb_predelay: float = 0.016
    reverb_lo: float = 250.0      # the wet signal is band-limited to this band
    reverb_hi: float = 6000.0
    # tint: a short feedback comb (a faint metallic resonance) and a slow, shallow chorus
    comb_mix: float = 0.0
    comb_ms: float = 4.0
    comb_fb: float = 0.35
    chorus_mix: float = 0.0
    chorus_delay_ms: float = 9.0
    chorus_depth_ms: float = 0.25
    chorus_rate: float = 0.3
    # tone
    deess_db: float = 0.0         # max sibilance reduction
    presence_db: float = 0.0      # peaking EQ at 3.2 kHz (negative softens harshness)
    warmth_db: float = 0.0        # low shelf at 220 Hz
    air_db: float = 0.0           # high shelf at 9 kHz
    # level
    target_lufs: float = -20.0
    ceiling_db: float = -3.8      # sample-peak ceiling, so true peaks stay under -3 dBFS


PRESETS: dict[str, Preset] = {
    # Tuned against UTMOS/UTMOSv2 and Whisper WER (see assistant/voice/README.md): reverb is
    # what costs naturalness scores, so it stays short and low; the tint stays faint.
    "vera": Preset(
        "vera", "Gentle plate and a faint synthetic sheen (default).",
        reverb_mix=0.10, reverb_rt60=0.6, comb_mix=0.04, comb_ms=3.0, chorus_mix=0.06,
        deess_db=4.0, presence_db=-1.0),
    "natural": Preset(
        "natural", "Almost dry: a touch of room, nothing synthetic.",
        reverb_mix=0.06, reverb_rt60=0.5, reverb_hi=4000, deess_db=3.0, presence_db=-1.0),
    "synthetic": Preset(
        "synthetic", "More of the robot: stronger comb and chorus, a larger plate.",
        reverb_mix=0.14, reverb_rt60=0.8, comb_mix=0.09, comb_ms=3.0, comb_fb=0.45,
        chorus_mix=0.12, chorus_depth_ms=0.35, deess_db=4.0, presence_db=-1.0),
    "raw": Preset("raw", "No character: only loudness and the limiter."),
}


def _band(sr, lo, hi, order=2):
    return signal.butter(order, [lo, min(hi, sr * 0.45)], "bandpass", fs=sr, output="sos")


def plate_ir(sr: int, p: Preset, seed: int = 7) -> np.ndarray:
    """Dense decorrelated noise with a frequency-dependent exponential decay (darker as it
    fades), a soft onset and predelay, band-limited, normalized to unit energy."""
    rng = np.random.default_rng(seed)
    n = int(sr * min(3.0, p.reverb_rt60 * 1.5))
    t = np.arange(n) / sr
    noise = rng.standard_normal(n)
    ir = np.zeros(n)
    for sos, k in ((signal.butter(2, 1200, "lowpass", fs=sr, output="sos"), 1.0),
                   (_band(sr, 1200, 3500), 0.7),
                   (signal.butter(2, 3500, "highpass", fs=sr, output="sos"), 0.45)):
        ir += signal.sosfilt(sos, noise) * np.exp(-6.91 * t / (p.reverb_rt60 * k))
    onset = int(0.008 * sr)
    ir[:onset] *= np.linspace(0, 1, onset) ** 2
    ir = np.concatenate([np.zeros(int(p.reverb_predelay * sr)), ir])
    ir = signal.sosfilt(_band(sr, p.reverb_lo, p.reverb_hi), ir)
    return ir / np.sqrt(np.sum(ir ** 2))


def _biquad(kind, sr, f0, gain_db, q=0.8):
    """RBJ cookbook peaking and shelving biquads, as SOS."""
    a = 10 ** (gain_db / 40)
    w = 2 * np.pi * f0 / sr
    c, s = np.cos(w), np.sin(w)
    if kind == "peak":
        al = s / (2 * q)
        b = [1 + al * a, -2 * c, 1 - al * a]
        d = [1 + al / a, -2 * c, 1 - al / a]
    else:
        sq = 2 * np.sqrt(a) * (s / 2 * np.sqrt(2))
        if kind == "lowshelf":
            b = [a * ((a + 1) - (a - 1) * c + sq), 2 * a * ((a - 1) - (a + 1) * c), a * ((a + 1) - (a - 1) * c - sq)]
            d = [(a + 1) + (a - 1) * c + sq, -2 * ((a - 1) + (a + 1) * c), (a + 1) + (a - 1) * c - sq]
        else:
            b = [a * ((a + 1) + (a - 1) * c + sq), -2 * a * ((a - 1) + (a + 1) * c), a * ((a + 1) + (a - 1) * c - sq)]
            d = [(a + 1) - (a - 1) * c + sq, 2 * ((a - 1) - (a + 1) * c), (a + 1) - (a - 1) * c - sq]
    return signal.tf2sos(np.array(b) / d[0], np.array(d) / d[0])


class _Sos:
    """A stateful SOS filter."""
    def __init__(self, sos):
        self.sos = sos
        self.zi = np.zeros((sos.shape[0], 2))

    def __call__(self, x):
        y, self.zi = signal.sosfilt(self.sos, x, zi=self.zi)
        return y


class _OnePole:
    """Stateful one-pole smoother (y += (1-a)(x-y))."""
    def __init__(self, sr, seconds):
        self.a = np.exp(-1 / (seconds * sr))
        self.zi = np.zeros(1)

    def __call__(self, x):
        y, self.zi = signal.lfilter([1 - self.a], [1, -self.a], x, zi=self.zi)
        return y


def loudness_lufs(x: np.ndarray, sr: int) -> float:
    """BS.1770 integrated loudness. Clips under 0.45 s use ungated K-weighted power."""
    import pyloudnorm as pyln
    m = pyln.Meter(sr)
    if len(x) >= int(0.45 * sr):
        v = m.integrated_loudness(np.asarray(x, np.float64))
        if np.isfinite(v):
            return float(v)
    y = np.asarray(x, np.float64)
    for f in m._filters.values():
        y = signal.lfilter(f.b, f.a, y)
    return float(-0.691 + 10 * np.log10(np.mean(y ** 2) + 1e-12))


class Chain:
    """One utterance's effect chain. `gain` is the linear gain that brings this voice's
    dry output to the preset's target loudness (calibrated once per voice)."""

    def __init__(self, sr: int, preset: Preset, gain: float = 1.0, ir: np.ndarray | None = None):
        p = self.p = preset
        self.sr, self.gain = sr, gain
        self.hp = _Sos(signal.butter(2, 70, "highpass", fs=sr, output="sos"))
        self.eq = [_Sos(s) for s in (
            _biquad("peak", sr, 3200, p.presence_db) if p.presence_db else None,
            _biquad("lowshelf", sr, 220, p.warmth_db) if p.warmth_db else None,
            _biquad("highshelf", sr, 9000, p.air_db) if p.air_db else None) if s is not None]
        # de-esser: split at 5 kHz with a complementary pair so the bands sum back flat
        self.sib_hp = _Sos(signal.butter(2, 5000, "highpass", fs=sr, output="sos"))
        self.env_hi, self.env_all = _OnePole(sr, 0.02), _OnePole(sr, 0.02)
        self.g_s = _OnePole(sr, 0.004)
        # tint
        self.comb_d = int(round(p.comb_ms * 1e-3 * sr))
        self.comb_zi = np.zeros(self.comb_d)
        self.comb_bp = _Sos(_band(sr, 400, 6000))
        self.hist = np.zeros(int((p.chorus_delay_ms + p.chorus_depth_ms + 2) * 1e-3 * sr))
        self.t = 0
        # reverb
        self.ir = (ir if ir is not None else plate_ir(sr, p)) if p.reverb_mix > 0 else None
        self.tail = np.zeros(0)
        self.ceil = 10 ** (p.ceiling_db / 20)
        self.lim_g = 1.0

    def _deess(self, x):
        if self.p.deess_db <= 0:
            return x
        hi = self.sib_hp(x)
        ratio = self.env_hi(np.abs(hi)) / (self.env_all(np.abs(x)) + 1e-5)
        over = np.clip((ratio - 0.25) / 0.25, 0, 1)
        g = self.g_s(10 ** (-self.p.deess_db * over / 20))
        return x - hi * (1 - g)

    def _tint(self, x):
        p, sr = self.p, self.sr
        y = x.copy()
        if p.comb_mix > 0:
            d = self.comb_d
            b = np.zeros(d + 1); b[d] = 1.0
            a = np.zeros(d + 1); a[0] = 1.0; a[d] = -p.comb_fb
            c, self.comb_zi = signal.lfilter(b, a, x, zi=self.comb_zi)
            y += p.comb_mix * self.comb_bp(c)
        if p.chorus_mix > 0:
            buf = np.concatenate([self.hist, x])
            h = len(self.hist)
            n = np.arange(len(x))
            delay = (p.chorus_delay_ms + p.chorus_depth_ms * np.sin(2 * np.pi * p.chorus_rate * (n + self.t) / sr)) * 1e-3 * sr
            y += p.chorus_mix * np.interp(n + h - delay, np.arange(len(buf)), buf)
            self.hist = buf[-h:]
        self.t += len(x)
        return y

    def _limit(self, x):
        """Peak limiter: gain is the min of ceiling/|x| over +-3 ms, with a 60 ms release
        carried across chunks; a final clip guarantees the ceiling."""
        if len(x) == 0:
            return x
        look = int(0.003 * self.sr)
        need = np.minimum(1.0, self.ceil / (maximum_filter1d(np.abs(x), size=2 * look + 1) + 1e-9))
        if need.min() >= 1.0 and self.lim_g >= 0.999:
            self.lim_g = 1.0
            return x
        a = np.exp(-1 / (0.06 * self.sr))
        g = np.empty_like(need)
        prev = self.lim_g
        for i in range(len(need)):  # short chunks; only runs while limiting
            v = need[i]
            prev = v if v < prev else 1.0 - (1.0 - prev) * a if prev < 1.0 else 1.0
            if prev > v:
                prev = v
            g[i] = prev
        self.lim_g = prev
        return np.clip(x * g, -self.ceil, self.ceil)

    def process(self, x: np.ndarray) -> np.ndarray:
        x = np.asarray(x, np.float64)
        if len(x) == 0:
            return np.zeros(0, np.float32)
        x = self.hp(x)
        for f in self.eq:
            x = f(x)
        x = self._deess(x)
        x = self._tint(x) * self.gain
        if self.ir is not None:
            wet = signal.fftconvolve(x, self.ir) * self.p.reverb_mix
            wet[:len(x)] += x
            y = wet
        else:
            y = x
        if len(self.tail):
            n = max(len(y), len(self.tail))
            y = np.pad(y, (0, n - len(y)))
            y[:len(self.tail)] += self.tail
        head, self.tail = y[:len(x)], y[len(x):]
        return self._limit(head).astype(np.float32)

    def flush(self, fade_s: float = 0.08) -> np.ndarray:
        t, self.tail = self.tail, np.zeros(0)
        if len(t) == 0:
            return np.zeros(0, np.float32)
        # trim the inaudible end of the tail (under -70 dB relative to ceiling)
        nz = np.nonzero(np.abs(t) > 10 ** (-70 / 20))[0]
        t = t[: (nz[-1] + 1) if len(nz) else 0]
        f = min(len(t), int(fade_s * self.sr))
        if f:
            t[-f:] *= np.linspace(1, 0, f) ** 2
        return self._limit(t).astype(np.float32)


def calibrate_gain(dry: np.ndarray, sr: int, preset: Preset) -> float:
    """Gain that brings `dry` (a typical sentence from this voice) to the target loudness
    once it has been through the preset's tone stages (measured with the reverb, since
    the tail adds a little loudness)."""
    c = Chain(sr, preset, 1.0)
    wet = np.concatenate([c.process(dry), c.flush()])
    lufs = loudness_lufs(wet, sr)
    return float(10 ** ((preset.target_lufs - lufs) / 20)) if np.isfinite(lufs) else 1.0


def render(x: np.ndarray, sr: int, preset: str | Preset, gain: float | None = None,
           chunk: int | None = None) -> np.ndarray:
    """Process a whole clip (tests, samples). `chunk` feeds it in pieces of that size."""
    p = PRESETS[preset] if isinstance(preset, str) else preset
    if gain is None:
        gain = calibrate_gain(x, sr, p)
    c = Chain(sr, p, gain)
    if chunk:
        parts = [c.process(x[i:i + chunk]) for i in range(0, len(x), chunk)]
    else:
        parts = [c.process(x)]
    return np.concatenate(parts + [c.flush()])
