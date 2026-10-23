import { formatTokens } from "./render.ts"
import { activeSpans, protectedIndexes, refsOf } from "./state.ts"
import type { SessionState, Unit } from "./types.ts"

interface Candidate {
  readonly start: string
  readonly end: string
  readonly tokens: number
  readonly units: number
}

/** Largest unarchived, unprotected runs: the best places to archive next. */
export const candidates = (state: SessionState, units: readonly Unit[], limit = 5): Candidate[] => {
  const refs = refsOf(state, units)
  const spans = activeSpans(state, units)
  const barriers = [
    ...spans.map((span) => ({ from: span.from, to: span.to })),
    ...protectedIndexes(units).map((index) => ({ from: index, to: index })),
  ].sort((a, b) => a.from - b.from)
  const runs: Candidate[] = []
  let from = 0
  const flush = (to: number) => {
    if (to < from) return
    const slice = units.slice(from, to + 1)
    runs.push({ start: refs[from]!, end: refs[to]!, units: slice.length, tokens: slice.reduce((sum, unit) => sum + unit.tokens, 0) })
  }
  for (const barrier of barriers) {
    flush(barrier.from - 1)
    from = Math.max(from, barrier.to + 1)
  }
  flush(units.length - 1)
  return runs.sort((a, b) => b.tokens - a.tokens).slice(0, limit)
}

interface StatusInput {
  readonly state: SessionState
  readonly units: readonly Unit[]
  readonly tokens: number
  readonly originalTokens: number
  readonly limit?: number
  /** Corrected size of an estimate (see calibration.ts). Defaults to the raw estimate. */
  readonly scale?: (estimate: number) => number
  /** System prompt and tool definitions, which cannot be archived. */
  readonly overhead?: number
}

export const statusReport = ({ state, units, tokens: rawTokens, originalTokens, limit, scale = (n) => n, overhead = 0 }: StatusInput) => {
  const blocks = Object.values(state.blocks)
  const top = activeSpans(state, units).map((span) => span.block)
  const tokens = overhead + scale(rawTokens)
  const usage = limit ? ` of ${formatTokens(limit)} (${Math.round((tokens / limit) * 100)}%)` : ""
  const fixed = overhead ? ` (~${formatTokens(overhead)} of it system prompt and tools)` : ""
  const lines = [
    `Context: ~${formatTokens(tokens)} tokens${usage}${fixed}; ~${formatTokens(overhead + scale(originalTokens))} without archiving.`,
    `Blocks: ${top.length} top-level, ${blocks.length - top.length} nested.`,
  ]
  for (const block of top) {
    lines.push(`- ${block.id} ${block.start}–${block.end}: ~${formatTokens(scale(block.tokens))} → ~${formatTokens(scale(Math.ceil(block.summary.length / 4)))}${block.topic ? ` · ${block.topic}` : ""}`)
  }
  const runs = candidates(state, units)
  if (runs.length) {
    lines.push("Largest unarchived ranges (the latest user message is protected):")
    for (const run of runs) lines.push(`- ${run.start}–${run.end}: ~${formatTokens(scale(run.tokens))} tokens, ${run.units} messages`)
  }
  return lines.join("\n")
}
