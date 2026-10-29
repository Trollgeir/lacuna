import { contextCharacters } from "../projection.ts"
import { archive, inspectRange, type RangeInput } from "../state.ts"
import type { SessionState, Unit } from "../types.ts"
import { entryErrors } from "./output.ts"
import type { ValidationError } from "../validation.ts"

/** Validate on clones, retaining independent entries without choosing winners among conflicts. */
export const stageRanges = (state: SessionState, units: readonly Unit[], staged: readonly RangeInput[], entries: readonly unknown[]) => {
  const errors: ValidationError[] = []
  const before = contextCharacters(state, units)
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
      else if (replacement >= source || contextCharacters(copy, units) >= before) {
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
  // Recheck together: wrappers and nested blocks must be valid in the combined result too.
  if (ranges.length) {
    const copy = structuredClone(state)
    archive(copy, units, ranges)
    const after = contextCharacters(copy, units)
    if (after >= before) {
      errors.push({ entries: [], issue: { kind: "combined-size", percentage: before > 0 ? after / before * 100 : 100 } })
      ranges.splice(staged.length)
    }
  }
  return { ranges, errors, rejected: entries.length - (ranges.length - staged.length) }
}

export interface ArchiveFeedback {
  readonly prompt: string
  readonly output: string
}

export type ArchiveGenerate = (prompt: string, signal: AbortSignal, history?: readonly ArchiveFeedback[]) => Promise<string>

export const repairPrompt = (errors: readonly string[], staged: readonly RangeInput[]): string => `Your previous archive response failed validation:
${errors.map((error) => `- ${error}`).join("\n")}

${staged.length ? `These ranges are already accepted and staged: ${staged.map((range) => `${range.start}–${range.end}`).join(", ")}. Do not repeat their summaries. This response is a patch: return ONLY replacements for rejected entries. You may omit any rejected entries to leave their source visible. Return [] to omit all rejected entries; the already accepted ranges will still be applied.` : "Return the complete corrected archive selection."}
Return a bare JSON array matching the original schema, without commentary or Markdown fences. Each summary must be below 100% of its source size. Do not overlap accepted ranges or other replacements. Nothing has been applied yet.`
