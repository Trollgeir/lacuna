import { ArchiveError } from "../state.ts"
import { parseJson } from "../json.ts"
import type { ValidationIssue } from "../validation.ts"

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

export const entryErrors = (value: unknown): ValidationIssue[] => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [{ kind: "expected-object" }]
  const range = value as Record<string, unknown>
  const { properties, required, additionalProperties } = outputSchema.items
  const errors: ValidationIssue[] = []
  for (const key of required) {
    if (!Object.hasOwn(range, key)) errors.push({ kind: "missing-field", field: key })
  }
  if (!additionalProperties) {
    for (const key of Object.keys(range)) {
      if (!Object.hasOwn(properties, key)) errors.push({ kind: "unexpected-field", field: key })
    }
  }
  for (const [key, field] of Object.entries(properties)) {
    if (!Object.hasOwn(range, key)) continue
    const text = range[key]
    if (typeof text !== field.type) errors.push({ kind: "field-type", field: key })
    else if (typeof text === "string" && (("minLength" in field && text.length < field.minLength) ||
      ("pattern" in field && !new RegExp(field.pattern).test(text)))) errors.push({ kind: "empty-field", field: key })
  }
  return errors
}

export const parseEntries = (output: string): unknown[] => {
  const result = parseJson(output)
  if (!result.ok) throw new ArchiveError(result.error)
  const ranges = result.value
  if (!Array.isArray(ranges)) throw new ArchiveError("Expected a JSON array of archive ranges.")
  return ranges
}
