"""Text in, processed PCM out, one sentence at a time.

`Synth.stream(text, voice, preset)` yields float32 mono chunks at 24 kHz: sentences are
synthesized in order (the first starts streaming within a few hundred ms), leading and
trailing silence is trimmed to fixed pauses, and the whole utterance runs through one
effect chain so the reverb tail carries across sentence boundaries.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Iterator

import numpy as np

from . import dsp, guard, text as textmod
from .engines import (Engines, Voice, load_voices, cuda_available, SAMPLE_RATE, HOME, USER_VOICES_DIR,
                      SAMPLING, SAFE_SAMPLING)

log = logging.getLogger("assistant.voice")

CALIBRATION_FILE = HOME / "voice" / "calibration.json"
CALIBRATION_TEXT = [
    "Okay. The build finished, and I've left the summary in your inbox for later.",
    "Two of the tests failed in the audio module, so I asked Claude to take a look.",
    "Sure, I'll check on the thread and let you know what it says.",
]
SILENCE_DB = -50.0
SENTENCE_GAP_S = 0.22   # pause between sentences
LEAD_S = 0.015          # silence kept before the first word
RESTART_GAP_S = 0.3     # pause before a degenerate sentence is said again


class SilenceShaper:
    """Trims leading silence (first sentence) and trailing silence (every sentence), so
    pauses come out a fixed length whatever the engine left in. Holds back only the
    quiet tail of what it has seen, so speech is never delayed."""

    def __init__(self, sr: int, trim_lead: bool):
        self.sr = sr
        self.thr = 10 ** (SILENCE_DB / 20)
        self.lead = trim_lead
        self.held = np.zeros(0, np.float32)

    def push(self, x: np.ndarray) -> np.ndarray:
        x = np.concatenate([self.held, x])
        loud = np.nonzero(np.abs(x) > self.thr)[0]
        if self.lead:
            if len(loud) == 0:
                self.held = x[-int(LEAD_S * self.sr):]
                return np.zeros(0, np.float32)
            start = max(0, loud[0] - int(LEAD_S * self.sr))
            x, loud = x[start:], loud - start
            self.lead = False
        if len(loud) == 0:
            self.held = x
            return np.zeros(0, np.float32)
        end = loud[-1] + 1 + int(0.03 * self.sr)  # keep 30 ms of decay
        end = min(end, len(x))
        self.held = x[end:]
        return x[:end]

    def finish(self) -> np.ndarray:
        """End of a sentence: drop the held silence, return a fixed pause."""
        self.held = np.zeros(0, np.float32)
        return np.zeros(int(SENTENCE_GAP_S * self.sr), np.float32)


class Synth:
    def __init__(self, default_voice: str | None = None, default_preset: str = "vera"):
        self.voices = {v.id: v for v in load_voices()}
        self.cuda = cuda_available()
        self.engines = Engines()
        self.default_voice = self._pick_default(default_voice)
        self.default_preset = default_preset if default_preset in dsp.PRESETS else "vera"
        self._cal = self._load_calibration()
        self._cal_lock = threading.Lock()
        self.ready = False
        self.error: str | None = None

    def reload_voices(self) -> dict:
        """Read the voice list again (user voices added or removed since startup)."""
        voices = {v.id: v for v in load_voices()}
        with self._cal_lock:
            self._cal = {**self._cal, **self._load_calibration()}
        self.voices = voices
        if self.default_voice not in voices:
            self.default_voice = self._pick_default(None)
        log.info("reloaded voices: %s", ", ".join(voices))
        return self.describe()

    def _pick_default(self, want: str | None) -> str:
        if want and want in self.voices and self.available(self.voices[want]):
            return want
        for v in self.voices.values():
            if self.available(v):
                return v.id
        # No GPU: keep a default so the service still answers; warm() reports why it can't speak.
        return want if want in self.voices else next(iter(self.voices))

    def available(self, v: Voice) -> bool:
        return v.engine != "qwen" or self.cuda

    def voice(self, vid: str | None) -> Voice:
        v = self.voices.get(vid or self.default_voice)
        if v is None:
            raise KeyError(f"unknown voice {vid!r}")
        if not self.available(v):
            raise KeyError(f"voice {vid!r} needs a CUDA GPU")
        return v

    def preset(self, name: str | None, voice: Voice | None = None) -> dsp.Preset:
        """The named preset, else the voice's own, else the service default."""
        p = dsp.PRESETS.get(name or self.voice_preset(voice))
        if p is None:
            raise KeyError(f"unknown preset {name!r}")
        return p

    def voice_preset(self, v: Voice | None) -> str:
        return v.preset if v is not None and v.preset in dsp.PRESETS else self.default_preset

    # --- startup ----------------------------------------------------------------
    def warm(self):
        """Load the default voice's engine, run it once (CUDA graphs, caches) and make
        sure its loudness calibration exists. Sets `ready`."""
        try:
            t = time.perf_counter()
            v = self.voice(None)
            for _ in self.stream("Ready.", v.id):
                pass
            for p in dsp.PRESETS:
                self.gain(v, dsp.PRESETS[p])
            self.ready = True
            log.info("ready in %.1fs (voice %s)", time.perf_counter() - t, v.id)
            # calibrate the other voices on loaded engines so switching voices is instant
            for o in self.voices.values():
                if o.engine in self.engines.loaded() and self.available(o):
                    for p in dsp.PRESETS.values():
                        self.gain(o, p)
        except Exception as e:  # reported through /v1/health
            self.error = f"{type(e).__name__}: {e}"
            log.exception("warmup failed")

    # --- loudness calibration ----------------------------------------------------
    def _load_calibration(self) -> dict:
        """Shipped gains (measured on the dev machine) overlaid with this machine's and
        the user voices' own."""
        cal = {}
        users = sorted(USER_VOICES_DIR.glob("*/calibration.json")) if USER_VOICES_DIR.is_dir() else []
        for f in (Path(__file__).parent / "voices" / "calibration.json", CALIBRATION_FILE, *users):
            try:
                cal.update(json.loads(f.read_text()))
            except Exception:
                pass
        return cal

    def gain(self, v: Voice, p: dsp.Preset) -> float:
        key = cal_key(v, p)
        g = self._cal.get(key)
        if g is not None:
            return g
        with self._cal_lock:
            if key in self._cal:
                return self._cal[key]
            gap = np.zeros(int(SENTENCE_GAP_S * SAMPLE_RATE), np.float32)
            dry = np.concatenate([c for t in CALIBRATION_TEXT
                                  for c in [*self._raw(t, v, threading.Event()), gap]])
            g = dsp.calibrate_gain(dry, SAMPLE_RATE, p)
            self._cal[key] = g
            try:
                if v.user:  # kept with the voice, so it goes when the voice does
                    f = Path(v.ref).parent / "calibration.json"
                    own = {k: g for k, g in self._cal.items() if k.startswith(v.cal_id + "|")}
                    f.write_text(json.dumps(own, indent=1))
                else:
                    CALIBRATION_FILE.parent.mkdir(parents=True, exist_ok=True)
                    CALIBRATION_FILE.write_text(json.dumps(
                        {k: g for k, g in self._cal.items() if "#" not in k.split("|")[0]}, indent=1))
            except OSError:
                log.warning("couldn't save calibration")
            log.info("calibrated %s: gain %.2f dB", key, 20 * np.log10(g))
            return g

    # --- synthesis -----------------------------------------------------------------
    def _raw(self, sentence: str, v: Voice, stop: threading.Event) -> Iterator[np.ndarray]:
        yield from self.engines.get(v.engine).stream(sentence, v, stop, max_frames=guard.budget_frames(sentence))

    def stream(self, text: str, voice: str | None = None, preset: str | None = None,
               stop: threading.Event | None = None, timing: dict | None = None) -> Iterator[np.ndarray]:
        v = self.voice(voice)
        p = self.preset(preset, v)
        stop = stop or threading.Event()
        parts = textmod.sentences(text)
        if not parts:
            return
        chain = dsp.Chain(SAMPLE_RATE, p, self.gain(v, p))
        hold = guard.Holdback(SAMPLE_RATE)
        t0 = time.perf_counter()
        first = True
        for i, s in enumerate(parts):
            for y in self._sentence(s, v, stop, chain, hold, trim_lead=(i == 0), timing=timing):
                if stop.is_set():
                    return
                if first and timing is not None:
                    timing["first_audio_ms"] = 1000 * (time.perf_counter() - t0)
                first = False
                hold.sent_samples(len(y), time.perf_counter())
                yield y
            if stop.is_set():
                return
            if i < len(parts) - 1:
                gap = chain.process(np.zeros(int(SENTENCE_GAP_S * SAMPLE_RATE), np.float32))
                hold.sent_samples(len(gap), time.perf_counter())
                yield gap
        tail = chain.flush()
        if len(tail):
            yield tail
        if timing is not None:
            timing["total_ms"] = 1000 * (time.perf_counter() - t0)

    def base_voice(self, v: Voice) -> Voice | None:
        """The voice a sentence falls back to when `v` keeps degenerating."""
        want = v.base or ("isla" if v.gender == "female" else "eli")
        b = self.voices.get(want)
        if b is None or b.id == v.id or not self.available(b):
            return None
        return b

    def _attempts(self, v: Voice):
        yield v, SAMPLING, 0
        yield v, SAFE_SAMPLING, 1
        b = self.base_voice(v)
        if b is not None:
            yield b, SAMPLING, 0

    def _sentence(self, s: str, v: Voice, stop: threading.Event, chain: dsp.Chain,
                  hold: guard.Holdback, trim_lead: bool, timing: dict | None = None) -> Iterator[np.ndarray]:
        """One sentence through the guard: the newest audio is held back (as far as the
        client's buffer allows) while `SentenceWatch` checks it; a degenerate take is
        dropped and the sentence said again with safer sampling, then in the base voice."""
        released = False
        for n, (voice, sampling, seed) in enumerate(self._attempts(v)):
            shaper = SilenceShaper(SAMPLE_RATE, trim_lead=trim_lead or n > 0)
            watch = guard.SentenceWatch(s, SAMPLE_RATE)
            held: list[np.ndarray] = []
            held_n = 0
            bad = None
            gen = self.engines.get(voice.engine).stream(
                s, voice, stop, sampling=sampling, seed=seed, max_frames=watch.limit, tokens=watch.tokens)
            try:
                for raw in gen:
                    if stop.is_set():
                        return
                    watch.push_audio(raw)
                    bad = watch.check()
                    if bad:
                        break
                    held.append(raw)
                    held_n += len(raw)
                    keep = hold.keep(time.perf_counter())
                    while held and held_n - len(held[0]) >= keep:
                        r = held.pop(0)
                        held_n -= len(r)
                        y = chain.process(shaper.push(r))
                        if len(y):
                            released = True
                            yield y
            finally:
                gen.close()
            if stop.is_set():
                return
            if bad is None:
                bad = watch.finished()
            if bad is None:
                for r in held:
                    y = chain.process(shaper.push(r))
                    if len(y):
                        yield y
                return
            nxt = ("safer sampling" if n == 0 else
                   "the base voice" if n == 1 and self.base_voice(v) is not None else "nothing (skipping it)")
            log.warning("degenerate speech caught (voice %s, attempt %d, %.1fs generated, %s played): %s; "
                        "retrying with %s. Sentence: %r", voice.id, n + 1, watch.samples / SAMPLE_RATE,
                        "some" if released else "none", bad, nxt, s)
            if timing is not None:
                timing["regenerated"] = timing.get("regenerated", 0) + 1
            if released:
                yield chain.process(np.zeros(int(RESTART_GAP_S * SAMPLE_RATE), np.float32))
        log.error("skipped a sentence: every attempt degenerated: %r", s)

    def render(self, text: str, voice: str | None = None, preset: str | None = None) -> np.ndarray:
        chunks = list(self.stream(text, voice, preset))
        return np.concatenate(chunks) if chunks else np.zeros(0, np.float32)

    def describe(self) -> dict:
        return {
            "default": self.default_voice,
            "default_preset": self.default_preset,
            "sample_rate": SAMPLE_RATE,
            "voices": [dict(v.public(), preset=self.voice_preset(v), available=self.available(v))
                       for v in self.voices.values()],
            "presets": [{"id": p.name, "description": p.description}
                        for p in dsp.PRESETS.values() if p.name != "raw"],
        }


def cal_key(v: Voice, p: dsp.Preset) -> str:
    return f"{v.cal_id}|{v.engine}|{hash_preset(p)}|cal2"


def hash_preset(p: dsp.Preset) -> str:
    import hashlib
    return hashlib.sha1(repr(p).encode()).hexdigest()[:10]
