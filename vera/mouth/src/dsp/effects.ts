// Vera's voice character: the chain every sentence goes through.
//
//   trim silence -> level -> flatten pitch (PSOLA)        per sentence
//   EQ -> metallic tint (comb + ring) -> reverb -> limiter  streaming, state carries across sentences
//
// Pauses between sentences are fed through the streaming half as silence, so
// the reverb tail rings naturally into them instead of being cut off.

import { FilterChain, type BiquadSpec } from "./biquad.ts"
import { flattenPitch } from "./psola.ts"
import { Reverb, type ReverbOptions } from "./reverb.ts"

export interface EffectsConfig {
  /** Pitch flattening, 0 (natural) to 1 (monotone). */
  flatten: number
  /** Overall pitch shift in semitones (applied with the flattening). */
  pitchShift: number
  /** Metallic tint: a short feedback comb blended in. mix 0 disables it. */
  comb: { mix: number; delayMs: number; feedback: number }
  /** Ring modulation blended in. mix 0 disables it. */
  ring: { mix: number; hz: number }
  reverb: ReverbOptions
  /** Clarity EQ, applied before the tint and reverb. */
  eq: BiquadSpec[]
  /** Per-sentence loudness target, dBFS RMS of the voiced part. null disables leveling. */
  levelDb: number | null
  /** Output gain, linear, applied before the limiter. */
  gain: number
}

/** Clarity EQ for small speakers in a noisy room: no rumble, less mud, a little presence. */
const CLARITY_EQ: BiquadSpec[] = [
  { kind: "highpass", hz: 90, q: 0.7 },
  { kind: "peaking", hz: 280, q: 1.0, gainDb: -2 },
  { kind: "peaking", hz: 3000, q: 0.9, gainDb: 3 },
  { kind: "highshelf", hz: 8000, q: 0.7, gainDb: 1 },
]

const NO_REVERB: ReverbOptions = { wet: 0, size: 0, damping: 0 }

export const PRESETS = {
  /** Default: calm, slightly flattened, a hint of metal, a small bright room. */
  vera: {
    flatten: 0.45,
    pitchShift: 0,
    comb: { mix: 0.12, delayMs: 4.5, feedback: 0.45 },
    ring: { mix: 0, hz: 0 },
    reverb: { wet: 0.16, size: 0.42, damping: 0.45, scale: 0.75, predelayMs: 12, lowCutHz: 300, highCutHz: 6500 },
    eq: CLARITY_EQ,
    levelDb: -20,
    gain: 1,
  },
  /** Same character without the room: the most intelligible over cooking noise. */
  dry: {
    flatten: 0.45,
    pitchShift: 0,
    comb: { mix: 0.12, delayMs: 4.5, feedback: 0.45 },
    ring: { mix: 0, hz: 0 },
    reverb: NO_REVERB,
    eq: CLARITY_EQ,
    levelDb: -20,
    gain: 1,
  },
  /** More robot: near-monotone, a stronger metallic ring, a slightly bigger plate. */
  "robot+": {
    flatten: 0.85,
    pitchShift: -0.5,
    comb: { mix: 0.28, delayMs: 5.0, feedback: 0.6 },
    ring: { mix: 0.14, hz: 70 },
    reverb: { wet: 0.2, size: 0.5, damping: 0.4, scale: 0.6, predelayMs: 10, lowCutHz: 300, highCutHz: 7000 },
    eq: CLARITY_EQ,
    levelDb: -20,
    gain: 1,
  },
  /** The engine's own voice: only leveling and the safety limiter. */
  plain: {
    flatten: 0,
    pitchShift: 0,
    comb: { mix: 0, delayMs: 5, feedback: 0 },
    ring: { mix: 0, hz: 0 },
    reverb: NO_REVERB,
    eq: [{ kind: "highpass", hz: 60, q: 0.7 }],
    levelDb: -20,
    gain: 1,
  },
} satisfies Record<string, EffectsConfig>

export type PresetName = keyof typeof PRESETS
export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[]

