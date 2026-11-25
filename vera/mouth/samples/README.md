# Samples to compare

All say "On it. I've asked Codex to check the build. I'll ping you when it's
done." unless noted. Regenerate with `pnpm --filter @vera/mouth samples`.

**Presets** (default voice, Kokoro `af_heart`):

- `preset-vera.mp3`: the recommended default. Slightly flattened pitch, a hint of metal, a small bright room.
- `preset-dry.mp3`: same character, no room. Most intelligible over noise.
- `preset-robot-plus.mp3`: more robot: near-monotone, stronger metallic ring.
- `preset-plain.mp3`: the raw neural voice, leveled only.

**Voices** (each with `vera` and `plain`):

- `voice-af_heart-*`: American female, Kokoro's best voice. **Recommended.**
- `voice-bf_emma-*`: British female, naturally calmer and flatter. Runner-up.
- `voice-am_michael-*`: American male.
- `voice-piper-alba-vera.mp3`: Piper (much lighter engine) for comparison.

**Longer passage** (tests numbers, a file path, pacing): `longer-vera.mp3`, `longer-dry.mp3`.

**Chimes**: `chime-notify.mp3` (inbox ping), `chime-listening.mp3`, `chime-done.mp3`, `chime-error.mp3`.

To switch: set `"mouth": { "voice": "bf_emma", "preset": "dry" }` in `~/.vera/config.json`.
