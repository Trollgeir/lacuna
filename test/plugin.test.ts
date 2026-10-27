import assert from "node:assert/strict"
import { setImmediate } from "node:timers/promises"
import { test } from "node:test"
import { Media, Message } from "@opencode/ai/effect"
import plugin from "../src/opencode/server/plugin.ts"
import type { Msg, SessionState } from "../src/core/types.ts"
import type { Stats } from "../src/opencode/rpc.ts"

interface HookEvent {
  sessionID: string
  messages: Msg[]
  system: { type: string; text: string }[]
  model: { providerID: string; id: string; variant?: string }
  agent: string
  tools: Record<string, { description: string; input: Record<string, unknown> }>
  options: Record<string, unknown>
}
interface Tool {
  name: string
  input: unknown
  execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>
}
const transcript = (): Msg[] => [
  { id: "u1", role: "user", content: [{ type: "text", text: "Read config" }] },
  { id: "a1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: { path: "/config.ts" } }] },
  { role: "tool", content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "port 8080 zebra\n".repeat(200) } }] },
  { id: "u2", role: "user", content: [{ type: "text", text: "Fix it" }] },
]
const deferred = () => {
  let resolve!: (text: string) => void
  const promise = new Promise<string>((yes) => { resolve = yes })
  return { promise, resolve }
}
const setup = async (options: { archiveAt?: number; archiveMode?: unknown; archiveModel?: unknown } = { archiveAt: 500 }) => {
  const hooks = new Map<string, (event: HookEvent) => Promise<void>>()
  const tools = new Map<string, Tool>()
  const stored = new Map<string, unknown>()
  const generation = deferred()
  const generations = [generation]
  const requests: (HookEvent & { prompt: string; signal: AbortSignal })[] = []
  const emitted: Stats[] = []
  const models: { providerID: string; id: string; enabled: boolean; variants: { id: string }[]; limit: { context: number; output: number; input?: number } }[] = [
    { providerID: "provider", id: "model", enabled: true, variants: [], limit: { context: 500_000, output: 16_000, input: 484_000 } },
    { providerID: "other", id: "team/luna", enabled: true, variants: [{ id: "fast" }], limit: { context: 500_000, output: 8_000, input: 492_000 } },
  ]
  const children = new Map<string, { model: HookEvent["model"]; parentID: string; agent: string; location: { directory: string } }>()
  const primaryModels = new Map<string, HookEvent["model"]>()
  const created: string[] = []
  const removed: string[] = []
  let removal: ReturnType<typeof deferred> | undefined
  let failGeneration = false
  let readStats!: (input: { sessionID: string }) => Promise<{ stats?: Stats }>
  const events: unknown[] = []
  let wake: (() => void) | undefined
  let failCommit = false
  let failSave = false
  const makeEvent = (messages = transcript(), sessionID = "s1"): HookEvent => ({
    sessionID, messages: messages.map((message) => Message.make(message as ConstructorParameters<typeof Message>[0])),
    system: [{ type: "text", text: "Main agent instructions" }],
    model: { providerID: "provider", id: "model" },
    agent: "build",
    tools: { read: { description: "Read a file", input: { type: "object", properties: { path: { type: "string" } } } } },
    options: { temperature: 0.2, reasoningEffort: "high" },
  })
  const context = {
    options,
    storage: {
      get: async (key: string) => structuredClone(stored.get(key)),
      set: async (key: string, value: unknown) => {
        if (failSave && key.startsWith("session/")) {
          failSave = false
          throw new Error("Storage unavailable")
        }
        if (failCommit && key.startsWith("session/") && (value as SessionState).blocks.b1) {
          failCommit = false
          throw new Error("Storage unavailable")
        }
        stored.set(key, structuredClone(value))
      },
      remove: async (key: string) => { stored.delete(key) },
      scan: async ({ prefix }: { prefix: string }) => ({ entries: [...stored.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) }),
    },
    rpc: { register: async (_definition: unknown, handlers: { stats: typeof readStats }) => {
      readStats = handlers.stats
      return { events: { emit: async (name: string, value: Stats) => {
        assert.equal(name, "stats", "only UI status events are emitted")
        emitted.push(value)
      } } }
    } },
    event: {
      subscribe: async function* ({ signal }: { signal: AbortSignal }) {
        const abort = () => wake?.()
        signal.addEventListener("abort", abort, { once: true })
        try {
          while (!signal.aborted) {
            if (events.length) yield events.shift()
            else await new Promise<void>((resolve) => { wake = resolve })
          }
        } finally {
          signal.removeEventListener("abort", abort)
        }
      },
    },
    model: { list: async () => ({ data: models }) },
    session: {
      get: async () => ({ location: { directory: "/project" } }),
      create: async (input: { model: HookEvent["model"]; parentID: string; agent: string; location: { directory: string } }) => {
        const id = `child${created.length + 1}`
        created.push(id)
        children.set(id, input)
        return { id }
      },
      remove: async ({ sessionID }: { sessionID: string }) => {
        if (removal) await removal.promise
        removed.push(sessionID)
        children.delete(sessionID)
      },
      hook: async (name: string, hook: (event: HookEvent) => Promise<void>) => { hooks.set(name, hook) },
      generate: async ({ sessionID, prompt }: { sessionID: string; prompt: string }, { signal }: { signal: AbortSignal }) => {
        const event = makeEvent([...transcript(), { role: "user", content: [{ type: "text", text: prompt }] }], sessionID)
        const child = children.get(sessionID)
        event.model = { ...(child?.model ?? primaryModels.get(sessionID) ?? event.model) }
        if (child) {
          event.options = { temperature: 0.1 }
          event.tools = {}
        }
        await hooks.get("generate")!(event)
        const pending = generations[requests.length] ?? deferred()
        if (!generations.includes(pending)) generations.push(pending)
        requests.push({ ...event, prompt, signal })
        if (failGeneration) throw new Error("Provider rejected archive request")
        return { text: await pending.promise }
      },
    },
    tool: { transform: async (transform: (editor: { add: (tool: Tool) => void }) => void) => transform({ add: (tool) => { tools.set(tool.name, tool) } }) },
  }
  // The harness supplies only the modules this plugin consumes.
  const cleanup = (await plugin.setup(context as unknown as Parameters<typeof plugin.setup>[0]))!
  const invoke = (name: string, input: unknown, sessionID = "s1") => tools.get(name)!.execute(input, { sessionID })
  const hook = async (name: string, messages = transcript(), sessionID = "s1", model?: HookEvent["model"]) => {
    const event = makeEvent(messages, sessionID)
    if (model) event.model = model
    if (name === "context") primaryModels.set(sessionID, { ...event.model })
    await hooks.get(name)!(event)
    return event
  }
  const emit = (event: unknown) => { events.push(event); wake?.() }
  const finish = async (created = Date.now(), actual = 0, status = "stop") => {
    emit({ type: "session.step.ended", created, data: {
      sessionID: "s1", finish: status, tokens: { input: actual, cache: { read: 0, write: 0 } },
    } })
    await setImmediate()
  }
  return { tools, stored, generation, generations, requests, emitted, cleanup, invoke, hook, emit, finish, models, created, removed,
    readStats: (sessionID = "s1") => readStats({ sessionID }),
    failNextCommit: () => { failCommit = true },
    failNextSave: () => { failSave = true },
    failArchiveGeneration: () => { failGeneration = true },
    holdRemoval: () => (removal = deferred()),
  }
}
const output = JSON.stringify([{ start: "m1", end: "m2", summary: "Config /config.ts: port 8080, flag zebra." }])

