import { readFileSync } from "node:fs"
import { cpus, homedir } from "node:os"
import { join } from "node:path"
import type { EffectsOverrides, PresetName } from "./dsp/effects.ts"
import { defaultModelsDir, type EngineName } from "./models.ts"

export interface MouthConfig {
  /** "kokoro" (default, best quality) or "piper" (lighter, lower quality). */
  engine: EngineName
  /** Kokoro speaker (e.g. "bf_emma", "af_heart") or Piper voice (e.g. "en_GB-alba-medium"). */
  voice: string
  /** Speaking rate; 1 is the model's natural pace. */
  speed: number
  /** Character preset: "vera" (default), "dry", "robot+", or "plain". */
  preset: PresetName | (string & {})
  /** Fine-tune the preset; any field given here overrides it. */
  effects?: EffectsOverrides
  /** Playback volume, 0..1. */
  volume: number
  /** Where models live. Default ~/.vera/models. */
  modelsDir: string
  /** Download a missing model on first use. Default true. */
  autoDownload: boolean
  /** ONNX runtime threads for synthesis. */
  numThreads: number
  player: {
    /** ffplay executable. Default: found on PATH (scoop shims are resolved to the real exe). */
    command?: string
    /** Warm ffplay processes kept parked for instant starts. Default 2 (one for speech, one for chimes). */
    warm: number
  }
  /** Chime loudness, 0..1. */
  chimeVolume: number
  /** Diagnostics sink. Default: stderr. */
  log: (msg: string) => void
}

export const DEFAULT_CONFIG: MouthConfig = {
  engine: "kokoro",
  voice: "af_heart",
  speed: 1,
  preset: "vera",
  volume: 1,
  modelsDir: defaultModelsDir(),
  autoDownload: true,
  numThreads: Math.max(1, Math.min(6, Math.floor(cpus().length / 2))),
  player: { warm: 2 },
  chimeVolume: 0.5,
  log: (m) => process.stderr.write(`${m}\n`),
}

export function resolveConfig(partial: Partial<MouthConfig> = {}): MouthConfig {
  return {
    ...DEFAULT_CONFIG,
    ...stripUndefined(partial),
    player: { ...DEFAULT_CONFIG.player, ...stripUndefined(partial.player ?? {}) },
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

/** The "mouth" section of ~/.vera/config.json, if there is one. Used by the CLI; Core passes its own. */
export function loadUserMouthConfig(path = join(homedir(), ".vera", "config.json")): Partial<MouthConfig> {
  try {
    const json = JSON.parse(readFileSync(path, "utf8"))
    const m = json?.mouth
    return m && typeof m === "object" ? (m as Partial<MouthConfig>) : {}
  } catch {
    return {}
  }
}
