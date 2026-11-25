// Spawned by the playback test: start speaking, report ffplay pids, then wait to be killed.
import { createMouth } from "../../src/mouth.ts"
import { livePids } from "../../src/player.ts"

const mouth = await createMouth({ log: () => {} })
void mouth.speak("This is a long sentence that keeps going so that it is still playing when the parent process is killed without warning.")
mouth.on("start", () => {
  setTimeout(() => process.stdout.write(JSON.stringify({ pids: livePids() }) + "\n"), 200)
})
setInterval(() => {}, 1000)
