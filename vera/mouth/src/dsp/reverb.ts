// Mono Freeverb (Jezar's tuning), rescaled for the engine's sample rate,
// with a predelay and a band-limited wet path so the tail stays out of the
// way of consonants.

import { Biquad } from "./biquad.ts"

const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASS_TUNING = [556, 441, 341, 225]
const FIXED_GAIN = 0.015

class Comb {
  private buf: Float32Array
  private i = 0
  private store = 0
  private feedback: number
  private damp: number
  constructor(size: number, feedback: number, damp: number) {
    this.buf = new Float32Array(size)
    this.feedback = feedback
    this.damp = damp
  }
  step(x: number): number {
    const out = this.buf[this.i]
    this.store = out * (1 - this.damp) + this.store * this.damp
    this.buf[this.i] = x + this.store * this.feedback
    if (++this.i >= this.buf.length) this.i = 0
    return out
  }
}

class Allpass {
  private buf: Float32Array
  private i = 0
  constructor(size: number) {
    this.buf = new Float32Array(size)
  }
  step(x: number): number {
    const b = this.buf[this.i]
    const out = b - x
    this.buf[this.i] = x + b * 0.5
    if (++this.i >= this.buf.length) this.i = 0
    return out
  }
}

export interface ReverbOptions {
  /** 0..1 wet level. 0 disables the reverb. */
  wet: number
  /** 0..1 room size (decay time). */
  size: number
  /** 0..1 high-frequency damping in the tail. */
  damping: number
  /** Scales the delay lines: below 1 is a smaller, denser space (plate-ish). */
  scale?: number
  predelayMs?: number
  /** Wet-path band: keeps lows and highs out of the tail. */
  lowCutHz?: number
  highCutHz?: number
}

export class Reverb {
  private combs: Comb[]
  private allpasses: Allpass[]
  private pre: Float32Array
  private preI = 0
  private lowCut: Biquad
  private highCut: Biquad
  readonly wet: number

  constructor(opts: ReverbOptions, sampleRate: number) {
    const k = (sampleRate / 44100) * (opts.scale ?? 1)
    const feedback = opts.size * 0.28 + 0.7
    const damp = opts.damping * 0.4
    this.combs = COMB_TUNING.map((t) => new Comb(Math.max(8, Math.round(t * k)), feedback, damp))
    this.allpasses = ALLPASS_TUNING.map((t) => new Allpass(Math.max(4, Math.round(t * k))))
    this.pre = new Float32Array(Math.max(1, Math.round(((opts.predelayMs ?? 0) * sampleRate) / 1000)))
    this.lowCut = new Biquad({ kind: "highpass", hz: opts.lowCutHz ?? 250 }, sampleRate)
    this.highCut = new Biquad({ kind: "lowpass", hz: opts.highCutHz ?? 6000 }, sampleRate)
    this.wet = opts.wet
  }

  /** Returns only the wet signal for one input sample. */
  step(x: number): number {
    const delayed = this.pre[this.preI]
    this.pre[this.preI] = x
    if (++this.preI >= this.pre.length) this.preI = 0
    const input = this.highCut.step(this.lowCut.step(delayed)) * FIXED_GAIN
    let acc = 0
    for (const c of this.combs) acc += c.step(input)
    for (const a of this.allpasses) acc = a.step(acc)
    return acc * 3 * this.wet
  }
}
