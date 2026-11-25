// A stand-in voice service (DESIGN.md, "Voice service contract"): answers
// /v1/health and /v1/voices on 127.0.0.1:<port> and streams silence from
// /v1/speech, so assistant.exe's supervision and Settings' voice list can be
// tried without the real service. No dependencies.
import { createServer } from "node:http"

const flag = process.argv.indexOf("--port")
const port = Number(flag > 0 ? process.argv[flag + 1] : process.env.ASSISTANT_VOICE_PORT ?? 7314)
const voices = [
  { id: "af_heart", name: "Heart" },
  { id: "af_sky", name: "Sky" },
  { id: "bf_emma", name: "Emma" },
]

createServer((request, response) => {
  if (request.url === "/v1/health") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ ready: true, voice: "af_heart", sample_rate: 24000 }))
  } else if (request.url === "/v1/voices") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ voices }))
  } else if (request.url === "/v1/speech" && request.method === "POST") {
    response.writeHead(200, { "content-type": "application/octet-stream", "x-sample-rate": "24000" })
    response.end(Buffer.alloc(24000 * 4))
  } else {
    response.writeHead(404)
    response.end()
  }
}).listen(port, "127.0.0.1", () => process.stderr.write(`[fake-voice] listening on ${port}\n`))
