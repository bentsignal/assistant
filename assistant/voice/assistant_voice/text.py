"""Text shaping for speech: strip markup Vera shouldn't read, then split into sentences
so the first one can be synthesized and streamed while the rest wait."""
from __future__ import annotations

import re

from . import lexicon

_FENCE = re.compile(r"```.*?(```|$)", re.S)
_INLINE_CODE = re.compile(r"`([^`]*)`")
_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_URL = re.compile(r"https?://\S+")
_MD = re.compile(r"(^|\s)[#>*\-]+\s+|[*_~]{1,3}(?=\S)|(?<=\S)[*_~]{1,3}")
_SPACE = re.compile(r"\s+")
# "approval-required" -> "approval required": Qwen3-TTS can stutter on the hyphen's
# second word ("approval r-r-r-r…") and never recover; spoken, the hyphen is a space anyway.
_HYPHEN = re.compile(r"(?<=[A-Za-z])-(?=[A-Za-z])")


def normalize(text: str) -> str:
    t = _FENCE.sub(" ", text)
    t = _LINK.sub(r"\1", t)
    t = _URL.sub("a link", t)
    t = _INLINE_CODE.sub(r"\1", t)
    t = _MD.sub(r"\1", t)
    t = lexicon.apply(t)
    t = _HYPHEN.sub(" ", t)
    t = t.replace("&", " and ").replace("->", " to ").replace("=>", " to ")
    return _SPACE.sub(" ", t).strip()


_SENT = re.compile(r"(?<=[.!?])[\"')\]]*\s+(?=[A-Z0-9\"'(])")
_ABBR = re.compile(r"\b(Mr|Mrs|Ms|Dr|St|vs|etc|approx|No)\.$")


def sentences(text: str, first_max_words: int = 14, max_words: int = 40) -> list[str]:
    """Split into sentences. A long first sentence is cut at a clause boundary so the
    first audio comes sooner; any sentence is cut if it runs past `max_words`."""
    parts: list[str] = []
    buf = ""
    for piece in _SENT.split(normalize(text)):
        buf = f"{buf} {piece}".strip() if buf else piece
        if _ABBR.search(buf):
            continue
        parts.append(buf)
        buf = ""
    if buf:
        parts.append(buf)
    out: list[str] = []
    for i, s in enumerate(parts):
        limit = first_max_words if not out else max_words
        out.extend(_cut(s, limit))
    return [s for s in out if re.search(r"[A-Za-z0-9]", s)]


def _cut(s: str, limit: int) -> list[str]:
    words = s.split()
    if len(words) <= limit:
        return [s]
    # prefer a clause boundary (comma, semicolon, colon, dash) between 4 words and the limit
    best = None
    for i in range(4, min(limit, len(words) - 3)):
        if re.search(r"[,;:]$|^[-–—]$", words[i - 1]):
            best = i
    if best is None:
        if len(words) <= limit * 1.5:
            return [s]
        best = limit
    head = " ".join(words[:best]).rstrip(",;:—–- ")
    return [head] + _cut(" ".join(words[best:]), max(limit, 40))
