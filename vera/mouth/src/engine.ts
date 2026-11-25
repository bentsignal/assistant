// The neural TTS engine: sherpa-onnx running Kokoro (default) or a Piper voice on the CPU.
//
// sherpa-onnx-node is pinned to 1.13.x: 2.x removed the built-in espeak-ng
// phonemizer, and its Kokoro silently skips every word missing from the
// lexicon (including "Vera").

import sherpa, { type OfflineTts } from "sherpa-onnx-node"
import { join } from "node:path"
import { KOKORO_VOICES, type EngineName, type ModelPackage } from "./models.ts"
import { medianF0, trackPitch } from "./dsp/pitch.ts"

export interface EngineOptions {
  engine: EngineName
  voice: string
  modelDir: string
  pkg: ModelPackage
  numThreads: number
  speed: number
}

export class TtsEngine {
  readonly sampleRate: number
  readonly voice: string
  /** The voice's typical pitch, measured once at load: the target for pitch flattening. */
  pitchHz = 0
  private tts: OfflineTts
  private sid: number
  private speed: number
  private queue: Promise<unknown> = Promise.resolve()

  private constructor(tts: OfflineTts, sid: number, voice: string, speed: number) {
    this.tts = tts
    this.sid = sid
    this.voice = voice
    this.speed = speed
    this.sampleRate = tts.sampleRate
  }

  static async load(o: EngineOptions): Promise<TtsEngine> {
    const d = o.modelDir
    let config: unknown
    let sid = 0
    if (o.engine === "kokoro") {
      sid = KOKORO_VOICES[o.voice]
      const british = o.voice.startsWith("b")
      config = {
        model: {
          kokoro: {
            model: join(d, "model.onnx"),
            voices: join(d, "voices.bin"),
            tokens: join(d, "tokens.txt"),
            lexicon: join(d, british ? "lexicon-gb-en.txt" : "lexicon-us-en.txt"),
            dataDir: join(d, "espeak-ng-data"),
            // espeak-ng names British English "en" (lang/gmw/en); "en-gb" fails to load.
            ...(british ? { lang: "en" } : {}),
          },
          numThreads: o.numThreads,
          debug: false,
        },
        maxNumSentences: 1,
      }
    } else {
      config = {
        model: {
          vits: {
            model: join(d, `${o.voice}.onnx`),
            tokens: join(d, "tokens.txt"),
            dataDir: join(d, "espeak-ng-data"),
            noiseScale: 0.5,
            noiseScaleW: 0.6,
          },
          numThreads: o.numThreads,
          debug: false,
        },
        maxNumSentences: 1,
      }
    }
    const tts = await sherpa.OfflineTts.createAsync(config)
    const engine = new TtsEngine(tts, sid, o.voice, o.speed)
    // Warm the graph and learn the voice's pitch in one go.
    const cal = await engine.synthesize("Hello there. This is a short calibration sentence for the voice.")
    engine.pitchHz = medianF0(trackPitch(cal, engine.sampleRate))
    return engine
  }

  /** Synthesize one chunk. Calls are serialized: the native handle runs one job at a time. */
  synthesize(text: string): Promise<Float32Array> {
    const job = this.queue.then(async () => {
      const audio = await this.tts.generateAsync({ text, sid: this.sid, speed: this.speed })
      return audio.samples
    })
    this.queue = job.catch(() => undefined)
    return job
  }
}
