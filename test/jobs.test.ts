import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { test } from "node:test"
import { ArchiveJobs } from "../src/core/archive/jobs.ts"
import { projectContext } from "../src/core/projection.ts"
import { assignRefs } from "../src/core/state.ts"
import { emptyState, type Msg } from "../src/core/types.ts"
import { groupUnits } from "../src/core/units.ts"

const model = "provider/model"
const user = (id: string, text: string): Msg => ({ id, role: "user", content: [{ type: "text", text }] })
const messages = (): Msg[] => [
  user("u1", "Investigate the config"),
  { id: "a1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: { path: "/config.ts" } }] },
  { role: "tool", content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "port = 8080; flag = zebra\n".repeat(200) } }] },
  { id: "a2", role: "assistant", content: [{ type: "text", text: "The config is valid.\n".repeat(100) }] },
  user("u2", "Now fix the bug"),
]
const setup = () => {
  const state = emptyState()
  const units = groupUnits(messages())
  assignRefs(state, units)
  return { state, units, jobs: new ArchiveJobs() }
}
const deferred = () => {
  let resolve!: (value: string) => void
  const promise = new Promise<string>((yes) => { resolve = yes })
  return { promise, resolve }
}
const range = { start: "m1", end: "m3", topic: "config", summary: "Config /config.ts: port 8080, flag zebra." }
const output = (summary = range.summary) => JSON.stringify([{ ...range, summary }])

test("worker selects ranges from a snapshot and commits only at a later request", async (t) => {
  t.mock.method(Date, "now", () => 1000)
  const { state, units, jobs } = setup()
  const generation = deferred()
  assert.equal(jobs.start(state, units, model, () => generation.promise), "j1")
  assert.match(jobs.report(), /running/)
  assert.equal(jobs.apply(state, units, model), undefined)
  await setImmediate()
  generation.resolve(output())
  await setImmediate()
  assert.match(jobs.report(), /ready/)
  assert.deepEqual(state.blocks, {})
  const more = groupUnits([...messages(), user("u3", "Continue with tests")])
  assignRefs(state, more)
  const candidate = jobs.apply(state, more, model)!
  assert.equal(candidate.blocks.b1!.summary, range.summary)
  assert.deepEqual(state.blocks, {})
  assert.ok(projectContext(candidate, more, (message) => message).tokens < projectContext(state, more, (message) => message).tokens)
  assert.deepEqual(jobs.apply(state, more, model), candidate)
  jobs.committed()
  assert.match(jobs.report(), /applied/)
})

test("validates worker-selected ranges and rejects duplicate pending jobs", async () => {
  for (const ranges of [
    [{ ...range, end: "m4" }],
    [{ ...range, start: "m99", end: "m99" }],
    [range, range],
  ]) {
    const { state, units, jobs } = setup()
    jobs.start(state, units, model, async () => JSON.stringify(ranges))
    assert.throws(() => jobs.start(state, units, model, async () => "[]"), /running/)
    await setImmediate()
    assert.match(jobs.report(), /failed/)
    assert.deepEqual(state.blocks, {})
  }
  const { state, units, jobs } = setup()
  jobs.start(state, units, model, async () => output())
  await setImmediate()
  assert.throws(() => jobs.start(state, units, model, async () => "[]"), /ready/)
})

test("batches worker-selected summaries in order", async () => {
  const { state, units, jobs } = setup()
  jobs.start(state, units, model, async () => JSON.stringify([
    { ...range, end: "m2" }, { start: "m3", end: "m3", summary: "Config is valid.", topic: "conclusion" },
  ]))
  await setImmediate()
  const candidate = jobs.apply(state, units, model)!
  assert.equal(candidate.blocks.b1!.end, "m2")
  assert.equal(candidate.blocks.b2!.start, "m3")
  assert.equal(candidate.blocks.b2!.topic, "conclusion")
})

test("invalid summaries keep originals and allow retry", async () => {
  for (const invalid of ["not JSON", '[""]', '[42]', '[{}]', output(" "), JSON.stringify([{ ...range, extra: true }])]) {
    const { state, units, jobs } = setup()
    jobs.start(state, units, model, async () => invalid)
    await setImmediate()
    assert.match(jobs.report(), /failed/)
    assert.equal(jobs.apply(state, units, model), undefined)
    assert.deepEqual(state.blocks, {})
    assert.equal(jobs.start(state, units, model, async () => output()), "j2")
  }
})

test("generation failures and oversized summaries keep the originals", async () => {
  const { state, units, jobs } = setup()
  jobs.start(state, units, model, async () => { throw new Error("Provider unavailable") })
  await setImmediate()
  assert.match(jobs.report(), /failed.*Provider unavailable/)
  jobs.start(state, units, model, async () => output("Verbose summary ".repeat(2000)))
  await setImmediate()
  assert.equal(jobs.apply(state, units, model), undefined)
  assert.match(jobs.report(), /discarded.*did not reduce/)
  assert.deepEqual(state.blocks, {})
})

test("a changed or removed source or model switch cancels a running job", async () => {
  for (const change of ["edit", "remove", "model"]) {
    const { state, units, jobs } = setup()
    const generation = deferred()
    let signal: AbortSignal | undefined
    jobs.start(state, units, model, (_prompt, inputSignal) => { signal = inputSignal; return generation.promise })
    await setImmediate()
    const incoming = change === "remove" ? units.slice(2) : units.map((unit, i) =>
      change === "edit" && i === 1
        ? { ...unit, messages: [{ id: "a1", role: "assistant" as const, content: [{ type: "text", text: "Edited" }] }] }
        : unit)
    assert.equal(jobs.apply(state, incoming, change === "model" ? "provider/other" : model), undefined)
    assert.equal(signal!.aborted, true)
    generation.resolve(output())
    await setImmediate()
    assert.match(jobs.report(), /discarded/)
    assert.deepEqual(state.blocks, {})
  }
})

test("cancellation ignores late completion and does not interfere with a newer job", async () => {
  const { state, units, jobs } = setup()
  const generation = deferred()
  let signal: AbortSignal | undefined
  jobs.start(state, units, model, (_prompt, value) => { signal = value; return generation.promise })
  await setImmediate()
  jobs.cancel("Host compaction")
  assert.equal(signal!.aborted, true)
  jobs.start(state, units, model, async () => output("Fresh config summary."))
  generation.resolve(output("Old summary"))
  await setImmediate()
  assert.match(jobs.report(), /j2: ready/)
  assert.equal(jobs.apply(state, units, model)!.blocks.b1!.summary, "Fresh config summary.")
})
