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


class LexiconTests(unittest.TestCase):
    def say(self, line):
        from pathlib import Path
        import tempfile
        from vera_voice import lexicon
        with tempfile.TemporaryDirectory() as home:
            return lexicon.apply(line, Path(home))

    def test_terms(self):
        self.assertEqual(self.say("Check the T3 thread on GitHub."), "Check the T three thread on Git Hub.")
        self.assertEqual(self.say("Open T3 Code."), "Open T three Code.")
        self.assertEqual(self.say("The JSON from the CLI and npm."), "The Jason from the C L I and N P M.")
        self.assertEqual(self.say("Your ID, I'd say."), "Your I D, I'd say.")
        self.assertEqual(self.say("It took 200 ms and 3GB."), "It took 200 milliseconds and 3 gigabytes.")
        self.assertEqual(self.say("Run vera.exe now."), "Run vera dot E X E now.")

    def test_heteronyms_in_certain_company(self):
        self.assertEqual(self.say("The lead detonation is Friday."), "The led detonation is Friday.")
        self.assertEqual(self.say("Old lead pipes and lead-free paint."), "Old led pipes and led-free paint.")
        self.assertEqual(self.say("It's made of lead."), "It's made of led.")
        self.assertEqual(self.say("I've read it, and he had read it too."), "I've red it, and he had red it too.")
        self.assertEqual(self.say("Live music tonight; the stream is live."), "Lyve music tonight; the stream is lyve.")
        self.assertEqual(self.say("Wind up the cord."), "Wined up the cord.")
        self.assertEqual(self.say("Tear down the old shed."), "Tare down the old shed.")
        self.assertEqual(self.say("A bass guitar."), "A base guitar.")
        self.assertEqual(self.say("We're close to done."), "We're kloce to done.")

    def test_ambiguous_ones_are_left_alone(self):
        for line in [
            "Take the lead.",
            "Lead the way.",
            "She will lead the team with lead singer Ann.",
            "Read me the list.",
            "I live in Ohio.",
            "The wind is strong.",
            "A tear fell.",
            "Close the window.",
            "We caught a bass.",
        ]:
            self.assertEqual(self.say(line), line)

    def test_user_lexicon(self):
        from pathlib import Path
        import tempfile
        from vera_voice import lexicon
        with tempfile.TemporaryDirectory() as home:
            (Path(home) / "voice").mkdir()
            (Path(home) / "voice" / "lexicon.json").write_text('{"Hex": "Hecks", "JSON": "jay son"}')
            self.assertEqual(lexicon.apply("Hex reads JSON.", Path(home)), "Hecks reads jay son.")


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
