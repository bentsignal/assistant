import { test } from "node:test"
import assert from "node:assert/strict"
import { describeVoices, parseVoices, pickVoice } from "../src/voices.ts"

const body = {
  default: "isla",
  voices: [
    { id: "isla", name: "Isla", gender: "female", available: true },
    { id: "eli", name: "Eli", gender: "male" },
    { id: "gone", name: "Gone", available: false },
    { id: "nora", name: "Nora" },
  ],
}

test("only voices that can run here are listed", () => {
  const list = parseVoices(body)
  assert.equal(list.default, "isla")
  assert.deepEqual(
    list.voices.map((v) => v.id),
    ["isla", "eli", "nora"],
  )
  assert.deepEqual(parseVoices(["a", "b"]).voices.map((v) => v.id), ["a", "b"])
})

test("a voice by name or id in any case, or next/previous around the list", () => {
  const { voices } = parseVoices(body)
  assert.equal(pickVoice(voices, "ELI").id, "eli")
  assert.equal(pickVoice(voices, "the Nora voice").id, "nora")
  assert.equal(pickVoice(voices, "next", "isla").id, "eli")
  assert.equal(pickVoice(voices, "next", "nora").id, "isla")
  assert.equal(pickVoice(voices, "previous", "isla").id, "nora")
  assert.equal(pickVoice(voices, "next", undefined).id, "isla")
  assert.throws(() => pickVoice(voices, "gone"), /no voice called/)
  assert.match(describeVoices(voices, "eli"), /^\* Eli/m)
})