test("blocking waits for archive generation and cleanup before applying summaries", async (t) => {
  const harness = await setup({ archiveAt: 500, archiveMode: "blocking", archiveModel: { model: "other/team/luna#fast" } })
  t.after(harness.cleanup)
  const removal = harness.holdRemoval()
  await harness.hook("context")
  await harness.finish()
  let dispatched = false
  const next = harness.hook("context").then((event) => { dispatched = true; return event })
  await setImmediate()
  assert.equal(dispatched, false)
  harness.generation.resolve(output)
  await setImmediate()
  assert.equal(dispatched, false, "the worker is not idle until temporary-session cleanup finishes")
  removal.resolve("")
  assert.match(JSON.stringify((await next).messages), /<archived block/)
  assert.deepEqual(harness.removed, ["child1"])
  assert.equal((await harness.readStats()).stats!.job!.status, "applied")
})

test("deleting a session interrupts a blocking wait without resurrecting its context", async (t) => {
  const harness = await setup({ archiveMode: "blocking" })
  t.after(harness.cleanup)
  await harness.hook("context")
  assert.equal((await harness.invoke("archive", {})).content, "Archive job started.")
  const waiting = assert.rejects(harness.hook("context"), /The session was deleted/)
  await setImmediate()
  harness.emit({ type: "session.deleted", created: Date.now(), data: { sessionID: "s1" } })
  await waiting
  assert.equal(harness.requests[0]!.signal.aborted, true)
  assert.equal(harness.stored.has("session/s1"), false)
  harness.generation.resolve(output)
  await setImmediate()
  assert.deepEqual(await harness.readStats(), {})
})

