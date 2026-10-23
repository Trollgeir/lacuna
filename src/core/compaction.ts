import { activeSpans, refsOf } from "./state.ts"
import type { Msg, SessionState, Unit } from "./types.ts"
import { groupUnits } from "./units.ts"

const refNumber = (ref: string) => Number(ref.slice(1))

/**
 * Units inside archived ranges whose original messages are not stored yet.
 * Compaction drops the host's copies, so the originals must be kept to restore or search a block later.
 */
export const unsnapshotted = (state: SessionState, units: readonly Unit[]): { ref: string; unit: Unit }[] => {
  const refs = refsOf(state, units)
  const stored = state.snapshots ?? {}
  return activeSpans(state, units).flatMap((span) =>
    units
      .slice(span.from, span.to + 1)
      .map((unit, i) => ({ ref: refs[span.from + i]!, unit }))
      .filter(({ ref }) => !stored[ref]),
  )
}

export const markSnapshotted = (state: SessionState, refs: readonly string[]) => {
  state.snapshots ??= {}
  for (const ref of refs) state.snapshots[ref] = true
}

const CHECKPOINT = "<conversation-checkpoint>"

/**
 * Stored units that compaction removed from the host transcript, oldest first.
 * Only units older than the latest checkpoint in the transcript count: units missing after it were
 * reverted, and reverting past every checkpoint brings the host's own copies back.
 */
export const detachedRefs = (state: SessionState, units: readonly Unit[]): string[] => {
  const through = state.compactedThrough
  if (!through) return []
  const checkpoint = units.findLast((unit) => unit.role === "user" && unit.text.includes(CHECKPOINT))
  if (!checkpoint) return []
  const before = Math.min(through, refNumber(state.refs[checkpoint.key]!) - 1)
  const present = new Set(refsOf(state, units))
  return Object.keys(state.snapshots ?? {})
    .filter((ref) => refNumber(ref) <= before && !present.has(ref))
    .sort((a, b) => refNumber(a) - refNumber(b))
}

/** Rebuilds a stored unit from its messages, under its original key so it keeps its ref. */
export const unitFromSnapshot = (key: string, messages: readonly Msg[]): Unit | undefined => {
  const units = groupUnits(messages)
  return units.length === 1 ? { ...units[0]!, key } : undefined
}

/**
 * Prepare a compaction: drop messages that are already archived, so the summary covers only
 * what was never archived, and remember which refs the compaction will remove.
 * `context` is the full unit list, including detached units, used to find archived ranges.
 */
export const prepareCompaction = (state: SessionState, context: readonly Unit[], incoming: readonly Unit[]): Msg[] => {
  const refs = refsOf(state, context)
  const archived = new Set(activeSpans(state, context).flatMap((span) => refs.slice(span.from, span.to + 1)))
  const numbers = refsOf(state, incoming).map(refNumber)
  if (numbers.length) state.compactedThrough = Math.max(state.compactedThrough ?? 0, ...numbers)
  return incoming.filter((unit) => !archived.has(state.refs[unit.key]!)).flatMap((unit) => unit.messages)
}
