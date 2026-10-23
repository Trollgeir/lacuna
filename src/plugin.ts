import { Plugin } from "@opencode/plugin"
import { calibrate, DEFAULT_CALIBRATION, promptTokens, type Calibration, type Sample } from "./core/calibration.ts"
import { addNudge, GUIDANCE, nudgeThreshold } from "./core/prompt.ts"
import { formatTokens, render, stripEchoedTags, type MakeMessage } from "./core/render.ts"
import { search } from "./core/search.ts"
import { ArchiveError, archive, assignRefs, restore, type RangeInput } from "./core/state.ts"
import { detachedRefs, markSnapshotted, prepareCompaction, unitFromSnapshot, unsnapshotted } from "./core/compaction.ts"
import { statusReport } from "./core/status.ts"
import { emptyState, type Msg, type SessionState, type Unit } from "./core/types.ts"
import { groupUnits } from "./core/units.ts"
import { Lacuna, type Stats } from "./rpc.ts"

interface Options {
  /** When to nudge the model to archive: a fraction of the context window (≤ 1) or an absolute token count (> 1). */
  readonly nudgeAt: number
}

const readOptions = (raw: unknown): Options => {
  const value = (raw ?? {}) as Partial<Options>
  return { nudgeAt: typeof value.nudgeAt === "number" && value.nudgeAt > 0 ? value.nudgeAt : 200_000 }
}

interface Live {
  units: Unit[]
  tokens: number
  originalTokens: number
  limit?: number
  model: string
}

/** A context hook call, kept until the provider reports the size of the request it produced. */
interface Pending {
  readonly at: number
  readonly estimate: number
  readonly model: string
}

interface Measured {
  calibration: Calibration
  anchor?: Sample
}

const isState = (value: unknown): value is SessionState =>
  typeof value === "object" && value !== null && (value as SessionState).version === 1

const text = (content: string) => ({ content })