test("archiveModel uses a registered model and variant without changing the primary session", async (t) => {
  const overrides = { maxTokens: 100, reasoningEffort: "low" }
  const harness = await setup({ archiveAt: 500, archiveModel: { model: "other/team/luna#fast", options: overrides } })
  t.after(harness.cleanup)
  // This fits only with the explicit output budget, not the model's full 8k output allowance.
  delete harness.models[1]!.limit.input
  harness.models[1]!.limit.context = 8_010
  const main = await harness.hook("context")
  main.options.maxTokens = 12_000
  await harness.finish()
  const fork = harness.requests[0]!
  assert.equal(fork.sessionID, "child1")
  assert.deepEqual(fork.model, { providerID: "other", id: "team/luna", variant: "fast" })
  assert.deepEqual(fork.system, main.system)
  assert.deepEqual(fork.messages.slice(0, -1), main.messages)
  assert.deepEqual(fork.tools, main.tools)
  assert.deepEqual(fork.options, { temperature: 0.1, ...overrides }, "overrides apply on top of archive settings, not primary settings")
  assert.deepEqual(main.options, { temperature: 0.2, reasoningEffort: "high", maxTokens: 12_000 })
  assert.deepEqual(main.model, { providerID: "provider", id: "model" })
  harness.generation.resolve(output)
  await setImmediate()
  assert.deepEqual(harness.removed, ["child1"])
  const next = await harness.hook("context")
  assert.match(JSON.stringify(next.messages), /<archived block/)
  assert.equal((await harness.readStats()).stats!.job!.status, "applied", "validity is tied to the primary model, not the archive model")
  assert.deepEqual(next.model, main.model)
  assert.deepEqual((await harness.hook("generate")).model, main.model, "unrelated generation stays on the primary model")
})

test("archiveModel options without a model inherit the primary model, variant and remaining settings", async (t) => {
  const harness = await setup({ archiveAt: 500, archiveModel: { options: { maxTokens: 8192, reasoningEffort: "low" } } })
  t.after(harness.cleanup)
  harness.models[0]!.variants.push({ id: "high" })
  const model = { providerID: "provider", id: "model", variant: "high" }
  const main = await harness.hook("context", transcript(), "s1", model)
  main.options.maxTokens = 12_000
  await harness.finish()
  const fork = harness.requests[0]!
  assert.equal(fork.sessionID, "s1")
  assert.deepEqual(fork.model, model)
  assert.deepEqual(fork.options, { temperature: 0.2, reasoningEffort: "low", maxTokens: 8192 })
  assert.deepEqual(main.options, { temperature: 0.2, reasoningEffort: "high", maxTokens: 12_000 })
  assert.deepEqual(harness.created, [])
  harness.generation.resolve("[]")
})

