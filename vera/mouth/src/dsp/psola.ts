// Pitch flattening with TD-PSOLA: keep timing and formants, pull the pitch
// contour toward one target note. amount 0 leaves it alone, 1 is monotone.

import { Biquad } from "./biquad.ts"
import { medianF0, trackPitch, type PitchTrack } from "./pitch.ts"

export interface FlattenOptions {
  /** 0..1: how far to pull each pitch toward the target (in log frequency). */
  amount: number
  /** Target pitch in Hz; defaults to the clip's own median. */
  targetHz?: number
  /** Shift the whole contour, in semitones, after flattening. */
  shiftSemitones?: number
}

interface Mark {
  pos: number
  period: number
  voiced: boolean
}

function f0At(track: PitchTrack, pos: number): number {
  const i = Math.round(pos / track.hop)
  if (i < 0 || i >= track.f0.length) return 0
  return track.f0[i]
}

function analysisMarks(x: Float32Array, sr: number, track: PitchTrack): Mark[] {
  const lp = new Biquad({ kind: "lowpass", hz: 900 }, sr)
  const s = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) s[i] = lp.step(x[i])
  const unvoicedStep = Math.round(sr * 0.005)
  const marks: Mark[] = []
  let pos = 0
  let inVoiced = false
  while (pos < x.length) {
    const f = f0At(track, pos)
    if (f > 0) {
      const P = sr / f
      let best = pos
      if (!inVoiced) {
        // Anchor the first mark of a voiced run on the biggest peak in one period.
        const end = Math.min(x.length, pos + Math.round(P))
        for (let i = pos; i < end; i++) if (s[i] > s[best]) best = i
      } else {
        const r = Math.round(P * 0.2)
        const lo = Math.max(0, pos - r)
        const hi = Math.min(x.length - 1, pos + r)
        best = lo
        for (let i = lo; i <= hi; i++) if (s[i] > s[best]) best = i
      }
      if (marks.length && best <= marks[marks.length - 1].pos) best = marks[marks.length - 1].pos + Math.round(P)
      if (best >= x.length) break
      marks.push({ pos: best, period: P, voiced: true })
      inVoiced = true
      pos = best + Math.round(P)
    } else {
      marks.push({ pos, period: unvoicedStep, voiced: false })
      inVoiced = false
      pos += unvoicedStep
    }
  }
  // A voiced mark's period is the spacing to its neighbors, which matches the grain to the real cycle.
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]
    if (!m.voiced) continue
    const prev = marks[i - 1]
    const next = marks[i + 1]
    const spans: number[] = []
    if (prev?.voiced) spans.push(m.pos - prev.pos)
    if (next?.voiced) spans.push(next.pos - m.pos)
    if (spans.length) {
      const sp = spans.reduce((a, b) => a + b, 0) / spans.length
      if (sp > m.period * 0.6 && sp < m.period * 1.6) m.period = sp
    }
  }
  return marks
}

/** Flatten (and optionally shift) the pitch of a mono clip. Returns a new buffer of the same length. */
export function flattenPitch(x: Float32Array, sampleRate: number, opts: FlattenOptions): Float32Array {
  const amount = Math.max(0, Math.min(1, opts.amount))
  const shift = opts.shiftSemitones ?? 0
  if ((amount === 0 && shift === 0) || x.length < sampleRate * 0.05) return Float32Array.from(x)
  const track = trackPitch(x, sampleRate)
  const target = opts.targetHz && opts.targetHz > 0 ? opts.targetHz : medianF0(track)
  if (!target) return Float32Array.from(x)
  const logT = Math.log(target)
  const shiftRatio = Math.pow(2, shift / 12)
  const marks = analysisMarks(x, sampleRate, track)
  if (marks.length < 2) return Float32Array.from(x)

  const out = new Float64Array(x.length)
  const wsum = new Float64Array(x.length)
  let k = 0
  let ts = marks[0].pos
  // Precompute Hann windows by integer half-length.
  const hannCache = new Map<number, Float64Array>()
  const hann = (half: number): Float64Array => {
    let w = hannCache.get(half)
    if (!w) {
      w = new Float64Array(2 * half + 1)
      for (let j = -half; j <= half; j++) w[j + half] = 0.5 * (1 + Math.cos((Math.PI * j) / (half + 1)))
      hannCache.set(half, w)
    }
    return w
  }
  // Leading samples before the first mark pass through.
  for (let i = 0; i < Math.min(ts, x.length); i++) {
    out[i] = x[i]
    wsum[i] = 1
  }
  let prevVoiced = false
  let lastCenter = -1
  let guard = 0
  while (ts < x.length && guard++ < x.length) {
    while (k + 1 < marks.length && Math.abs(marks[k + 1].pos - ts) <= Math.abs(marks[k].pos - ts)) k++
    // Unvoiced grains go back exactly where they came from (so noise passes through untouched):
    // take the first unvoiced mark ahead of the last grain, never one behind it.
    if (!marks[k].voiced && marks[k].pos <= lastCenter && k + 1 < marks.length) k++
    const m = marks[k]
    const next = marks[k + 1]
    let step: number
    if (m.voiced) {
      // Entering a voiced run: start exactly on its first mark.
      if (!prevVoiced && m.pos > lastCenter) ts = m.pos
      const f = sampleRate / m.period
      const lf = Math.log(f)
      const nf = Math.exp(logT + (1 - amount) * (lf - logT)) * shiftRatio
      // Step by the real spacing to the next cycle, scaled: with no change the marks line up exactly.
      const spacing = next?.voiced ? next.pos - m.pos : m.period
      step = spacing * (f / nf)
    } else {
      ts = m.pos > lastCenter ? m.pos : Math.max(ts, lastCenter + 1)
      step = m.period
    }
    prevVoiced = m.voiced
    const half = Math.max(8, Math.round(m.voiced ? m.period : m.period * 1.5))
    const w = hann(half)
    const center = Math.round(ts)
    lastCenter = center
    for (let j = -half; j <= half; j++) {
      const src = m.pos + j
      const dst = center + j
      if (src < 0 || src >= x.length || dst < 0 || dst >= x.length) continue
      const wj = w[j + half]
      out[dst] += x[src] * wj
      wsum[dst] += wj
    }
    ts += Math.max(4, step)
  }
  const y = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) {
    const ws = wsum[i]
    y[i] = ws > 0.25 ? out[i] / ws : out[i] / 0.25
  }
  return y
}
