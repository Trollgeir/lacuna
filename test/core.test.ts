import assert from "node:assert/strict"
import { test } from "node:test"
import { calibrate, DEFAULT_CALIBRATION } from "../src/core/calibration.ts"
import { addNudge, nudgeThreshold } from "../src/core/prompt.ts"
import { render, stripEchoedTags } from "../src/core/render.ts"
import { search } from "../src/core/search.ts"
import { archive, assignRefs, refsOf, restore } from "../src/core/state.ts"
import { detachedRefs, markSnapshotted, prepareCompaction, unitFromSnapshot, unsnapshotted } from "../src/core/compaction.ts"
import { statusReport } from "../src/core/status.ts"
import { emptyState, type Msg } from "../src/core/types.ts"
import { groupUnits } from "../src/core/units.ts"

const user = (id: string, text: string): Msg => ({ id, role: "user", content: [{ type: "text", text }] })
const assistant = (id: string, text: string, call?: string): Msg => ({
  id,
  role: "assistant",
  content: [{ type: "text", text }, ...(call ? [{ type: "tool-call", id: call, name: "read", input: { path: "/x" } }] : [])],
})
const tool = (call: string, output: string): Msg => ({
  role: "tool",
  content: [{ type: "tool-result", id: call, name: "read", result: { type: "text", value: output } }],
})

const transcript = (): Msg[] => [
  user("u1", "Please read the config"),
  assistant("a1", "Reading", "c1"),
  tool("c1", "port = 8080 and secret flag zebra".repeat(20)),
  assistant("a2", "The port is 8080"),
  user("u2", "Now fix the bug"),
  assistant("a3", "Working on it"),
]

const setup = () => {
  const state = emptyState()
  const units = groupUnits(transcript())
  assignRefs(state, units)
  return { state, units }
}

const identity = (message: Msg) => message
const texts = (messages: Msg[]) => messages.flatMap((m) => m.content).filter((p) => p.type === "text").map((p) => String(p.text))

test("groups tool results with their assistant call and assigns stable refs", () => {
  const { state, units } = setup()
  assert.deepEqual(units.map((u) => u.role), ["user", "assistant", "assistant", "user", "assistant"])
  assert.equal(units[1]!.messages.length, 2)
  assert.equal(units[1]!.label, "tools:read")
  assert.deepEqual(Object.values(state.refs), ["m1", "m2", "m3", "m4", "m5"])

  const more = groupUnits([...transcript(), user("u3", "next")])
  assignRefs(state, more)
  assert.equal(state.refs["u3"], "m6")
  assert.equal(state.refs["a1"], "m2")
})

test("archive replaces a range into a summary and keeps tool pairs intact", () => {
  const { state, units } = setup()
  const [result] = archive(state, units, [{ start: "m1", end: "m3", summary: "Config port is 8080.", topic: "config" }])
  assert.equal(result!.block.id, "b1")
  const out = render(state, units, identity)
  assert.equal(out.messages.length, 3)
  assert.match(texts(out.messages)[0]!, /<archived block="b1" range="m1–m3".*topic="config">\nConfig port is 8080\./)
  assert.ok(!out.messages.some((m) => m.role === "tool"))
  assert.ok(out.tokens < out.originalTokens)
})

test("a failed archive call reports every problem and archives nothing", () => {
  const { state, units } = setup()
  assert.throws(
    () =>
      archive(state, units, [
        { start: "m1", end: "m2", summary: "ok" },
        { start: "m9", end: "m9", summary: "x" },
        { start: "m3", end: "m2", summary: "x" },
        { start: "m2", end: "m3", summary: "x" },
      ]),
    (error: Error) =>
      /Unknown ref "m9"/.test(error.message) &&
      /m3–m2 is reversed/.test(error.message) &&
      /m1–m2 and m2–m3 overlap/.test(error.message) &&
      /Nothing was archived/.test(error.message),
  )
  assert.deepEqual(state.blocks, {})
  assert.equal(state.nextBlock, 1)
})

test("protects the latest user message but allows archiving work in the current turn", () => {
  const { state, units } = setup()
  assert.throws(() => archive(state, units, [{ start: "m3", end: "m4", summary: "x" }]), /latest user message/)
  assert.doesNotThrow(() => archive(state, units, [{ start: "m5", end: "m5", summary: "x" }]))

  const turn = groupUnits([
    user("u1", "do a long task"),
    assistant("a1", "step 1", "c1"),
    tool("c1", "output 1"),
    assistant("a2", "step 2", "c2"),
    tool("c2", "output 2"),
    assistant("a3", "step 3", "c3"),
    tool("c3", "output 3"),
  ])
  const fresh = emptyState()
  assignRefs(fresh, turn)
  const [result] = archive(fresh, turn, [{ start: "m2", end: "m4", summary: "steps 1-3 done" }])
  assert.equal(result!.messages, 3)
})

