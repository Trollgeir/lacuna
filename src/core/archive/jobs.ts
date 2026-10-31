import { projectContext } from "../projection.ts"
import { archive, ArchiveError, protectedIndexes, refsOf, type RangeInput } from "../state.ts"
import type { SessionState, Unit } from "../types.ts"
import { archivePrompt } from "./prompt.ts"
import { parseEntries } from "./output.ts"
import { archivePlan, repairPrompt, stageRanges, TARGET_REDUCTION, uncoveredSources, type ArchiveGenerate } from "./selection.ts"
import { formatValidationError } from "../validation.ts"
import type { ArchiveJobStatus } from "./status.ts"
import { candidates } from "./candidates.ts"

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

interface Worker {
  done: Promise<void>
  signal: AbortSignal
  abortedAt?: number
}

/** Cancellation changes job status immediately, but inference and cleanup may still be draining. */
const waitForWorker = (worker: Worker, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (error?: unknown) => {
    clearTimeout(timer)
    worker.signal.removeEventListener("abort", stopping)
    signal?.removeEventListener("abort", interrupted)
    if (error !== undefined) reject(error)
    else resolve()
  }
  const stopping = () => {
    timer = setTimeout(() => finish(new ArchiveError("Archive generation did not stop after cancellation; refusing to overlap requests.")),
      Math.max(0, 10_000 - (Date.now() - worker.abortedAt!)))
  }
  const interrupted = () => finish(signal!.reason)
  worker.done.then(() => finish())
  worker.signal.addEventListener("abort", stopping, { once: true })
  signal?.addEventListener("abort", interrupted, { once: true })
  if (worker.signal.aborted) stopping()
  if (signal?.aborted) interrupted()
})

interface Target {
  readonly start: string
  readonly end: string
  readonly fingerprint: string
  readonly source: string
}

const capture = (state: SessionState, units: readonly Unit[], ranges: readonly RangeInput[]): Target[] => {
  const copy = structuredClone(state)
  const resolved = archive(copy, units, ranges)
  return resolved.map(({ block, from, to }) => {
    const selected = units.slice(from, to + 1)
    const children = block.children.map((id) => state.blocks[id])
    return {
      start: block.start,
      end: block.end,
      fingerprint: JSON.stringify({ units: selected.map((unit) => ({ key: unit.key, messages: unit.messages })), children }),
      source: JSON.stringify(projectContext(state, selected).messages),
    }
  })
}

/** One job per session. The worker selects ranges; only apply crosses the archive-state seam. */
export class ArchiveJobs {
  private readonly onChange: (job: ArchiveJobStatus) => void

  constructor(onChange: (job: ArchiveJobStatus) => void = () => {}) {
    this.onChange = onChange
  }

  private next = 1
  private readonly workers = new Set<Worker>()
  private job?: {
    id: string
    model: string
    state: SessionState
    units: Unit[]
    ranges: RangeInput[]
    targets: Target[]
    controller: AbortController
    status: ArchiveJobStatus["status"]
    startedAt: number
    updatedAt: number
    detail?: string
  }

