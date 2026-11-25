"""Smoke test for a running voice service.

  ~/.vera/voice/venv/Scripts/python vera/voice/scripts/test_service.py [--port 7314] [--play] [--out dir]

Checks /v1/health and /v1/voices, streams a few utterances (time to first byte, length,
loudness, peaks), checks that closing the connection mid-stream cancels, and that bad
requests get a 400. --play plays one line quietly (gain 0.25).
"""
import argparse, http.client, json, sys, time
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=7314)
ap.add_argument("--play", action="store_true")
ap.add_argument("--out")
ap.add_argument("--voice")
a = ap.parse_args()
H = ("127.0.0.1", a.port)
fails = 0


def check(ok, msg):
    global fails
    print(("ok   " if ok else "FAIL ") + msg)
    fails += 0 if ok else 1


def get(path):
    c = http.client.HTTPConnection(*H, timeout=10)
    c.request("GET", path)
    r = c.getresponse()
    return r.status, json.loads(r.read())


def speech(body, cancel_after=None):
    c = http.client.HTTPConnection(*H, timeout=60)
    t0 = time.perf_counter()
    c.request("POST", "/v1/speech", json.dumps(body), {"Content-Type": "application/json"})
    r = c.getresponse()
    if r.status != 200:
        return r.status, None, None, r.read()
    sr = int(r.getheader("X-Sample-Rate"))
    buf, ttfb = b"", None
    while True:
        b = r.read1(65536) if hasattr(r, "read1") else r.read(4096)
        if not b:
            break
        if ttfb is None:
            ttfb = 1000 * (time.perf_counter() - t0)
        buf += b
        if cancel_after and len(buf) >= cancel_after * sr * 4:
            c.sock.close()
            break
    n = len(buf) // 4 * 4
    return 200, sr, ttfb, np.frombuffer(buf[:n], "<f4")


def lufs(x, sr):
    try:
        import pyloudnorm as pyln
        return pyln.Meter(sr).integrated_loudness(x.astype(np.float64))
    except Exception:
        return float("nan")


# wait for ready
t = time.time()
while True:
    try:
        st, h = get("/v1/health")
        if h.get("ready") or h.get("error"):
            break
    except OSError:
        pass
    if time.time() - t > 300:
        sys.exit("service not ready after 5 minutes")
    time.sleep(1)
check(h["ready"] and h["sample_rate"] == 24000, f"health {h}")
st, v = get("/v1/voices")
check(st == 200 and v["voices"] and v["presets"], f"voices: {[x['id'] for x in v['voices']]} presets {[p['id'] for p in v['presets']]}")

lines = ["On it. I've asked Codex to check the build, I'll ping you when it's done.",
         "Your T3 thread on the hex fork needs an answer: should it keep the old shortcut?",
         "Okay."]
played = None
for i, text in enumerate(lines):
    body = {"text": text}
    if a.voice:
        body["voice"] = a.voice
    st, sr, ttfb, pcm = speech(body)
    peak = 20 * np.log10(np.abs(pcm).max() + 1e-12)
    L = lufs(pcm, sr)
    check(st == 200 and ttfb < 600 and peak < -3 and (len(pcm) < sr * 1.5 or abs(L + 20) < 3),
          f"speech[{i}]: first byte {ttfb:.0f} ms, {len(pcm) / sr:.2f}s, {L:.1f} LUFS, peak {peak:.1f} dBFS")
    played = played if played is not None else pcm
    if a.out:
        import soundfile as sf
        sf.write(f"{a.out}/service_{i}.wav", pcm, sr)

# cancel mid-stream: the service should stop, and the next request should work at once
long = " ".join(["This is a long answer that keeps going so we can cancel it part way through."] * 6)
st, sr, ttfb, pcm = speech({"text": long}, cancel_after=0.5)
t0 = time.perf_counter()
st2, sr2, ttfb2, pcm2 = speech({"text": "Stopped."})
check(st == 200 and st2 == 200 and ttfb2 < 1500, f"cancel: next request's first byte after {1000 * (time.perf_counter() - t0):.0f} ms")

st, *_rest = speech({"text": "hi", "voice": "nope"})
check(st == 400, f"unknown voice -> {st}")
st, *_rest = speech({"text": "hi", "preset": "loud"})
check(st == 400, f"unknown preset -> {st}")
st, sr, ttfb, pcm = speech({"text": "```code only```"})
check(st == 200 and len(pcm) == 0, f"nothing speakable -> {len(pcm)} samples")

for p in ("natural", "synthetic"):
    st, sr, ttfb, pcm = speech({"text": "Preset check.", "preset": p})
    check(st == 200 and len(pcm) > 0, f"preset {p}: {len(pcm) / 24000:.2f}s")

if a.play and played is not None:
    import sounddevice as sd
    sd.play(played * 0.25, 24000)
    sd.wait()

print("all passed" if not fails else f"{fails} failed")
sys.exit(1 if fails else 0)