test("rejects partial overlap and overlapping ranges", () => {
  const { state, units } = setup()
  archive(state, units, [{ start: "m2", end: "m3", summary: "inner" }])
  assert.throws(() => archive(state, units, [{ start: "m1", end: "m2", summary: "x" }]), /partially overlaps/)
  assert.throws(
    () => archive(state, units, [
      { start: "m1", end: "m1", summary: "a" },
      { start: "m1", end: "b1", summary: "b" },
    ]),
    /overlap/,
  )
})

test("nested blocks restore one level at a time", () => {
  const { state, units } = setup()
  archive(state, units, [{ start: "m2", end: "m3", summary: "inner" }])
  archive(state, units, [{ start: "m1", end: "b1", summary: "outer" }])
  assert.equal(state.blocks["b1"]!.parent, "b2")
  assert.throws(() => restore(state, "b1"), /nested inside b2/)

  restore(state, "b2")
  const once = texts(render(state, units, identity).messages)
  assert.ok(once.some((t) => t.includes("inner")))
  assert.ok(!once.some((t) => t.includes("outer")))

  restore(state, "b1")
  const full = render(state, units, identity)
  assert.ok(full.messages.some((m) => m.role === "tool"))
})

test("never puts ref tags inside assistant messages", () => {
  const state = emptyState()
  const units = groupUnits([
    user("u1", "hi"),
    { id: "a1", role: "assistant", content: [{ type: "reasoning", text: "think" }, { type: "text", text: "hello" }] },
    assistant("a2", "Reading", "c1"),
    tool("c1", "file body"),
    user("u2", "bye"),
  ])
  assignRefs(state, units)
  const out = render(state, units, identity).messages
  for (const message of out.filter((m) => m.role === "assistant")) {
    assert.ok(!JSON.stringify(message.content).includes("<ref id="))
  }
  assert.match(String(out[0]!.content[0]!.text), /^<ref id="m1" [^>]*kind="user"\/>$/)
  const result = out[3]!.content[0]!.result as { value: string }
  assert.match(result.value, /^<ref id="m3" [^>]*kind="tools:read"\/>\nfile body$/)
  // The plain reply (m2) has no tool result, so its tag rides on the next user message.
  assert.match(String(out[4]!.content[0]!.text), /^<ref id="m2" [^>]*kind="assistant"\/>\n<ref id="m4" [^>]*kind="user"\/>$/)
})

test("search finds details in summaries and in the archived originals", () => {
  const { state, units } = setup()
  archive(state, units, [{ start: "m1", end: "m3", summary: "Read the config file." }])
  assert.equal(search(state, units, "zebra")[0]?.block.id, "b1")
  assert.equal(search(state, units, "config")[0]?.block.id, "b1")
  assert.deepEqual(search(state, units, "nonexistent"), [])
})

test("status lists blocks and archivable candidates", () => {
  const { state, units } = setup()
  archive(state, units, [{ start: "m1", end: "m1", summary: "asked to read config" }])
  const out = render(state, units, identity)
  const report = statusReport({ state, units, tokens: out.tokens, originalTokens: out.originalTokens, limit: 100_000 })
  assert.match(report, /b1 m1–m1/)
  assert.match(report, /m2–m3/)
})

test("nudgeAt is a fraction of the window up to 1, otherwise an absolute token count", () => {
  assert.equal(nudgeThreshold(0.6, 200_000), 120_000)
  assert.equal(nudgeThreshold(0.6, undefined), undefined)
  assert.equal(nudgeThreshold(100_000, 1_000_000), 100_000)
  assert.equal(nudgeThreshold(100_000, undefined), 100_000)
})

test("strips ref tags the model echoed into its own replies", () => {
  const echoed: Msg = {
    id: "a",
    role: "assistant",
    content: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: '<ref id="m7" tokens="1k" kind="assistant"/><ref id="m7" tokens="2k" kind="assistant"/>Hello <ref id="m1"/>\n<ref id="m9" tokens="3" kind="tools:shell"/>\nmore' },
      { type: "text", text: '<ref id="m7" tokens="1k" kind="assistant"/>' },
    ],
  }
  assert.deepEqual(stripEchoedTags(echoed)?.content, [
    { type: "reasoning", text: "thinking" },
    { type: "text", text: 'Hello <ref id="m1"/>\nmore' },
  ])
  assert.equal(stripEchoedTags(assistant("b", "plain")), undefined)
  assert.equal(stripEchoedTags(user("c", '<ref id="m1" kind="user"/>')), undefined)

  const clean: Msg = { ...echoed, content: [echoed.content[0]!, { type: "text", text: 'Hello <ref id="m1"/>\nmore' }] }
  const renderOf = (message: Msg) => {
    const state = emptyState()
    const units = groupUnits([user("u", "hi"), stripEchoedTags(message) ?? message])
    assignRefs(state, units)
    return render(state, units, (m) => m).messages
  }
  assert.deepEqual(renderOf(echoed), renderOf(clean))
})

