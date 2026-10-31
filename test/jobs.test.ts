import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { test } from "node:test"
import { ArchiveJobs } from "../src/core/archive/jobs.ts"
import { stageRanges, uncoveredSources } from "../src/core/archive/selection.ts"
import { contextCharacters, projectContext } from "../src/core/projection.ts"
import { archive, assignRefs } from "../src/core/state.ts"
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

test("idle includes superseded workers and rejects cancellation that does not stop them", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const { state, units, jobs } = setup()
  const generation = deferred()
  jobs.start(state, units, model, () => generation.promise)
  await setImmediate()
  jobs.cancel("Host compaction")
  jobs.start(state, units, model, async () => "[]")
  await setImmediate()
  let idle = false
  const waiting = jobs.idle()!.then(() => { idle = true })
  const refused = assert.rejects(waiting, /refusing to overlap/)
  await setImmediate()
  assert.equal(idle, false, "the newer job finishing does not mean the old inference stopped")
  t.mock.timers.tick(10_000)
  await refused
  generation.resolve(output())
  await setImmediate()
  assert.equal(jobs.idle(), undefined)
})

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

test("worker can archive across an unidentified latest user without undefined protection refs", async () => {
  const state = emptyState()
  const latest: Msg = { role: "user", content: [{ type: "text", text: "UNIDENTIFIED_LATEST_USER" }] }
  const units = groupUnits([...messages().slice(0, -1), latest, {
    id: "a3", role: "assistant", content: [{ type: "text", text: "Completed follow-up work.\n".repeat(100) }],
  }])
  assignRefs(state, units)
  const jobs = new ArchiveJobs()
  jobs.start(state, units, model, async (prompt) => {
    assert.doesNotMatch(prompt, /## Protected message|undefined/)
    return JSON.stringify([{ ...range, end: "m4" }])
  })
  await setImmediate()
  assert.match(jobs.report(), /ready/)
  const candidate = jobs.apply(state, units, model)!
  assert.ok(candidate)
  assert.deepEqual(candidate.blocks.b1!.unitKeys, ["u1", "a1", "a2", "a3"])
  assert.match(JSON.stringify(projectContext(candidate, units).messages), /UNIDENTIFIED_LATEST_USER/)
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
  const { state, units: original, jobs } = setup()
  const units = original.map((unit) => ({ ...unit, tokens: 0 }))
  jobs.start(state, units, model, async () => `\`\`\`json\n${JSON.stringify([
    { ...range, end: "m2" }, { start: "m3", end: "m3", summary: "Config is valid.", topic: "conclusion" },
  ])}\n\`\`\``)
  await setImmediate()
  const candidate = jobs.apply(state, units, model)!
  assert.equal(candidate.blocks.b1!.end, "m2")
  assert.equal(candidate.blocks.b2!.start, "m3")
  assert.equal(candidate.blocks.b2!.topic, "conclusion")
  assert.ok(contextCharacters(candidate, units) < contextCharacters(state, units))
  assert.ok(projectContext(candidate, units).tokens > projectContext(state, units).tokens, "size validation uses characters, not token estimates")
})

test("invalid summaries keep originals and allow retry", async () => {
  for (const invalid of ["not JSON", '""', '[""]', '[42]', '[{}]', output(" "), JSON.stringify([{ ...range, extra: true }])]) {
    const { state, units, jobs } = setup()
    let calls = 0
    jobs.start(state, units, model, async (_prompt, _signal, history) => {
      calls++
      if (calls === 2) assert.equal(history![0]!.output, invalid)
      return invalid
    })
    await setImmediate()
    assert.match(jobs.report(), /failed/)
    assert.equal(calls, 2, "validation gets exactly one repair attempt")
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
  const summary = "Verbose summary ".repeat(2000)
  const copy = structuredClone(state)
  archive(copy, units, [{ ...range, summary }])
  const selected = units.slice(0, 3)
  const percentage = contextCharacters(copy, selected) / contextCharacters(state, selected) * 100
  const validation = stageRanges(state, units, [], [{ ...range, summary }])
  assert.deepEqual(validation.errors, [{ entries: [0], issue: { kind: "summary-size", start: range.start, end: range.end, percentage } }])
  jobs.start(state, units, model, async () => output(summary))
  await setImmediate()
  assert.equal(jobs.apply(state, units, model), undefined)
  assert.match(jobs.report(), /failed.*summary size is \d+\.\d+%.*below 100%/)
  assert.deepEqual(state.blocks, {})
  jobs.start(state, units, model, async () => output())
  await jobs.idle()
  const archived = jobs.apply(state, units, model)!
  jobs.committed()
  jobs.start(archived, units, model, async () => JSON.stringify([{ start: "b1", end: "b1", summary: "Expanded existing summary. ".repeat(20) }]))
  await jobs.idle()
  assert.match(jobs.report(), /failed.*summary size is \d+\.\d+%.*below 100%/, "refolds compare against the visible summary, not the original source")
  assert.equal(jobs.apply(archived, units, model), undefined)
})

test("stages independent summaries and retries only rejected entries, retaining partial success", async (t) => {
  for (const repair of ["valid", "invalid", "malformed", "empty", "provider-error", "schema", "timeout", "cancel"]) {
    const state = emptyState()
    const units = groupUnits([
      user("u1", "Initial discussion.\n".repeat(200)),
      { id: "a1", role: "assistant", content: [{ type: "text", text: "Investigation.\n".repeat(200) }] },
      { id: "a2", role: "assistant", content: [{ type: "text", text: "Conclusion.\n".repeat(200) }] },
      user("u2", "Continue"),
    ])
    assignRefs(state, units)
    const jobs = new ArchiveJobs()
    const accepted = [
      { start: "m1", end: "m1", summary: "Initial discussion." },
      { start: "m2", end: "m2", summary: "Investigation." },
    ]
    const bad = { start: "m3", end: "m3", summary: "Bloated summary.\n".repeat(1000) }
    const deadline = new AbortController()
    const timeout = t.mock.method(AbortSignal, "timeout", () => deadline.signal)
    let calls = 0
    jobs.start(state, units, model, async (prompt, signal, history) => {
      if (++calls === 1) return JSON.stringify([...accepted, repair === "schema" ? { ...bad, summary: 42 } : bad])
      assert.equal(history!.length, 1)
      assert.match(prompt, /## Archive plan[\s\S]*m1–m1[\s\S]*m2–m2/)
      assert.doesNotMatch(prompt, /Initial discussion\.|Investigation\.|## Low context reduction/)
      assert.deepEqual(state.blocks, {}, "staging never commits")
      if (repair === "provider-error") throw new Error("Provider unavailable")
      if (repair === "timeout") deadline.abort(new DOMException("Timed out", "TimeoutError"))
      if (repair === "cancel") jobs.cancel("Host compaction")
      signal.throwIfAborted()
      return repair === "valid" || repair === "schema" ? JSON.stringify([{ ...bad, summary: "Conclusion." }])
        : repair === "empty" ? "[]" : repair === "invalid" ? JSON.stringify([bad]) : "malformed"
    })
    timeout.mock.restore()
    await jobs.idle()
    assert.equal(calls, 2)
    if (repair === "cancel") {
      assert.equal(jobs.snapshot()!.status, "discarded")
      assert.equal(jobs.apply(state, units, model), undefined)
      assert.deepEqual(state.blocks, {})
      continue
    }
    const complete = repair === "valid" || repair === "schema"
    assert.match(jobs.report(), complete ? /ready/ : /ready.*Partial success/)
    const candidate = jobs.apply(state, units, model)!
    assert.equal(Object.keys(candidate.blocks).length, complete ? 3 : 2)
    if (!complete) assert.match(JSON.stringify(projectContext(candidate, units).messages), /Conclusion/)
    assert.deepEqual(state.blocks, {})
    jobs.committed()
    if (!complete) assert.match(jobs.report(), /applied.*Partial success/)
  }
})

test("repairs malformed JSON and retries empty selections", async () => {
  const { state, units, jobs } = setup()
  let calls = 0
  jobs.start(state, units, model, async (prompt, _signal, history) => {
    if (++calls === 1) return output() + "}"
    assert.equal(history![0]!.output, output() + "}")
    assert.match(prompt, /^## Validation errors\n/)
    assert.doesNotMatch(prompt, /## Archive plan/)
    return output()
  })
  await jobs.idle()
  assert.equal(calls, 2)
  assert.equal(jobs.snapshot()!.status, "ready")
  jobs.cancel("Next test")
  for (const empty of ["[]", ""]) {
    calls = 0
    jobs.start(state, units, model, async (prompt) => {
      if (++calls === 2) assert.doesNotMatch(prompt, /## Archive plan/)
      return empty
    })
    await jobs.idle()
    assert.equal(calls, 2)
    assert.equal(jobs.snapshot()!.status, "skipped")
    assert.equal(jobs.apply(state, units, model), undefined)
  }
})

test("archive plan uses a 20% target, adds only new ranges, and stops after one follow-up", async () => {
  const state = emptyState()
  const units = groupUnits([
    user("u1", "First discussion. ".repeat(100)),
    { id: "a1", role: "assistant", content: [{ type: "text", text: "Later work. ".repeat(2000) }] },
    user("u2", "Protected"),
  ])
  assignRefs(state, units)
  const first = { start: "m1", end: "m1", summary: "First discussion." }
  const additional = { start: "m2", end: "m2", summary: "Later work." }
  for (const followUp of ["[]", JSON.stringify([additional])]) {
    const jobs = new ArchiveJobs()
    let calls = 0
    jobs.start(state, units, model, async (prompt) => {
      if (++calls === 1) {
        assert.doesNotMatch(prompt, /Suggested spans/)
        return JSON.stringify([first])
      }
      assert.match(prompt, /## Archive plan[\s\S]*m1–m1[\s\S]*## Low context reduction:[\s\S]*target is 20%[\s\S]*m2–m2/)
      assert.doesNotMatch(prompt.slice(prompt.indexOf("## Low context reduction:")), /m1–m1/)
      return followUp
    })
    await jobs.idle()
    assert.equal(calls, 2)
    const candidate = jobs.apply(state, units, model)!
    assert.equal(candidate.blocks.b1!.summary, first.summary)
    assert.equal(Object.keys(candidate.blocks).length, followUp === "[]" ? 1 : 2)
  }

  const jobs = new ArchiveJobs()
  let calls = 0
  jobs.start(state, units, model, async () => { calls++; return JSON.stringify([additional]) })
  await jobs.idle()
  assert.equal(calls, 1, "no follow-up when the initial reduction meets the target")
  assert.equal(jobs.apply(state, units, model)!.blocks.b1!.summary, additional.summary)
})

test("repair completeness follows source coverage when replacements split or merge", async () => {
  for (const split of [true, false]) {
    const state = emptyState()
    const units = groupUnits([1, 2, 3, 4, 5].map((id) => user(`u${id}`, `Discussion ${id}.\n`.repeat(200))))
    assignRefs(state, units)
    const jobs = new ArchiveJobs()
    const accepted = { start: "m1", end: "m1", summary: "First discussion." }
    const rejected = [
      { start: "m2", end: "m3", summary: 42 },
      { start: "m4", end: "m4", summary: 42 },
    ]
    const repair = split
      ? [{ start: "m2", end: "m2", summary: "Second discussion." }, { start: "m3", end: "m3", summary: "Third discussion." }]
      : [{ start: "m2", end: "m4", summary: "Remaining discussions." }]
    let calls = 0
    jobs.start(state, units, model, async () => JSON.stringify(++calls === 1 ? [accepted, ...rejected] : repair))
    await jobs.idle()
    assert.equal(calls, 2)
    assert.equal(jobs.snapshot()!.status, "ready")
    assert.equal(jobs.snapshot()!.detail !== undefined, split)
    const candidate = jobs.apply(state, units, model)!
    assert.equal(JSON.stringify(projectContext(candidate, units).messages).includes("Discussion 4."), split)
  }
})

test("range validation returns all independent issues as structured data", () => {
  const { state, units } = setup()
  const result = stageRanges(state, units, [], [
    { start: "m99", end: "m98", summary: 42 },
    { ...range, end: "m2", summary: "Oversized summary. ".repeat(2000), extra: true },
    { ...range, start: "m2" },
  ])
  assert.deepEqual(result.errors.filter(({ issue }) => issue.kind !== "summary-size"), [
    { entries: [0], issue: { kind: "field-type", field: "summary" } },
    { entries: [0], issue: { kind: "unknown-ref", side: "start", ref: "m99" } },
    { entries: [0], issue: { kind: "unknown-ref", side: "end", ref: "m98" } },
    { entries: [1], issue: { kind: "unexpected-field", field: "extra" } },
    { entries: [1, 2], issue: { kind: "overlap" } },
  ])
  const sizeErrors = result.errors.filter(({ issue }) => issue.kind === "summary-size")
  assert.equal(sizeErrors.length, 1)
  assert.deepEqual(sizeErrors[0]!.entries, [1])
  const size = sizeErrors[0]!.issue
  assert.ok(size.kind === "summary-size" && size.percentage > 100)
  assert.equal(result.rejected, 3)
  assert.deepEqual(result.ranges, [])
  assert.deepEqual(state.blocks, {})
  const sources = [{ ...range, end: "m2" }, { ...range, start: "m3" }]
  const split = [{ ...range, end: "m1" }, { ...range, start: "m2", end: "m2" }]
  assert.deepEqual(uncoveredSources(state, units, sources, split), [{ from: 2, to: 2 }])
  assert.deepEqual(uncoveredSources(state, units, sources, [range]), [])
  assert.deepEqual(uncoveredSources(state, units, sources, []), [{ from: 0, to: 1 }, { from: 2, to: 2 }])
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
