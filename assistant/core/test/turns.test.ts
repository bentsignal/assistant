import { test } from "node:test"
import assert from "node:assert/strict"
import { continues, joinTurns, RESUME_FINAL_MS, type Resumable } from "../src/turns.ts"

const resume: Resumable = { turnId: 3, text: "check the build and.", why: "thinking", at: 1_000 }

test("only an unaddressed follow-up continues the turn he was cut off in", () => {
  assert.equal(continues(resume, { action: "turn", text: "run the tests", via: "followup" }, 2_000), true)
  assert.equal(continues(resume, { action: "turn", text: "tell me a joke", via: "wake" }, 2_000), false)
  assert.equal(continues(resume, { action: "ignore", reason: "no wake word" }, 2_000), false)
  assert.equal(continues(resume, { action: "turn", text: "x", via: "followup" }, 1_000 + RESUME_FINAL_MS + 1), false)
  assert.equal(continues(null, { action: "turn", text: "x", via: "followup" }, 2_000), false)
})

test("joined parts read as one message", () => {
  assert.equal(joinTurns("Check the build and.", "Run the tests."), "Check the build and run the tests.")
  assert.equal(joinTurns("Check the build.", "And the tests."), "Check the build and the tests.")
  assert.equal(joinTurns("What's on today?", "Also the weather."), "What's on today? Also the weather.")
  assert.equal(joinTurns("Tell me about the.", "I mean Alps."), "Tell me about the I mean Alps.")
  assert.equal(joinTurns("Okay.", "I think so."), "Okay. I think so.")
  assert.equal(joinTurns("", "Hello."), "Hello.")
})