test("calibration learns the factor from size changes and puts the rest in overhead", () => {
  const first = calibrate(DEFAULT_CALIBRATION, undefined, { estimate: 100_000, actual: 190_000 })
  assert.equal(first.measured, false)
  assert.equal(first.calibration.factor, 1)
  assert.equal(first.calibration.overhead, 90_000)

  const small = calibrate(first.calibration, { estimate: 100_000, actual: 190_000 }, { estimate: 101_000, actual: 191_500 })
  assert.equal(small.measured, false)

  const second = calibrate(first.calibration, { estimate: 100_000, actual: 190_000 }, { estimate: 120_000, actual: 220_000 })
  assert.equal(second.measured, true)
  assert.equal(second.calibration.factor, 1.5)
  assert.equal(second.calibration.overhead, 40_000)

  const outlier = calibrate(second.calibration, { estimate: 120_000, actual: 220_000 }, { estimate: 130_000, actual: 400_000 })
  assert.equal(outlier.measured, false)
  assert.equal(outlier.calibration.factor, 1.5)
})

test("archived blocks survive compaction and only unarchived units are summarised", () => {
  const { state, units } = setup()
  archive(state, units, [{ start: "m1", end: "m2", summary: "Port is 8080." }])
  const stored = new Map(unsnapshotted(state, units).map(({ ref, unit }) => [ref, JSON.parse(JSON.stringify({ key: unit.key, messages: unit.messages }))]))
  markSnapshotted(state, [...stored.keys()])
  assert.deepEqual([...stored.keys()], ["m1", "m2"])
  assert.equal(unsnapshotted(state, units).length, 0)

  const kept = prepareCompaction(state, units, units)
  assert.deepEqual(kept.map((m) => m.id), ["a2", "u2", "a3"])
  assert.equal(state.compactedThrough, 5)

  // After compaction the host sends a checkpoint and later messages only.
  const after = groupUnits([user("cp", "<conversation-checkpoint>summary</conversation-checkpoint>"), user("u3", "Next")])
  assignRefs(state, after)
  const detached = detachedRefs(state, after).map((ref) => unitFromSnapshot(stored.get(ref).key, stored.get(ref).messages)!)
  const combined = [...detached, ...after]
  assert.deepEqual(refsOf(state, combined), ["m1", "m2", "m6", "m7"])
  const rendered = texts(render(state, combined, identity).messages).join("\n")
  assert.match(rendered, /<archived block="b1" range="m1–m2"/)
  assert.equal(search(state, combined, "zebra")[0]?.block.id, "b1")

  restore(state, "b1")
  assert.match(JSON.stringify(render(state, combined, identity).messages), /zebra/)
})

test("reverting past a compaction does not bring back reverted archived units", () => {
  const { state, units } = setup()
  archive(state, units, [{ start: "m1", end: "m2", summary: "s" }, { start: "m5", end: "m5", summary: "t" }])
  markSnapshotted(state, unsnapshotted(state, units).map(({ ref }) => ref))
  prepareCompaction(state, units, units)
  const after = groupUnits([user("cp", "<conversation-checkpoint>summary</conversation-checkpoint>"), user("u3", "Next")])
  assignRefs(state, after)
  assert.deepEqual(detachedRefs(state, after), ["m1", "m2", "m5"])

  // Undo to m3: the checkpoint and m4 onward are gone, including archived m5, the host sends its own copies again.
  assert.deepEqual(detachedRefs(state, units.slice(0, 3)), [])
})

test("nudges stay where they were first shown so earlier requests remain a prefix", () => {
  const { state, units } = setup()
  assert.equal(addNudge(state, "m5", 900, 1000), false)
  assert.equal(addNudge(state, "m5", 1000, 1000), true)
  const first = render(state, units, identity).messages

  const more = groupUnits([...transcript(), user("u3", "next")])
  assignRefs(state, more)
  assert.equal(addNudge(state, "m6", 1100, 1000), false, "waits for more growth before nudging again")
  const second = render(state, more, identity).messages
  assert.deepEqual(second.slice(0, first.length), first)
  assert.equal(first.at(-1)!.role, "system")

  assert.equal(addNudge(state, "m6", 1200, 1000), true)
  archive(state, more, [{ start: "m1", end: "m5", summary: "Earlier work." }])
  const third = texts(render(state, more, identity).messages).join("\n")
  assert.equal(third.match(/\[context\]/g)?.length, 1, "nudges inside archived ranges are dropped")

  assert.equal(addNudge(state, "m6", 500, 1000), false)
  assert.equal(state.nudgedAt, undefined, "dropping below the threshold resets the step")
})

test("sessions with zero-padded refs keep them and accept either form", () => {
  const { state, units } = setup()
  state.refs = Object.fromEntries(Object.entries(state.refs).map(([key, ref]) => [key, ref.replace(/^m/, "m000")]))
  const [result] = archive(state, units, [{ start: "m1", end: "m0003", summary: "Old format." }])
  assert.equal(result!.block.start, "m0001")
  assert.match(texts(render(state, units, identity).messages).join("\n"), /range="m0001–m0003"/)
})
