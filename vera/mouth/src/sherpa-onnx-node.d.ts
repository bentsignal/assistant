// Minimal typings for the parts of sherpa-onnx-node 1.13 that Mouth uses.
declare module "sherpa-onnx-node" {
  export interface GeneratedAudio {
    samples: Float32Array
    sampleRate: number
  }
  export interface TtsRequest {
    text: string
    sid: number
    speed: number
    enableExternalBuffer?: boolean
    onProgress?: (info: { samples: Float32Array; progress: number }) => number | boolean | void
  }
  export class OfflineTts {
    constructor(config: unknown)
    static createAsync(config: unknown): Promise<OfflineTts>
    readonly numSpeakers: number
    readonly sampleRate: number
    generate(req: TtsRequest): GeneratedAudio
    generateAsync(req: TtsRequest): Promise<GeneratedAudio>
  }
  const sherpa: { OfflineTts: typeof OfflineTts; version?: string }
  export default sherpa
}