test("failed archive generation cleans up without fallback or context mutation", async (t) => {
  const harness = await setup({ archiveAt: 500, archiveModel: { model: "other/team/luna" } })
  t.after(harness.cleanup)
  harness.failArchiveGeneration()
  await harness.hook("context")
  await harness.finish()
  assert.equal(harness.requests.length, 1, "must not fall back to the primary model")
  assert.deepEqual(harness.removed, ["child1"])
  assert.equal((await harness.readStats()).stats!.job!.status, "failed")
  assert.deepEqual((harness.stored.get("session/s1") as SessionState).blocks, {})
})

test("archive ranges spanning unidentified host messages become ready and keep those messages visible", async (t) => {
  const harness = await setup({ archiveAt: 1_000_000 })
  t.after(harness.cleanup)
  const messages: Msg[] = [transcript()[0]!, { role: "system", content: [{ type: "text", text: "UNIDENTIFIED_HOST_STATE" }] }, ...transcript().slice(1)]
  await harness.hook("context", messages)
  await harness.invoke("archive", {})
  await setImmediate()
  harness.generation.resolve(output)
  await setImmediate()
  const ready = (await harness.readStats()).stats!
  assert.equal(ready.job!.status, "ready")
  assert.equal(ready.changed, true, "ready summaries must set the footer marker")
  const next = await harness.hook("context", messages)
  assert.match(JSON.stringify(next.messages), /<archived block/)
  assert.match(JSON.stringify(next.messages), /UNIDENTIFIED_HOST_STATE/)
  assert.doesNotMatch(JSON.stringify(next.messages), /port 8080 zebra/)
  const applied = (await harness.readStats()).stats!
  assert.equal(applied.job!.status, "applied")
  assert.ok(applied.archived > 0)
})

test("committed archives survive model switches and report wholly absent blocks", async (t) => {
  const harness = await setup({ archiveAt: 1_000_000 })
  t.after(harness.cleanup)
  const messages: Msg[] = [
    { id: "u1", role: "user", content: [{ type: "text", text: "previous" }] },
    { id: "reasoning", role: "assistant", content: [{ type: "reasoning", text: "", providerMetadata: { openai: { blob: "fixture" } } }] },
    ...transcript().slice(1, 3),
    { id: "end", role: "assistant", content: [{ type: "text", text: "finished" }] },
    transcript()[3]!,
  ]
  await harness.hook("context", messages)
  await harness.invoke("archive", {})
  await setImmediate()
  harness.generation.resolve(JSON.stringify([{ start: "m2", end: "m4", summary: "Completed archived work." }]))
  await setImmediate()
  await harness.hook("context", messages)
  const otherModel = { providerID: "other", id: "claude" }
  const revealed: Msg = { id: "new", role: "assistant", content: [{ type: "text", text: "NEW_VISIBLE" }] }
  const switched = [messages[0]!, messages[2]!, messages[3]!, revealed, messages[5]!]
  const out = await harness.hook("context", switched, "s1", otherModel)
  assert.match(JSON.stringify(out.messages), /Completed archived work/)
  assert.match(JSON.stringify(out.messages), /NEW_VISIBLE/)
  assert.doesNotMatch(JSON.stringify(out.messages), /port 8080 zebra/)
  assert.match((await harness.invoke("search_archive", { query: "zebra" })).content, /b1/)
  assert.deepEqual((await harness.readStats()).stats!.unresolved, [])
  assert.ok((await harness.readStats()).stats!.archived > 0)

  await harness.hook("context", [messages[0]!, revealed, messages[5]!], "s1", otherModel)
  assert.deepEqual((await harness.readStats()).stats!.unresolved, ["b1"])
  const returned = await harness.hook("context", messages)
  assert.match(JSON.stringify(returned.messages), /Completed archived work/)
  assert.doesNotMatch(JSON.stringify(returned.messages), /port 8080 zebra/)
  assert.deepEqual((await harness.readStats()).stats!.unresolved, [])
})

