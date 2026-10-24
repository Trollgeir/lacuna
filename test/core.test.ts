import assert from "node:assert/strict"
import { test } from "node:test"
import { calibrate, DEFAULT_CALIBRATION } from "../src/core/calibration.ts"
import { ArchiveTrigger, archiveThreshold } from "../src/core/archive/trigger.ts"
import { projectContext, stripEchoedTags } from "../src/core/projection.ts"
import { search } from "../src/core/search.ts"
import { archive, assignRefs, refsOf, restore } from "../src/core/state.ts"
import { detachedRefs, markSnapshotted, prepareCompaction, unitFromSnapshot, unsnapshotted } from "../src/core/compaction.ts"
import { candidates } from "../src/core/archive/candidates.ts"
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
  const out = projectContext(state, units, identity)
  assert.equal(out.messages.length, 3)
  assert.doesNotMatch(JSON.stringify(out.messages), /tokens=/)
  assert.match(texts(out.messages)[0]!, /<archived block="b1" range="m1–m3".*topic="config">\nConfig port is 8080\./)
  assert.ok(!out.messages.some((m) => m.role === "tool"))
  assert.ok(out.tokens < out.originalTokens)
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
  const before = structuredClone(state)
  assert.throws(() => archive(state, units, [{ start: "m1", end: "m2", summary: "x" }]), /partially overlaps/)
  assert.throws(
    () => archive(state, units, [
      { start: "m1", end: "m1", summary: "a" },
      { start: "m1", end: "b1", summary: "b" },
    ]),
    /overlap/,
  )
  assert.deepEqual(state, before, "invalid batches cannot partially mutate archive state")
})

test("nested blocks restore one level at a time", () => {
  const { state, units } = setup()
  archive(state, units, [{ start: "m2", end: "m3", summary: "inner" }])
  archive(state, units, [{ start: "m1", end: "b1", summary: "outer" }])
  assert.equal(state.blocks["b1"]!.parent, "b2")
  assert.throws(() => restore(state, "b1"), /nested inside b2/)

  restore(state, "b2")
  const once = texts(projectContext(state, units, identity).messages)
  assert.ok(once.some((t) => t.includes("inner")))
  assert.ok(!once.some((t) => t.includes("outer")))

  restore(state, "b1")
  const full = projectContext(state, units, identity)
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
  const out = projectContext(state, units, identity).messages
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

test("candidates group role runs and include users while excluding archives and protected messages", () => {
  const { state, units: originalUnits } = setup()
  const sizes = [1500, 1500, 1000, 10, 1000]
  const units = originalUnits.map((unit, i) => ({ ...unit, tokens: sizes[i]! }))
  assert.deepEqual(candidates(state, units).map(({ start, end }) => [start, end]), [["m2", "m3"], ["m1", "m1"], ["m5", "m5"]])
  archive(state, units, [{ start: "m1", end: "m1", summary: "asked to read config" }])
  const runs = candidates(state, units)
  assert.deepEqual(runs.map(({ start, end }) => [start, end]), [["m2", "m3"], ["m5", "m5"]])
  assert.ok(runs[0]!.tokens >= runs[1]!.tokens)
  assert.equal(runs[0]!.prefixPreserved, projectContext(state, units.slice(0, 1), identity).tokens)
  assert.equal(runs[1]!.prefixPreserved, projectContext(state, units.slice(0, 4), identity).tokens)
  const tied = units.map((unit, i) => i === 4 ? { ...unit, tokens: runs[0]!.tokens } : unit)
  assert.equal(candidates(state, tied)[0]!.start, "m5", "equal-sized candidates prefer the later range")
  const separated = { ...setup(), units }
  archive(separated.state, separated.units, [{ start: "m2", end: "m2", summary: "Read the config." }])
  assert.deepEqual(candidates(separated.state, separated.units).map(({ start, end }) => [start, end]), [["m1", "m1"], ["m5", "m5"], ["m3", "m3"]])
  const largeUserState = emptyState()
  const largeUserUnits = groupUnits([
    user("u1", "Long pasted data. ".repeat(1000)),
    user("u2", "Additional context"),
    assistant("a1", "Reading", "c1"),
    tool("c1", "Result"),
    assistant("a2", "Done"),
    user("u3", "Protected request"),
  ])
  assignRefs(largeUserState, largeUserUnits)
  assert.deepEqual(candidates(largeUserState, largeUserUnits).map(({ start, end }) => [start, end]), [["m1", "m2"]])
  const belowMinimum = largeUserUnits.map((unit, i) => ({ ...unit, tokens: i === 0 ? 999 : 0 }))
  assert.deepEqual(candidates(largeUserState, belowMinimum), [])
  const atMinimum = belowMinimum.map((unit, i) => i === 0 ? { ...unit, tokens: 1000 } : unit)
  assert.equal(candidates(largeUserState, atMinimum, 1)[0]!.start, "m1")
})

test("archiveAt is a fraction of the window up to 1, otherwise an absolute token count", () => {
  assert.equal(archiveThreshold(0.6, 200_000), 120_000)
  assert.equal(archiveThreshold(0.6, undefined), undefined)
  assert.equal(archiveThreshold(100_000, 1_000_000), 100_000)
  assert.equal(archiveThreshold(100_000, undefined), 100_000)
})

test("strips ref tags the model echoed into its own replies", () => {
  const echoed: Msg = {
    id: "a",
    role: "assistant",
    content: [
      { type: "reasoning", text: "thinking" },
      { type: "text", text: '<ref id="m7" kind="assistant"/><ref id="m7" kind="assistant"/>Hello <ref id="m1"/>\n<ref id="m9" kind="tools:shell"/>\nmore' },
      { type: "text", text: '<ref id="m7" kind="assistant"/>' },
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
    return projectContext(state, units, (m) => m).messages
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
  const rendered = texts(projectContext(state, combined, identity).messages).join("\n")
  assert.match(rendered, /<archived block="b1" range="m1–m2"/)
  assert.equal(search(state, combined, "zebra")[0]?.block.id, "b1")

  restore(state, "b1")
  assert.match(JSON.stringify(projectContext(state, combined, identity).messages), /zebra/)
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

test("automatic archiving waits for growth between attempts", () => {
  const trigger = new ArchiveTrigger()
  assert.equal(trigger.shouldStart(900, 1000), false)
  assert.equal(trigger.shouldStart(1000, undefined), false)
  assert.equal(trigger.shouldStart(1000, 1000), true)
  assert.equal(trigger.shouldStart(1100, 1000), false)
  assert.equal(trigger.shouldStart(1200, 1000), true)
  assert.equal(trigger.shouldStart(1000, 1000), false, "context shrinkage rebases the cooldown")
  assert.equal(trigger.shouldStart(1200, 1000), true)
  assert.equal(trigger.shouldStart(500, 1000), false)
  assert.equal(trigger.shouldStart(1000, 1000), true, "dropping below threshold rearms the trigger")
})