export type EffectsOverrides = Partial<Omit<EffectsConfig, "comb" | "ring" | "reverb">> & {
  comb?: Partial<EffectsConfig["comb"]>
  ring?: Partial<EffectsConfig["ring"]>
  reverb?: Partial<ReverbOptions>
}

export function resolveEffects(preset: string, overrides?: EffectsOverrides): EffectsConfig {
  const base = (PRESETS as Record<string, EffectsConfig>)[preset]
  if (!base) throw new Error(`Unknown preset "${preset}". Presets: ${PRESET_NAMES.join(", ")}`)
  const o = overrides ?? {}
  return {
    ...base,
    ...o,
    comb: { ...base.comb, ...o.comb },
    ring: { ...base.ring, ...o.ring },
    reverb: { ...base.reverb, ...o.reverb },
    eq: o.eq ?? base.eq,
  }
}

const TRIM_THRESHOLD = 0.006 // about -44 dBFS
const EDGE_MS = 15

/** Cut leading and trailing near-silence, keeping a short margin with tiny fades. */
export function trimSilence(x: Float32Array, sampleRate: number): Float32Array {
  let a = 0
  let b = x.length - 1
  while (a < x.length && Math.abs(x[a]) < TRIM_THRESHOLD) a++
  while (b > a && Math.abs(x[b]) < TRIM_THRESHOLD) b--
  if (a >= b) return new Float32Array(0)
  const margin = Math.round((sampleRate * EDGE_MS) / 1000)
  a = Math.max(0, a - margin)
  b = Math.min(x.length - 1, b + margin * 2)
  const y = x.slice(a, b + 1)
  const fade = Math.min(margin, y.length >> 2)
  for (let i = 0; i < fade; i++) {
    const g = i / fade
    y[i] *= g
    y[y.length - 1 - i] *= g
  }
  return y
}

/** Scale so the voiced part sits at targetDb RMS, within sane gain bounds. */
export function level(x: Float32Array, targetDb: number): Float32Array {
  let sum = 0
  let n = 0
  for (const v of x) {
    if (Math.abs(v) > 0.01) {
      sum += v * v
      n++
    }
  }
  if (n < 32) return x
  const rms = Math.sqrt(sum / n)
  const gain = Math.min(4, Math.max(0.25, Math.pow(10, targetDb / 20) / rms))
  for (let i = 0; i < x.length; i++) x[i] *= gain
  return x
}

/**
 * Lookahead peak limiter followed by a soft clipper, so nothing the chain
 * produces can exceed full scale.
 */
export class Limiter {
  private ceiling: number
  private delay: Float32Array
  private reqs: Float32Array
  private i = 0
  private gain = 1
  private release: number
  private attack: number

  constructor(sampleRate: number, ceiling = 0.89, lookaheadMs = 3, releaseMs = 90) {
    this.ceiling = ceiling
    const n = Math.max(1, Math.round((sampleRate * lookaheadMs) / 1000))
    this.delay = new Float32Array(n)
    this.reqs = new Float32Array(n).fill(1)
    this.release = 1 - Math.exp(-1 / ((sampleRate * releaseMs) / 1000))
    this.attack = 1 - Math.exp(-1 / Math.max(1, n / 3))
  }

  get latency(): number {
    return this.delay.length
  }

  step(x: number): number {
    const out = this.delay[this.i]
    this.delay[this.i] = x
    const a = Math.abs(x)
    this.reqs[this.i] = a > this.ceiling ? this.ceiling / a : 1
    if (++this.i >= this.delay.length) this.i = 0
    let target = 1
    for (let k = 0; k < this.reqs.length; k++) if (this.reqs[k] < target) target = this.reqs[k]
    this.gain += (target - this.gain) * (target < this.gain ? this.attack : this.release)
    return softClip(out * this.gain)
  }
}

/** Transparent below 0.9, saturates smoothly to a hard ceiling of 0.99. */
export function softClip(x: number): number {
  const a = Math.abs(x)
  if (a <= 0.9) return x
  const y = 0.9 + 0.09 * Math.tanh((a - 0.9) / 0.09)
  return x < 0 ? -y : y
}

