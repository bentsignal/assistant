// pnpm --filter @vera/mouth bench
// Synthesis latency and real-time factor for short and medium sentences, sync vs async, per thread count.

import sherpa from "sherpa-onnx-node"
import { join } from "node:path"
import { defaultModelsDir, KOKORO, KOKORO_VOICES } from "../src/models.ts"

const voice = process.argv[2] ?? "af_heart"
const d = join(defaultModelsDir(), KOKORO.name)
const texts = ["On it.", "Okay, done.", "I've asked Codex to check the build.", "On it. I've asked Codex to check the build. I'll ping you when it's done."]
for (const threads of [2, 4, 6, 8]) {
  const tts = new sherpa.OfflineTts({
    model: { kokoro: { model: join(d, "model.onnx"), voices: join(d, "voices.bin"), tokens: join(d, "tokens.txt"), lexicon: join(d, "lexicon-us-en.txt"), dataDir: join(d, "espeak-ng-data") }, numThreads: threads },
    maxNumSentences: 1,
  })
  const sid = KOKORO_VOICES[voice]
  tts.generate({ text: "Warm up the graph.", sid, speed: 1 })
  const row: string[] = []
  for (const text of texts) {
    const runs: number[] = []
    let dur = 0
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      const a = await tts.generateAsync({ text, sid, speed: 1 })
      runs.push(performance.now() - t0)
      dur = a.samples.length / a.sampleRate
    }
    runs.sort((a, b) => a - b)
    row.push(`"${text.slice(0, 18)}" ${runs[1].toFixed(0)}ms/${dur.toFixed(2)}s rtf ${(runs[1] / 1000 / dur).toFixed(2)}`)
  }
  console.log(`threads ${threads}: ${row.join(" | ")}`)
}
