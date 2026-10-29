export type ValidationIssue =
  | { kind: "expected-object" }
  | { kind: "missing-field" | "unexpected-field" | "field-type" | "empty-field"; field: string }
  | { kind: "unknown-ref" | "unavailable-block"; side: "start" | "end"; ref: string }
  | { kind: "reversed-range"; start: string; end: string }
  | { kind: "protected-message"; start: string; end: string; ref: string }
  | { kind: "partial-block"; start: string; end: string; block: string; blockStart: string; blockEnd: string }
  | { kind: "empty-source"; start: string; end: string }
  | { kind: "summary-size"; start: string; end: string; percentage: number }
  | { kind: "staged-overlap" | "overlap" }
  | { kind: "combined-size"; percentage: number }

export interface ValidationError {
  /** Zero-based indexes of the rejected entries; empty for a batch-wide issue. */
  entries: number[]
  issue: ValidationIssue
}

/** Presentation only; validators return data rather than repair instructions. */
export const formatIssue = (issue: ValidationIssue): string => {
  switch (issue.kind) {
    case "expected-object": return "Expected an object with start, end, summary, and optional topic."
    case "missing-field": return `Missing required field "${issue.field}".`
    case "unexpected-field": return `Unexpected field "${issue.field}".`
    case "field-type": return `Field "${issue.field}" must be a string.`
    case "empty-field": return `Field "${issue.field}" must contain non-whitespace text.`
    case "unknown-ref": return `${issue.side}: Unknown ref "${issue.ref}". Use the m# or b# IDs shown in context.`
    case "unavailable-block": return `${issue.side}: Block ${issue.ref} is nested inside another block or no longer in context.`
    case "reversed-range": return `Range ${issue.start}–${issue.end} is reversed.`
    case "protected-message": return `Range ${issue.start}–${issue.end} includes ${issue.ref}, the latest user message, which must stay visible.`
    case "partial-block": return `Range ${issue.start}–${issue.end} partially overlaps block ${issue.block} (${issue.blockStart}–${issue.blockEnd}). Widen the range to include the whole block, or start/end at ${issue.block}.`
    case "empty-source": return `Range ${issue.start}–${issue.end} has no visible text to reduce. Omit this range.`
    case "summary-size": return `Range ${issue.start}–${issue.end}: summary size is ${issue.percentage.toFixed(1)}% of the source; it must be below 100%. Shorten the summary or omit this range.`
    case "staged-overlap": return "Overlaps an already accepted range. Do not resubmit accepted ranges."
    case "overlap": return "Overlap. Replace both with non-overlapping ranges."
    case "combined-size": return `Combined summary size is ${issue.percentage.toFixed(1)}% of the previous visible context; it must be below 100%. Shorten the summaries or omit ranges.`
  }
}

export const formatValidationError = ({ entries, issue }: ValidationError): string => {
  const prefix = entries.length === 1 ? `Entry ${entries[0]! + 1}: `
    : entries.length > 1 ? `Entries ${entries.map((index) => index + 1).join(" and ")}: ` : ""
  return prefix + formatIssue(issue)
}
