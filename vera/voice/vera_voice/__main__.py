"""vera-voice: Vera's local TTS service.

  pythonw -m vera_voice serve [--port 7314] [--voice ID] [--preset vera] [--parent-pid PID]   (no console)
  python  -m vera_voice say "Text" [--voice ID] [--preset P] [--out file.wav]
  python  -m vera_voice voices
  python  -m vera_voice calibrate      (measure every voice's loudness gain; runs on demand otherwise)

Defaults come from the "voice" section of ~/.vera/config.json:
  {"voice": {"port": 7314, "voice": "vera", "preset": "vera"}}
Logs go to ~/.vera/logs/voice.log.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

HOME = Path(os.environ.get("VERA_HOME", Path.home() / ".vera"))


def _hide_children():
    """No console window may ever flash: every child process (including os.popen's shell)
    is created with CREATE_NO_WINDOW. The `sox` package runs `sox -h` through the shell
    on import; qwen-tts imports it only for a tokenizer Vera doesn't use, so stub it."""
    import subprocess, types
    if os.name == "nt":
        orig = subprocess.Popen.__init__

        def init(self, *a, **kw):
            kw["creationflags"] = kw.get("creationflags", 0) | subprocess.CREATE_NO_WINDOW
            orig(self, *a, **kw)
        subprocess.Popen.__init__ = init
    if "sox" not in sys.modules:
        stub = types.ModuleType("sox")
        stub.NO_SOX = True
        sys.modules["sox"] = stub


def _quiet_console():
    # pythonw has no console: stdout/stderr are None, and libraries that print would crash.
    log_dir = HOME / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    if sys.stdout is None or sys.stderr is None:
        f = open(log_dir / "voice.stdio.log", "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or f
        sys.stderr = sys.stderr or f
    os.environ.setdefault("HF_HOME", str(HOME / "models" / "hf"))
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TQDM_DISABLE", "1")
    os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


def _config() -> dict:
    try:
        return json.loads((HOME / "config.json").read_text(encoding="utf-8")).get("voice", {}) or {}
    except Exception:
        return {}


def _logging(to_console: bool):
    handlers = [logging.FileHandler(HOME / "logs" / "voice.log", encoding="utf-8")]
    if to_console and sys.stderr is not None:
        handlers.append(logging.StreamHandler())
    logging.basicConfig(level=logging.INFO, handlers=handlers,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for noisy in ("httpx", "urllib3", "huggingface_hub", "transformers", "faster_qwen3_tts", "qwen_tts"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def _exit_with_parent(pid: int):
    """Watch the parent process and exit (freeing the GPU) as soon as it's gone."""
    import ctypes, threading
    k32 = ctypes.windll.kernel32
    SYNCHRONIZE = 0x00100000
    h = k32.OpenProcess(SYNCHRONIZE, False, pid)
    if not h:
        logging.getLogger("vera.voice").warning("parent %d not found; exiting", pid)
        os._exit(0)

    def wait():
        k32.WaitForSingleObject(h, 0xFFFFFFFF)
        logging.getLogger("vera.voice").info("parent %d exited; shutting down", pid)
        os._exit(0)
    threading.Thread(target=wait, name="parent-watch", daemon=True).start()


def main(argv=None):
    _hide_children()
    _quiet_console()
    cfg = _config()
    ap = argparse.ArgumentParser(prog="vera_voice")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=int(cfg.get("port", 7314)))
    s.add_argument("--parent-pid", type=int, help="exit when this process exits (the App passes its PID)")
    for p in (s, sub.add_parser("say"), sub.add_parser("voices"), sub.add_parser("calibrate")):
        p.add_argument("--voice", default=cfg.get("voice"))
        p.add_argument("--preset", default=cfg.get("preset", "vera"))
    say = sub._name_parser_map["say"]
    say.add_argument("text")
    say.add_argument("--out", help="write a WAV instead of playing it")
    say.add_argument("--volume", type=float, default=0.7,
                     help="Vera's volume when playing, on the App's scale: 0-1, 40*(v-1) dB (0.7 = -12 dB)")
    args = ap.parse_args(argv)
    _logging(args.cmd != "serve")

    from .synth import Synth
    synth = Synth(args.voice, args.preset)
    if args.cmd == "serve":
        from .server import serve
        if args.parent_pid:
            _exit_with_parent(args.parent_pid)
        serve(synth, args.host, args.port)
    elif args.cmd == "voices":
        print(json.dumps(synth.describe(), indent=1))
    elif args.cmd == "calibrate":
        from . import dsp
        from .synth import CALIBRATION_FILE
        for v in synth.voices.values():
            if synth.available(v):
                for p in dsp.PRESETS.values():
                    print(f"{v.id:8s} {p.name:10s} {synth.gain(v, p):.3f}")
        print(f"saved to {CALIBRATION_FILE}")
    else:
        import time
        import numpy as np
        timing: dict = {}
        t = time.perf_counter()
        pcm = np.concatenate(list(synth.stream(args.text, args.voice, args.preset, timing=timing)))
        print(f"{len(pcm) / 24000:.2f}s audio, first audio {timing.get('first_audio_ms', 0):.0f} ms "
              f"(cold, includes loading) total {1000 * (time.perf_counter() - t):.0f} ms", file=sys.stderr)
        if args.out:
            import soundfile as sf
            sf.write(args.out, pcm, 24000)
        else:
            import sounddevice as sd
            gain = 0.0 if args.volume <= 0 else 10 ** (40 * (min(args.volume, 1.0) - 1) / 20)
            sd.play(pcm * gain, 24000)
            sd.wait()


if __name__ == "__main__":
    main()
