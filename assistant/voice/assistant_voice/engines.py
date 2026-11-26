"""TTS engines behind the voice service.

- `qwen`: Qwen3-TTS 1.7B Base (Apache 2.0) on the GPU through faster-qwen3-tts (CUDA
  graphs, streaming). Each voice is a fixed ~10 s reference clip, designed once with
  Qwen3-TTS VoiceDesign from a text description (timbre, age, accent and delivery only)
  and then cloned, so the voice is identical every time. It needs a CUDA GPU.

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

log = logging.getLogger("assistant.voice")

SAMPLE_RATE = 24000
HOME = Path(os.environ.get("ASSISTANT_HOME", Path.home() / ".assistant"))
# `ASSISTANT_VOICE_MODELS` points a test home (ASSISTANT_HOME elsewhere) at the real models.
MODELS = Path(os.environ.get("ASSISTANT_VOICE_MODELS", HOME / "models"))
HF_HOME = MODELS / "hf"
VOICES_DIR = Path(__file__).parent / "voices"
# Voices made with `add-voice`: <id>/voice.json, ref.wav, ref.txt, calibration.json (user data).
USER_VOICES_DIR = HOME / "voices"

QWEN_BASE = "Qwen/Qwen3-TTS-12Hz-1.7B-Base"


@dataclass(frozen=True)
class Voice:
    id: str
    engine: str
    name: str
    description: str
    gender: str
    accent: str
    ref: str = ""        # qwen: reference clip in voices/ (with a .txt transcript), or an absolute path
    preset: str = ""     # this voice's own effects preset; empty uses the service default
    user: bool = False   # made with add-voice; overrides a built-in voice with the same id
    clip_sha: str = ""   # user voices: the reference clip's hash, so calibration follows the clip

    @property
    def cal_id(self) -> str:
        return f"{self.id}#{self.clip_sha}" if self.clip_sha else self.id

    def public(self) -> dict:
        d = asdict(self)
        d.pop("ref"); d.pop("clip_sha")
        return d


def _voice(d: dict) -> Voice:
    known = set(Voice.__dataclass_fields__)
    return Voice(**{k: v for k, v in d.items() if k in known})


def user_voices(root: Path | None = None) -> list[Voice]:
    """Voices in ~/.assistant/voices/<id>/ (a broken one is logged and skipped)."""
    root = root or USER_VOICES_DIR
    out = []
    for f in sorted(root.glob("*/voice.json")) if root.is_dir() else []:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            d.update(id=f.parent.name, engine="qwen", user=True, ref=str(f.parent / "ref.wav"))
            if not (f.parent / "ref.wav").is_file() or not (f.parent / "ref.txt").is_file():
                raise FileNotFoundError("ref.wav or ref.txt is missing")
            out.append(_voice(d))
        except Exception as e:
            log.warning("skipping user voice %s: %s", f.parent.name, e)
    return out


def load_voices(user_root: Path | None = None, include_user: bool = True) -> list[Voice]:
    """Built-in voices, then user voices (a user voice replaces a built-in one with its id)."""
    data = json.loads((VOICES_DIR / "voices.json").read_text(encoding="utf-8"))
    voices = {v["id"]: _voice(v) for v in data}
    if include_user:
        for v in user_voices(user_root):
            voices[v.id] = v
    return list(voices.values())


def cuda_available() -> bool:
    try:
        import torch
        return bool(torch.cuda.is_available())
    except Exception:
        return False


# Normal sampling, and the safer settings a sentence is regenerated with when it degenerates.
SAMPLING = dict(temperature=0.7, top_k=40, top_p=1.0, repetition_penalty=1.05)
SAFE_SAMPLING = dict(temperature=0.45, top_k=20, top_p=0.85, repetition_penalty=1.1)


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
        self._sink: list | None = None
        self._tap_codes()

    def _tap_codes(self):
        """Copy each streamed chunk's first-codebook tokens into `self._sink`, so the
        degeneration guard can see the codec loop the audio hides. faster-qwen3-tts imports
        its streaming loop at call time, so wrapping the module attribute is enough."""
        try:
            from faster_qwen3_tts import streaming as fs
        except Exception:
            log.warning("can't watch codec tokens (faster_qwen3_tts.streaming missing)")
            return
        if getattr(fs.fast_generate_streaming, "_assistant_tap", False):
            fs.fast_generate_streaming._assistant_engine = self
            return
        orig = fs.fast_generate_streaming
        engine = self

        def tapped(*a, **kw):
            for codec_chunk, timing in orig(*a, **kw):
                sink = tapped._assistant_engine._sink
                if sink is not None:
                    try:
                        sink.extend(codec_chunk[:, 0].tolist())
                    except Exception:
                        pass
                yield codec_chunk, timing

        tapped._assistant_tap = True
        tapped._assistant_engine = engine
        fs.fast_generate_streaming = tapped

    def stream(self, text: str, voice: Voice, stop: threading.Event, sampling: dict | None = None,
               seed: int = 0, max_frames: int = 2048, tokens: list | None = None) -> Iterator[np.ndarray]:
        """`tokens`, if given, receives the first-codebook codec tokens as they generate."""
        ref = VOICES_DIR / voice.ref
        ref_text = ref.with_suffix(".txt").read_text(encoding="utf-8").strip()
        with self.lock:
            self.torch.manual_seed(seed)  # same text, same reading
            self._sink = tokens
            gen = self.model.generate_voice_clone_streaming(
                text=text, language="English", ref_audio=str(ref), ref_text=ref_text,
                chunk_size=self.chunk_steps, max_new_tokens=max(8, int(max_frames)),
                **(sampling or SAMPLING))
            try:
                for chunk, sr, _timing in gen:
                    if stop.is_set():
                        break
                    yield np.asarray(chunk, np.float32).reshape(-1)
            finally:
                self._sink = None
                gen.close()


class Engines:
    """Loads engines on first use (the default voice's engine is loaded at startup)."""

    def __init__(self):
        self._engines: dict[str, object] = {}
        self._lock = threading.Lock()

    def get(self, name: str):
        with self._lock:
            if name not in self._engines:
                log.info("loading engine %s", name)
                if name != "qwen":
                    raise KeyError(f"unknown engine {name!r}")
                self._engines[name] = QwenEngine()
                log.info("engine %s loaded", name)
            return self._engines[name]

    def loaded(self) -> list[str]:
        return list(self._engines)
