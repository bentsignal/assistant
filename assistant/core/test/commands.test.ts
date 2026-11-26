/**
 * run_command's runs (commands.ts) and his talking never breaking running
 * work: a barge-in during a tool lets it finish and delivers his words next.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { CommandRuns, describeRun } from "../src/commands.ts"
import { isInteractive, parseSkill } from "../src/skills.ts"
import { FakeApp, sleep, testConfig, type Cmd } from "../scripts/fake-app.ts"

const later = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms))

test("a failure reports its stderr first, with the exit code; success its output", () => {
  const failed = describeRun({ code: 1, stdout: "Opening browser...", stderr: "error: token exchange failed: invalid_grant", timedOut: false }, "free-mail")
  assert.match(failed, /^Failed with exit 1 \(free-mail\)\.\n\[stderr\]\nerror: token exchange failed: invalid_grant\n\[stdout\]\nOpening browser/)
  assert.match(describeRun({ code: null, stdout: "", stderr: "", timedOut: true }, "x", 900_000), /^Timed out after 900 s and was stopped .*\n\(nothing on stderr\)/)
  assert.equal(describeRun({ code: 0, stdout: "3 unread\n", stderr: "", timedOut: false }, "free-mail"), "Exit 0 (free-mail).\n3 unread")
})

test("a skill marks interactive command lines by prefix, or all of them", () => {
  const s = parseSkill("---\nname: free-mail\ndescription: d\ncommands: freemail\ninteractive: freemail auth login\n---\nbody", "f.md")
  assert.deepEqual(s.interactive, ["freemail auth login"])
  assert.ok(isInteractive(s, ["freemail", "auth", "login"]))
  assert.ok(isInteractive(s, ["C:\\bin\\freemail.exe", "auth", "login", "--browser"]))
  assert.ok(!isInteractive(s, ["freemail", "list"]))
  assert.ok(isInteractive(parseSkill("---\nname: a\ncommands: a\ninteractive: true\n---\nb", "a.md"), ["a", "x"]))
  assert.equal(parseSkill("---\nname: a\ncommands: a\n---\nb", "a.md").interactive, undefined)
})

test("a detached run keeps going and reports its result when it ends; a quick one doesn't report", async () => {
  const reports: string[] = []
  const runs = new CommandRuns((run, text) => reports.push(`${run.id} ${text}`))
  const quick = runs.start("echo hi", "s", false, async () => ({ code: 0, stdout: "hi", stderr: "", timedOut: false }))
  assert.equal((await runs.wait(quick, 1000))?.stdout, "hi")
  const slow = runs.start("sleep", "s", false, async (onData) => {
    onData("working...\n")
    return later(150, { code: 0, stdout: "working...\nslept", stderr: "", timedOut: false })
  })
  assert.equal(await runs.wait(slow, 20), null)
  assert.ok(slow.detached)
  assert.equal(slow.output, "working...\n")
  assert.deepEqual(runs.running().map((r) => r.id), [slow.id])
  await slow.done
  assert.deepEqual(reports, [`${slow.id} Exit 0 (s).\nworking...\nslept`])
})

test("a run whose turn is gone (cancelled, stopped) still reports when it finishes", async () => {
  const reports: string[] = []
  const runs = new CommandRuns((_run, text) => reports.push(text))
  let turn = 1
  const run = runs.start("login", "s", true, () => later(50, { code: 2, stdout: "", stderr: "denied", timedOut: false }), { reportIf: () => turn !== 1 })
  turn = 2 // the brain's request was cancelled and the turn ended
  await run.done
  assert.equal(reports.length, 1)
  assert.match(reports[0], /Failed with exit 2.*\n\[stderr\]\ndenied/)
})

const speaks = (cmds: Cmd[]) => cmds.filter((c) => c.cmd === "speak").map((c) => c.text as string)

/** A skill that lets run_command run this Node, so a test can run a slow script. */
function nodeSkill(home: string) {
  mkdirSync(join(home, "skills"), { recursive: true })
  writeFileSync(join(home, "skills", "slow-node.md"), `---\nname: slow-node\ndescription: Test helper.\ncommands: ${process.execPath}\n---\nRuns node.\n`)
}
const sleeper = (ms: number, word: string) => ({ argv: [process.execPath, "-e", `setTimeout(() => console.log(${JSON.stringify(word)}), ${ms})`] })

test("barge-in during a running tool stops her speech, not the tool: it finishes and his words are the next message (a brain that can't steer)", async () => {
  // A Claude-style brain takes his words into the running turn instead (bargetools.test.ts).
  const rules = [
    { match: "While he was talking", steps: [{ tool: "speak", args: { text: "Got both." } }] },
    {
      match: "slow thing",
      steps: [
        { tool: "speak", args: { text: "Running it now, this takes a moment or two." } },
        { tool: "run_command", args: sleeper(2500, "slept-ok") },
        { tool: "speak", args: { text: "It slept." } },
      ],
    },
  ]
  const script = { steer: false, rules }
  const app = await FakeApp.start({ config: testConfig(), script, msPerChar: 60 })
  try {
    nodeSkill(app.home)
    app.send({ type: "ready", mic: "m" })
    const m = app.mark
    await app.say("Hey Vera, run the slow thing.")
    await app.waitFor((c) => c.cmd === "speak", 5000, m)
    for (let i = 0; i < 50 && !/tool run_command \{/.test(app.stderr); i++) await sleep(50)
    await sleep(600) // the command is running and her line is playing
    app.bargeIn()
    await app.say("and also tell me the time", { duringPlayback: true, skipStart: true })
    await app.waitFor((c) => c.cmd === "speak" && c.text === "Got both.", 15_000, m)
    assert.match(app.stderr, /still running, so the brain stops once it returns/)
    assert.match(app.stderr, /tool run_command -> Exit 0 \(slow-node\)\. slept-ok/)
    assert.ok(!speaks(app.since(m)).includes("It slept."), "nothing more from the turn he talked over")
    const told = app.brainLog().at(-1) ?? ""
    assert.match(told, /run_command finished and returned: "Exit 0 \(slow-node\)\. slept-ok"/)
    assert.match(told, /tell me the time/)
  } finally {
    await app.stop()
  }
})

test("a command still running at the detach threshold goes on after the turn, and its result chimes into the inbox", async () => {
  const script = [{ match: "long command", steps: [{ tool: "run_command", args: sleeper(2000, "long-done") }, { tool: "speak", args: { text: "It's running." } }] }]
  const app = await FakeApp.start({ config: testConfig({ jobs: { commandDetachSeconds: 1 } }), script })
  try {
    nodeSkill(app.home)
    app.send({ type: "ready", mic: "m" })
    const m = app.mark
    await app.say("Hey Vera, run the long command.")
    await app.waitFor((c) => c.cmd === "speak" && c.text === "It's running.", 8000, m)
    assert.match(app.stderr, /tool run_command -> .*\(c1\) is still running after 1 s/)
    await app.waitFor((c) => c.cmd === "chime" && (c as any).kind === "notify", 8000, m)
    assert.match(app.stderr, /inbox: Command "[^"]+" finished \[c1\]/)
    const state = await app.state()
    assert.match(JSON.stringify(state.inbox ?? state), /long-done/)
  } finally {
    await app.stop()
  }
})