test("pending-context marker covers ready summaries and unacknowledged primary revisions", async (t) => {
  let now = 1000
  t.mock.method(Date, "now", () => now)
  const harness = await setup()
  t.after(harness.cleanup)
  const finish = async (created: number, actual = 100, status = "stop") => {
    harness.emit({ type: "session.step.ended", created, data: {
      sessionID: "s1", finish: status, tokens: { input: actual, cache: { read: 0, write: 0 } },
    } })
    await setImmediate()
  }
  const dirty = async () => (await harness.readStats()).stats!.changed

  await harness.hook("context")
  assert.equal(await dirty(), false)
  await harness.finish(1500)
  assert.equal(await dirty(), false)
  harness.generation.resolve(output)
  await setImmediate()
  assert.equal(await dirty(), true, "ready summaries mark a pending context update")
  await finish(1600)
  assert.equal(await dirty(), true, "a response without the summaries cannot clear a pending update")
  now = 2000
  await harness.hook("context")
  assert.equal(await dirty(), true, "applying an archive marks context dirty")
  await harness.hook("generate")
  assert.equal(await dirty(), true, "auxiliary requests cannot acknowledge a revision")
  await finish(2500)
  assert.equal(await dirty(), false, "a primary response using the archive clears the marker")

  now = 3000
  await harness.hook("context")
  now = 3100
  await harness.invoke("restore", { block: "b1" })
  assert.equal(await dirty(), true)
  await finish(3500)
  assert.equal(await dirty(), true, "an in-flight response did not use the restored context")
  now = 4000
  await harness.hook("context")
  assert.equal(await dirty(), true, "dispatch alone does not clear the marker")
  await finish(4500, 0)
  assert.equal(await dirty(), false, "completion clears even when usage is absent")
  await harness.invoke("restore", { block: "missing" })
  assert.equal(await dirty(), false, "invalid restores do not mark context dirty")
})

