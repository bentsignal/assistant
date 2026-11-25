import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeForSpeech as n, speakPath } from "../src/text/normalize.ts"
import { splitForSpeech, splitSentences } from "../src/text/split.ts"
import { intToWords, ordinalToWords, timeToWords, yearToWords, moneyToWords } from "../src/text/numbers.ts"

test("numbers read as words", () => {
  assert.equal(intToWords(0), "zero")
  assert.equal(intToWords(42), "forty-two")
  assert.equal(intToWords(1234), "one thousand two hundred thirty-four")
  assert.equal(intToWords(-7), "minus seven")
  assert.equal(intToWords(3_000_000), "three million")
  assert.equal(ordinalToWords(1), "first")
  assert.equal(ordinalToWords(21), "twenty-first")
  assert.equal(ordinalToWords(12), "twelfth")
  assert.equal(yearToWords(2026), "twenty twenty-six")
  assert.equal(yearToWords(2005), "two thousand five")
  assert.equal(yearToWords(1999), "nineteen ninety-nine")
  assert.equal(timeToWords(3, 5), "three oh five")
  assert.equal(timeToWords(10, 0), "ten o'clock")
  assert.equal(moneyToWords("$", "5.20"), "five dollars and twenty cents")
  assert.equal(moneyToWords("$", "1"), "one dollar")
})

test("markdown is stripped and code fences are never read", () => {
  const out = n("# Status\n- **Build**: passing\n- Tests: 42/45\n\n```ts\nconst secret = 1\n```\nDone!")
  assert.doesNotMatch(out, /[#*`]/)
  assert.doesNotMatch(out, /secret|const/)
  assert.match(out, /Status\./)
  assert.match(out, /Build: passing\./)
  assert.match(out, /forty-two out of forty-five/)
  assert.match(out, /Done!$/)
})

test("links become 'a link', markdown links keep their text", () => {
  assert.equal(n("See https://github.com/anomalyco/hex/pull/2785 for details."), "See a link for details.")
  assert.equal(n("Read [the design doc](https://example.com/x) first."), "Read the design doc first.")
  assert.equal(n("Check www.example.com now."), "Check a link now.")
})

test("file paths and identifiers read sensibly", () => {
  assert.equal(speakPath("src/dictation/audio.rs"), "audio dot R S in dictation")
  assert.equal(speakPath("C:\\Users\\shawn\\.vera\\config.json"), "config dot jason in dot vera")
  assert.equal(speakPath("~/notes.md"), "notes dot M D in your home folder")
  assert.equal(n("I changed `createMouth()` in `src/mouth.ts`."), "I changed create Mouth in mouth dot T S in src.")
  assert.equal(n("Set TTS_ENGINE in package.json."), "Set T T S engine in package dot jason.")
  assert.equal(n("Install @vera/mouth."), "Install at vera slash mouth.")
})

test("times, money, percents, units, versions", () => {
  assert.equal(n("It's 3:45pm. Lunch at 12:30."), "It's three forty-five P M. Lunch at twelve thirty.")
  assert.equal(n("It costs $5.20, 15% more."), "It costs five dollars and twenty cents, fifteen percent more.")
  assert.equal(n("Latency was 250ms and it used 2.5 GB."), "Latency was two hundred fifty milliseconds and it used two point five gigabytes.")
  assert.equal(n("Released v1.13.8 on the 21st."), "Released version one point thirteen point eight on the twenty-first.")
  assert.equal(n("Wait 5m please."), "Wait five minutes please.")
  assert.equal(n("See #123."), "See number one hundred twenty-three.")
})

test("acronyms are spelled unless they're words", () => {
  assert.equal(n("The CLI and API are ready."), "The C L I and A P I are ready.")
  assert.equal(n("Three PRs merged."), "Three P R's merged.")
  assert.equal(n("NASA uses JSON."), "nasa uses jason.")
  assert.equal(n("This is VERY important."), "This is very important.")
  assert.equal(n("Shawn's T3 thread."), "Shawn's T three thread.")
})

test("plain speech passes through unchanged", () => {
  const s = "On it. I've asked Codex to check the build. I'll ping you when it's done."
  assert.equal(n(s), s)
  assert.equal(n("Hi there, how are you?"), "Hi there, how are you?")
})

test("emoji and stray symbols disappear", () => {
  assert.equal(n("Done ✅ 🎉"), "Done")
  assert.equal(n("A -> B and x != y"), "A to B and x is not y")
})

test("sentence splitting keeps terminators and ignores lowercase continuations", () => {
  assert.deepEqual(splitSentences("On it. I've asked Codex. Done!"), ["On it.", "I've asked Codex.", "Done!"])
  assert.deepEqual(splitSentences("Is it ready? Yes."), ["Is it ready?", "Yes."])
  assert.deepEqual(splitSentences("No terminator at the end"), ["No terminator at the end"])
  assert.deepEqual(splitSentences("It was ten A M. tomorrow it moves."), ["It was ten A M. tomorrow it moves."])
})

test("chunks carry pauses, and the last one has none", () => {
  const chunks = splitForSpeech("On it. I've asked Codex to check the build. Ready?\nNext paragraph.")
  assert.deepEqual(chunks.map((c) => c.text), ["On it.", "I've asked Codex to check the build.", "Ready?", "Next paragraph."])
  assert.ok(chunks[0].pauseMs > 0)
  assert.ok(chunks[2].pauseMs > chunks[1].pauseMs, "paragraph pause is longer")
  assert.equal(chunks.at(-1)!.pauseMs, 0)
})

test("a long first sentence is split at a clause so audio starts sooner", () => {
  const chunks = splitForSpeech("I looked at the build output, and the failure is in the audio module where the stream closes early.")
  assert.equal(chunks[0].text, "I looked at the build output,")
  assert.ok(chunks.length >= 2)
})

test("very long sentences are broken into bounded chunks", () => {
  const long = Array.from({ length: 6 }, (_, i) => `clause number ${i} has a handful of words in it`).join(", ") + "."
  for (const c of splitForSpeech(long)) assert.ok(c.text.split(/\s+/).length <= 26, c.text)
})

test("empty and whitespace-only input yields nothing to say", () => {
  assert.deepEqual(splitForSpeech(n("   ")), [])
  assert.deepEqual(splitForSpeech(n("```\ncode only\n```")), [])
})
