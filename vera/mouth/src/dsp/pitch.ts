// YIN pitch tracking, run on a 2x-decimated copy for speed.

import { Biquad } from "./biquad.ts"

export interface PitchTrack {
  /** Hop between frames, in samples at the input rate. */
  hop: number
  /** f0 in Hz per frame; 0 where unvoiced. */
  f0: Float32Array
}

export interface PitchOptions {
  minHz?: number
  maxHz?: number
  hopMs?: number
  windowMs?: number
  threshold?: number
}

export function trackPitch(x: Float32Array, sampleRate: number, opts: PitchOptions = {}): PitchTrack {
  const minHz = opts.minHz ?? 65
  const maxHz = opts.maxHz ?? 420
  const threshold = opts.threshold ?? 0.15
  // Decimate by 2 after a lowpass: pitch lives well below 3 kHz.
  const lp = new Biquad({ kind: "lowpass", hz: sampleRate / 5 }, sampleRate)
  const lp2 = new Biquad({ kind: "lowpass", hz: sampleRate / 5 }, sampleRate)
  const sr = sampleRate / 2
  const d = new Float32Array(Math.floor(x.length / 2))
  for (let i = 0, j = 0; j < d.length; i += 2, j++) {
    const a = lp2.step(lp.step(x[i]))
    lp2.step(lp.step(x[i + 1] ?? 0))
    d[j] = a
  }
  const hop = Math.max(1, Math.round((sr * (opts.hopMs ?? 5)) / 1000))
  const win = Math.round((sr * (opts.windowMs ?? 32)) / 1000)
  const minLag = Math.max(2, Math.floor(sr / maxHz))
  const maxLag = Math.ceil(sr / minHz)
  const frames = Math.max(0, Math.floor((d.length - win - maxLag) / hop) + 1)
  const f0 = new Float32Array(frames)
  const diff = new Float64Array(maxLag + 2)
  // Energy gate relative to the loudest frame.
  const energies = new Float64Array(frames)
  let maxE = 0
  for (let f = 0; f < frames; f++) {
    const s = f * hop
    let e = 0
    for (let j = 0; j < win; j++) e += d[s + j] * d[s + j]
    energies[f] = e / win
    if (energies[f] > maxE) maxE = energies[f]
  }
  const gate = Math.max(maxE * 0.003, 1e-7)
  for (let f = 0; f < frames; f++) {
    if (energies[f] < gate) continue
    const s = f * hop
    for (let lag = 1; lag <= maxLag + 1; lag++) {
      let acc = 0
      for (let j = 0; j < win; j++) {
        const v = d[s + j] - d[s + j + lag]
        acc += v * v
      }
      diff[lag] = acc
    }
    // Cumulative mean normalized difference.
    let run = 0
    let best = -1
    let cmPrev = 1
    const cm = new Float64Array(maxLag + 2)
    cm[0] = 1
    for (let lag = 1; lag <= maxLag + 1; lag++) {
      run += diff[lag]
      cm[lag] = run > 0 ? (diff[lag] * lag) / run : 1
    }
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (cm[lag] < threshold) {
        while (lag + 1 <= maxLag && cm[lag + 1] < cm[lag]) lag++
        best = lag
        break
      }
      cmPrev = cm[lag]
    }
    void cmPrev
    if (best < 0) continue
    // Parabolic interpolation around the minimum.
    const a = cm[best - 1]
    const b = cm[best]
    const c = cm[best + 1]
    const denom = a - 2 * b + c
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0
    const period = best + Math.max(-0.5, Math.min(0.5, shift))
    f0[f] = sr / period
  }
  cleanTrack(f0)
  return { hop: hop * 2, f0 }
}

/** Median-smooth, fix octave jumps, and drop isolated voiced blips. */
function cleanTrack(f0: Float32Array): void {
  const n = f0.length
  const src = Float32Array.from(f0)
  for (let i = 0; i < n; i++) {
    if (!src[i]) continue
    const neigh: number[] = []
    for (let k = -3; k <= 3; k++) if (src[i + k]) neigh.push(src[i + k])
    if (neigh.length < 3) {
      f0[i] = 0
      continue
    }
    neigh.sort((p, q) => p - q)
    const med = neigh[neigh.length >> 1]
    let v = src[i]
    if (v > med * 1.7) v /= 2
    else if (v < med / 1.7) v *= 2
    f0[i] = v
  }
}

/** Median f0 over voiced frames, or 0 when nothing is voiced. */
export function medianF0(track: PitchTrack): number {
  const v = [...track.f0].filter((x) => x > 0).sort((a, b) => a - b)
  return v.length ? v[v.length >> 1] : 0
}

/** Standard deviation of voiced f0 in semitones: a monotony measure. */
export function pitchSpreadSemitones(track: PitchTrack): number {
  const v = [...track.f0].filter((x) => x > 0).map((x) => 12 * Math.log2(x / 100))
  if (v.length < 2) return 0
  const m = v.reduce((a, b) => a + b, 0) / v.length
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length)
}