test("automatic archiving preserves the primary prefix, applies silently, and cools down after a no-op", async (t) => {
  const harness = await setup()
  t.after(harness.cleanup)
  const main = await harness.hook("context")
  // These stand in for modifications made by later primary hooks.
  main.tools.read!.description = "Read a file with line numbers"
  main.options.maxTokens = 12_000
  assert.equal(harness.requests.length, 0, "dispatch alone does not spawn an archive request")
  await harness.finish()
  assert.equal(harness.requests.length, 1)
  assert.deepEqual(harness.requests[0]!.model, { providerID: "provider", id: "model" })
  const fork = harness.requests[0]!
  assert.deepEqual(fork.system, main.system)
  assert.deepEqual(fork.tools, main.tools)
  assert.deepEqual(fork.options, main.options)
  assert.deepEqual(fork.messages.slice(0, -1), main.messages)
  assert.equal(fork.messages.length, main.messages.length + 1)
  // The captured prefix must not track further primary mutations.
  main.system[0]!.text = "Changed after spawning"
  main.tools.read!.description = "Changed after spawning"
  main.options.maxTokens = 1
  assert.notDeepEqual(fork.system, main.system)
  assert.notDeepEqual(fork.tools, main.tools)
  assert.notDeepEqual(fork.options, main.options)
  assert.deepEqual((harness.stored.get("session/s1") as SessionState).blocks, {})
  assert.equal((await harness.readStats()).stats!.job!.status, "running")
  const continued: Msg[] = [...transcript(), { id: "u3", role: "user", content: [{ type: "text", text: "Keep working. ".repeat(1000) }] }]
  const whileRunning = await harness.hook("context", continued)
  assert.ok(whileRunning.messages.some((message) => message.role === "tool"))
  await harness.finish()
  assert.equal(harness.requests.length, 1, "running jobs suppress automatic triggers")

  const beforeCompletion = harness.emitted.length
  harness.generation.resolve(output)
  await setImmediate()
  // One UI-only status update, no message injection or automatic model continuation.
  assert.equal(harness.emitted.length, beforeCompletion + 1)
  assert.equal(harness.emitted.at(-1)!.job!.status, "ready")
  assert.equal(harness.requests.length, 1)
  assert.equal((await harness.readStats()).stats!.job!.status, "ready")
  assert.deepEqual((harness.stored.get("session/s1") as SessionState).blocks, {})
  const next = await harness.hook("context", continued)
  assert.equal(harness.requests.length, 1, "applying summaries does not spawn a request")
  assert.match(JSON.stringify(next.messages), /<archived block/)
  assert.ok(!next.messages.some((message) => message.role === "tool"))
  assert.ok(harness.stored.has("snapshot/s1/m1"))
  assert.ok(harness.stored.has("snapshot/s1/m2"))
  assert.equal((await harness.readStats()).stats!.job!.status, "applied")
  assert.ok(harness.emitted.at(-1)!.archived > 0)
  assert.match((await harness.invoke("search_archive", { query: "zebra" })).content, /b1/)
  await harness.invoke("restore", { block: "b1" })
  await harness.finish()
  assert.equal(harness.requests.length, 1, "unacknowledged changes suppress automatic triggers")
  const restored = await harness.hook("context", continued)
  assert.ok(restored.messages.some((message) => message.role === "tool"))
  await harness.finish()
  assert.equal(harness.requests.length, 2, "growth allows another attempt after the marker clears")
  harness.generations[1]!.resolve("[]")
  await setImmediate()
  assert.equal((await harness.readStats()).stats!.job!.status, "skipped")
  assert.equal((await harness.readStats()).stats!.changed, false)
  await harness.hook("context", continued)
  await harness.finish()
  assert.equal(harness.requests.length, 2, "a no-op does not retry on unchanged context")
  assert.match((await harness.invoke("archive", {})).content, /job started/)
  assert.equal(harness.requests.length, 3, "explicit cleanup bypasses growth cooldown")
  harness.generations[2]!.resolve("[]")
  await setImmediate()
  await harness.hook("context", continued)
  await harness.finish()
  assert.equal(harness.requests.length, 3, "explicit cleanup also records the cooldown baseline")
  await harness.hook("context", [...continued, {
    id: "u4", role: "user", content: [{ type: "text", text: "Continue. ".repeat(2000) }],
  }])
  await harness.finish()
  assert.equal(harness.requests.length, 4, "meaningful growth rearms the trigger after a no-op")
})

test("failed persistence retains a ready job and retries without changing live archive state", async (t) => {
  const harness = await setup({ archiveAt: 200_000 })
  t.after(harness.cleanup)
  await harness.hook("context")
  await harness.finish()
  assert.equal(harness.requests.length, 0)
  assert.equal((await harness.invoke("archive", {})).content, "Archive job started.")
  assert.equal((await harness.invoke("archive", {})).content, "Archive job already running.")
  assert.equal(harness.requests.length, 1, "explicit cleanup bypasses the threshold but not an active job")
  harness.generation.resolve(output)
  await setImmediate()
  assert.equal((await harness.invoke("archive", {})).content, "Archive summaries are ready for the next request.")
  harness.failNextCommit()
  const kept = await harness.hook("context")
  assert.ok(kept.messages.some((message) => message.role === "tool"), "a failed save keeps the originals in context")
  assert.deepEqual((harness.stored.get("session/s1") as SessionState).blocks, {})
  assert.equal((await harness.readStats()).stats!.job!.status, "ready")
  assert.equal((await harness.readStats()).stats!.changed, true, "failed persistence keeps the context update pending")
  await harness.hook("context")
  assert.equal((harness.stored.get("session/s1") as SessionState).blocks.b1!.summary, "Config /config.ts: port 8080, flag zebra.")
  assert.equal((await harness.readStats()).stats!.job!.status, "applied")
  assert.match((await harness.invoke("archive", {})).content, /Context changes await acknowledgment/)
  assert.equal(harness.requests.length, 1)
  await harness.finish()
  assert.equal((await harness.readStats()).stats!.changed, false)
  const saved = structuredClone(harness.stored.get("session/s1"))
  const beforeRestore = harness.emitted.length
  harness.failNextSave()
  await assert.rejects(harness.invoke("restore", { block: "b1" }), /Storage unavailable/)
  assert.deepEqual(harness.stored.get("session/s1"), saved, "failed restore leaves persisted state unchanged")
  assert.equal(harness.emitted.length, beforeRestore, "failed restore publishes no context mutation")
  assert.equal((await harness.readStats()).stats!.changed, false)
  assert.match((await harness.invoke("search_archive", { query: "zebra" })).content, /b1/, "failed restore keeps the block in memory")
  assert.match((await harness.invoke("restore", { block: "b1" })).content, /Restored b1/, "restore can be retried")
  assert.equal((await harness.readStats()).stats!.changed, true)
})

