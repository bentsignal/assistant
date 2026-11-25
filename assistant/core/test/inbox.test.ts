import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Inbox } from "../src/inbox.ts"

test("digest includes only undelivered items, once", () => {
  const inbox = new Inbox(null)
  assert.equal(inbox.takeDigest(), "")
  inbox.add({ kind: "job", title: "grok job j1 finished", summary: "People on X like the new release." })
  inbox.add({ kind: "t3", title: 'T3 "fix tests" needs your input', summary: "Should I delete the snapshot?", ref: "t-1" })
  const d = inbox.takeDigest()
  assert.match(d, /2 new items/)
  assert.match(d, /\[i1\] grok job j1 finished/)
  assert.match(d, /\[i2\].*Should I delete the snapshot\?/)
  assert.match(d, /Don't bring these up unless he asks/)
  assert.equal(inbox.takeDigest(), "", "already delivered")
  inbox.add({ kind: "job", title: "claude job j2 finished", summary: "done" })
  assert.match(inbox.takeDigest(), /1 new item arrived/)
})

test("delivered is not read; markRead marks both", () => {
  const inbox = new Inbox(null)
  const a = inbox.add({ kind: "job", title: "a", summary: "x" })
  inbox.add({ kind: "job", title: "b", summary: "y" })
  inbox.takeDigest()
  assert.equal(inbox.unread().length, 2)
  assert.equal(inbox.markRead([a.id]), 1)
  assert.deepEqual(
    inbox.unread().map((i) => i.title),
    ["b"],
  )
  assert.equal(inbox.markRead(), 1)
  assert.equal(inbox.unread().length, 0)
})

test("long summaries are truncated in the digest", () => {
  const inbox = new Inbox(null)
  inbox.add({ kind: "job", title: "big", summary: "word ".repeat(2000) })
  const d = inbox.takeDigest(400)
  assert.ok(d.length < 700, `digest is ${d.length} chars`)
  assert.match(d, /…/)
})

test("persists and reloads with ids continuing", () => {
  const dir = mkdtempSync(join(tmpdir(), "assistant-inbox-"))
  const file = join(dir, "inbox.json")
  const one = new Inbox(file)
  one.add({ kind: "system", title: "hello", summary: "world" })
  one.add({ kind: "system", title: "second", summary: "!" })
  assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 2)
  const two = new Inbox(file)
  assert.equal(two.items.length, 2)
  assert.equal(two.add({ kind: "system", title: "third", summary: "" }).id, "i3")
})

test("keeps at most the limit", () => {
  const inbox = new Inbox(null, 3)
  for (let i = 0; i < 5; i++) inbox.add({ kind: "job", title: `t${i}`, summary: "" })
  assert.deepEqual(
    inbox.items.map((i) => i.title),
    ["t2", "t3", "t4"],
  )
})

import { cleanResult } from "../src/jobs.ts"

test("job results drop a leading plan", () => {
  const text = "I'll look through posts from the past week.\n\nThe first pass is mostly complaints. I'll pull a few more posts.\n\nPast week on X: mostly reliability talk."
  assert.equal(cleanResult(text), "Past week on X: mostly reliability talk.")
  assert.equal(cleanResult("Paris."), "Paris.")
  assert.equal(cleanResult("I'll do it.\n\n"), "I'll do it.")
})
