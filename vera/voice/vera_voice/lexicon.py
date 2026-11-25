"""How Vera says things the voice would otherwise get wrong.

Three layers, applied in order to every line before it's synthesized:

1. **Terms**: tech words, names, and acronyms, respelled the way Shawn says
   them (T3 is "T three", JSON is "Jason", npm is "N P M"). Whole words,
   case-sensitive, so "ID" changes and "I'd" doesn't.
2. **Units and symbols** after numbers ("200 ms" is "200 milliseconds").
3. **Heteronyms in unambiguous company**: "lead pipes", "red lead", "have
   read", "live music", "wind up", "bass guitar", "close to". The brain is
   told to respell heteronyms itself (the `speak` tool and the prompt), so
   this only catches the collocations where the meaning is certain; a bare
   "lead" or "read" is left alone, since guessing wrong is worse.

`~/.vera/voice/lexicon.json` (`{"Word": "how to say it"}`) adds or
overrides whole-word terms without a code change.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

log = logging.getLogger("vera.voice")

# Whole words, case-sensitive. Spaced letters are read letter by letter.
TERMS: dict[str, str] = {
    # Shawn's tools
    "T3": "T three",
    "T3 Code": "T three Code",
    "GitHub": "Git Hub",
    "Github": "Git Hub",
    "GitLab": "Git Lab",
    "Qwen": "Kwen",
    "VS Code": "V S Code",
    "VSCode": "V S Code",
    "macOS": "mac O S",
    "iOS": "eye O S",
    "README": "read me",
    "TODO": "to do",
    "TODOs": "to dos",
    "stdin": "standard in",
    "stdout": "standard out",
    "stderr": "standard error",
    "sudo": "soo doo",
    "nginx": "engine X",
    "regex": "rej ex",
    "k8s": "Kubernetes",
    "PyPI": "pie P I",
    "CUDA": "Coo da",
    "VRAM": "V ram",
    "WebRTC": "web R T C",
    "OAuth": "oh auth",
    "SQLite": "S Q Lite",
    # data formats and acronyms
    "JSON": "Jason",
    "YAML": "yammel",
    "SQL": "sequel",
    "CLI": "C L I",
    "CLIs": "C L Is",
    "API": "A P I",
    "APIs": "A P Is",
    "UI": "U I",
    "UX": "U X",
    "GPU": "G P U",
    "GPUs": "G P Us",
    "CPU": "C P U",
    "CPUs": "C P Us",
    "TTS": "T T S",
    "STT": "S T T",
    "AEC": "A E C",
    "PR": "P R",
    "PRs": "P Rs",
    "URL": "U R L",
    "URLs": "U R Ls",
    "HTTP": "H T T P",
    "HTTPS": "H T T P S",
    "SSH": "S S H",
    "MCP": "M C P",
    "LLM": "L L M",
    "LLMs": "L L Ms",
    "AI": "A I",
    "OS": "O S",
    "WSL": "W S L",
    "ID": "I D",
    "IDs": "I Ds",
    "ETA": "E T A",
    "FAQ": "F A Q",
    "CI": "C I",
    "PDF": "P D F",
    "USB": "U S B",
    "HDMI": "H D M I",
    "npm": "N P M",
    "pnpm": "P N P M",
    "exe": "E X E",
    "vs": "versus",
    "vs.": "versus",
}

# Phrases that aren't whole words.
PATTERNS: list[tuple[str, str]] = [
    (r"\be\.g\.", "for example"),
    (r"\bi\.e\.", "that is"),
    (r"\betc\.", "et cetera"),
    (r"\.exe\b", " dot E X E"),
    (r"\.md\b", " dot M D"),
    (r"\.ts\b", " dot T S"),
    (r"\.rs\b", " dot R S"),
    (r"\.py\b", " dot P Y"),
    # Units after numbers.
    (r"(\d)\s?ms\b", r"\1 milliseconds"),
    (r"(\d)\s?GB\b", r"\1 gigabytes"),
    (r"(\d)\s?MB\b", r"\1 megabytes"),
    (r"(\d)\s?KB\b", r"\1 kilobytes"),
    (r"(\d)\s?TB\b", r"\1 terabytes"),
    (r"(\d)\s?GHz\b", r"\1 gigahertz"),
    (r"(\d)\s?MHz\b", r"\1 megahertz"),
    (r"(\d)\s?kHz\b", r"\1 kilohertz"),
    (r"(\d)\s?°F\b", r"\1 degrees Fahrenheit"),
    (r"(\d)\s?°C\b", r"\1 degrees Celsius"),
    (r"(\d)\s?°", r"\1 degrees"),
    (r"(\d)\s?%", r"\1 percent"),
    (r"~\s?(\d)", r"about \1"),
    (r"(\d)\s?\+\s?(\d)", r"\1 plus \2"),
]

# Heteronyms, only where the company they keep settles the meaning.
_LEAD_METAL = (
    r"pipes?|paint|poisoning|azide|acid|bullets?|shot|weights?|ore|levels?|exposure|"
    r"contamination|detonation|free|based|crystal|glass|sinker|apron|oxide|content|"
    r"mines?|mining|smelters?|smelting|dust|deposits?|sheets?|solder|batter(?:y|ies)|"
    r"line|lined|lining|roof|flashing|fishing weights?"
)
_LIVE_ADJ = (
    r"music|show|shows|stream|streams|streaming|wire|wires|updates?|events?|coverage|"
    r"demo|demos|version|audio|video|text|feed|broadcast|performance|concert|action|"
    r"bait|ammo|ammunition|recording|chat|captions?|preview|reload|data|traffic|"
    r"site|server|session|transcription|view|tv|TV|radio|blog|link"
)
HETERONYMS: list[tuple[str, str]] = [
    # lead, the metal -> "led"
    (rf"\b([Ll])ead(?=[- ](?:{_LEAD_METAL})\b)", r"\1ed"),
    (r"\b(red|white|black) lead\b", r"\1 led"),
    (r"\b(made of|full of|tons of|pounds of|heavy as|contains?|containing|traces of) lead(?=[.,;:!?]| and\b| or\b|$)", r"\1 led"),
    (r"\blead(?=-acid|-based|-free|-lined)", "led"),
    # read, past tense -> "red"
    (r"(\b(?:have|has|had|having|been|was|were|already|never|once)|'ve|'d) read\b", r"\1 red"),
    # live, the adjective -> "lyve"
    (rf"\b([Ll])ive(?=[- ](?:{_LIVE_ADJ})\b)", r"\1yve"),
    (r"\b(go|goes|going|went|gone|is|are|was|were|be|being|now|it's|we're|they're|you're) live\b", r"\1 lyve"),
    # wind, to turn -> "wined"
    (r"\b([Ww])ind(?= (?:up|down|it|them|the (?:clock|watch|cord|cable|string|rope)))", r"\1ined"),
    # tear, to rip -> "tare"
    (r"\b([Tt])ear(?= (?:down|apart|off|open|it|them|through|into)\b)", r"\1are"),
    (r"\bwear and tear\b", "wear and tare"),
    # bass, the sound -> "base"
    (r"\b([Bb])ass(?=[- ](?:guitars?|lines?|players?|drums?|boost|notes?|frequencies|response|heavy|clef|amps?|speakers?|tones?|parts?)\b)", r"\1ase"),
    (r"\b([Bb])assline", r"\1ase line"),
    # close, near -> "kloce"
    (r"\bclose(?= (?:to|by|call|calls|friends?|enough|together|range|up|second|race)\b)", "kloce"),
    (r"\bClose(?= (?:to|by|call|calls|friends?|enough|together|range|up|second|race)\b)", "Kloce"),
    (r"\b(up|too|so|very|pretty|really|that) close\b", r"\1 kloce"),
    # wound up (wind) -> "wownd"
    (r"\b([Ww])ound (up|down)\b", r"\1ownd \2"),
]

_compiled: list[tuple[re.Pattern, str]] | None = None
_user_file: Path | None = None
_user_mtime: float | None = None


def _terms_pattern(terms: dict[str, str]) -> list[tuple[re.Pattern, str]]:
    out = []
    # Longest first, so "T3 Code" wins over "T3".
    for word in sorted(terms, key=len, reverse=True):
        say = terms[word]
        out.append((re.compile(rf"(?<![\w.]){re.escape(word)}(?![\w])"), say.replace("\\", r"\\")))
    return out


def _user_terms(home: Path) -> dict[str, str]:
    path = home / "voice" / "lexicon.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return {}
    except Exception as e:  # a broken file never stops speech
        log.warning("lexicon.json ignored: %s", e)
        return {}
    return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}


def rules(home: Path | None = None) -> list[tuple[re.Pattern, str]]:
    """The compiled rules, rebuilt when the user's lexicon file changes."""
    global _compiled, _user_file, _user_mtime
    if home is None:
        from .engines import HOME as home
    path = home / "voice" / "lexicon.json"
    try:
        mtime = path.stat().st_mtime
    except OSError:
        mtime = None
    if _compiled is None or path != _user_file or mtime != _user_mtime:
        terms = {**TERMS, **_user_terms(home)}
        _compiled = (
            [(re.compile(p), r) for p, r in HETERONYMS]
            + [(re.compile(p), r) for p, r in PATTERNS]
            + _terms_pattern(terms)
        )
        _user_file, _user_mtime = path, mtime
    return _compiled


def apply(text: str, home: Path | None = None) -> str:
    for pattern, replacement in rules(home):
        text = pattern.sub(replacement, text)
    return text
