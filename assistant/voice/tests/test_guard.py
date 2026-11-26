"""Model-free tests: the degeneration guard and the leveler."""
import unittest

import numpy as np

from assistant_voice import dsp, guard, text

SR = 24000


def voiced(seconds, f0=120.0, seed=0):
    t = np.arange(int(seconds * SR)) / SR
    ph = 2 * np.pi * np.cumsum(f0 + 10 * np.sin(2 * np.pi * 0.8 * t)) / SR
    return (0.1 * sum(np.sin(k * ph) / k for k in range(1, 10))).astype(np.float32)


def babble(seconds, seed=0):
    """Loud, unpitched: what the runaway turns into."""
    rng = np.random.default_rng(seed)
    x = rng.standard_normal(int(seconds * SR))
    return (0.05 * np.convolve(x, np.ones(3) / 3, "same")).astype(np.float32)


class BudgetTests(unittest.TestCase):
    def test_budget_is_generous_but_bounded(self):
        s = "The error says my calls run at approval required, and that thread runs full access."
        # read at 13-18 chars/s this is about 5-6 s; the runaway ran for 50 s
        self.assertGreater(guard.budget_s(s), 9.0)
        self.assertLess(guard.budget_s(s), 11.0)
        self.assertGreater(guard.budget_s("It's 2026."), guard.budget_s("It's then."))
        self.assertEqual(guard.budget_frames(s), int(np.ceil(guard.budget_s(s) * guard.FRAME_HZ)))

    def test_watch_trips_on_length(self):
        w = guard.SentenceWatch("Okay.", SR)
        for _ in range(20):
            w.push_audio(voiced(0.24))
            if w.check():
                break
        self.assertIn("length budget", w.check())


class LoopTests(unittest.TestCase):
    def test_speechlike_tokens_pass(self):
        rng = np.random.default_rng(1)
        self.assertIsNone(guard.token_loop(rng.integers(0, 2048, 200).tolist()))

    def test_stutter_and_stuck_tokens_trip(self):
        self.assertIsNotNone(guard.token_loop([5, 900, 77] * 20))            # period 3
        self.assertIsNotNone(guard.token_loop(list(range(40)) + [3] * 40))   # stuck
        rng = np.random.default_rng(2)
        noisy = np.tile([11, 12, 13, 14], 15)
        noisy[rng.integers(0, len(noisy), 8)] = 999   # a loop with a few slips still trips
        self.assertIsNotNone(guard.token_loop(noisy.tolist()))

    def test_a_stutter_without_a_fixed_period_trips(self):
        rng = np.random.default_rng(4)
        stutter = rng.choice([7, 40, 41, 300, 1200], 38).tolist()   # a few sounds, in any order
        self.assertIn("recurring", guard.token_loop(stutter))

    def test_short_history_never_trips(self):
        self.assertIsNone(guard.token_loop([1] * 10))


class VoicingTests(unittest.TestCase):
    def test_speech_is_voiced_babble_is_not(self):
        self.assertGreater(guard.voiced_fraction(voiced(2.0), SR), 0.8)
        self.assertLess(guard.voiced_fraction(babble(2.0), SR), 0.1)
        self.assertIsNone(guard.voiced_fraction(np.zeros(SR, np.float32), SR))

    def test_watch_trips_when_speech_turns_to_babble(self):
        w = guard.SentenceWatch("x" * 200, SR)   # long budget
        reasons = []
        for i in range(30):
            w.push_audio(voiced(0.25) if i < 10 else babble(0.25, seed=i))
            reasons.append(w.check())
        self.assertTrue(all(r is None for r in reasons[:10]))
        self.assertTrue(any(r and "speech" in r for r in reasons))


class HoldbackTests(unittest.TestCase):
    def test_holds_back_part_of_the_clients_buffer(self):
        h = guard.Holdback(SR)
        self.assertEqual(h.keep(0.0), 0)               # first audio goes out at once
        h.sent_samples(3 * SR, 0.0)                     # 3 s sent at t=0
        self.assertEqual(h.keep(1.0), SR)              # 2 s still buffered: hold 1 s
        self.assertEqual(h.keep(3.5), 0)               # client caught up: hold nothing
        h.sent_samples(20 * SR, 3.5)
        self.assertEqual(h.keep(3.5), int(2.5 * SR))   # capped


