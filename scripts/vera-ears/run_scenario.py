"""Drives `hex ears` over a scenario WAV and checks what it prints.

python scripts/vera-ears/run_scenario.py <hex.exe> <scenario.wav> [--pause-at S --resume-at S] [-- extra ears args]

Plays the WAV as the microphone (HEX_AUDIO_FIXTURE, real-time pace), records
every stdout line with its arrival time, sends {"cmd":"shutdown"} once the
WAV has played, and prints each expected utterance next to the `final` that
matched it, with:
  after_speech_ms  the fixture's end of speech -> the `final` line arriving
  latency_ms       Ears' own measure, from the pause being reached
Exit status 1 when an expected utterance has no final or something extra
was transcribed.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time


def words(text):
    return re.findall(r"[a-z0-9']+", text.lower())


def similarity(a, b):
    a, b = words(a), words(b)
    if not a or not b:
        return 0.0
    rows = [[0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a)):
        for j in range(len(b)):
            rows[i + 1][j + 1] = rows[i][j] + 1 if a[i] == b[j] else max(rows[i][j + 1], rows[i + 1][j])
    return 2 * rows[-1][-1] / (len(a) + len(b))


def main():
    argv = sys.argv[1:]
    extra = []
    if "--" in argv:
        extra = argv[argv.index("--") + 1:]
        argv = argv[: argv.index("--")]
    exe, wav = argv[0], argv[1]
    pause_at = resume_at = None
    if "--pause-at" in argv:
        pause_at = float(argv[argv.index("--pause-at") + 1])
        resume_at = float(argv[argv.index("--resume-at") + 1])
    manifest = json.load(open(wav.rsplit(".", 1)[0] + ".json"))
    env = dict(os.environ, HEX_AUDIO_FIXTURE=wav)
    started = time.time()
    proc = subprocess.Popen([exe, "ears", *extra], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, text=True, encoding="utf-8")
    lines, log = [], []

    def read_stderr():
        for line in proc.stderr:
            log.append(line.rstrip())

    threading.Thread(target=read_stderr, daemon=True).start()
    t0 = None
    deadline = None

    def send(command):
        proc.stdin.write(json.dumps({"cmd": command}) + "\n")
        proc.stdin.flush()

    def control():
        while t0 is None:
            time.sleep(0.01)
        if pause_at is not None:
            time.sleep(max(0, t0 + pause_at - time.time()))
            send("pause")
            time.sleep(max(0, t0 + resume_at - time.time()))
            send("resume")
        time.sleep(max(0, t0 + manifest["duration_ms"] / 1000 + 1.0 - time.time()))
        send("shutdown")

    threading.Thread(target=control, daemon=True).start()
    for raw in proc.stdout:
        now = time.time()
        event = json.loads(raw)
        lines.append((now, event))
        if event["type"] == "ready" and t0 is None:
            # The first fixture chunk (10 ms) has just been delivered.
            t0 = now - 0.010
            print(f"ready after {now - started:.1f} s: {raw.strip()}")
    proc.wait(timeout=30)
    finals = [(at, e) for at, e in lines if e["type"] == "final"]
    for at, e in lines:
        rel = (at - t0) * 1000 if t0 else 0
        if e["type"] != "ready":
            print(f"  {rel:8.0f} ms  {json.dumps(e)}")
    print()
    used, failed = set(), False
    for want in manifest["utterances"]:
        if pause_at is not None and want["start_ms"] < resume_at * 1000 and want["end_ms"] > pause_at * 1000:
            print(f"(paused)  {want['text']}")
            continue
        best = max(((similarity(want["text"], e["text"]), i) for i, (_, e) in enumerate(finals) if i not in used),
                   default=(0, None))
        if best[1] is None or best[0] < 0.5:
            print(f"MISSING   {want['text']}")
            failed = True
            continue
        used.add(best[1])
        at, e = finals[best[1]]
        after = (at - t0) * 1000 - want["end_ms"]
        print(f"ok {best[0]:.2f}  after_speech_ms={after:5.0f} latency_ms={e['latency_ms']:4d}  "
              f"{want['text']!r} -> {e['text']!r}")
    for i, (_, e) in enumerate(finals):
        if i not in used:
            print(f"EXTRA     {e['text']!r}")
            failed = True
    cancels = [e for _, e in lines if e["type"] == "speech_cancel"]
    errors = [e for _, e in lines if e["type"] == "error"]
    print(f"\n{len(finals)} finals, {len(cancels)} cancels, {len(errors)} errors, "
          f"{sum(1 for _, e in lines if e['type'] == 'partial')} partials; exit {proc.returncode}")
    if os.environ.get("EARS_SHOW_LOG"):
        print("\n".join(log))
    sys.exit(1 if failed or proc.returncode else 0)


main()
