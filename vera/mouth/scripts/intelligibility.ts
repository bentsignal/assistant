// Rough intelligibility check: render test sentences per preset/voice, mix in
// kitchen-like noise, and score word error with Windows' built-in recognizer
// (System.Speech dictation). Old SAPI is a weak listener, so only compare
// scores against each other. Windows only.
//
//   pnpm --filter @vera/mouth exec tsx scripts/intelligibility.ts [--voices bf_emma,af_heart] [--presets vera,dry] [--snr 5]

import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMouth } from "../src/mouth.ts"
import { PRESET_NAMES } from "../src/dsp/effects.ts"
import { writeWav } from "../src/wav.ts"
import { Biquad } from "../src/dsp/biquad.ts"

const SENTENCES = [
  "On it. I've asked Codex to check the build. I'll ping you when it's done.",
  "The tests passed, but two of them were slow. Do you want me to look into it?",
  "Your timer for the pasta has about three minutes left.",
  "There is a new message in your inbox from the design team.",
]

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 ? process.argv[i + 1] : d
}
const voices = arg("voices", "bf_emma,af_heart,am_michael").split(",")
const presets = arg("presets", PRESET_NAMES.join(",")).split(",")
const snrs = arg("snr", "inf,5").split(",").map((s) => (s === "inf" ? Infinity : Number(s)))

/** Brownish noise with clatter: lowpassed noise plus random short bursts. */
function kitchenNoise(n: number, sr: number, seed = 7): Float32Array {
  let s = seed
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
  const lp = new Biquad({ kind: "lowpass", hz: 1200 }, sr)
  const y = new Float32Array(n)
  for (let i = 0; i < n; i++) y[i] = lp.step(rnd()) * 2
  for (let b = 0; b < n / sr * 3; b++) {
    const at = Math.floor(((rnd() + 1) / 2) * n)
    const len = Math.floor(sr * 0.04)
    for (let i = 0; i < len && at + i < n; i++) y[at + i] += rnd() * Math.exp(-i / (len / 4)) * 0.8
  }
  return y
}

function rms(x: Float32Array): number {
  let s = 0
  let c = 0
  for (const v of x) if (Math.abs(v) > 0.005) { s += v * v; c++ }
  return Math.sqrt(s / Math.max(1, c))
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z' ]/g, " ").split(/\s+/).filter(Boolean)
}

function wer(ref: string, hyp: string): number {
  const r = words(ref)
  const h = words(hyp)
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...new Array(h.length).fill(0)])
  for (let j = 0; j <= h.length; j++) d[0][j] = j
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))
  return d[r.length][h.length] / r.length
}

const dir = mkdtempSync(join(tmpdir(), "vera-intel-"))
const ps1 = join(dir, "stt.ps1")
writeFileSync(ps1, `param([string]$File)
Add-Type -AssemblyName System.Speech
$r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
$r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
$out = @()
try { $r.SetInputToWaveFile($File); for ($i = 0; $i -lt 20; $i++) { $res = $r.Recognize(); if ($res -eq $null) { break }; $out += $res.Text } } catch {}
$r.Dispose()
Write-Output ($out -join " ")
`)
const recognize = (file: string) =>
  spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-File", file], { encoding: "utf8" }).stdout.trim()

for (const voice of voices) {
  for (const preset of presets) {
    const mouth = await createMouth({ voice, preset, player: { warm: 0 }, log: () => {} })
    const scores: string[] = []
    for (const snr of snrs) {
      let total = 0
      for (const [i, text] of SENTENCES.entries()) {
        const clean = await mouth.render(text)
        const x = Float32Array.from(clean)
        if (Number.isFinite(snr)) {
          const noise = kitchenNoise(x.length, mouth.sampleRate, 11 + i)
          const g = rms(clean) / rms(noise) / Math.pow(10, snr / 20)
          for (let k = 0; k < x.length; k++) x[k] = Math.max(-1, Math.min(1, x[k] + noise[k] * g))
        }
        const f = join(dir, `${voice}-${preset}-${snr}-${i}.wav`)
        await writeWav(f, x, mouth.sampleRate)
        total += wer(text, recognize(f))
      }
      scores.push(`snr ${String(snr).padStart(3)}: WER ${((total / SENTENCES.length) * 100).toFixed(0).padStart(3)}%`)
    }
    await mouth.close()
    console.log(`${voice.padEnd(11)} ${preset.padEnd(7)} ${scores.join("   ")}`)
  }
}
console.log(`(audio in ${dir})`)