class TextTests(unittest.TestCase):
    def test_hyphenated_words_are_spaced(self):
        s = text.normalize("Calls run at approval-required; full-access, -3 dB, T3.")
        self.assertIn("approval required", s)
        self.assertIn("full access", s)
        self.assertIn("-3", s)


class LevelerTests(unittest.TestCase):
    def test_evens_out_a_quiet_word_and_keeps_pauses_quiet(self):
        loud, quiet = voiced(1.5), voiced(0.6) * 10 ** (-8 / 20)
        pause = np.zeros(int(0.5 * SR), np.float32)
        x = np.concatenate([loud, quiet, loud, pause, loud])
        y = dsp.Leveler(SR)(x.copy())
        seg = lambda a, s, e: 20 * np.log10(np.sqrt(np.mean(a[int(s * SR):int(e * SR)] ** 2)) + 1e-12)
        before = seg(x, 0.2, 1.4) - seg(x, 1.75, 2.1)
        after = seg(y, 0.2, 1.4) - seg(y, 1.75, 2.1)
        self.assertGreater(before, 7.5)
        self.assertLess(after, before - 3.0)            # the quiet word comes up
        self.assertLess(np.abs(y[int(3.75 * SR):int(4.05 * SR)]).max(), 1e-9)  # silence stays silent

    def test_leveler_is_chunk_size_invariant(self):
        x = np.concatenate([voiced(1.0), voiced(0.7) * 0.3, voiced(1.0)])
        whole = dsp.Leveler(SR)(x.copy())
        lv = dsp.Leveler(SR)
        parts = np.concatenate([lv(x[i:i + 1777].copy()) for i in range(0, len(x), 1777)])
        self.assertLess(np.abs(whole - parts).max(), 1e-6)

    def test_boost_and_cut_are_limited(self):
        x = np.concatenate([voiced(1.0), voiced(1.0) * 10 ** (-20 / 20)])
        y = dsp.Leveler(SR)(x.copy())
        gain = 20 * np.log10(np.sqrt(np.mean(y[-SR // 2:] ** 2)) / np.sqrt(np.mean(x[-SR // 2:] ** 2)))
        self.assertLessEqual(gain, dsp.LEVEL_BOOST_DB + dsp.LEVEL_MAKEUP_DB + 0.1)


class FakeEngine:
    """Says every take with `stuck` tokens until `good_seed`, which comes out clean."""

    def __init__(self, good_seed=None):
        self.good_seed, self.calls = good_seed, []

    def stream(self, text, voice, stop, sampling=None, seed=0, max_frames=0, tokens=None):
        self.calls.append((voice.id, seed, dict(sampling)))
        rng = np.random.default_rng(seed)
        for i in range(12):
            tokens.extend([7] * 6 if seed != self.good_seed else rng.integers(0, 2048, 6).tolist())
            yield voiced(0.48, seed=i)
            if seed == self.good_seed and i == 3:
                return


class RetryTests(unittest.TestCase):
    def run_sentence(self, good_seed):
        from assistant_voice import synth as sy
        from assistant_voice.engines import Voice
        s = object.__new__(sy.Synth)
        eng = FakeEngine(good_seed)
        s.engines = type("E", (), {"get": lambda self, name: eng})()
        saul = Voice(id="saul", engine="qwen", name="Saul", description="", gender="male", accent="American")
        chain = dsp.Chain(SR, dsp.PRESETS["raw"], 1.0)
        out = list(s._sentence("A sentence of about this length, give or take.", saul,
                               __import__("threading").Event(), chain, guard.Holdback(SR), trim_lead=True))
        return eng.calls, out

    def test_a_degenerate_sentence_is_retried_in_the_same_voice(self):
        calls, out = self.run_sentence(good_seed=2)
        self.assertEqual([c[:2] for c in calls], [("saul", 0), ("saul", 1), ("saul", 2)])
        self.assertLess(calls[1][2]["temperature"], calls[0][2]["temperature"])
        self.assertGreater(sum(len(y) for y in out), SR)

    def test_a_sentence_that_never_comes_out_clean_is_skipped_never_revoiced(self):
        from assistant_voice import synth as sy
        with self.assertLogs("assistant.voice", "ERROR"):
            calls, out = self.run_sentence(good_seed=None)
        self.assertEqual({c[0] for c in calls}, {"saul"})
        self.assertEqual(len(calls), sy.RETRIES + 1)
        self.assertFalse(hasattr(sy.Synth, "base_voice"))


if __name__ == "__main__":
    unittest.main()
