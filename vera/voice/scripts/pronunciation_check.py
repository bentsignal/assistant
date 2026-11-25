"""Does Vera say words right? Synthesizes test lines through a running voice
service, transcribes them with Vera's own ears (Parakeet, `hex vera-audio
transcribe`), and compares words.

  ~/.vera/voice/venv/Scripts/python vera/voice/scripts/pronunciation_check.py \
      --url http://127.0.0.1:7314 --hex target/ears-dev/hex.exe --out <dir>

Speech to text writes what it thinks was *meant*, so it can't hear a
heteronym said wrong in context ("the lead pipes" comes out "lead" whichever
way it was said). Three kinds of check get around that as far as they can:

- **contrast**: a word alone in a neutral carrier ("The next word is led."),
  spelled the way the brain is told to respell it, and the plain spelling.
  Where the two pronunciations are different words to the recognizer
  (led/lead, red/read, base/bass, tare/tear), the respelling must come back
  as the intended sound and the plain spelling as the other: that proves
  the respelling changes what the voice says.
- **sentence**: whole lines as the brain writes them (respelled) must come
  back word for word, with the heteronym accepted in either spelling: the
  respelling mustn't garble the line.
- **term**: tech terms, names, and acronyms (the voice service's lexicon)
  must come back as one of their accepted forms.

The results are printed as a table and written to `<out>/report.json`.
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import subprocess
import sys
import urllib.request
from pathlib import Path

# (id, carrier, word that must be heard, word that must not). The carrier
# rhymes, so the recognizer spells what it HEARS, not what the context
# suggests: "bed, led, and fed" comes back "led" only if the voice said
# /lɛd/ ("bead, lead, and feed" comes back "lead"). `None`: the recognizer
# spells both sounds the same way, so it's only informational.
CONTRAST = [
    ("led", "The words are bed, led, and fed.", "led", "lead"),
    ("lead", "The words are bead, lead, and feed.", "lead", "led"),
    ("base", "The words are case, base, and face.", "base", "bass"),
    ("bass-fish", "The words are mass, bass, and glass.", None, "base"),
    ("kloce", "The words are dose, kloce, and gross.", None, "closed"),
    ("red", "The words are bed, red, and fed.", None, None),
    ("tare", "The words are care, tare, and bare.", None, "tier"),
    ("lyve", "The words are five, lyve, and hive.", None, None),
    ("wined", "The words are find, wined, and kind.", None, None),
    ("woond", "The words are spooned, woond, and tuned.", None, None),
    ("duv", "The words are love, duv, and glove.", None, None),
]

# (id, what the brain writes, the canonical line, {word: accepted spellings})
SENTENCES = [
    ("lead-metal", "The led detonation happened today, and sensors found no led in the air.",
     "The lead detonation happened today, and sensors found no lead in the air.", {"lead": {"lead", "led"}}),
    ("lead-azide", "Probably the Army's led azide detonation at the Iowa ammunition plant.",
     "Probably the Army's lead azide detonation at the Iowa ammunition plant.",
     {"lead": {"lead", "led"}, "azide": {"azide", "a z", "az", "a zide"}, "army's": {"army's", "armies", "army"}}),
    ("lead-verb", "I'll lead you through the setup.", "I'll lead you through the setup.", {}),
    ("read-past", "I red the thread an hour ago.", "I read the thread an hour ago.", {"read": {"read", "red"}}),
    ("read-present", "I can read it to you now.", "I can read it to you now.", {}),
    ("live-adj", "The lyve stream starts at noon.", "The live stream starts at noon.", {"live": {"live", "lyve"}}),
    ("live-verb", "You live about ten minutes away.", "You live about ten minutes away.", {}),
    ("wind-verb", "Wined the cable before you pack it.", "Wind the cable before you pack it.", {"wind": {"wind", "wined"}}),
    ("tear-rip", "Don't tare the label off yet.", "Don't tear the label off yet.", {"tear": {"tear", "tare"}}),
    ("bass-sound", "Turn the base down on the speaker.", "Turn the bass down on the speaker.", {"bass": {"bass", "base"}}),
    ("close-near", "We're kloce to the end of the list.", "We're close to the end of the list.", {"close": {"close"}}),
]

# (id, line, {word: accepted forms (normalized)})
TERMS = [
    ("t3", "Check the T3 thread when it finishes.", {"t3": {"t3", "t three", "tthree", "tea three"}}),
    ("github", "The fix is on GitHub now.", {"github": {"github", "git hub"}}),
    ("json", "Open the JSON file.", {"json": {"json", "jason"}}),
    ("npm", "Run npm install first.", {"npm": {"npm", "n p m", "n pm"}}),
    ("cli", "The CLI printed an error.", {"cli": {"cli", "c l i", "c li", "cl i"}}),
    ("codex", "I asked Codex to look.", {"codex": {"codex", "codecs"}}),
    ("names", "Okay Shawn, Vera here.", {"shawn": {"shawn", "sean", "shaun", "sean"}, "vera": {"vera"}}),
    ("ms", "It answered in 200 ms.", {"ms": {"milliseconds", "200 milliseconds"}}),
]


NUMBERS = {"ten": "10", "two hundred": "200", "one": "1", "two": "2", "three": "3"}


def norm(text: str) -> str:
    text = text.lower().replace("-", " ")
    for word, digits in NUMBERS.items():
        text = re.sub(rf"\b{word}\b", digits, text)
    text = re.sub(r"[^a-z0-9' ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def synth(url: str, text: str, path: Path) -> None:
    req = urllib.request.Request(f"{url}/v1/speech", data=json.dumps({"text": text}).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        rate = int(r.headers.get("X-Sample-Rate") or 24000)
        pcm = r.read()
    # 32-bit float WAV.
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 3, 1, rate, rate * 4, 4, 32) + b"data" + struct.pack("<I", len(pcm))
    path.write_bytes(header + pcm)


def transcribe(hex_exe: str, files: list[Path]) -> dict[str, str]:
    out = subprocess.run([hex_exe, "vera-audio", "transcribe", *map(str, files)], capture_output=True,
                         text=True, encoding="utf-8", errors="replace", check=True,
                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    heard = {}
    for line in out.stdout.splitlines():
        if "\t" in line:
            file, text = line.split("\t", 1)
            heard[Path(file).stem] = text
    return heard


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:7314")
    ap.add_argument("--hex", default="target/ears-dev/hex.exe")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    lines = {f"contrast-{i}": t for i, t, *_ in CONTRAST}
    lines |= {f"sentence-{i}": t for i, t, *_ in SENTENCES}
    lines |= {f"term-{i}": t for i, t, *_ in TERMS}
    files = []
    for name, text in lines.items():
        path = out / f"{name}.wav"
        synth(a.url, text, path)
        files.append(path)
    heard = transcribe(a.hex, files)
    results = []

    for i, text, must, must_not in CONTRAST:
        got = norm(heard.get(f"contrast-{i}", ""))
        words = got.split()
        ok = (must is None or must in words) and (must_not is None or must_not not in words)
        results.append({"kind": "contrast", "id": i, "said": text, "heard": got, "ok": ok,
                        "checked": must is not None or must_not is not None})

    for i, text, canonical, accept in SENTENCES:
        got = f" {norm(heard.get(f'sentence-{i}', ''))} "
        want = norm(canonical).split()
        alts = {norm(w): {norm(x) for x in xs} for w, xs in accept.items()}
        # Word error: the canonical words, each heteronym in any accepted spelling.
        missing = [w for w in want if not any(f" {x} " in got for x in {w} | alts.get(w, set()))]
        results.append({"kind": "sentence", "id": i, "said": text, "heard": got.strip(),
                        "missing": missing, "ok": not missing, "checked": True})

    for i, text, accept in TERMS:
        got = norm(heard.get(f"term-{i}", ""))
        bad = [w for w, forms in accept.items() if not any(f" {norm(f)} " in f" {got} " for f in forms)]
        results.append({"kind": "term", "id": i, "said": text, "heard": got, "missing": bad,
                        "ok": not bad, "checked": True})

    (out / "report.json").write_text(json.dumps(results, indent=2))
    checked = [r for r in results if r["checked"]]
    for r in results:
        mark = "ok  " if r["ok"] else "FAIL"
        if not r["checked"]:
            mark = "info"
        print(f"{mark} {r['kind']:<8} {r['id']:<13} said: {r['said']}\n{'':<28}heard: {r['heard']}")
    passed = sum(r["ok"] for r in checked)
    print(f"\n{passed}/{len(checked)} checks passed ({len(results) - len(checked)} informational)")
    return 0 if passed == len(checked) else 1


if __name__ == "__main__":
    sys.exit(main())
