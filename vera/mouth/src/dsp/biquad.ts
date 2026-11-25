// RBJ cookbook biquads, direct form I, streaming.

export type BiquadKind = "lowpass" | "highpass" | "peaking" | "lowshelf" | "highshelf"

export interface BiquadSpec {
  kind: BiquadKind
  hz: number
  q?: number
  gainDb?: number
}

export class Biquad {
  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0

  constructor(spec: BiquadSpec, sampleRate: number) {
    const f = Math.min(spec.hz, sampleRate * 0.45)
    const w = (2 * Math.PI * f) / sampleRate
    const cos = Math.cos(w)
    const sin = Math.sin(w)
    const q = spec.q ?? Math.SQRT1_2
    const alpha = sin / (2 * q)
    const A = Math.pow(10, (spec.gainDb ?? 0) / 40)
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number
    switch (spec.kind) {
      case "lowpass":
        b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2
        a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha
        break
      case "highpass":
        b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2
        a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha
        break
      case "peaking":
        b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A
        a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A
        break
      case "lowshelf": {
        const s = 2 * Math.sqrt(A) * alpha
        b0 = A * (A + 1 - (A - 1) * cos + s); b1 = 2 * A * (A - 1 - (A + 1) * cos); b2 = A * (A + 1 - (A - 1) * cos - s)
        a0 = A + 1 + (A - 1) * cos + s; a1 = -2 * (A - 1 + (A + 1) * cos); a2 = A + 1 + (A - 1) * cos - s
        break
      }
      case "highshelf": {
        const s = 2 * Math.sqrt(A) * alpha
        b0 = A * (A + 1 + (A - 1) * cos + s); b1 = -2 * A * (A - 1 + (A + 1) * cos); b2 = A * (A + 1 + (A - 1) * cos - s)
        a0 = A + 1 - (A - 1) * cos + s; a1 = 2 * (A - 1 - (A + 1) * cos); a2 = A + 1 - (A - 1) * cos - s
        break
      }
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0
  }

  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1; this.x1 = x
    this.y2 = this.y1; this.y1 = y
    return y
  }

  /** Filter in place. */
  run(buf: Float32Array): Float32Array {
    for (let i = 0; i < buf.length; i++) buf[i] = this.step(buf[i])
    return buf
  }
}

export class FilterChain {
  private filters: Biquad[]
  constructor(specs: BiquadSpec[], sampleRate: number) {
    this.filters = specs.map((s) => new Biquad(s, sampleRate))
  }
  run(buf: Float32Array): Float32Array {
    for (const f of this.filters) f.run(buf)
    return buf
  }
  step(x: number): number {
    for (const f of this.filters) x = f.step(x)
    return x
  }
}
