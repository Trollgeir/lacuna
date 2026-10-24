import { Plugin } from "@opencode/plugin"
import { calibrate, DEFAULT_CALIBRATION, promptTokens, type Calibration, type Sample } from "../core/calibration.ts"
import { GUIDANCE } from "../core/prompt.ts"
import { projectContext, type MakeMessage } from "../core/projection.ts"
import { search } from "../core/search.ts"
import { ArchiveError, assignRefs, restore } from "../core/state.ts"
import { detachedRefs, markSnapshotted, prepareCompaction, unitFromSnapshot, unsnapshotted } from "../core/compaction.ts"
import { emptyState, type Msg, type SessionState, type Unit } from "../core/types.ts"
import { groupUnits } from "../core/units.ts"
import { ArchiveJobs } from "../core/archive/jobs.ts"
import { ArchiveTrigger, archiveThreshold } from "../core/archive/trigger.ts"
import { Lacuna, type Stats } from "../rpc.ts"
import { registerTools } from "./tools.ts"
import { forkRequest, makerFor, stripAll, type ModelContext } from "./host.ts"

interface Options {
  /** Automatic archive threshold: a fraction of the context window (≤ 1) or an absolute token count (> 1). */
  readonly archiveAt: number
}

const readOptions = (raw: unknown): Options => {
  const { archiveAt } = (raw ?? {}) as Partial<Options>
  return { archiveAt: typeof archiveAt === "number" && archiveAt > 0 ? archiveAt : 200_000 }
}

interface Live {
  units: Unit[]
  tokens: number
  originalTokens: number
  unresolved: readonly string[]
  limit?: number
  model: string
  request: ModelContext
}

const modelKey = (model: ModelContext["model"]) => `${model.providerID}/${model.id}#${model.variant ?? ""}`

/** A context hook call, kept until the provider reports the size of the request it produced. */
interface Pending {
  readonly at: number
  readonly estimate: number
  readonly model: string
  readonly revision: number
  readonly view: Live
}

interface Measured {
  calibration: Calibration
  anchor?: Sample
}

interface SessionRuntime {
  state?: SessionState
  // Tools act on the transcript captured by the latest primary context hook.
  view?: Live
  job?: ArchiveJobs
  trigger: ArchiveTrigger
  snapshots: Map<string, Unit>
  // Anchors are per model: a sample from one model cannot measure another's tokenizer or overhead.
  measured: Map<string, Measured>
  pending: Pending[]
  revision: number
  completedRevision: number
  latest?: Stats
  lock?: Promise<void>
}

const isState = (value: unknown): value is SessionState =>
  typeof value === "object" && value !== null && (value as SessionState).version === 1

