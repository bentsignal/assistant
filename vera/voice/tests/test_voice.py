"""Model-free tests: text shaping and the DSP chain.

  ~/.vera/voice/venv/Scripts/python -m unittest discover -s vera/voice/tests
"""
import unittest

import numpy as np

from vera_voice import dsp, text
from vera_voice.synth import SilenceShaper

SR = 24000


def speechlike(seconds=2.0, seed=0):
    """Harmonic bursts with a pitch glide and noisy 'sibilants', at roughly speech level."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * SR)) / SR
    f0 = 190 + 25 * np.sin(2 * np.pi * 0.7 * t)
    ph = 2 * np.pi * np.cumsum(f0) / SR
    x = sum(np.sin(k * ph) / k for k in range(1, 12))
    env = (np.sin(2 * np.pi * 2.2 * t) > -0.2).astype(float)
    hiss = np.convolve(rng.standard_normal(len(t)), [1, -1], "same") * (np.sin(2 * np.pi * 1.1 * t) > 0.8)
    return (0.1 * x * env + 0.05 * hiss).astype(np.float32)


class TextTests(unittest.TestCase):
    def test_strips_markup(self):
        s = text.normalize("See `foo` in **bold** and [the docs](http://x.y) or https://a.b/c\n```py\nprint(1)\n```")
        self.assertNotIn("`", s)
        self.assertNotIn("*", s)
        self.assertNotIn("print", s)
        self.assertIn("the docs", s)
        self.assertIn("a link", s)

    def test_sentences(self):
        parts = text.sentences("On it. I've asked Codex to check the build, I'll ping you when it's done.")
        self.assertEqual(parts[0], "On it.")
        self.assertEqual(len(parts), 2)

    def test_abbreviation_does_not_split(self):
        self.assertEqual(len(text.sentences("Ask Dr. Smith about it.")), 1)

    def test_long_first_sentence_is_cut_at_a_clause(self):
        parts = text.sentences("When the build finishes and the tests pass on every platform, "
                               "I'll let you know and post the summary to your inbox.")
        self.assertGreater(len(parts), 1)
        self.assertLessEqual(len(parts[0].split()), 14)

    def test_nothing_to_say(self):
        self.assertEqual(text.sentences("```only code```"), [])


class DspTests(unittest.TestCase):
    def test_presets_respect_ceiling_and_target(self):
        x = speechlike(4.0)
        for name, p in dsp.PRESETS.items():
            y = dsp.render(x, SR, p)
            self.assertLess(20 * np.log10(np.abs(y).max()), -3.0, name)
            self.assertAlmostEqual(dsp.loudness_lufs(y, SR), p.target_lufs, delta=1.0, msg=name)
            self.assertTrue(np.all(np.isfinite(y)), name)

    def test_chunked_equals_whole(self):
        x = speechlike(3.0, seed=1)
        p = dsp.PRESETS["vera"]
        g = dsp.calibrate_gain(x, SR, p)
        whole = dsp.render(x, SR, p, gain=g)
        chunked = dsp.render(x, SR, p, gain=g, chunk=2017)
        n = min(len(whole), len(chunked))
        err = np.abs(whole[:n] - chunked[:n]).max()
        self.assertLess(err, 0.02)  # only the limiter's lookahead differs at chunk edges

    def test_reverb_tail_comes_out_in_flush(self):
        c = dsp.Chain(SR, dsp.PRESETS["vera"], 1.0)
        c.process(speechlike(1.0))
        tail = c.flush()
        self.assertGreater(len(tail), int(0.1 * SR))
        self.assertLess(np.abs(tail[-100:]).max(), 1e-3)  # faded out

    def test_deesser_reduces_sibilance_only(self):
        rng = np.random.default_rng(3)
        hiss = np.convolve(rng.standard_normal(SR), [1, -1], "same").astype(np.float32) * 0.1
        p = dsp.Preset("d", deess_db=6.0)
        y = dsp.Chain(SR, p, 1.0).process(hiss)
        self.assertLess(np.std(y), np.std(hiss) * 0.9)
        tone = (0.1 * np.sin(2 * np.pi * 220 * np.arange(SR) / SR)).astype(np.float32)
        y = dsp.Chain(SR, p, 1.0).process(tone)
        self.assertAlmostEqual(np.std(y[SR // 2:]), np.std(tone), delta=0.01)


class ShaperTests(unittest.TestCase):
    def test_trims_lead_and_tail_to_fixed_pause(self):
        sil = np.zeros(SR // 2, np.float32)
        s = SilenceShaper(SR, trim_lead=True)
        burst = speechlike(0.5)
        out = np.concatenate([s.push(sil), s.push(np.concatenate([burst, sil]))])
        lead = np.nonzero(np.abs(out) > 1e-3)[0][0]
        self.assertLess(lead, int(0.03 * SR))
        self.assertLess(len(out), len(burst) + int(0.1 * SR))
        self.assertEqual(len(s.finish()), int(0.22 * SR))


if __name__ == "__main__":
    unittest.main()