/** One utterance's worth of voice processing. Create one per speak(). */
export class VoiceFx {
  readonly sampleRate: number
  private cfg: EffectsConfig
  private eq: FilterChain
  private comb: Float32Array
  private combI = 0
  private combLp = 0
  private ringPhase = 0
  private ringStep: number
  private reverb: Reverb | null
  private limiter: Limiter
  private targetHz: number | undefined
  private tailEnergy = 0

  constructor(cfg: EffectsConfig, sampleRate: number, targetHz?: number) {
    this.cfg = cfg
    this.sampleRate = sampleRate
    this.targetHz = targetHz
    this.eq = new FilterChain(cfg.eq, sampleRate)
    this.comb = new Float32Array(Math.max(1, Math.round((cfg.comb.delayMs * sampleRate) / 1000)))
    this.ringStep = (2 * Math.PI * cfg.ring.hz) / sampleRate
    this.reverb = cfg.reverb.wet > 0 ? new Reverb(cfg.reverb, sampleRate) : null
    this.limiter = new Limiter(sampleRate)
  }

  /** Process one synthesized sentence. Returns audio ready to play. */
  sentence(raw: Float32Array): Float32Array {
    let x = trimSilence(raw, this.sampleRate)
    if (x.length === 0) return x
    if (this.cfg.levelDb !== null) x = level(x, this.cfg.levelDb)
    if (this.cfg.flatten > 0 || this.cfg.pitchShift !== 0) {
      x = flattenPitch(x, this.sampleRate, {
        amount: this.cfg.flatten,
        targetHz: this.targetHz,
        shiftSemitones: this.cfg.pitchShift,
      })
    }
    return this.stream(x)
  }

  /** Silence through the streaming half (the reverb keeps ringing). */
  silence(ms: number): Float32Array {
    return this.stream(new Float32Array(Math.round((ms * this.sampleRate) / 1000)))
  }

  /** The reverb tail and limiter lookahead after the last sentence. */
  tail(maxMs = 1500): Float32Array {
    if (!this.reverb) return this.stream(new Float32Array(this.limiter.latency + 8))
    const block = Math.round(this.sampleRate * 0.05)
    const parts: Float32Array[] = []
    const maxBlocks = Math.ceil((maxMs * this.sampleRate) / 1000 / block)
    for (let b = 0; b < maxBlocks; b++) {
      const y = this.stream(new Float32Array(block))
      parts.push(y)
      if (this.tailEnergy < 1e-7 && b > 1) break
    }
    // Fade the very end so a cut tail never clicks.
    const out = concat(parts)
    const fade = Math.min(out.length, Math.round(this.sampleRate * 0.03))
    for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade
    return out
  }

  private stream(x: Float32Array): Float32Array {
    const { comb, ring, gain } = this.cfg
    const y = new Float32Array(x.length)
    const combOn = comb.mix > 0
    const ringOn = ring.mix > 0
    const combNorm = 1 - comb.feedback
    let energy = 0
    for (let i = 0; i < x.length; i++) {
      let v = this.eq.step(x[i])
      if (combOn) {
        const d = this.comb[this.combI]
        this.combLp = d * 0.7 + this.combLp * 0.3
        const c = v + this.combLp * comb.feedback
        this.comb[this.combI] = c
        if (++this.combI >= this.comb.length) this.combI = 0
        v = v * (1 - comb.mix) + c * combNorm * comb.mix
      }
      if (ringOn) {
        v = v * (1 - ring.mix) + v * Math.sin(this.ringPhase) * ring.mix * 1.4
        this.ringPhase += this.ringStep
        if (this.ringPhase > 2 * Math.PI) this.ringPhase -= 2 * Math.PI
      }
      if (this.reverb) {
        const w = this.reverb.step(v)
        energy += w * w
        v += w
      }
      y[i] = this.limiter.step(v * gain)
    }
    this.tailEnergy = x.length ? energy / x.length : 0
    return y
  }
}

export function concat(parts: Float32Array[]): Float32Array {
  const n = parts.reduce((a, p) => a + p.length, 0)
  const out = new Float32Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
