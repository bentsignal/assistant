#!/usr/bin/env -S node --import tsx
// pnpm --filter @vera/mouth say "text" [--preset name] [--voice id] [--engine kokoro|piper]
//                                      [--speed n] [--out file.wav] [--chime kind] [--plan] [--timing]

import { createMouth, type VeraMouth } from "./mouth.ts"
import { loadUserMouthConfig, type MouthConfig } from "./config.ts"
import { PRESET_NAMES } from "./dsp/effects.ts"
import { normalizeForSpeech } from "./text/normalize.ts"
import { splitForSpeech } from "./text/split.ts"
import { writeWav } from "./wav.ts"
import { CHIME_KINDS, type ChimeKind } from "./chimes.ts"
import { concat } from "./dsp/effects.ts"
import { resolve } from "node:path"

const USAGE = `usage: say "text" [options]
  --preset <${PRESET_NAMES.join("|")}>   character preset (default from ~/.vera/config.json, else vera)
  --voice <id>       Kokoro speaker (bf_emma, af_heart, am_michael, ...) or Piper voice
  --engine <name>    kokoro (default) or piper
  --speed <n>        speaking rate, 1 = natural
  --out <file.wav>   write a WAV instead of playing
  --chime <kind>     play (or with --out, write) a chime: ${CHIME_KINDS.join(", ")}
  --plan             print the normalized chunks and exit (no model needed)
  --timing           print latency and real-time factor`

function parse(argv: string[]): { text: string; opts: Record<string, string | true> } {
  const opts: Record<string, string | true> = {}
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--") continue
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const val = argv[i + 1]
      if (["plan", "timing", "help"].includes(key) || val === undefined || val.startsWith("--")) opts[key] = true
      else {
        opts[key] = val
        i++
      }
    } else words.push(a)
  }
  return { text: words.join(" "), opts }
}

async function main(): Promise<void> {
  const { text, opts } = parse(process.argv.slice(2))
  if (opts.help || (!text && !opts.chime)) {
    console.log(USAGE)
    process.exit(text || opts.chime ? 0 : 1)
  }
  if (opts.plan) {
    const norm = normalizeForSpeech(text)
    console.log(JSON.stringify(norm))
    for (const c of splitForSpeech(norm)) console.log(`  [${c.pauseMs}ms] ${c.text}`)
    return
  }
  const cfg: Partial<MouthConfig> = { ...loadUserMouthConfig() }
  if (typeof opts.preset === "string") cfg.preset = opts.preset
  if (typeof opts.voice === "string") cfg.voice = opts.voice
  if (typeof opts.engine === "string") cfg.engine = opts.engine as MouthConfig["engine"]
  if (typeof opts.speed === "string") cfg.speed = Number(opts.speed)
  // pnpm runs scripts in the package folder; resolve --out against where the command was typed.
  const out = typeof opts.out === "string" ? resolve(process.env.INIT_CWD ?? process.cwd(), opts.out) : undefined
  if (out) cfg.player = { warm: 0 }
  const t0 = performance.now()
  const mouth = (await createMouth(cfg)) as VeraMouth & { renderChime(kind: ChimeKind): Float32Array }
  const loadMs = performance.now() - t0
  try {
    if (opts.chime) {
      const kind = String(opts.chime) as ChimeKind
      if (out) await writeWav(out, mouth.renderChime(kind), mouth.sampleRate)
      else await mouth.chime(kind)
      if (!text) return
    }
    if (out) {
      const t1 = performance.now()
      const samples = await mouth.render(text)
      const ms = performance.now() - t1
      await writeWav(out, opts.chime ? concat([new Float32Array(mouth.sampleRate / 4), samples]) : samples, mouth.sampleRate)
      if (opts.timing) console.log(`load ${loadMs.toFixed(0)} ms, render ${ms.toFixed(0)} ms for ${(samples.length / mouth.sampleRate).toFixed(2)} s (RTF ${(ms / 1000 / (samples.length / mouth.sampleRate)).toFixed(3)})`)
      console.log(out)
      return
    }
    process.once("SIGINT", () => mouth.stop())
    await mouth.speak(text)
    const t = mouth.lastTiming
    if (opts.timing && t) {
      const synth = t.synthMs.reduce((a, b) => a + b, 0)
      console.log(`load ${loadMs.toFixed(0)} ms, first audio ${t.firstAudioMs.toFixed(0)} ms, synth ${synth.toFixed(0)} ms for ${t.audioSeconds.toFixed(2)} s of audio (RTF ${(synth / 1000 / t.audioSeconds).toFixed(3)}), chunks ${t.chunks.length}`)
    }
  } finally {
    await mouth.close()
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
