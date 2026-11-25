// A fake background agent for tests: reads the task on stdin, waits, and
// prints a Claude Code stream-json result. Usage in config.json:
//   "jobs": { "claude": { "command": ["node", "<path>/scripts/fake-job.mjs", "1500"] } }
let task = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (d) => (task += d))
process.stdin.on("end", () => {
  const ms = Number(process.argv[2] ?? 1000)
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake" }) + "\n")
    process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: `Fake result for: ${task.trim()}` }) + "\n")
  }, ms)
})
