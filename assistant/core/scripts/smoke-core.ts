/**
 * Hosts this checkout's Core for scripts/assistant-soak/smoke-brain.mjs on a
 * machine without assistant.exe: a FakeApp (simulated playback) and the real
 * Claude brain, in a throwaway ASSISTANT_HOME that it prints and keeps.
 *
 *   node --import tsx scripts/smoke-core.ts      # then: smoke-brain.mjs --home <printed> --skip-voice
 */
import { FakeApp } from "./fake-app.ts"

const app = await FakeApp.start({
  config: {
    brain: { harness: "claude-code", "claude-code": { model: "sonnet", effort: "low" } },
    t3: { pollSeconds: 5 }, // the T3 steps watch a thread to its finish
    voice: { defaultVolume: 0 },
  },
  msPerChar: 10,
  startMs: 50,
})
console.log(`HOME ${app.home}`)
const stop = async () => {
  await app.stop(true)
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
setInterval(() => {}, 60_000)
