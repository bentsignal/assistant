"""Guards that keep a misbehaving TTS model from reaching the speaker.

Qwen3-TTS is autoregressive: now and then a sentence never emits its end token and the
model keeps going, first stuttering on one sound ("approval r-r-r-r…"), then babbling in
something that no longer sounds like speech, until the context runs out (about a minute
of audio). Three checks catch that while a sentence streams:

- **Length budget.** A sentence can't run much longer than its text implies
  (`budget_s`); generation is also capped there.
- **Token loop.** The first-codebook codec tokens of the last few seconds cycle with a
  short period, keep recurring (the stutter), or sit on one token.
- **Voicing collapse.** Speech is mostly voiced; the babble isn't (`voiced_fraction`).

`Holdback` keeps the newest audio of a sentence back from the client, as much as the
client's own buffer allows, so a sentence caught early never reaches the speaker.
Everything here is model-free and tested in `tests/test_guard.py`.
"""
from __future__ import annotations

import numpy as np

FRAME_HZ = 12.5            # Qwen3-TTS 12 Hz tokenizer: 1920 samples per codec frame at 24 kHz

# Budget: about twice a slow reading, so it only trips on runaway sentences. The voices
# read 14-19 chars/s (measured: at most 0.064 s/char); a digit counts as four characters,
# since Qwen reads "2026" as "twenty twenty-six".
BUDGET_BASE_S = 1.5
BUDGET_S_PER_CHAR = 0.1
BUDGET_DIGIT_CHARS = 4

# Token loop: within the last LOOP_WINDOW frames, the share of frames equal to the frame
# `p` steps back, for the best period p in 1..LOOP_MAX_PERIOD.
LOOP_WINDOW = 30           # 2.4 s
LOOP_MAX_PERIOD = 8
LOOP_SHARE = 0.6
# Stutter: the share of frames in the window whose token already occurred in the 8 frames
# before it, with no fixed period. Clean speech measured at most 0.17 (60 sentences, four
# voices); forced loops 0.37-1.0.
RECUR_BACK = 8
RECUR_SHARE = 0.35

# Voicing: over the last VOICE_WINDOW_S of non-silent audio.
VOICE_WINDOW_S = 2.0
VOICE_MIN = 0.2
VOICE_SILENCE_DB = -45.0


def budget_s(text: str) -> float:
    """The longest a sentence of this text may plausibly take to say."""
    t = text.strip()
    chars = len(t) + (BUDGET_DIGIT_CHARS - 1) * sum(c.isdigit() for c in t)
    return BUDGET_BASE_S + BUDGET_S_PER_CHAR * chars


def budget_frames(text: str) -> int:
    return int(np.ceil(budget_s(text) * FRAME_HZ))


def token_loop(tokens: list[int] | np.ndarray) -> str | None:
    """A reason if the last LOOP_WINDOW tokens repeat with a short period, else None."""
    t = np.asarray(tokens[-(LOOP_WINDOW + LOOP_MAX_PERIOD):])
    if len(t) < LOOP_WINDOW + LOOP_MAX_PERIOD:
        return None
    w = t[LOOP_MAX_PERIOD:]
    for p in range(1, LOOP_MAX_PERIOD + 1):
        share = float(np.mean(w == t[LOOP_MAX_PERIOD - p:len(t) - p]))
        if share >= LOOP_SHARE:
            return f"codec tokens repeat every {p} frame{'s' if p > 1 else ''} ({share:.0%} of {LOOP_WINDOW})"
    k = LOOP_MAX_PERIOD
    recur = float(np.mean([t[i] in t[i - RECUR_BACK:i] for i in range(k, len(t))]))
    if recur >= RECUR_SHARE:
        return f"codec tokens keep recurring ({recur:.0%} of {LOOP_WINDOW} frames seen in the 8 before)"
    return None


def voiced_fraction(x: np.ndarray, sr: int) -> float | None:
    """Share of non-silent 40 ms frames with a clear pitch (normalized autocorrelation
    peak over 60-400 Hz above 0.5). None when there's too little sound to judge."""
    n = int(0.04 * sr)
    lo, hi = int(sr / 400), int(sr / 60)
    frames = len(x) // n
    if frames == 0:
        return None
    f = np.asarray(x[:frames * n], np.float64).reshape(frames, n)
    rms = np.sqrt(np.mean(f ** 2, axis=1))
    loud = 20 * np.log10(rms + 1e-12) > VOICE_SILENCE_DB
    if loud.sum() < 10:
        return None
    f = f[loud] - f[loud].mean(axis=1, keepdims=True)
    spec = np.fft.rfft(f, 2 * n, axis=1)
    ac = np.fft.irfft(np.abs(spec) ** 2, axis=1)[:, :n]
    peak = ac[:, lo:hi].max(axis=1) / (ac[:, 0] + 1e-12)
    return float(np.mean(peak > 0.5))


class SentenceWatch:
    """Watches one sentence as it generates. `check()` returns a reason once it has
    degenerated, else None."""

    def __init__(self, text: str, sr: int):
        self.sr = sr
        self.limit = budget_frames(text)
        self.tokens: list[int] = []
        self.audio: list[np.ndarray] = []
        self.samples = 0
        self._checked_voice_at = 0

    def push_audio(self, x: np.ndarray):
        self.audio.append(x)
        self.samples += len(x)

    def check(self) -> str | None:
        frames = max(len(self.tokens), int(self.samples / self.sr * FRAME_HZ))
        if frames >= self.limit:
            return f"ran past its length budget ({self.limit / FRAME_HZ:.1f}s)"
        r = token_loop(self.tokens)
        if r:
            return r
        # voicing, every ~0.5 s once there's a window's worth
        if self.samples - self._checked_voice_at >= self.sr // 2 and self.samples >= VOICE_WINDOW_S * self.sr:
            self._checked_voice_at = self.samples
            tail = np.concatenate(self.audio)[-int(VOICE_WINDOW_S * self.sr):]
            self.audio = [tail]
            v = voiced_fraction(tail, self.sr)
            if v is not None and v < VOICE_MIN:
                return f"stopped sounding like speech (voiced {v:.0%} of the last {VOICE_WINDOW_S:.0f}s)"
        return None

    def finished(self) -> str | None:
        """At the end of a sentence: did it stop only because it hit the cap?"""
        frames = max(len(self.tokens), int(self.samples / self.sr * FRAME_HZ))
        if frames >= self.limit - 1:
            return f"hit its length cap ({self.limit / FRAME_HZ:.1f}s) without finishing"
        return None


class Holdback:
    """How much of the newest audio may be held back from the client. The client plays in
    real time while generation runs about 3x faster, so the audio it has buffered (sent
    minus elapsed) grows; holding back up to half of that, capped, never starves it, and
    the first audio of a reply goes out at once."""

    def __init__(self, sr: int, share: float = 0.5, max_s: float = 2.5):
        self.sr, self.share, self.max_s = sr, share, max_s
        self.t0: float | None = None
        self.sent = 0

    def keep(self, now: float) -> int:
        """Samples to keep held at this moment."""
        if self.t0 is None:
            return 0
        lead = self.sent / self.sr - (now - self.t0)
        return int(self.sr * min(self.max_s, max(0.0, self.share * lead)))

    def sent_samples(self, n: int, now: float):
        if self.t0 is None and n:
            self.t0 = now
        self.sent += n
