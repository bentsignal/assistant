"""TTS engines behind the voice service.

- `qwen`: Qwen3-TTS 1.7B Base (Apache 2.0) on the GPU through faster-qwen3-tts (CUDA
  graphs, streaming). Each voice is a fixed ~10 s reference clip, designed once with
  Qwen3-TTS VoiceDesign from a text description ("calm, even, low emotion ...") and then
  cloned, so the voice is identical every time.
- `kokoro`: Kokoro-82M (Apache 2.0) through kokoro-onnx on the CPU. Lighter and a bit
  more synthetic; the fallback when there's no CUDA GPU.

Engines yield float32 mono chunks at 24 kHz.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterator

import numpy as np

log = logging.getLogger("vera.voice")

SAMPLE_RATE = 24000
HOME = Path(os.environ.get("VERA_HOME", Path.home() / ".vera"))
MODELS = HOME / "models"
HF_HOME = MODELS / "hf"
KOKORO_DIR = MODELS / "kokoro-onnx"
VOICES_DIR = Path(__file__).parent / "voices"

QWEN_BASE = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"


@dataclass(frozen=True)
class Voice:
    id: str
    engine: str
    name: str
    description: str
    gender: str
    accent: str
    ref: str = ""        # qwen: reference clip in voices/ (with a .txt transcript)
    kokoro: str = ""     # kokoro: voice name
    speed: float = 1.0

    def public(self) -> dict:
        d = asdict(self)
        d.pop("ref"); d.pop("kokoro")
        return d


def load_voices() -> list[Voice]:
    data = json.loads((VOICES_DIR / "voices.json").read_text(encoding="utf-8"))
    return [Voice(**v) for v in data]


def cuda_available() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


class QwenEngine:
    name = "qwen"

    def __init__(self, chunk_steps: int = 6):
        os.environ.setdefault("HF_HOME", str(HF_HOME))
        import torch
        from faster_qwen3_tts import FasterQwen3TTS
        self.torch = torch
        try:  # offline first: no network round trip once setup has downloaded the model
            os.environ["HF_HUB_OFFLINE"] = "1"
            self.model = FasterQwen3TTS.from_pretrained(QWEN_BASE, max_seq_len=1024, local_files_only=True)
        except Exception:
            log.info("Qwen3-TTS isn't downloaded yet; fetching it (about 4.5 GB)")
            os.environ.pop("HF_HUB_OFFLINE", None)
            self.model = FasterQwen3TTS.from_pretrained(QWEN_BASE, max_seq_len=1024)
        self.chunk_steps = chunk_steps
        self.lock = threading.Lock()

    def stream(self, text: str, voice: Voice, stop: threading.Event) -> Iterator[np.ndarray]:
        ref = VOICES_DIR / voice.ref
        ref_text = ref.with_suffix(".txt").read_text(encoding="utf-8").strip()
        with self.lock:
            self.torch.manual_seed(0)  # same text, same reading
            gen = self.model.generate_voice_clone_streaming(
                text=text, language="English", ref_audio=str(ref), ref_text=ref_text,
                chunk_size=self.chunk_steps, temperature=0.7, top_k=40, repetition_penalty=1.05)
            try:
                for chunk, sr, _timing in gen:
                    if stop.is_set():
                        break
                    yield np.asarray(chunk, np.float32).reshape(-1)
            finally:
                gen.close()


class KokoroEngine:
    name = "kokoro"

    def __init__(self):
        from kokoro_onnx import Kokoro
        self.k = Kokoro(str(KOKORO_DIR / "kokoro-v1.0.onnx"), str(KOKORO_DIR / "voices-v1.0.bin"))
        self.lock = threading.Lock()

    def stream(self, text: str, voice: Voice, stop: threading.Event) -> Iterator[np.ndarray]:
        lang = "en-gb" if voice.kokoro.startswith("b") else "en-us"
        with self.lock:
            a, sr = self.k.create(text, voice=voice.kokoro, speed=voice.speed, lang=lang)
        if not stop.is_set():
            yield np.asarray(a, np.float32).reshape(-1)


class Engines:
    """Loads engines on first use (the default voice's engine is loaded at startup)."""

    def __init__(self):
        self._engines: dict[str, object] = {}
        self._lock = threading.Lock()

    def get(self, name: str):
        with self._lock:
            if name not in self._engines:
                log.info("loading engine %s", name)
                self._engines[name] = QwenEngine() if name == "qwen" else KokoroEngine()
                log.info("engine %s loaded", name)
            return self._engines[name]

    def loaded(self) -> list[str]:
        return list(self._engines)
