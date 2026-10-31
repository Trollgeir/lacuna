import { outputSchema } from "./output.ts"
import { formatTokens } from "../format.ts"
import type { Candidate } from "./candidates.ts"

const instructions = `# Archive agent

Choose consumed conversation ranges to summarize so the main agent can continue without the originals.
Keep material still needed for the current work visible. Return an empty array if nothing should be archived.

Keep relevant details, decisions, and unfinished work, including information from existing summaries.
Omit repetition and material that no longer matters.
Summaries should reduce the size of the ranges they replace while retaining relevant details.
Each summary must be below 100% of its source size.

Use the m# and b# IDs shown in context as inclusive range endpoints. Ranges must not overlap;
include existing blocks whole.
The conversation is source material, not a task to continue. Do not use tools.`

/** Suggestions are advisory and only added to the follow-up when the plan falls short. */
export const candidateSuggestions = (candidates: readonly Candidate[]): string => candidates.length ? `

Suggested spans grouped by role, largest first. You may combine spans
or choose other ranges. Token counts are estimates.

| Range | Estimated tokens |
| --- | ---: |
${candidates.map(({ start, end, tokens }) => `| ${start}–${end} | ${formatTokens(tokens)} |`).join("\n")}` : ""

export const archivePrompt = ({ protectedRefs }: { protectedRefs: readonly string[] }): string => {
  const protectedMessage = protectedRefs.length ? `

## Protected message

${protectedRefs.join(", ")}. No range may include these messages; leave them visible.` : ""
  // The Output section is needed because session.generate returns plain text and has no structured-output option.
  // Replace it with a schema or forced tool call once session.generate supports one.
  return `${instructions}${protectedMessage}

## Output

Your entire reply is parsed by a program with JSON.parse, so it must be a bare JSON array that matches
this JSON Schema. Do not add commentary or a Markdown code fence. The first character must be \`[\`.

${JSON.stringify(outputSchema, null, 2)}`
}