  start(
    state: SessionState,
    units: readonly Unit[],
    model: string,
    generate: ArchiveGenerate,
  ): string {
    if (this.job?.status === "running" || this.job?.status === "ready") {
      throw new ArchiveError(`Archive job ${this.job.id} is ${this.job.status}.`)
    }
    const now = Date.now()
    const job: NonNullable<ArchiveJobs["job"]> = {
      id: `j${this.next++}`, model, state: structuredClone(state), units: structuredClone(units) as Unit[],
      ranges: [], targets: [], controller: new AbortController(), status: "running",
      startedAt: now, updatedAt: now,
    }
    this.job = job
    this.changed()
    const refs = refsOf(job.state, job.units)
    const prompt = archivePrompt({
      protectedRefs: protectedIndexes(job.units).flatMap((index) => refs[index] ? [refs[index]!] : []),
    })
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(300_000)])
    const worker: Worker = { done: Promise.resolve(), signal, ...(signal.aborted ? { abortedAt: Date.now() } : {}) }
    const aborted = () => { worker.abortedAt = Date.now() }
    signal.addEventListener("abort", aborted, { once: true })
    worker.done = Promise.resolve().then(async () => {
      if (job.controller.signal.aborted) return
      const output = await generate(prompt, signal)
      if (job.status !== "running") return
      signal.throwIfAborted()
      let ranges: RangeInput[] = []
      let errors: string[] = []
      let originalEntries: unknown[] = []
      const validate = (output: string, staged: readonly RangeInput[]) => {
        const entries = parseEntries(output)
        const selection = stageRanges(job.state, job.units, staged, entries)
        return { entries, ranges: selection.ranges, errors: selection.errors.map(formatValidationError) }
      }
      try {
        const selection = validate(output, [])
        originalEntries = selection.entries
        ranges = selection.ranges
        errors = selection.errors
      } catch (error) {
        errors = [reason(error)]
      }
      const plan = archivePlan(job.state, job.units, ranges)
      const shortfall = plan.reduction < TARGET_REDUCTION
      if (errors.length || shortfall) {
        const hadErrors = errors.length > 0
        try {
          const suggestions = shortfall ? candidates(plan.projected, job.units) : undefined
          const retry = await generate(repairPrompt(errors, plan, suggestions), signal, [{ prompt, output }])
          if (job.status !== "running") return
          signal.throwIfAborted()
          const selection = validate(retry, ranges)
          const replacements = selection.ranges.length - ranges.length
          ranges = selection.ranges
          const uncovered = hadErrors ? uncoveredSources(job.state, job.units, originalEntries, ranges) : []
          errors = [...selection.errors, ...(uncovered.length ? [`${uncovered.length} original source range(s) remain partly or wholly visible.`] : [])]
          if (hadErrors && !replacements && !selection.entries.length) errors.push("The repair returned no replacements for the invalid archive response.")
        } catch (error) {
          // A deadline stops inference, not independently valid staging. Explicit cancellation
          // still discards the job (including on source changes, compaction, or deletion).
          job.controller.signal.throwIfAborted()
          if (job.status !== "running") return
          errors = [reason(error)]
        }
      }
      if (!ranges.length) {
        if (errors.length) throw new ArchiveError(errors.join("\n"))
        job.status = "skipped"
        this.changed()
        return
      }
      job.targets = capture(job.state, job.units, ranges)
      job.ranges = ranges
      job.status = "ready"
      if (errors.length) job.detail = `Partial success: ${ranges.length} accepted range(s). ${errors.join(" ")}`
      this.changed()
    }).catch((error: unknown) => {
      if (job.status !== "running") return
      job.status = "failed"
      job.detail = reason(error)
      this.changed()
    }).finally(() => {
      signal.removeEventListener("abort", aborted)
      this.workers.delete(worker)
    })
    this.workers.add(worker)
    return job.id
  }

  /** A snapshot of all pending workers, including cancelled and superseded jobs. Wait outside session locks. */
  idle(signal?: AbortSignal): Promise<void> | undefined {
    if (!this.workers.size) return undefined
    return Promise.all([...this.workers].map((worker) => waitForWorker(worker, signal))).then(() => {}).catch((error: unknown) => {
      if (!signal?.aborted) this.cancel(reason(error))
      throw error
    })
  }

  /** While selection runs, preserve its source snapshot; once ready, validate only its selected targets. */
  check(state: SessionState, units: readonly Unit[], model: string): void {
    const job = this.job
    if (!job || (job.status !== "running" && job.status !== "ready")) return
    try {
      if (model !== job.model) throw new ArchiveError("The model changed.")
      if (job.status === "running") {
        const current = units.slice(0, job.units.length)
        if (JSON.stringify(current) !== JSON.stringify(job.units) ||
          JSON.stringify(state.blocks) !== JSON.stringify(job.state.blocks)) {
          throw new ArchiveError("The captured material changed.")
        }
      } else if (JSON.stringify(capture(state, units, job.ranges)) !== JSON.stringify(job.targets)) {
        throw new ArchiveError("The targeted material changed.")
      }
    } catch (error) {
      this.cancel(reason(error))
    }
  }

  /** Returns an isolated candidate. The caller persists it before replacing its live state. */
  apply(state: SessionState, units: readonly Unit[], model: string): SessionState | undefined {
    this.check(state, units, model)
    const job = this.job
    if (job?.status !== "ready") return undefined
    try {
      const candidate = structuredClone(state)
      archive(candidate, units, job.ranges.map((range, i) => ({
        ...range, start: job.targets[i]!.start, end: job.targets[i]!.end,
      })))
      return candidate
    } catch (error) {
      this.cancel(reason(error))
      return undefined
    }
  }

  committed() {
    if (this.job?.status !== "ready") return
    this.job.status = "applied"
    this.changed()
  }

  cancel(reason: string) {
    if (!this.job || (this.job.status !== "running" && this.job.status !== "ready")) return
    this.job.status = "discarded"
    this.job.detail = reason
    this.job.controller.abort()
    this.changed()
  }

  /** A detached UI snapshot, never the captured conversation or generated summaries. */
  snapshot(): ArchiveJobStatus | undefined {
    const job = this.job
    if (!job) return undefined
    return {
      id: job.id, status: job.status, startedAt: job.startedAt, updatedAt: job.updatedAt,
      ranges: job.targets.map((target, i) => ({
        start: target.start, end: target.end,
        ...(job.ranges[i]!.topic === undefined ? {} : { topic: job.ranges[i]!.topic }),
      })),
      ...(job.detail === undefined ? {} : { detail: job.detail }),
    }
  }

  private changed() {
    this.job!.updatedAt = Date.now()
    try {
      this.onChange(this.snapshot()!)
    } catch {
      // A status observer must never affect generation or archive commits.
    }
  }

  report(): string {
    const job = this.job
    return job ? `Archive job ${job.id}: ${job.status}${job.detail ? ` — ${job.detail}` : ""}.` : "No archive job."
  }
}
