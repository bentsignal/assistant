// Voice models: where they come from, where they live, and how to fetch them.
// Models are downloaded to ~/.vera/models/ and never committed.

import { spawn } from "node:child_process"
import { createWriteStream, existsSync } from "node:fs"
import { mkdir, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

export type EngineName = "kokoro" | "piper"

export const RELEASE_BASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models"

export interface ModelPackage {
  /** Directory (and archive) name in the sherpa-onnx tts-models release. */
  name: string
  engine: EngineName
  approxMB: number
  /** Files that must exist for the package to count as installed. */
  required: string[]
}

export const KOKORO: ModelPackage = {
  name: "kokoro-multi-lang-v1_0",
  engine: "kokoro",
  approxMB: 350,
  required: ["model.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt", "lexicon-gb-en.txt", "espeak-ng-data"],
}

/** Kokoro v1.0 English speakers and their speaker ids. */
export const KOKORO_VOICES: Record<string, number> = {
  af_alloy: 0, af_aoede: 1, af_bella: 2, af_heart: 3, af_jessica: 4, af_kore: 5, af_nicole: 6,
  af_nova: 7, af_river: 8, af_sarah: 9, af_sky: 10, am_adam: 11, am_echo: 12, am_eric: 13,
  am_fenrir: 14, am_liam: 15, am_michael: 16, am_onyx: 17, am_puck: 18, am_santa: 19,
  bf_alice: 20, bf_emma: 21, bf_isabella: 22, bf_lily: 23, bm_daniel: 24, bm_fable: 25,
  bm_george: 26, bm_lewis: 27,
}

export function piperPackage(voice: string): ModelPackage {
  return { name: `vits-piper-${voice}`, engine: "piper", approxMB: 70, required: [`${voice}.onnx`, "tokens.txt", "espeak-ng-data"] }
}

export function packageFor(engine: EngineName, voice: string): ModelPackage {
  if (engine === "kokoro") {
    if (!(voice in KOKORO_VOICES)) throw new Error(`Unknown Kokoro voice "${voice}". Voices: ${Object.keys(KOKORO_VOICES).join(", ")}`)
    return KOKORO
  }
  return piperPackage(voice)
}

export function defaultModelsDir(): string {
  return join(homedir(), ".vera", "models")
}

export function isInstalled(modelsDir: string, pkg: ModelPackage): boolean {
  const dir = join(modelsDir, pkg.name)
  return pkg.required.every((f) => existsSync(join(dir, f)))
}

function tarCommand(): string {
  // Windows' bundled bsdtar handles .tar.bz2 and drive-letter paths; Git's GNU tar reads "C:" as a host.
  if (process.platform === "win32") {
    const sys = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    if (existsSync(sys)) return sys
  }
  return "tar"
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
    let err = ""
    p.stderr.on("data", (d) => (err += d))
    p.on("error", reject)
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim()}`))))
  })
}

export interface DownloadOptions {
  log?: (msg: string) => void
}

/** Download and unpack a model package if it isn't installed yet. Safe to call repeatedly. */
export async function ensureModel(modelsDir: string, pkg: ModelPackage, opts: DownloadOptions = {}): Promise<string> {
  const dir = join(modelsDir, pkg.name)
  if (isInstalled(modelsDir, pkg)) return dir
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`))
  await mkdir(modelsDir, { recursive: true })
  const url = `${RELEASE_BASE}/${pkg.name}.tar.bz2`
  const part = join(modelsDir, `${pkg.name}.tar.bz2.part`)
  const staging = join(modelsDir, `.staging-${pkg.name}-${process.pid}`)
  log(`[mouth] downloading ${pkg.name} (~${pkg.approxMB} MB) from ${url}`)
  const res = await fetch(url, { redirect: "follow" })
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`)
  const total = Number(res.headers.get("content-length") ?? 0)
  let got = 0
  let lastPct = -10
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream)
  body.on("data", (chunk: Buffer) => {
    got += chunk.length
    const pct = total ? Math.floor((got / total) * 100) : 0
    if (total && pct >= lastPct + 10) {
      lastPct = pct
      log(`[mouth]   ${pct}% (${(got / 1e6).toFixed(0)} of ${(total / 1e6).toFixed(0)} MB)`)
    }
  })
  await pipeline(body, createWriteStream(part))
  if (total && (await stat(part)).size !== total) throw new Error(`Download of ${pkg.name} was truncated`)
  log(`[mouth] unpacking ${pkg.name}`)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await run(tarCommand(), ["-xjf", part, "-C", staging])
    await rm(dir, { recursive: true, force: true })
    await rename(join(staging, pkg.name), dir)
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(part, { force: true })
  }
  if (!isInstalled(modelsDir, pkg)) throw new Error(`${pkg.name} unpacked but is missing files: ${pkg.required.join(", ")}`)
  log(`[mouth] installed ${pkg.name} in ${dir}`)
  return dir
}
