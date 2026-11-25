# Vera: design and contracts

Vera is a hands-free voice front end for the coding agents Shawn already pays
for. You talk, Vera listens locally, a thin "brain" agent decides what to do,
hands real work off to existing harnesses (T3 Code, Claude Code, Codex, Grok),
and talks back in a calm, slightly robotic local voice. A panel window shows
anything worth seeing. It's built for working in the kitchen: hands busy and
dirty, eyes and voice free.

This repo is a fork of [Hex](https://github.com/anomalyco/hex) (MIT). Hex
supplies the local speech-to-text. Vera adds everything else. The upstream
remote is `upstream`, and our branch is `main`.

## The loop

```ts
mic ─▶ Ears (local STT, Hex engine) ─▶ transcript segments (JSON lines)
        │
        ▼
Core daemon (vera/core) ── wake word "Vera" / follow-up window gate
        │
        ▼
Brain harness (Claude Code or Codex, headless, persistent session)
        │  tools come only from the Vera MCP server, plus the harness's own web search
        ├─ speak(text)        ─▶ Mouth (local TTS + robot/reverb DSP) ─▶ speakers
        ├─ show(...)          ─▶ panel (http://127.0.0.1:7313)
        ├─ ask_claude/ask_codex/ask_grok ─▶ headless CLI jobs (background) ─▶ inbox + chime
        ├─ t3_* tools         ─▶ `t3` CLI ─▶ T3 Code threads (watched ─▶ inbox + chime)
        └─ system prompt tools ─▶ ~/.vera/system-prompt.md (Vera edits itself by voice)
```

Rules that shape the experience:

- **Only the `speak` tool makes sound with words.** The brain's ordinary text
  output goes to the panel and is never spoken. That keeps Vera from
  narrating its own reasoning.
- **No unprompted talking.** When background work finishes, or a T3 thread
  finishes or needs input, Vera plays a short chime, adds an inbox item, and
  shows it on the panel. It speaks only when Shawn asks ("Vera, what's new?").
  The inbox digest goes to the brain with the next user turn.
- **Wake word.** An utterance reaches the brain if it starts with or contains
  "Vera" (fuzzy: vera, vara, vira, bera, and so on), or arrives inside the
  follow-up window (default 8 s after Vera stops speaking). The panel also has
  a text box and a talk button.
- **Half-duplex.** Ears are paused while Mouth is speaking, plus a short tail,
  so Vera doesn't hear itself.
- **Thin brain.** The brain doesn't edit files or run shell commands itself. It
  delegates.

## Routing (goes in the system prompt)

- Coding work in a project: start or continue a **T3 Code** thread (Shawn
  watches T3 side by side). Quick one-off file edits or questions about local
  code: `ask_claude`.
- **Using the computer** (desktop apps, clicking around, browser automation):
  `ask_codex`. OpenAI models are best at computer use, and Codex has the
  computer-use plugin enabled.
- **Searching X/Twitter**, or what people are saying right now: `ask_grok`.
- General web search: the brain's own web search tool.
- Confirm out loud before anything destructive or outward-facing (deleting,
  pushing, sending messages, spending money). Transcription can mishear.

## Packages and contracts

All Vera TypeScript lives in `vera/`, a pnpm workspace on Node 22+.

### Ears: speech to text (`src/` Rust in the fork, plus `vera/ears-*` fallbacks)

Ears is any process that speaks this JSON-lines protocol. Core spawns
`config.ears.command`.

stdout, one JSON object per line:

```json
{"type":"ready","engine":"hex","model":"parakeet_unified_en"}
{"type":"speech_start","t":1732500000000}
{"type":"partial","text":"vera can you","t":1732500000400}
{"type":"final","text":"Vera, can you check on the hex thread?","start":1732500000000,"end":1732500002100}
{"type":"error","message":"..."}
```

stdin, one JSON command per line: `{"cmd":"pause"}`, `{"cmd":"resume"}`,
`{"cmd":"shutdown"}`. Logs go to stderr. `partial` is optional. Times are
Unix epoch milliseconds.

### Mouth: text to speech (`vera/mouth`, package `@vera/mouth`)

```ts
export interface Mouth {
  /** Speak text. Synthesizes sentence by sentence and starts playing the first sentence as soon as it's ready. Resolves when playback ends or is stopped. */
  speak(text: string): Promise<void>
  /** Stop playback immediately and drop anything queued. */
  stop(): void
  readonly speaking: boolean
  on(event: "start" | "end", cb: () => void): () => void
  /** Short non-speech earcons. "notify" is the inbox ping. */
  chime(kind: "notify" | "listening" | "done" | "error"): Promise<void>
  close(): Promise<void>
}
export function createMouth(config?: Partial<MouthConfig>): Promise<Mouth>
```

Fully local, with no paid API. The voice should be calm, a little monotone and
robotic with some reverb: a pleasant synthetic assistant, not an emotional
human imitation, and not early-Siri bad either.

### Core (`vera/core`, package `@vera/core`)

- Daemon: HTTP and WebSocket on `127.0.0.1:7313`, serving the panel at `/`
  and an event stream at `/ws`.
- `POST /api/utterance {"text": "..."}` injects an utterance as if it were
  heard. The wake-word gate is bypassed when `{"direct": true}`. This is the
  main test hook.
- The Vera MCP server (stdio) is spawned by the brain harness and forwards
  tool calls to the daemon over localhost HTTP.
- Brain adapters: `claude-code` (`claude -p` with stream-json input and output,
  one persistent process) and `codex` (`codex app-server` or `codex exec --json`
  plus resume). There's room for `grok` or `gemini` later. You pick one in
  config, and Vera can switch it by voice.

### User state (`~/.vera/`, never in the repo)

- `config.json`: brain harness, model and effort, wake words, follow-up
  window, ears command, mouth voice and effects, default workspace.
- `system-prompt.md`: the brain's system prompt, seeded from
  `vera/core/prompts/system.md`. Vera can edit it by voice, and every edit is
  backed up to `prompt-history/` so it can be reverted.
- `logs/`, `jobs/`: logs and job transcripts.