export default Plugin.define({
  id: "lacuna",
  async setup(ctx) {
    const options = readOptions(ctx.options)
    const states = new Map<string, SessionState>()
    // Tools run after the context hook for the same turn, so they act on the transcript the model just saw.
    const live = new Map<string, Live>()

    const load = async (sessionID: string) => {
      const cached = states.get(sessionID)
      if (cached) return cached
      const stored = await ctx.storage.get(`session/${sessionID}`)
      const state = isState(stored) ? stored : emptyState()
      states.set(sessionID, state)
      return state
    }
    const save = (sessionID: string, state: SessionState) =>
      ctx.storage.set(`session/${sessionID}`, JSON.parse(JSON.stringify(state)))

    // The conversion factor is per model and persisted; the overhead (system prompt, tools) is per session.
    const factors = new Map<string, Calibration>()
    const measured = new Map<string, Measured>()
    const pending = new Map<string, Pending[]>()

    const modelFactor = async (model: string) => {
      const cached = factors.get(model)
      if (cached) return cached
      const stored = (await ctx.storage.get(`calibration/${model}`)) as Partial<Calibration> | undefined
      const value =
        stored && typeof stored.factor === "number" && typeof stored.samples === "number"
          ? { ...DEFAULT_CALIBRATION, factor: stored.factor, samples: stored.samples }
          : DEFAULT_CALIBRATION
      factors.set(model, value)
      return value
    }
    const scaleFor = (sessionID: string, model: string) => {
      const session = measured.get(sessionID)?.calibration
      const factor = factors.get(model)?.factor ?? 1
      return { factor, overhead: session?.overhead ?? 0, scale: (estimate: number) => Math.round(factor * estimate) }
    }
    const corrected = (sessionID: string, view: Pick<Live, "tokens" | "originalTokens" | "model">) => {
      const { overhead, scale } = scaleFor(sessionID, view.model)
      return { tokens: overhead + scale(view.tokens), originalTokens: overhead + scale(view.originalTokens) }
    }

    const latest = new Map<string, Stats>()
    const rpc = await ctx.rpc.register(Lacuna, {
      stats: async (input) => {
        const stats = latest.get((input as { sessionID: string }).sessionID)
        return stats ? { stats: { ...stats } } : {}
      },
    })
    const publish = (sessionID: string, totals: { tokens: number; originalTokens: number }) => {
      const stats: Stats = { sessionID, archived: Math.max(0, totals.originalTokens - totals.tokens) }
      latest.set(sessionID, stats)
      void rpc.events.emit("stats", { ...stats }).catch(() => {})
    }
    // Archiving takes effect on the next model call; recompute now so the footer updates immediately.
    const republish = (sessionID: string, state: SessionState) => {
      const view = live.get(sessionID)
      if (!view) return
      const totals = render(state, view.units, (message) => message)
      view.tokens = totals.tokens
      view.originalTokens = totals.originalTokens
      publish(sessionID, corrected(sessionID, view))
    }

    const record = async (sessionID: string, at: number, actual: number) => {
      const calls = pending.get(sessionID)
      const call = calls?.filter((entry) => entry.at <= at).at(-1)
      if (!call || actual <= 0) return
      pending.set(sessionID, calls!.filter((entry) => entry.at > call.at))
      const sample = { estimate: call.estimate, actual }
      const base = await modelFactor(call.model)
      const previous = measured.get(sessionID)
      const result = calibrate({ ...base, overhead: previous?.calibration.overhead ?? 0 }, previous?.anchor, sample)
      measured.set(sessionID, {
        calibration: result.calibration,
        anchor: result.measured || !previous?.anchor ? sample : previous.anchor,
      })
      if (result.measured) {
        const { factor, samples } = result.calibration
        factors.set(call.model, { ...DEFAULT_CALIBRATION, factor, samples })
        await ctx.storage.set(`calibration/${call.model}`, { factor, samples })
      }
      const state = states.get(sessionID)
      if (state) republish(sessionID, state)
    }

    const forget = async (sessionID: string) => {
      for (const map of [states, live, measured, pending, latest]) map.delete(sessionID)
      await ctx.storage.remove(`session/${sessionID}`)
      const prefix = `snapshot/${sessionID}/`
      let after: string | undefined
      do {
        const page = await ctx.storage.scan({ prefix, after })
        for (const entry of page.entries) await ctx.storage.remove(entry.key)
        after = page.next
      } while (after)
    }

    const events = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (event.type === "session.deleted") await forget(event.data.sessionID).catch(() => {})
          if (event.type !== "session.step.ended") continue
          await record(event.data.sessionID, event.created, promptTokens(event.data.tokens)).catch(() => {})
        }
      } catch {
        // Subscription ends when the plugin unloads.
      }
    })()

    const limits = new Map<string, number | undefined>()
    const contextLimit = async (providerID: string, modelID: string) => {
      const key = `${providerID}/${modelID}`
      if (limits.has(key)) return limits.get(key)
      try {
        const { data } = await ctx.model.list()
        const model = data.find((info) => info.providerID === providerID && info.id === modelID)
        limits.set(key, model?.limit.context)
        return model?.limit.context
      } catch {
        return undefined
      }
    }

    const makerFor = (incoming: readonly Msg[]): MakeMessage => {
      const Ctor = incoming[0]?.constructor as (new (input: Msg) => Msg) | undefined
      return (message) => {
        if (!Ctor) return message
        try {
          return new Ctor(message)
        } catch {
          return message
        }
      }
    }
    const stripAll = (incoming: readonly Msg[], make: MakeMessage) =>
      incoming.map((message) => {
        const stripped = stripEchoedTags(message)
        return stripped ? make(stripped) : message
      })

    // Original messages of archived units, so blocks survive compaction. Loaded lazily, once per session.
    const snapshots = new Map<string, Map<string, Unit>>()
    const snapshotKey = (sessionID: string, ref: string) => `snapshot/${sessionID}/${ref}`
    const storeSnapshots = async (sessionID: string, state: SessionState, units: readonly Unit[]) => {
      const missing = unsnapshotted(state, units)
      if (!missing.length) return false
      await Promise.all(
        missing.map(({ ref, unit }) =>
          ctx.storage.set(snapshotKey(sessionID, ref), JSON.parse(JSON.stringify({ key: unit.key, messages: unit.messages }))),
        ),
      )
      markSnapshotted(state, missing.map(({ ref }) => ref))
      return true
    }
    const detachedUnits = async (sessionID: string, state: SessionState, units: readonly Unit[], make: MakeMessage) => {
      const refs = detachedRefs(state, units)
      if (!refs.length) return []
      const cache = snapshots.get(sessionID) ?? new Map<string, Unit>()
      snapshots.set(sessionID, cache)
      const loaded = await Promise.all(
        refs.map(async (ref) => {
          const cached = cache.get(ref)
          if (cached) return cached
          const stored = (await ctx.storage.get(snapshotKey(sessionID, ref))) as { key?: string; messages?: Msg[] } | undefined
          if (!stored?.key || !Array.isArray(stored.messages)) return undefined
          const unit = unitFromSnapshot(stored.key, stored.messages.map(make))
          if (unit) cache.set(ref, unit)
          return unit
        }),
      )
      return loaded.filter((unit): unit is Unit => Boolean(unit))
    }
    /** The host transcript as units, with archived units that compaction removed put back in front. */
    const prepare = async (sessionID: string, incoming: readonly Msg[]) => {
      const make = makerFor(incoming)
      const state = await load(sessionID)
      const current = groupUnits(stripAll(incoming, make))
      const before = state.nextRef
      assignRefs(state, current)
      const units = [...(await detachedUnits(sessionID, state, current, make)), ...current]
      const stored = await storeSnapshots(sessionID, state, units)
      if (stored || state.nextRef !== before) await save(sessionID, state)
      return { make, state, current, units }
    }

    await ctx.session.hook("compaction", async (event) => {
      const incoming = event.messages as unknown as Msg[]
      if (!incoming.length) return
      const { make, state, current, units } = await prepare(event.sessionID, incoming)
      const kept = prepareCompaction(state, units, current)
      await save(event.sessionID, state)
      const messages = kept.length ? kept : [make({ role: "user", content: [{ type: "text", text: "Everything before this point is archived." }] })]
      event.messages = messages as unknown as typeof event.messages
    })

    await ctx.session.hook("context", async (event) => {
      const incoming = event.messages as unknown as Msg[]
      if (!incoming.length) return
      const { make, state, units } = await prepare(event.sessionID, incoming)
      const result = render(state, units, make)
      const limit = await contextLimit(event.model.providerID, event.model.id)
      const model = `${event.model.providerID}/${event.model.id}`
      await modelFactor(model)
      const view: Live = { units, tokens: result.tokens, originalTokens: result.originalTokens, limit, model }
      live.set(event.sessionID, view)
      pending.set(event.sessionID, [...(pending.get(event.sessionID) ?? []).slice(-4), { at: Date.now(), estimate: result.tokens, model }])
      const totals = corrected(event.sessionID, view)
      publish(event.sessionID, totals)

      event.system.push({ type: "text", text: GUIDANCE } as (typeof event.system)[number])
      const threshold = nudgeThreshold(options.nudgeAt, limit)
      const anchor = state.refs[units.at(-1)!.key]!
      const nudgedAt = state.nudgedAt
      if (threshold !== undefined && state.nudges?.[anchor] === undefined) {
        if (addNudge(state, anchor, totals.tokens, threshold, limit)) {
          result.messages.push(make({ role: "system", content: [{ type: "text", text: state.nudges![anchor]! }] }))
        }
        if (state.nudgedAt !== nudgedAt) await save(event.sessionID, state)
      }
      event.messages = result.messages as unknown as typeof event.messages
    })

    const current = async (sessionID: string) => {
      const view = live.get(sessionID)
      if (!view) throw new ArchiveError("No context has been seen for this session yet.")
      return { state: await load(sessionID), view }
    }

    const run = async (fn: () => Promise<string>) => {
      try {
        return text(await fn())
      } catch (error) {
        if (error instanceof ArchiveError) return text(`Error: ${error.message}`)
        throw error
      }
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "archive",
        description:
          "Move consumed conversation ranges out of context into the archive, leaving self-contained summaries you write in their place. Each range is identified by the m# IDs (or b# block IDs) shown in context. Batch several ranges in one call. Nothing is lost: restore brings a block back.",
        input: {
          type: "object",
          properties: {
            ranges: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  start: { type: "string", description: "First ID in the range, e.g. m12 or b3" },
                  end: { type: "string", description: "Last ID in the range (inclusive)" },
                  summary: { type: "string", description: "Self-contained summary that replaces the range" },
                  topic: { type: "string", description: "Optional short title" },
                },
                required: ["start", "end", "summary"],
                additionalProperties: false,
              },
            },
          },
          required: ["ranges"],
          additionalProperties: false,
        } as never,
        options: { codemode: false },
        execute: async (input: unknown, context) =>
          run(async () => {
            const { state, view } = await current(context.sessionID)
            const ranges = (input as { ranges: RangeInput[] }).ranges
            const results = archive(state, view.units, ranges)
            await storeSnapshots(context.sessionID, state, view.units)
            const { scale } = scaleFor(context.sessionID, view.model)
            await save(context.sessionID, state)
            republish(context.sessionID, state)
            return results
              .map(({ block, messages }) => {
                const nested = block.children.length ? `, nesting ${block.children.join(", ")}` : ""
                return `Archived ${block.start}–${block.end} as ${block.id} (${messages} messages, ~${formatTokens(scale(block.tokens))} tokens${nested}).`
              })
              .join("\n")
          }),
      })

      editor.add({
        name: "restore",
        description:
          "Bring an archived block back into context one level: its original messages come back, or the blocks it contained if it was nested. Use search_archive first to find the right block.",
        input: {
          type: "object",
          properties: { block: { type: "string", description: "Block ID, e.g. b3" } },
          required: ["block"],
          additionalProperties: false,
        } as never,
        options: { codemode: false },
        execute: async (input: unknown, context) =>
          run(async () => {
            const state = await load(context.sessionID)
            const block = restore(state, (input as { block: string }).block)
            await save(context.sessionID, state)
            republish(context.sessionID, state)
            const restored = block.children.length ? `blocks ${block.children.join(", ")}` : "the original messages"
            return `Restored ${block.id} (${block.start}–${block.end}) to ${restored}. It is visible from the next step.`
          }),
      })

      editor.add({
        name: "search_archive",
        description: "Search archived blocks (their summaries and the original messages they replaced) by keyword.",
        input: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number", description: "Max results, default 5" },
          },
          required: ["query"],
          additionalProperties: false,
        } as never,
        options: { codemode: false },
        execute: async (input: unknown, context) =>
          run(async () => {
            const { state, view } = await current(context.sessionID)
            const { query, limit } = input as { query: string; limit?: number }
            const hits = search(state, view.units, query, limit ?? 5)
            if (!hits.length) return `No archived block matches "${query}".`
            return hits
              .map(({ block, snippets }) => {
                const location = block.parent ? ` (inside ${block.parent})` : ""
                const head = `${block.id}${location} ${block.start}–${block.end}${block.topic ? ` · ${block.topic}` : ""}`
                return [head, ...snippets.map((snippet) => `  ${snippet}`)].join("\n")
              })
              .join("\n")
          }),
      })

      editor.add({
        name: "context_status",
        description: "Show context usage, archived blocks, and the largest ranges that could be archived.",
        input: { type: "object", properties: {}, additionalProperties: false } as never,
        options: { codemode: false },
        execute: async (_input: unknown, context) =>
          run(async () => {
            const { state, view } = await current(context.sessionID)
            const { scale, overhead } = scaleFor(context.sessionID, view.model)
            return statusReport({ state, units: view.units, tokens: view.tokens, originalTokens: view.originalTokens, limit: view.limit, scale, overhead })
          }),
      })
    })

    return () => events.abort()
  },
})
