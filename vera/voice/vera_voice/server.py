"""The voice service: HTTP on 127.0.0.1 (see "Voice service contract" in VERA.md).

GET  /v1/health  -> {"ready": bool, "voice": "...", "sample_rate": 24000, ...}
GET  /v1/voices  -> {"default": "...", "voices": [...], "presets": [...]}
POST /v1/speech  {"text": "...", "voice"?: "...", "preset"?: "..."}
                 -> chunked raw little-endian f32 mono PCM, X-Sample-Rate header.
                 Closing the connection stops synthesis at the next chunk.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .synth import Synth
from .engines import SAMPLE_RATE

log = logging.getLogger("vera.voice")

MAX_TEXT = 5000


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "vera-voice/2"
    synth: Synth  # set on the class by serve()

    def log_message(self, fmt, *args):
        log.debug("%s %s", self.address_string(), fmt % args)

    def _json(self, code: int, body: dict):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        s = self.synth
        if self.path == "/v1/health":
            self._json(200, {"ready": s.ready, "voice": s.default_voice, "preset": s.default_preset,
                             "sample_rate": SAMPLE_RATE, "engines": s.engines.loaded(),
                             "error": s.error})
        elif self.path == "/v1/voices":
            self._json(200, s.describe())
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/speech":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
            text = str(req.get("text") or "")[:MAX_TEXT]
            v, p = self.synth.voice(req.get("voice")), self.synth.preset(req.get("preset"))
        except (ValueError, KeyError) as e:
            return self._json(400, {"error": str(e).strip("'\"")})
        if not self.synth.ready:
            return self._json(503, {"error": "voice is still loading", "detail": self.synth.error})

        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("X-Sample-Rate", str(SAMPLE_RATE))
        self.send_header("X-Channels", "1")
        self.send_header("X-Sample-Format", "f32le")
        self.send_header("X-Voice", v.id)
        self.send_header("X-Preset", p.name)
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        stop = threading.Event()
        timing: dict = {}
        sent = 0
        t0 = time.perf_counter()
        try:
            for pcm in self.synth.stream(text, v.id, p.name, stop=stop, timing=timing):
                b = pcm.astype("<f4").tobytes()
                self.wfile.write(b"%x\r\n%s\r\n" % (len(b), b))
                self.wfile.flush()
                sent += len(pcm)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            stop.set()
            log.info("speech cancelled by client after %.2fs of audio", sent / SAMPLE_RATE)
            self.close_connection = True
            return
        log.info("spoke %d chars, %.2fs audio, first audio %.0f ms, total %.0f ms (%s/%s)",
                 len(text), sent / SAMPLE_RATE, timing.get("first_audio_ms", -1),
                 1000 * (time.perf_counter() - t0), v.id, p.name)


def serve(synth: Synth, host: str = "127.0.0.1", port: int = 7314):
    Handler.synth = synth
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    threading.Thread(target=synth.warm, name="warm", daemon=True).start()
    log.info("listening on http://%s:%d", host, port)
    try:
        httpd.serve_forever(poll_interval=0.25)
    finally:
        httpd.server_close()
