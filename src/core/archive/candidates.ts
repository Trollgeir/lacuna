import { activeSpans, protectedIndexes, refsOf } from "../state.ts"
import type { SessionState, Unit } from "../types.ts"

const MIN_CANDIDATE_TOKENS = 1_000

export interface Candidate {
  readonly start: string
  readonly end: string
  readonly tokens: number
}

/** Role-contiguous spans split by archives and protected messages, ranked by estimated size. */
export const candidates = (state: SessionState, units: readonly Unit[], limit = 5): Candidate[] => {
  const refs = refsOf(state, units)
  const spans = activeSpans(state, units)
  const barriers = [
    ...spans.flatMap((span) => span.indexes.map((index) => ({ from: index, to: index }))),
    ...protectedIndexes(units).map((index) => ({ from: index, to: index })),
    ...units.flatMap((unit, index) => unit.key ? [] : [{ from: index, to: index }]),
  ].sort((a, b) => a.from - b.from)
  const runs: (Candidate & { from: number })[] = []
  let from = 0
  const flush = (to: number) => {
    let start = from
    while (start <= to) {
      let end = start
      while (end < to && units[end + 1]!.role === units[start]!.role) end++
      const slice = units.slice(start, end + 1)
      runs.push({ from: start, start: refs[start]!, end: refs[end]!, tokens: slice.reduce((sum, unit) => sum + unit.tokens, 0) })
      start = end + 1
    }
  }
  for (const barrier of barriers) {
    flush(barrier.from - 1)
    from = Math.max(from, barrier.to + 1)
  }
  flush(units.length - 1)
  return runs.filter((range) => range.tokens >= MIN_CANDIDATE_TOKENS)
    .sort((a, b) => b.tokens - a.tokens || b.from - a.from).slice(0, limit).map(({ from: _from, ...range }) => range)
}
