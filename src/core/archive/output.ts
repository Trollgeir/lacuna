import { ArchiveError, type RangeInput } from "../state.ts"

export const outputSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      start: { type: "string" },
      end: { type: "string" },
      summary: { type: "string", minLength: 1, pattern: "\\S" },
      topic: { type: "string" },
    },
    required: ["start", "end", "summary"],
    additionalProperties: false,
  },
} as const

const validRange = (value: unknown): value is RangeInput => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const range = value as Record<string, unknown>
  const { properties, required, additionalProperties } = outputSchema.items
  if (required.some((key) => !Object.hasOwn(range, key))) return false
  if (!additionalProperties && Object.keys(range).some((key) => !Object.hasOwn(properties, key))) return false
  return Object.entries(properties).every(([key, field]) => {
    if (!Object.hasOwn(range, key)) return true
    const text = range[key]
    if (typeof text !== field.type) return false
    if (typeof text !== "string") return false
    return (!("minLength" in field) || text.length >= field.minLength) &&
      (!("pattern" in field) || new RegExp(field.pattern).test(text))
  })
}

export const parseRanges = (output: string): RangeInput[] => {
  const ranges: unknown = JSON.parse(output)
  if (!Array.isArray(ranges) || !ranges.every(validRange)) {
    throw new ArchiveError("Expected an array of ranges with start, end, summary, and optional topic.")
  }
  return ranges.map((range) => ({ ...range, summary: range.summary.trim() }))
}
