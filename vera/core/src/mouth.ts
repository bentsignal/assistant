import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { WORKSPACE_DIR, paths, type VeraConfig } from "./config.ts"
import { killTree, onLines } from "./proc.ts"

/** The Mouth contract from VERA.md. @vera/mouth implements it. */
export interface Mouth {
  speak(text: string): Promise<void>
  stop(): void
  readonly speaking: boolean
  on(event: "start" | "end", cb: () => void): () => void
  chime(kind: ChimeKind): Promise<void>
  close(): Promise<void>
}
export type ChimeKind = "notify" | "listening" | "done" | "error"

class Emitter {
  private l = { start: new Set<() => void>(), end: new Set<() => void>() }
  on(event: "start" | "end", cb: () => void) {
    this.l[event].add(cb)
    return () => this.l[event].delete(cb)
  }
  emit(event: "start" | "end") {
    for (const cb of this.l[event]) cb()
  }
}

/** Logs only. */
export class StubMouth extends Emitter implements Mouth {
  speaking = false
  async speak(text: string) {
    this.speaking = true
    this.emit("start")
    console.log(`[mouth] 🗣  ${text}`)
    // Roughly how long it would take to say, capped, so half-duplex timing is realistic-ish.
    await new Promise((r) => setTimeout(r, Math.min(3000, 200 + text.length * 15)))
    this.speaking = false
    this.emit("end")
  }
  stop() {
    if (this.speaking) {
      this.speaking = false
      this.emit("end")
    }
  }
  async chime(kind: ChimeKind) {
    console.log(`[mouth] 🔔 ${kind}`)
  }
  async close() {}
}

/**
 * Windows SAPI through one persistent PowerShell, so it's audible before
 * @vera/mouth lands. Speech is serialized; stop() kills the speaker and a new
 * one starts on the next call. Chimes are small sine WAVs we generate.
 */
export class SapiMouth extends Emitter implements Mouth {
  speaking = false
  private ps: ChildProcess | null = null
  private pending: (() => void) | null = null
  private queue: Promise<void> = Promise.resolve()
  private generation = 0

  private shell(): ChildProcess {
    if (this.ps && this.ps.exitCode === null) return this.ps
    const script = [
      "Add-Type -AssemblyName System.Speech",
      "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$s.Rate = 1",
      "try { $v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Name -match 'Zira|Aria|Jenny' } | Select-Object -First 1; if ($v) { $s.SelectVoice($v.VoiceInfo.Name) } } catch {}",
      "[Console]::Out.WriteLine('ready')",
      "while ($true) { $line = [Console]::In.ReadLine(); if ($line -eq $null) { break }",
      "  $m = $line | ConvertFrom-Json",
      "  try { if ($m.cmd -eq 'speak') { $s.Speak([string]$m.text) } elseif ($m.cmd -eq 'wav') { (New-Object System.Media.SoundPlayer $m.path).PlaySync() } } catch {}",
      "  [Console]::Out.WriteLine('done') }",
    ].join("\n")
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    ps.stdin!.write(script.replace(/\n/g, "\r\n") + "\r\n")
    onLines(ps.stdout!, (line) => {
      if (line.trim() === "done") {
        const p = this.pending
        this.pending = null
        p?.()
      }
    })
    ps.stderr!.on("data", () => {})
    ps.on("exit", () => {
      const p = this.pending
      this.pending = null
      p?.()
    })
    this.ps = ps
    return ps
  }

  private send(msg: object): Promise<void> {
    return new Promise((resolve) => {
      this.pending = resolve
      this.shell().stdin!.write(JSON.stringify(msg) + "\r\n")
    })
  }

  speak(text: string): Promise<void> {
    const gen = this.generation
    const run = async () => {
      if (gen !== this.generation) return
      this.speaking = true
      this.emit("start")
      await this.send({ cmd: "speak", text })
      if (gen === this.generation) {
        this.speaking = false
        this.emit("end")
      }
    }
    this.queue = this.queue.then(run, run)
    return this.queue
  }

  stop() {
    this.generation++
    if (this.ps) {
      killTree(this.ps)
      this.ps = null
    }
    if (this.speaking) {
      this.speaking = false
      this.emit("end")
    }
  }

  async chime(kind: ChimeKind) {
    const file = ensureChime(kind)
    // Chimes go on their own short-lived player so they never wait behind speech.
    await new Promise<void>((resolve) => {
      const p = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", `(New-Object System.Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync()`],
        { stdio: "ignore", windowsHide: true },
      )
      p.on("exit", () => resolve())
      p.on("error", () => resolve())
    })
  }

  async close() {
    this.stop()
  }
}

const CHIMES: Record<ChimeKind, [number, number][]> = {
  notify: [
    [880, 0.12],
    [1318.5, 0.22],
  ],
  listening: [[660, 0.1]],
  done: [
    [1046.5, 0.1],
    [784, 0.16],
  ],
  error: [
    [330, 0.18],
    [262, 0.25],
  ],
}

/** Write a soft two-note sine chime as a 16-bit mono WAV. */
export function ensureChime(kind: ChimeKind): string {
  const file = join(paths.sounds, `${kind}.wav`)
  if (existsSync(file)) return file
  const rate = 22050
  const samples: number[] = []
  for (const [freq, dur] of CHIMES[kind]) {
    const n = Math.floor(rate * dur)
    for (let i = 0; i < n; i++) {
      const t = i / rate
      const env = Math.min(1, i / (rate * 0.005)) * Math.exp(-4 * (i / n))
      samples.push(0.35 * env * (Math.sin(2 * Math.PI * freq * t) + 0.25 * Math.sin(4 * Math.PI * freq * t)))
    }
  }
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-1, Math.min(1, s)) * 32767, i * 2))
  const h = Buffer.alloc(44)
  h.write("RIFF", 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write("WAVEfmt ", 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write("data", 36)
  h.writeUInt32LE(data.length, 40)
  writeFileSync(file, Buffer.concat([h, data]))
  return file
}

/** Find @vera/mouth: as a dependency, else the sibling workspace package. */
async function importMouthPackage(): Promise<any> {
  try {
    return await import("@vera/mouth" as string)
  } catch {}
  const dir = join(WORKSPACE_DIR, "mouth")
  const pkgFile = join(dir, "package.json")
  if (!existsSync(pkgFile)) throw new Error("@vera/mouth isn't installed")
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"))
  const exp = pkg.exports
  const entry =
    (typeof exp === "string" ? exp : exp?.["."]?.import ?? exp?.["."]?.default ?? exp?.["."]) ?? pkg.module ?? pkg.main ?? "src/index.ts"
  return import(pathToFileURL(join(dir, typeof entry === "string" ? entry : "src/index.ts")).href)
}

export async function createMouth(config: VeraConfig["mouth"]): Promise<{ mouth: Mouth; name: string }> {
  const want = config.module
  if (want === "@vera/mouth" || want === "auto") {
    try {
      const mod = await importMouthPackage()
      const mouth: Mouth = await mod.createMouth(config.options ?? {})
      return { mouth, name: "@vera/mouth" }
    } catch (err) {
      if (want === "@vera/mouth") throw err
      console.error(`[mouth] @vera/mouth unavailable (${(err as Error).message}); using ${process.platform === "win32" ? "SAPI" : "stub"}`)
    }
  }
  if ((want === "sapi" || want === "auto") && process.platform === "win32") return { mouth: new SapiMouth(), name: "sapi" }
  return { mouth: new StubMouth(), name: "stub" }
}
