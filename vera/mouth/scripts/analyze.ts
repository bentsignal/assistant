// pnpm --filter @vera/mouth exec tsx scripts/analyze.ts file.wav [...]
// Prints duration, peak, RMS, pitch median and spread (a monotony measure), and PSOLA identity SNR.

import { readFileSync } from "node:fs"
import { basename } from "node:path"
import { decodeWav } from "../src/wav.ts"
import { medianF0, pitchSpreadSemitones, trackPitch } from "../src/dsp/pitch.ts"
import { flattenPitch } from "../src/dsp/psola.ts"

for (const file of process.argv.slice(2)) {
  const { samples: x, sampleRate: sr } = decodeWav(readFileSync(file))
  let peak = 0
  let sum = 0
  for (const v of x) {
    peak = Math.max(peak, Math.abs(v))
    sum += v * v
  }
  const tr = trackPitch(x, sr)
  const id = flattenPitch(x, sr, { amount: 1e-4 })
  let e = 0
  for (let i = 0; i < x.length; i++) e += (x[i] - id[i]) ** 2
  console.log(
    `${basename(file).padEnd(34)} ${(x.length / sr).toFixed(2)}s peak ${peak.toFixed(3)} rms ${(20 * Math.log10(Math.sqrt(sum / x.length))).toFixed(1)}dB ` +
      `f0 ${medianF0(tr).toFixed(0)}Hz spread ${pitchSpreadSemitones(tr).toFixed(2)}st psola-identity ${(10 * Math.log10(sum / Math.max(e, 1e-12))).toFixed(1)}dB`,
  )
}