test("compaction and deletion discard only their session's background job", async (t) => {
  const harness = await setup()
  t.after(harness.cleanup)
  await harness.hook("context")
  await harness.finish()
  await harness.hook("context", transcript(), "s2")
  await harness.invoke("archive", {}, "s2")
  assert.equal(harness.requests.length, 2)
  await harness.hook("compaction")
  assert.equal(harness.requests[0]!.signal.aborted, true)
  assert.equal(harness.requests[1]!.signal.aborted, false)
  harness.generation.resolve(output)
  await setImmediate()
  await harness.hook("context")
  assert.deepEqual((harness.stored.get("session/s1") as SessionState).blocks, {})
  assert.equal((await harness.readStats()).stats!.job!.status, "discarded")
  assert.match((await harness.readStats()).stats!.job!.detail!, /compaction/)
  harness.emit({ type: "session.deleted", created: Date.now(), data: { sessionID: "s1" } })
  await setImmediate()
  assert.deepEqual(await harness.readStats(), {})
  assert.equal(harness.stored.has("session/s1"), false)
  assert.equal((await harness.readStats("s2")).stats!.job!.status, "running")
  harness.generations[1]!.resolve(output)
  await setImmediate()
  assert.equal((await harness.readStats("s2")).stats!.job!.status, "ready")
  assert.deepEqual(await harness.readStats(), {}, "late callbacks cannot revive a deleted session")
})

test("archive forks preserve host Message prototypes, provider metadata and binary media", async (t) => {
  const harness = await setup()
  t.after(harness.cleanup)
  const main = await harness.hook("context", transcript().map((message) => new Message(message as ConstructorParameters<typeof Message>[0])))
  const media = new Message({ role: "user", providerMetadata: { openai: { itemID: "cached-item" } }, content: [
    { type: "media", media: new Media.Asset({ source: { type: "bytes", mediaType: "image/png", data: new Uint8Array([1, 2, 3]) } }) },
  ] })
  main.messages.push(media)
  main.system.push({ type: "text", text: "Extra primary instructions" })
  await harness.finish()
  const fork = harness.requests[0]!
  assert.deepEqual(fork.messages.slice(0, -1), main.messages)
  assert.ok(fork.messages.slice(0, -1).every((message) => message instanceof Message))
  const clonedMedia = fork.messages.at(-2)!.content[0] as unknown as { media: { source: { data: Uint8Array } } }
  assert.ok(clonedMedia.media.source.data instanceof Uint8Array)
  assert.deepEqual(clonedMedia.media.source.data, new Uint8Array([1, 2, 3]))
  const original = media.content[0]!
  assert.ok(original.type === "media" && original.media.source.type === "bytes")
  assert.notEqual(clonedMedia.media.source.data, original.media.source.data)
  const clonedAsset = (fork.messages.at(-2) as Message).content[0]!
  assert.ok(clonedAsset.type === "media")
  assert.equal(clonedAsset.media.inline()!.base64, original.media.inline()!.base64)
  assert.deepEqual(fork.messages.at(-2)!.providerMetadata, media.providerMetadata)
  harness.generation.resolve(output)
})
