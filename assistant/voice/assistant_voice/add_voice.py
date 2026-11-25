"""`python -m assistant_voice add-voice`: make a voice from your own recording.

The clip (any length; WAV, MP3, FLAC, Ogg...) is cut to its cleanest 6-15 s stretch between
sentences (or `--start/--end`), levelled, transcribed with Parakeet (`hex transcribe`)
unless `--text` is given, and written to ~/.assistant/voices/<id>/ with its loudness
calibration. A running service picks it up through POST /v1/voices/reload. A user voice
with a built-in voice's id replaces it.
"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

import numpy as np

from . import clip
from .engines import USER_VOICES_DIR, HOME

ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


def find_hex(given: str | None) -> str:
    """Hex's CLI, for Parakeet: --hex, $ASSISTANT_HEX, `hex` on PATH, else the installed copy."""
    for c in (given, os.environ.get("ASSISTANT_HEX"), shutil.which("hex")):
        if c and Path(c).is_file():
            return c
    appdata = os.environ.get("APPDATA")
    found = sorted(glob.glob(os.path.join(appdata, "hex", "versions", "*", "hex.exe"))) if appdata else []
    if found:
        return max(found, key=os.path.getmtime)
    raise FileNotFoundError("couldn't find Hex for transcription; pass --text or --hex <path to hex.exe>")


def transcribe(hex_exe: str, wav: Path) -> str:
    r = subprocess.run([hex_exe, "transcribe", str(wav)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=180,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    text = r.stdout.strip()
    if r.returncode != 0 or not text:
        raise RuntimeError(f"transcription failed: {(r.stderr or r.stdout).strip()[:300]}")
    return text


def _ts(s: float) -> str:
    return f"{int(s // 60)}:{s % 60:05.2f}"


def add_voice(args) -> int:
    vid = args.id.lower()
    if not ID_RE.match(vid):
        print(f"--id must be lowercase letters, digits, - or _ (got {args.id!r})", file=sys.stderr)
        return 2
    from . import dsp
    if args.preset and args.preset not in dsp.PRESETS:
        print(f"unknown preset {args.preset!r}; one of {', '.join(dsp.PRESETS)}", file=sys.stderr)
        return 2
    x = clip.load(args.clip)
    total = len(x) / clip.SR
    if args.start is not None or args.end is not None:
        a = max(0.0, args.start or 0.0)
        b = min(total, args.end if args.end is not None else total)
        if b - a < 3:
            print(f"--start/--end leave only {b - a:.1f} s; give at least 3 s (10-15 s is best)", file=sys.stderr)
            return 2
        span = clip.Span(a, b, 0.0, "from --start/--end")
    elif total <= clip.MAX_S + 0.5:
        m, _, _ = clip.speech_mask(clip._frames_db(x, clip.SR))
        on = np.nonzero(m)[0]
        if len(on) == 0:
            print("no speech found in the clip", file=sys.stderr)
            return 1
        span = clip.Span(max(0, on[0] * clip.HOP_S - 0.12), min(total, on[-1] * clip.HOP_S + 0.15), 0.0,
                         "the whole clip, silence trimmed")
    else:
        span = clip.pick_span(x)
    seg = x[int(span.start * clip.SR):int(span.end * clip.SR)]
    print(f"clip {_ts(total)} long; using {_ts(span.start)}-{_ts(span.end)} ({span.seconds:.1f} s): {span.why}")
    if span.seconds < 5:
        print("warning: under 5 s of speech; cloning is steadier from 10-15 s", file=sys.stderr)
    if span.seconds > 20:
        print("warning: over 20 s; Qwen cloning is best with 10-15 s (use --start/--end)", file=sys.stderr)
    ref = clip.prepare(seg)

    import soundfile as sf
    root = Path(args.root) if args.root else USER_VOICES_DIR
    d = root / vid
    tmp = root / f".{vid}.new"
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    sf.write(tmp / "ref.wav", ref, clip.SR, subtype="PCM_16")
    text = (args.text or "").strip()
    if not text:
        text = transcribe(find_hex(args.hex), tmp / "ref.wav")
        print(f"transcript (Parakeet): {text}")
    (tmp / "ref.txt").write_text(text + "\n", encoding="utf-8")
    sha = hashlib.sha1((tmp / "ref.wav").read_bytes()).hexdigest()[:10]
    meta = {"name": args.name, "description": args.description or f"{args.name}, from your own recording.",
            "gender": args.gender or "", "accent": args.accent or "", "clip_sha": sha,
            "source": {"file": os.path.basename(args.clip), "start": round(span.start, 2), "end": round(span.end, 2)}}
    if args.preset:
        meta["preset"] = args.preset
    (tmp / "voice.json").write_text(json.dumps(meta, indent=1) + "\n", encoding="utf-8")
    shutil.rmtree(d, ignore_errors=True)
    tmp.rename(d)
    print(f"wrote {d}")

    if not args.no_calibrate:
        import threading
        from .engines import Engines, user_voices
        from .synth import Synth
        v = next(u for u in user_voices(root) if u.id == vid)
        s = Synth.__new__(Synth)  # just enough of a Synth to calibrate one voice
        s.engines, s._cal, s._cal_lock = Engines(), {}, threading.Lock()
        for p in dsp.PRESETS.values():
            g = s.gain(v, p)
            print(f"  calibrated {p.name:10s} {20 * np.log10(g):+.1f} dB")
    if not args.no_reload:
        port = args.port or 7314
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/voices/reload", data=b"{}", method="POST",
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as r:
                ids = [v["id"] for v in json.loads(r.read())["voices"]]
            print(f"the running service now has: {', '.join(ids)}")
        except Exception as e:
            print(f"(no running service reloaded: {e})")
    return 0


def register(sub, cfg: dict):
    p = sub.add_parser("add-voice", help="make a voice from your own recording")
    p.add_argument("--id", required=True, help="voice id (lowercase); a built-in id is overridden")
    p.add_argument("--name", required=True)
    p.add_argument("--clip", required=True, help="WAV, MP3, FLAC or Ogg, any length")
    p.add_argument("--text", help="what the chosen span says (default: Parakeet transcribes it)")
    p.add_argument("--start", type=float, help="use the clip from this second (skips the automatic pick)")
    p.add_argument("--end", type=float, help="...to this second")
    p.add_argument("--preset", help="this voice's own effects preset (default: the service default)")
    p.add_argument("--gender"); p.add_argument("--accent"); p.add_argument("--description")
    p.add_argument("--hex", help="path to hex.exe for transcription")
    p.add_argument("--root", help=argparse.SUPPRESS)  # tests: somewhere other than ~/.assistant/voices
    p.add_argument("--port", type=int, default=int(cfg.get("port", 7314)))
    p.add_argument("--no-calibrate", action="store_true", help="skip the loudness calibration (it then runs on first use)")
    p.add_argument("--no-reload", action="store_true", help="don't tell a running service")
    return p

