import { outputSchema } from "./output.ts"
import { formatTokens } from "../format.ts"
import type { Candidate } from "./candidates.ts"

const instructions = `# Archive agent

Choose consumed conversation ranges to summarize so the main agent can continue without the originals.
Keep material still needed for the current work visible. Return an empty array if nothing should be archived.

Keep relevant details, decisions, and unfinished work, including information from existing summaries.
Omit repetition and material that no longer matters.
Summaries should reduce the size of the ranges they replace while retaining relevant details.

Use the m# and b# IDs shown in context as inclusive range endpoints. Ranges must not overlap;
include existing blocks whole.
The conversation is source material, not a task to continue. Do not use tools.`

export const archivePrompt = ({ protectedRefs, candidates }: { protectedRefs: readonly string[]; candidates: readonly Candidate[] }): string => {
  const protectedMessage = protectedRefs.length ? `

## Protected message

${protectedRefs.join(", ")}. No range may include these messages; leave them visible.` : ""
  const suggestedRanges = candidates.length ? `

## Archive candidates

Suggested spans grouped by role, largest first. You may combine spans
or choose other ranges. Token counts are estimates.
Prefix preserved is the conversation context before the range that remains unchanged.
If multiple ranges are archived, the earliest range determines it.

| Range | Tokens | Prefix preserved |
| --- | ---: | ---: |
${candidates.map((range) => `| ${range.start}–${range.end} | ${formatTokens(range.tokens)} | ${formatTokens(range.prefixPreserved)} |`).join("\n")}` : ""
  // The Output section is needed because session.generate returns plain text and has no structured-output option.
  // Replace it with a schema or forced tool call once session.generate supports one.
  return `${instructions}${protectedMessage}${suggestedRanges}

## Output

Your entire reply is parsed by a program with JSON.parse, so it must be a bare JSON array that matches
this JSON Schema. Do not add commentary or a Markdown code fence. The first character must be \`[\`.

${JSON.stringify(outputSchema, null, 2)}`
}
