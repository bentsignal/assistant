"""Short phrases kept rendered, so they play at once.

Core's acknowledgements ("One sec.", "Checking.", in each persona's voice)
must start the moment they're asked for, with no synthesis wait. Core warms
them through POST /v1/speech/warm; any short line the service renders in
full is kept too. Entries are keyed by voice, preset and exact text, and the
oldest go first past `MAX_ENTRIES`. A voice reload clears the cache.
"""
from __future__ import annotations

import logging
import queue
import threading
import time
from collections import OrderedDict

import numpy as np

log = logging.getLogger("assistant.voice")

#: Only lines this short are kept (acknowledgements, not answers).
MAX_CHARS = 48
MAX_ENTRIES = 128


class PhraseCache:
    def __init__(self, max_entries: int = MAX_ENTRIES):
        self.max_entries = max_entries
        self._items: OrderedDict[tuple[str, str, str], np.ndarray] = OrderedDict()
        self._lock = threading.Lock()
        self._jobs: queue.Queue = queue.Queue(maxsize=256)
        self._worker: threading.Thread | None = None

    @staticmethod
    def keeps(text: str) -> bool:
        return 0 < len(text.strip()) <= MAX_CHARS

    def get(self, voice: str, preset: str, text: str) -> np.ndarray | None:
        with self._lock:
            pcm = self._items.get((voice, preset, text))
            if pcm is not None:
                self._items.move_to_end((voice, preset, text))
            return pcm

    def put(self, voice: str, preset: str, text: str, pcm: np.ndarray) -> None:
        if not self.keeps(text) or not len(pcm):
            return
        with self._lock:
            self._items[(voice, preset, text)] = pcm
            self._items.move_to_end((voice, preset, text))
            while len(self._items) > self.max_entries:
                self._items.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._items.clear()

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)

    def warm(self, synth, items: list[dict]) -> int:
        """Queues each {text, voice?} to be rendered in the background; returns how many were queued."""
        n = 0
        for it in items:
            text = str(it.get("text") or "")
            if not self.keeps(text):
                continue
            try:
                self._jobs.put_nowait((synth, text, it.get("voice"), it.get("preset")))
                n += 1
            except queue.Full:
                break
        if n and (self._worker is None or not self._worker.is_alive()):
            self._worker = threading.Thread(target=self._run, name="phrases", daemon=True)
            self._worker.start()
        return n

    def _run(self) -> None:
        while True:
            try:
                synth, text, voice, preset = self._jobs.get(timeout=5)
            except queue.Empty:
                return
            try:
                # Core warms them at its start, often before the voice has loaded.
                waited = 0.0
                while not synth.ready and waited < 300:
                    time.sleep(0.5)
                    waited += 0.5
                if not synth.ready:
                    continue
                v = synth.voice(voice)
                p = synth.preset(preset, v)
                if self.get(v.id, p.name, text) is None:
                    self.put(v.id, p.name, text, synth.render(text, v.id, p.name))
            except Exception:
                log.exception("warming %r failed", text)
