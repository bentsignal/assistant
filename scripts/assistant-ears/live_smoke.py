"""Runs `hex ears` on the real microphone for a while and prints every line.

python scripts/assistant-ears/live_smoke.py <hex.exe> [seconds] [-- extra ears args]

Proves the device opens beside the running Hex and that silence or room
noise produces no transcripts. Ends with {"cmd":"shutdown"} and reports how
long the shutdown took.
"""
import json
import subprocess
import sys
import threading
import time

argv = sys.argv[1:]
extra = argv[argv.index("--") + 1:] if "--" in argv else []
argv = argv[: argv.index("--")] if "--" in argv else argv
exe = argv[0]
seconds = float(argv[1]) if len(argv) > 1 else 20
started = time.time()
proc = subprocess.Popen([exe, "ears", *extra], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE, text=True, encoding="utf-8")
log = []
threading.Thread(target=lambda: [log.append(line.rstrip()) for line in proc.stderr], daemon=True).start()
ready = None


def stop():
    while ready is None and time.time() - started < 60:
        time.sleep(0.05)
    time.sleep(seconds)
    global stopping
    stopping = time.time()
    proc.stdin.write(json.dumps({"cmd": "shutdown"}) + "\n")
    proc.stdin.flush()


stopping = None
threading.Thread(target=stop, daemon=True).start()
for raw in proc.stdout:
    event = json.loads(raw)
    if event["type"] == "ready":
        ready = time.time()
        print(f"ready after {ready - started:.2f} s")
    print(f"{time.time() - started:7.2f}  {raw.strip()}")
proc.wait(timeout=30)
print(f"exit {proc.returncode}, shutdown took {time.time() - (stopping or time.time()):.2f} s")
print("\n".join(line for line in log if "WARN" in line or "ERROR" in line or "final" in line))
