// pnpm --filter @vera/mouth samples
// Renders the comparison set into vera/mouth/samples/ as small mp3s (needs ffmpeg).

import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createMouth } from "../src/mouth.ts"
import { PRESET_NAMES } from "../src/dsp/effects.ts"
import { CHIME_KINDS, renderChime } from "../src/chimes.ts"
import { isInstalled, piperPackage } from "../src/models.ts"
import { DEFAULT_CONFIG, type MouthConfig } from "../src/config.ts"
import { writeWav } from "../src/wav.ts"

const TEXT = "On it. I've asked Codex to check the build. I'll ping you when it's done."
const LONGER =
  "Okay, here's where things stand. The build passed, but two tests were slow, about 4.5 seconds each. " +
  "Your pasta timer has 3 minutes left. I put the details for `src/dictation/audio.rs` on the panel."

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "samples")
const tmp = mkdtempSync(join(tmpdir(), "vera-samples-"))
mkdirSync(out, { recursive: true })

function mp3(wav: string, name: string): void {
  const dest = join(out, `${name}.mp3`)
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", wav, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "56k", dest], { encoding: "utf8" })
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${name}: ${r.stderr}`)
  console.log(`samples/${name}.mp3`)
}

async function render(name: string, cfg: Partial<MouthConfig>, text = TEXT): Promise<void> {
  const mouth = await createMouth({ ...cfg, player: { warm: 0 }, log: () => {} })
  const pcm = await mouth.render(text)
  // A short lead-in so players don't clip the first syllable.
  const lead = new Float32Array(Math.round(mouth.sampleRate * 0.15))
  const wav = join(tmp, `${name}.wav`)
  await writeWav(wav, Float32Array.from([...lead, ...pcm]), mouth.sampleRate)
  await mouth.close()
  mp3(wav, name)
}

const defaultVoice = DEFAULT_CONFIG.voice
for (const preset of PRESET_NAMES) await render(`preset-${preset.replace("+", "-plus")}`, { voice: defaultVoice, preset })
for (const voice of ["af_heart", "bf_emma", "am_michael"]) {
  await render(`voice-${voice}-vera`, { voice, preset: "vera" })
  await render(`voice-${voice}-plain`, { voice, preset: "plain" })
}
if (isInstalled(DEFAULT_CONFIG.modelsDir, piperPackage("en_GB-alba-medium"))) {
  await render("voice-piper-alba-vera", { engine: "piper", voice: "en_GB-alba-medium", preset: "vera" })
}
await render("longer-vera", { preset: "vera" }, LONGER)
await render("longer-dry", { preset: "dry" }, LONGER)
for (const kind of CHIME_KINDS) {
  const wav = join(tmp, `chime-${kind}.wav`)
  await writeWav(wav, renderChime(kind, 24000, DEFAULT_CONFIG.chimeVolume), 24000)
  mp3(wav, `chime-${kind}`)
}
rmSync(tmp, { recursive: true, force: true })
