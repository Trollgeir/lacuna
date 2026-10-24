import { projectContext } from "../projection.ts"
import { archive, ArchiveError, protectedIndexes, refsOf, type RangeInput } from "../state.ts"
import type { SessionState, Unit } from "../types.ts"
import { archivePrompt } from "./prompt.ts"
import { parseRanges } from "./output.ts"
import type { ArchiveJobStatus } from "./status.ts"
import { candidates } from "./candidates.ts"

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

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
    generate: (prompt: string, signal: AbortSignal) => Promise<string>,
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
      protectedRefs: protectedIndexes(job.units).map((index) => refs[index]!),
      candidates: candidates(job.state, job.units),
    })
    void Promise.resolve().then(() => {
      if (job.controller.signal.aborted) return undefined
      return generate(prompt, AbortSignal.any([job.controller.signal, AbortSignal.timeout(300_000)]))
    }).then((output) => {
      if (job.status !== "running") return
      const ranges = parseRanges(output!)
      if (!ranges.length) {
        job.status = "skipped"
      } else {
        job.targets = capture(job.state, job.units, ranges)
        job.ranges = ranges
        job.status = "ready"
      }
      this.changed()
    }).catch((error: unknown) => {
      if (job.status !== "running") return
      job.status = "failed"
      job.detail = reason(error)
      this.changed()
    })
    return job.id
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
      if (projectContext(candidate, units).tokens >= projectContext(state, units).tokens) {
        throw new ArchiveError("The summaries did not reduce context size.")
      }
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
    return job ? `Archive job ${job.id}: ${job.status}${job.detail ? ` — ${job.detail}` : ""}.` : "No background archive job."
  }
}
