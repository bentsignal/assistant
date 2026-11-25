import { test } from "node:test"
import assert from "node:assert/strict"
import { PRESET_NAMES, resolveEffects, softClip, trimSilence, VoiceFx, concat, Limiter } from "../src/dsp/effects.ts"
import { flattenPitch } from "../src/dsp/psola.ts"
import { pitchSpreadSemitones, trackPitch, medianF0 } from "../src/dsp/pitch.ts"
import { renderChime, CHIME_KINDS } from "../src/chimes.ts"

const SR = 24000

/** A vowel-like test signal: harmonics of a gliding f0, with an amplitude envelope. */
function voice(seconds: number, f0From: number, f0To: number, amp = 0.5): Float32Array {
  const n = Math.round(seconds * SR)
  const x = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / n
    const f = f0From * Math.pow(f0To / f0From, t) * (1 + 0.04 * Math.sin(2 * Math.PI * 3 * (i / SR)))
    phase += (2 * Math.PI * f) / SR
    let s = 0
    for (let h = 1; h <= 12; h++) s += Math.sin(h * phase) / h ** 1.2
    x[i] = s * amp * 0.5 * Math.min(1, i / 600, (n - i) / 600)
  }
  return x
}

function peak(x: Float32Array): number {
  let p = 0
  for (const v of x) p = Math.max(p, Math.abs(v))
  return p
}

function rms(x: Float32Array): number {
  let s = 0
  for (const v of x) s += v * v
  return Math.sqrt(s / x.length)
}

test("pitch tracker finds a steady pitch", () => {
  const tr = trackPitch(voice(0.6, 180, 180), SR)
  assert.ok(Math.abs(medianF0(tr) - 180) < 6, `median ${medianF0(tr)}`)
})

test("PSOLA flattening narrows pitch spread and keeps length", () => {
  const x = voice(1.2, 140, 260)
  const before = pitchSpreadSemitones(trackPitch(x, SR))
  const y = flattenPitch(x, SR, { amount: 0.8, targetHz: 190 })
  const after = pitchSpreadSemitones(trackPitch(y, SR))
  assert.equal(y.length, x.length)
  assert.ok(before > 2.5, `before ${before}`)
  assert.ok(after < before * 0.45, `before ${before} after ${after}`)
  assert.ok(Math.abs(medianF0(trackPitch(y, SR)) - 190) < 15)
  assert.ok(Math.abs(rms(y) / rms(x) - 1) < 0.25, "loudness preserved")
})

test("PSOLA with no change is transparent", () => {
  const x = voice(0.8, 150, 220)
  const y = flattenPitch(x, SR, { amount: 1e-4 })
  let e = 0
  let s = 0
  for (let i = 0; i < x.length; i++) {
    e += (x[i] - y[i]) ** 2
    s += x[i] ** 2
  }
  assert.ok(10 * Math.log10(s / e) > 30, `identity SNR ${10 * Math.log10(s / e)} dB`)
})

test("every preset keeps hot input under full scale", () => {
  for (const name of PRESET_NAMES) {
    const fx = new VoiceFx(resolveEffects(name), SR, 190)
    // Deliberately far too loud, plus a full-scale square burst.
    const loud = voice(1, 120, 300, 3)
    const square = new Float32Array(SR / 4).map((_, i) => (Math.floor(i / 20) % 2 ? 1 : -1))
    const out = concat([fx.sentence(loud), fx.silence(200), fx.sentence(square), fx.tail()])
    assert.ok(out.length > 0)
    assert.ok(peak(out) <= 0.99, `${name} peak ${peak(out)}`)
    for (const v of out) assert.ok(Number.isFinite(v), `${name} produced a non-finite sample`)
  }
})

test("leveling brings quiet and loud sentences to similar loudness", () => {
  const fx = () => new VoiceFx(resolveEffects("dry"), SR, 190)
  const quiet = fx().sentence(voice(0.8, 180, 200, 0.12))
  const loud = fx().sentence(voice(0.8, 180, 200, 0.9))
  const ratioDb = 20 * Math.log10(rms(loud) / rms(quiet))
  assert.ok(Math.abs(ratioDb) < 3, `quiet vs loud differ by ${ratioDb.toFixed(1)} dB`)
})

test("reverb rings into the tail and then decays", () => {
  const fx = new VoiceFx(resolveEffects("vera"), SR, 190)
  fx.sentence(voice(0.5, 190, 190))
  const tail = fx.tail()
  assert.ok(tail.length > SR * 0.1, "has a tail")
  const head = rms(tail.subarray(0, 2400))
  const end = rms(tail.subarray(tail.length - 2400))
  assert.ok(head > 1e-4, "tail starts audible")
  assert.ok(end < head / 10, "tail decays")
})

test("dry and plain presets have no reverb tail", () => {
  for (const name of ["dry", "plain"]) {
    const fx = new VoiceFx(resolveEffects(name), SR, 190)
    fx.sentence(voice(0.3, 190, 190))
    assert.ok(fx.tail().length < SR * 0.01, name)
  }
})

test("silence trimming removes padding but keeps the speech", () => {
  const speech = voice(0.5, 190, 190)
  const padded = concat([new Float32Array(SR / 2), speech, new Float32Array(SR / 2)])
  const t = trimSilence(padded, SR)
  assert.ok(t.length < speech.length + SR * 0.08)
  assert.ok(t.length > speech.length * 0.9)
  assert.equal(trimSilence(new Float32Array(1000), SR).length, 0)
})

test("limiter and soft clip never exceed the ceiling", () => {
  const lim = new Limiter(SR)
  for (let i = 0; i < 5000; i++) assert.ok(Math.abs(lim.step(Math.sin(i / 3) * 4)) <= 0.99)
  assert.equal(softClip(0.5), 0.5)
  assert.ok(softClip(10) <= 0.99 && softClip(-10) >= -0.99)
})

test("overrides merge into a preset; unknown presets fail loudly", () => {
  const e = resolveEffects("vera", { flatten: 0.9, reverb: { wet: 0.3 } })
  assert.equal(e.flatten, 0.9)
  assert.equal(e.reverb.wet, 0.3)
  assert.equal(e.reverb.size, resolveEffects("vera").reverb.size)
  assert.throws(() => resolveEffects("nope"), /Unknown preset/)
})

test("chimes are short, soft, distinct, and never clip", () => {
  const rendered = CHIME_KINDS.map((k) => renderChime(k, SR, 0.5))
  for (const [i, x] of rendered.entries()) {
    assert.ok(x.length > SR * 0.2 && x.length < SR * 1.5, `${CHIME_KINDS[i]} length`)
    assert.ok(peak(x) <= 0.55, `${CHIME_KINDS[i]} peak ${peak(x)}`)
    assert.ok(Math.abs(x[x.length - 1]) < 1e-3, "ends silent")
  }
  // notify is the longest and must differ from done.
  assert.notDeepEqual(rendered[0].subarray(0, 2000), rendered[2].subarray(0, 2000))
})
