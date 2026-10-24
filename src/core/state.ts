import type { Block, SessionState, Unit } from "./types.ts"

const formatRef = (n: number) => `m${n}`

/** Lookups ignore leading zeros, so `m0012` and `m12` name the same unit. */
const normalizeRef = (id: string) => id.replace(/^m0+(?=\d)/, "m")

/** Gives identifiable units a stable ref. Returns true when new refs were assigned. */
export const assignRefs = (state: SessionState, units: readonly Unit[]) => {
  let changed = false
  for (const unit of units) {
    if (!unit.key || state.refs[unit.key]) continue
    state.refs[unit.key] = formatRef(state.nextRef++)
    changed = true
  }
  return changed
}

export const refsOf = (state: SessionState, units: readonly Unit[]) => units.map((unit) => unit.key ? state.refs[unit.key] : undefined)

interface Span {
  readonly block: Block
  readonly from: number
  readonly to: number
  readonly indexes: readonly number[]
}

/** Resolve captured membership against the current transcript, including nested blocks. */
export const blockSpan = (block: Block, units: readonly Unit[]): Span | undefined => {
  const keys = new Set(block.unitKeys)
  const indexes = units.flatMap((unit, i) => unit.key && keys.has(unit.key) ? [i] : [])
  return indexes.length ? { block, indexes, from: indexes[0]!, to: indexes.at(-1)! } : undefined
}

/** Top-level blocks with at least one surviving member, in transcript order. */
export const activeSpans = (state: SessionState, units: readonly Unit[]): Span[] =>
  Object.values(state.blocks)
    .filter((block) => !block.parent)
    .flatMap((block) => {
      const span = blockSpan(block, units)
      return span ? [span] : []
    })
    .sort((a, b) => a.from - b.from)

/** Protect the latest user message if identifiable; unidentified units always stay visible. */
export const protectedIndexes = (units: readonly Unit[]): number[] => {
  const user = units.findLastIndex((unit) => unit.role === "user")
  return user === -1 || !units[user]!.key ? [] : [user]
}

export interface RangeInput {
  readonly start: string
  readonly end: string
  readonly summary: string
  readonly topic?: string
}

export class ArchiveError extends Error {}

const resolveEndpoint = (state: SessionState, index: Map<string, number>, spans: Span[], id: string, side: "start" | "end") => {
  const trimmed = id.trim()
  const block = state.blocks[trimmed]
  if (block) {
    const span = spans.find((candidate) => candidate.block.id === block.id)
    if (!span) throw new ArchiveError(`Block ${trimmed} is nested inside another block or no longer in context.`)
    return side === "start" ? span.from : span.to
  }
  const position = index.get(normalizeRef(trimmed))
  if (position === undefined) throw new ArchiveError(`Unknown ref "${trimmed}". Use the m# or b# IDs shown in context.`)
  return position
}

interface ArchiveResult {
  readonly block: Block
  readonly from: number
  readonly to: number
  readonly messages: number
}

/** Retain missing child members in their captured order while weaving in newly archived units. */
const capturedKeys = (units: readonly Unit[], children: readonly Block[]): string[] => {
  const cursors = new Map<string, number>()
  const last = new Map(children.map((child) => [child.id, units.findLastIndex((unit) => child.unitKeys.includes(unit.key!))]))
  return units.flatMap((unit, index) => {
    if (!unit.key) return []
    const child = children.find((child) => child.unitKeys.includes(unit.key!))
    if (!child) return [unit.key!]
    const from = cursors.get(child.id) ?? 0
    const to = Math.max(from, index === last.get(child.id) ? child.unitKeys.length : child.unitKeys.indexOf(unit.key!) + 1)
    cursors.set(child.id, to)
    return child.unitKeys.slice(from, to)
  })
}

export const archive = (
  state: SessionState,
  units: readonly Unit[],
  ranges: readonly RangeInput[],
  now = Date.now(),
): ArchiveResult[] => {
  if (!ranges.length) throw new ArchiveError("Provide at least one range.")
  const refs = refsOf(state, units)
  const index = new Map(refs.flatMap((ref, i) => ref ? [[normalizeRef(ref), i] as const] : []))
  const spans = activeSpans(state, units)
  const guarded = protectedIndexes(units)

  const errors: string[] = []
  const check = (range: RangeInput) => {
    if (!range.summary?.trim()) throw new ArchiveError(`Range ${range.start}–${range.end} has an empty summary.`)
    const from = resolveEndpoint(state, index, spans, range.start, "start")
    const to = resolveEndpoint(state, index, spans, range.end, "end")
    if (from > to) throw new ArchiveError(`Range ${range.start}–${range.end} is reversed.`)
    const hit = guarded.find((index) => from <= index && index <= to)
    if (hit !== undefined) {
      throw new ArchiveError(`Range ${range.start}–${range.end} includes ${refs[hit]}, the latest user message, which must stay visible.`)
    }
    for (const span of spans) {
      const overlaps = span.indexes.some((index) => from <= index && index <= to)
      const contains = span.indexes.every((index) => from <= index && index <= to)
      if (overlaps && !contains) {
        throw new ArchiveError(
          `Range ${range.start}–${range.end} partially overlaps block ${span.block.id} (${span.block.start}–${span.block.end}). Widen the range to include the whole block, or start/end at ${span.block.id}.`,
        )
      }
    }
    return { range, from, to }
  }
  const resolved = ranges.flatMap((range) => {
    try {
      return [check(range)]
    } catch (error) {
      if (!(error instanceof ArchiveError)) throw error
      errors.push(error.message)
      return []
    }
  })

  const ordered = [...resolved].sort((a, b) => a.from - b.from)
  ordered.slice(1).forEach((current, i) => {
    const previous = ordered[i]!
    if (current.from <= previous.to) {
      errors.push(`Ranges ${previous.range.start}–${previous.range.end} and ${current.range.start}–${current.range.end} overlap.`)
    }
  })

  if (errors.length) {
    const list = errors.length === 1 ? errors[0]! : errors.map((error) => `- ${error}`).join("\n")
    throw new ArchiveError(`${list}\nNothing was archived. Fix ${errors.length === 1 ? "this" : "these"} and send the whole call again.`)
  }

  return resolved.map(({ range, from, to }) => {
    const selected = units.slice(from, to + 1)
    const identifiable = selected.filter((unit) => unit.key)
    const children = spans.filter((span) => span.indexes.every((index) => from <= index && index <= to)).map((span) => span.block)
    const id = `b${state.nextBlock++}`
    const block: Block = {
      id,
      start: refs[from]!,
      end: refs[to]!,
      unitKeys: capturedKeys(selected, children),
      summary: range.summary.trim(),
      topic: range.topic?.trim() || undefined,
      tokens: identifiable.reduce((sum, unit) => sum + unit.tokens, 0),
      createdAt: now,
      children: children.map((child) => child.id),
    }
    for (const child of children) child.parent = id
    state.blocks[id] = block
    return { block, from, to, messages: identifiable.length }
  })
}

/** Removes a block and promotes its children, restoring one level of detail. */
export const restore = (state: SessionState, id: string): Block => {
  const block = state.blocks[id.trim()]
  if (!block) throw new ArchiveError(`Unknown block "${id}".`)
  if (block.parent) throw new ArchiveError(`Block ${block.id} is nested inside ${block.parent}. Restore ${block.parent} first.`)
  for (const childID of block.children) {
    const child = state.blocks[childID]
    if (child) delete child.parent
  }
  delete state.blocks[block.id]
  return block
}
