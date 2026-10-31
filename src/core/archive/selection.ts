import { contextCharacters } from "../projection.ts"
import { archive, inspectRange, type RangeInput } from "../state.ts"
import type { SessionState, Unit } from "../types.ts"
import { entryErrors } from "./output.ts"
import { candidateSuggestions } from "./prompt.ts"
import type { Candidate } from "./candidates.ts"
import type { ValidationError } from "../validation.ts"

export const TARGET_REDUCTION = 0.2

/** Validate on clones, retaining independent entries without choosing winners among conflicts. */
export const stageRanges = (state: SessionState, units: readonly Unit[], staged: readonly RangeInput[], entries: readonly unknown[]) => {
  const errors: ValidationError[] = []
  const candidates = entries.flatMap((entry, index) => {
    const raw = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as Record<string, unknown> : {}
    const issues = entryErrors(entry)
    const bounds = inspectRange(state, units, raw)
    issues.push(...bounds.errors)
    const range: RangeInput | undefined = typeof raw.start === "string" && typeof raw.end === "string" && typeof raw.summary === "string" && raw.summary.trim()
      ? { start: raw.start, end: raw.end, summary: raw.summary.trim(), ...(typeof raw.topic === "string" ? { topic: raw.topic } : {}) } : undefined
    // Size needs usable bounds and summary text, but extra fields must not hide a size error.
    if (range && !bounds.errors.length && bounds.from !== undefined && bounds.to !== undefined) {
      const copy = structuredClone(state)
      // Include the eventual ID's wrapper cost (conservative when earlier entries are rejected).
      copy.nextBlock += staged.length + index
      archive(copy, units, [range])
      const selected = units.slice(bounds.from, bounds.to + 1)
      const source = contextCharacters(state, selected)
      const replacement = contextCharacters(copy, selected)
      if (!source) issues.push({ kind: "empty-source", start: range.start, end: range.end })
      else if (replacement >= source) {
        issues.push({ kind: "summary-size", start: range.start, end: range.end, percentage: replacement / source * 100 })
      }
    }
    errors.push(...issues.map((issue) => ({ entries: [index], issue })))
    // Invalid entries with known, ordered bounds still participate in overlap detection.
    return bounds.from !== undefined && bounds.to !== undefined && bounds.from <= bounds.to
      ? [{ range, from: bounds.from, to: bounds.to, index, valid: !issues.length && range !== undefined }] : []
  })
  const acceptedSpans = staged.length ? archive(structuredClone(state), units, staged) : []
  const conflicts = new Set<number>()
  const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) => a.from <= b.to && b.from <= a.to
  for (const candidate of candidates) {
    if (acceptedSpans.some((span) => overlaps(candidate, span))) {
      conflicts.add(candidate.index)
      errors.push({ entries: [candidate.index], issue: { kind: "staged-overlap" } })
    }
    for (const other of candidates) {
      if (other.index <= candidate.index || !overlaps(candidate, other)) continue
      conflicts.add(candidate.index)
      conflicts.add(other.index)
      errors.push({ entries: [candidate.index, other.index], issue: { kind: "overlap" } })
    }
  }
  const ranges = [...staged, ...candidates.flatMap((candidate) => candidate.valid && !conflicts.has(candidate.index) ? [candidate.range!] : [])]
  return { ranges, errors, rejected: entries.length - (ranges.length - staged.length) }
}

/** Measure the entire projected context and expose the staged state for candidate generation. */
export const archivePlan = (state: SessionState, units: readonly Unit[], ranges: readonly RangeInput[]) => {
  const projected = structuredClone(state)
  if (ranges.length) archive(projected, units, ranges)
  const before = contextCharacters(state, units)
  const after = contextCharacters(projected, units)
  return { ranges, projected, before, after, reduction: before ? (before - after) / before : 0 }
}

/** Report original source spans not fully covered, regardless of repair splitting or merging. */
export const uncoveredSources = (state: SessionState, units: readonly Unit[], entries: readonly unknown[], ranges: readonly RangeInput[]) => {
  const covered = ranges.length ? archive(structuredClone(state), units, ranges).sort((a, b) => a.from - b.from) : []
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return []
    const bounds = inspectRange(state, units, entry)
    // Unresolvable endpoints do not identify source material whose coverage can be measured.
    if (bounds.from === undefined || bounds.to === undefined) return []
    const from = Math.min(bounds.from, bounds.to)
    const to = Math.max(bounds.from, bounds.to)
    let next = from
    for (const span of covered) {
      if (span.from > next) break
      if (span.to >= next) next = span.to + 1
      if (next > to) return []
    }
    return [{ from, to }]
  })
}

export interface ArchiveFeedback {
  readonly prompt: string
  readonly output: string
}

export type ArchiveGenerate = (prompt: string, signal: AbortSignal, history?: readonly ArchiveFeedback[]) => Promise<string>

/** Render accepted entries independently of the reason for the follow-up. */
export const formatArchivePlan = (ranges: readonly RangeInput[]): string => {
  if (!ranges.length) return ""
  const entries = ranges.map((range) => `- ${range.start}–${range.end}${range.topic ? `: ${range.topic}` : ""}`).join("\n")
  return `## Archive plan\n\n${entries}\n\nThese entries do not need to be reapplied.`
}

export const repairPrompt = (errors: readonly string[], plan: ReturnType<typeof archivePlan>, suggestions?: readonly Candidate[]): string => {
  const sections = [formatArchivePlan(plan.ranges)]
  if (errors.length) sections.push(`## Validation errors\n\n${errors.map((error) => `- ${error}`).join("\n")}`)
  if (suggestions !== undefined) {
    const hints = suggestions.length ? candidateSuggestions(suggestions) : "\n\nNo candidate suggestions were found; you may choose other eligible ranges."
    sections.push(`## Low context reduction:\n\nThe archive plan currently only reduces context by approximately ${(plan.reduction * 100).toFixed(2)}%. The target is ${TARGET_REDUCTION * 100}%; consider archiving more.\n\nHere are some hints:${hints}`)
  }
  sections.push("## Output\n\nReturn ONLY new non-overlapping ranges that are not already defined in our current archive plan in the same json schema.")
  return sections.filter(Boolean).join("\n\n")
}
