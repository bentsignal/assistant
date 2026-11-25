// Synthesized earcons. Soft bell and marimba tones, short, never harsh.
//
//   notify     two-note rising major sixth (G5, E6) with a soft bell: friendly "something's ready"
//   listening  a quick soft upward blip: "go ahead"
//   done       two-note falling fifth (E6, A5), marimba-like: "finished"
//   error      two low muted notes, a gentle minor third down: "that didn't work" without alarm

import { Reverb } from "./dsp/reverb.ts"
import { Biquad } from "./dsp/biquad.ts"
import { softClip } from "./dsp/effects.ts"

export type ChimeKind = "notify" | "listening" | "done" | "error"
export const CHIME_KINDS: ChimeKind[] = ["notify", "listening", "done", "error"]

interface Note {
  hz: number
  at: number // seconds
  dur: number // seconds of decay
  gain: number
  /** Bell partials as [ratio, relative gain, decay multiplier]. */
  partials: [number, number, number][]
  glideTo?: number
}

const BELL: [number, number, number][] = [
  [1, 1, 1],
  [2.0, 0.28, 0.6],
  [3.01, 0.08, 0.35],
  [4.2, 0.03, 0.22],
]
const MARIMBA: [number, number, number][] = [
  [1, 1, 1],
  [3.93, 0.18, 0.3],
  [9.2, 0.03, 0.12],
]
const SOFT: [number, number, number][] = [
  [1, 1, 1],
  [2, 0.12, 0.5],
]

const NOTES: Record<ChimeKind, { notes: Note[]; length: number; wet: number; lowpass: number }> = {
  notify: {
    notes: [
      { hz: 783.99, at: 0, dur: 0.55, gain: 0.5, partials: BELL },
      { hz: 1318.51, at: 0.13, dur: 0.8, gain: 0.42, partials: BELL },
    ],
    length: 1.15,
    wet: 0.22,
    lowpass: 7000,
  },
  listening: {
    notes: [{ hz: 660, glideTo: 990, at: 0, dur: 0.18, gain: 0.42, partials: SOFT }],
    length: 0.4,
    wet: 0.12,
    lowpass: 5000,
  },
  done: {
    notes: [
      { hz: 1318.51, at: 0, dur: 0.35, gain: 0.42, partials: MARIMBA },
      { hz: 880, at: 0.11, dur: 0.55, gain: 0.46, partials: MARIMBA },
    ],
    length: 0.9,
    wet: 0.18,
    lowpass: 6500,
  },
  error: {
    notes: [
      { hz: 349.23, at: 0, dur: 0.22, gain: 0.5, partials: SOFT },
      { hz: 293.66, at: 0.16, dur: 0.38, gain: 0.5, partials: SOFT },
    ],
    length: 0.8,
    wet: 0.12,
    lowpass: 2500,
  },
}

export function renderChime(kind: ChimeKind, sampleRate: number, gain = 0.6): Float32Array {
  const spec = NOTES[kind]
  const n = Math.round(spec.length * sampleRate)
  const x = new Float32Array(n)
  for (const note of spec.notes) {
    const start = Math.round(note.at * sampleRate)
    const attack = Math.round(0.004 * sampleRate)
    for (const [ratio, pg, decayMul] of note.partials) {
      const tau = note.dur * decayMul
      let phase = 0
      for (let i = start; i < n; i++) {
        const t = (i - start) / sampleRate
        const glide = note.glideTo ? note.hz * Math.pow(note.glideTo / note.hz, Math.min(1, t / 0.09)) : note.hz
        const f = glide * ratio
        if (f >= sampleRate / 2) break
        phase += (2 * Math.PI * f) / sampleRate
        const env = Math.min(1, (i - start) / attack) * Math.exp(-t / tau)
        if (env < 1e-4 && t > 0.05) break
        x[i] += Math.sin(phase) * env * pg * note.gain
      }
    }
  }
  const lp = new Biquad({ kind: "lowpass", hz: spec.lowpass, q: 0.6 }, sampleRate)
  const hp = new Biquad({ kind: "highpass", hz: 120 }, sampleRate)
  const rv = new Reverb({ wet: spec.wet, size: 0.5, damping: 0.5, scale: 0.8, predelayMs: 8, lowCutHz: 300, highCutHz: 7000 }, sampleRate)
  let peak = 0
  for (let i = 0; i < n; i++) {
    const d = hp.step(lp.step(x[i]))
    x[i] = d + rv.step(d)
    peak = Math.max(peak, Math.abs(x[i]))
  }
  const norm = peak > 0 ? gain / peak : 1
  const fade = Math.round(0.05 * sampleRate)
  for (let i = 0; i < n; i++) {
    x[i] = softClip(x[i] * norm)
    if (i > n - fade) x[i] *= (n - i) / fade
  }
  return x
}
