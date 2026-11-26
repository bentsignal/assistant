import unittest

import numpy as np

from assistant_voice.phrases import MAX_CHARS, PhraseCache


class FakeVoice:
    def __init__(self, vid):
        self.id = vid


class FakePreset:
    name = "vera"


class FakeSynth:
    ready = True

    def __init__(self):
        self.rendered = []

    def voice(self, vid):
        return FakeVoice(vid or "isla")

    def preset(self, name, v=None):
        return FakePreset()

    def render(self, text, voice, preset):
        self.rendered.append((text, voice))
        return np.ones(10, np.float32)


class PhraseCacheTest(unittest.TestCase):
    def test_keeps_short_lines_by_voice_and_text(self):
        c = PhraseCache(max_entries=2)
        c.put("isla", "vera", "One sec.", np.ones(5, np.float32))
        self.assertIsNotNone(c.get("isla", "vera", "One sec."))
        self.assertIsNone(c.get("alfred", "vera", "One sec."))
        c.put("isla", "vera", "x" * (MAX_CHARS + 1), np.ones(5, np.float32))
        self.assertEqual(len(c), 1)

    def test_oldest_go_first(self):
        c = PhraseCache(max_entries=2)
        for t in ("a.", "b.", "c."):
            c.put("isla", "vera", t, np.ones(3, np.float32))
        self.assertIsNone(c.get("isla", "vera", "a."))
        self.assertIsNotNone(c.get("isla", "vera", "c."))

    def test_warm_renders_in_the_background(self):
        c = PhraseCache()
        s = FakeSynth()
        self.assertEqual(c.warm(s, [{"text": "One moment, sir.", "voice": "alfred"}, {"text": ""}]), 1)
        c._worker.join(timeout=10)
        self.assertEqual(s.rendered, [("One moment, sir.", "alfred")])
        self.assertIsNotNone(c.get("alfred", "vera", "One moment, sir."))


if __name__ == "__main__":
    unittest.main()
