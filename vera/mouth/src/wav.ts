import { writeFile } from "node:fs/promises"
import { toPcm16 } from "./player.ts"

/** 16-bit mono PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const data = toPcm16(samples)
  const h = Buffer.alloc(44)
  h.write("RIFF", 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write("WAVE", 8)
  h.write("fmt ", 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write("data", 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

export async function writeWav(path: string, samples: Float32Array, sampleRate: number): Promise<void> {
  await writeFile(path, encodeWav(samples, sampleRate))
}

/** Decode a mono (or first channel of) 16-bit PCM or 32-bit float WAV. */
export function decodeWav(b: Buffer): { samples: Float32Array; sampleRate: number } {
  let o = 12
  let sampleRate = 0
  let format = 1
  let channels = 1
  let bits = 16
  let data: Buffer | undefined
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4)
    const size = b.readUInt32LE(o + 4)
    if (id === "fmt ") {
      format = b.readUInt16LE(o + 8)
      channels = b.readUInt16LE(o + 10)
      sampleRate = b.readUInt32LE(o + 12)
      bits = b.readUInt16LE(o + 22)
    } else if (id === "data") data = b.subarray(o + 8, o + 8 + size)
    o += 8 + size + (size & 1)
  }
  if (!data) throw new Error("WAV has no data chunk")
  const frame = (bits / 8) * channels
  const n = Math.floor(data.length / frame)
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const at = i * frame
    samples[i] = format === 3 || bits === 32 ? data.readFloatLE(at) : data.readInt16LE(at) / 32768
  }
  return { samples, sampleRate }
}