export default Plugin.define({
  id: "lacuna",
  async setup(ctx) {
    const options = readOptions(ctx.options)
    const sessions = new Map<string, SessionRuntime>()
    const sessionFor = (sessionID: string): SessionRuntime => {
      const existing = sessions.get(sessionID)
      if (existing) return existing
      const value: SessionRuntime = {
        trigger: new ArchiveTrigger(), snapshots: new Map(), measured: new Map(),
        pending: [], revision: 0, completedRevision: 0,
      }
      sessions.set(sessionID, value)
      return value
    }
    const forks = new Map<string, { sessionID: string; request: ModelContext }>()
    // Commit, restore, compaction and deletion share one ordering; generation stays outside it.
    let disposed = false
    const serial = async <T>(sessionID: string, fn: () => Promise<T>): Promise<T> => {
      const session = sessionFor(sessionID)
      const previous = session.lock ?? Promise.resolve()
      const result = previous.then(() => {
        if (disposed) throw new ArchiveError("Lacuna has unloaded.")
        if (sessions.get(sessionID) !== session) throw new ArchiveError("The session was deleted.")
        return fn()
      })
      const tail = result.then(() => {}, () => {})
      session.lock = tail
      try {
        return await result
      } finally {
        if (session.lock === tail) delete session.lock
      }
    }

    const load = async (sessionID: string) => {
      const session = sessionFor(sessionID)
      if (session.state) return session.state
      const stored = await ctx.storage.get(`session/${sessionID}`)
      const state = isState(stored) ? stored : emptyState()
      session.state = state
      return state
    }
    const save = (sessionID: string, state: SessionState) =>
      ctx.storage.set(`session/${sessionID}`, JSON.parse(JSON.stringify(state)))

    // The conversion factor is per model and persisted; the overhead (system prompt, tools) is per session.
    const factors = new Map<string, Calibration>()
    // Compare Lacuna mutations with the context actually used by a completed primary request.
    const changed = (sessionID: string) => sessionFor(sessionID).revision++
    const hasChanges = (sessionID: string) => {
      const session = sessions.get(sessionID)
      return !!session && session.revision > session.completedRevision
    }
    // Call under the session lock with an isolated candidate; publish only after persistence succeeds.
    const commit = async (sessionID: string, candidate: SessionState) => {
      await save(sessionID, candidate)
      sessionFor(sessionID).state = candidate
      changed(sessionID)
    }

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
      const measured = sessions.get(sessionID)?.measured.get(model)?.calibration
      const factor = factors.get(model)?.factor ?? 1
      return { factor, overhead: measured?.overhead ?? 0, scale: (estimate: number) => Math.round(factor * estimate) }
    }
    const corrected = (sessionID: string, view: Pick<Live, "tokens" | "originalTokens" | "model" | "unresolved">) => {
      const { overhead, scale } = scaleFor(sessionID, view.model)
      return { tokens: overhead + scale(view.tokens), originalTokens: overhead + scale(view.originalTokens), unresolved: view.unresolved }
    }

    const rpc = await ctx.rpc.register(Lacuna, {
      stats: async (input) => {
        const stats = sessions.get((input as { sessionID: string }).sessionID)?.latest
        return stats ? { stats: { ...stats } } : {}
      },
    })
    const publish = (sessionID: string, totals?: { tokens: number; originalTokens: number; unresolved: readonly string[] }) => {
      if (disposed) return
      const session = sessions.get(sessionID)
      if (!session) return
      const job = session.job?.snapshot()
      const stats: Stats = {
        sessionID,
        archived: totals ? Math.max(0, totals.originalTokens - totals.tokens) : session.latest?.archived ?? 0,
        unresolved: [...(totals?.unresolved ?? session.latest?.unresolved ?? [])],
        changed: job?.status === "ready" || hasChanges(sessionID),
        ...(job ? { job } : {}),
      }
      session.latest = stats
      void rpc.events.emit("stats", { ...stats }).catch(() => {})
    }
    const jobsFor = (sessionID: string) => {
      const session = sessionFor(sessionID)
      if (session.job) return session.job
      // UI-only events: no synthetic messages, attention notifications, or agent continuation.
      session.job = new ArchiveJobs(() => {
        if (sessions.get(sessionID) === session) publish(sessionID)
      })
      return session.job
    }
    // Recompute token savings after context changes; job transitions publish independently.
    const republish = (sessionID: string, state: SessionState) => {
      const view = sessions.get(sessionID)?.view
      if (!view) return
      const totals = projectContext(state, view.units)
      view.tokens = totals.tokens
      view.originalTokens = totals.originalTokens
      view.unresolved = totals.unresolved
      publish(sessionID, corrected(sessionID, view))
    }

    const record = async (sessionID: string, at: number, actual: number) => {
      const session = sessions.get(sessionID)
      if (!session) return
      const calls = session.pending
      const call = calls.filter((entry) => entry.at <= at).at(-1)
      if (!call) return
      session.pending = calls.slice(calls.indexOf(call) + 1)
      session.completedRevision = Math.max(session.completedRevision, call.revision)
      // A valid response need not include usage. Clear the marker independently of calibration.
      publish(sessionID)
      if (actual > 0) {
        const sample = { estimate: call.estimate, actual }
        const base = await modelFactor(call.model)
        const previous = session.measured.get(call.model)
        const result = calibrate({ ...base, overhead: previous?.calibration.overhead ?? 0 }, previous?.anchor, sample)
        session.measured.set(call.model, {
          calibration: result.calibration,
          anchor: result.measured || !previous?.anchor ? sample : previous.anchor,
        })
        if (result.measured) {
          const { factor, samples } = result.calibration
          factors.set(call.model, { ...DEFAULT_CALIBRATION, factor, samples })
          await ctx.storage.set(`calibration/${call.model}`, { factor, samples })
        }
      }
      if (sessions.get(sessionID) !== session) return
      const state = session.state
      if (state) republish(sessionID, state)
      await serial(sessionID, async () => {
        // Only a completed current request may trigger a fork, never an older response or auxiliary generation.
        if (sessions.get(sessionID) === session && session.view === call.view) await startArchive(sessionID, call.view)
      })
    }

    const forget = (sessionID: string) => serial(sessionID, async () => {
      sessions.get(sessionID)?.job?.cancel("The session was deleted.")
      for (const [prompt, fork] of forks) if (fork.sessionID === sessionID) forks.delete(prompt)
      sessions.delete(sessionID)
      await ctx.storage.remove(`session/${sessionID}`)
      const prefix = `snapshot/${sessionID}/`
      let after: string | undefined
      do {
        const page = await ctx.storage.scan({ prefix, after })
        for (const entry of page.entries) await ctx.storage.remove(entry.key)
        after = page.next
      } while (after)
    })

    const events = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (event.type === "session.deleted") await forget(event.data.sessionID).catch(() => {})
          if (event.type !== "session.step.ended") continue
          if (event.data.finish === "error") continue
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

    const startArchive = async (sessionID: string, view: Live, explicit = false) => {
      const job = jobsFor(sessionID)
      const status = job.snapshot()?.status
      if (status === "running") return "Archive job already running."
      if (status === "ready") return "Archive summaries are ready for the next request."
      if (hasChanges(sessionID)) return "Context changes await acknowledgment; try again after the current response."
      const trigger = sessionFor(sessionID).trigger
      const tokens = corrected(sessionID, view).tokens
      if (!explicit && !trigger.shouldStart(tokens, archiveThreshold(options.archiveAt, view.limit))) return
      const state = await load(sessionID)
      const request = forkRequest(view.request)
      const marker = `<lacuna-job id="${crypto.randomUUID()}"/>`
      job.start(state, view.units, modelKey(request.model), async (instructions, signal) => {
        const prompt = `${marker}\n${instructions}`
        forks.set(prompt, { sessionID, request })
        try {
          const result = await ctx.session.generate({ sessionID, prompt }, { signal })
          return result.text
        } finally {
          forks.delete(prompt)
        }
      })
      if (explicit) trigger.recordAttempt(tokens)
      return "Archive job started."
    }

    await ctx.session.hook("generate", (event) => {
      // Match our unique suffix, not just the session: /btw may run concurrently.
      const suffix = event.messages.at(-1)
      const prompt = suffix?.role === "user" && suffix.content.length === 1 && suffix.content[0]?.type === "text"
        ? suffix.content[0].text : undefined
      const fork = typeof prompt === "string" ? forks.get(prompt) : undefined
      if (!fork || fork.sessionID !== event.sessionID) return
      const request = fork.request
      if (disposed || modelKey(event.model) !== modelKey(request.model)) {
        throw new ArchiveError("The model changed before the archive fork could start.")
      }
      if (Object.keys(request.tools).some((name) => !(name in event.tools))) {
        throw new ArchiveError("The tool catalog changed before the archive fork could start.")
      }
      // Replay the entire primary prefix, including schemas and request overrides. Only the suffix is new.
      event.system = request.system
      event.messages = [...request.messages, suffix!]
      event.tools = request.tools
      event.options = request.options
    })

    // Original messages of archived units, so blocks survive compaction. Loaded lazily, once per session.
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
      const cache = sessionFor(sessionID).snapshots
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

    await ctx.session.hook("compaction", (event) => serial(event.sessionID, async () => {
      sessions.get(event.sessionID)?.job?.cancel("Host compaction invalidated the captured context.")
      const incoming = event.messages as unknown as Msg[]
      if (!incoming.length) return
      const { make, state, current, units } = await prepare(event.sessionID, incoming)
      const kept = prepareCompaction(state, units, current)
      await save(event.sessionID, state)
      const messages = kept.length ? kept : [make({ role: "user", content: [{ type: "text", text: "Everything before this point is archived." }] })]
      event.messages = messages as unknown as typeof event.messages
    }))

    await ctx.session.hook("context", (event) => serial(event.sessionID, async () => {
      const incoming = event.messages as unknown as Msg[]
      if (!incoming.length) return
      const prepared = await prepare(event.sessionID, incoming)
      const { make, units } = prepared
      let state = prepared.state
      const model = `${event.model.providerID}/${event.model.id}`
      const session = sessionFor(event.sessionID)
      const job = session.job
      const candidate = job?.apply(state, units, modelKey(event.model))
      if (candidate) {
        try {
          await storeSnapshots(event.sessionID, candidate, units)
          await commit(event.sessionID, candidate)
          state = candidate
          job!.committed()
        } catch {
          // Background summaries must never fail the user's request; the job stays ready and retries.
        }
      }
      const result = projectContext(state, units, make)
      const limit = await contextLimit(event.model.providerID, event.model.id)
      await modelFactor(model)
      const view: Live = { units, tokens: result.tokens, originalTokens: result.originalTokens, unresolved: result.unresolved, limit, model, request: event }
      session.view = view
      session.pending = [...session.pending.slice(-4), {
        at: Date.now(), estimate: result.tokens, model, revision: session.revision, view,
      }]
      const totals = corrected(event.sessionID, view)
      publish(event.sessionID, totals)

      event.system.push({ type: "text", text: GUIDANCE } as (typeof event.system)[number])
      event.messages = result.messages as unknown as typeof event.messages
    }))

    const current = async (sessionID: string) => {
      const view = sessions.get(sessionID)?.view
      if (!view) throw new ArchiveError("No context has been seen for this session yet.")
      return { state: await load(sessionID), view }
    }

    await registerTools(ctx.tool, {
      archive: (sessionID) => serial(sessionID, async () => {
        const { view } = await current(sessionID)
        return (await startArchive(sessionID, view, true))!
      }),
      restore: (sessionID, blockID) => serial(sessionID, async () => {
        const state = structuredClone(await load(sessionID))
        const block = restore(state, blockID)
        await commit(sessionID, state)
        const session = sessionFor(sessionID)
        const view = session.view
        if (view) session.job?.check(state, view.units, modelKey(view.request.model))
        republish(sessionID, state)
        const restored = block.children.length ? `blocks ${block.children.join(", ")}` : "the original messages"
        return `Restored ${block.id} (${block.start}–${block.end}) to ${restored}. It is visible from the next step.`
      }),
      search: (sessionID, query, limit) => serial(sessionID, async () => {
        const { state, view } = await current(sessionID)
        const hits = search(state, view.units, query, limit)
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

    return () => {
      disposed = true
      events.abort()
      for (const session of sessions.values()) session.job?.cancel("Lacuna unloaded; originals were kept.")
      forks.clear()
    }
  },
})
