import { formatTokens } from "./render.ts"
import type { SessionState } from "./types.ts"

export const GUIDANCE = `# Context archive

Your context window is managed by you. Every message has a tag like <ref id="m12" tokens="1.2k" kind="tools:read"/> giving its ID, approximate size, and kind. User messages carry their tag at the start. Your own steps are tagged at the start of their first tool result, or, for replies without tool calls, at the start of the next user message. These tags are metadata added by the host and are invisible to the user; never write them yourself.

Tools:
- archive: move one or more consumed ranges (by start and end ID) out of context into the archive, leaving a summary you write in their place. Nothing is lost. Ranges can cover earlier blocks, which nests them.
- restore: bring an archived block back into context one level (its original messages, or the blocks it contained).
- search_archive: find which block holds a detail, by keyword. Use it before restoring.
- context_status: see usage, blocks, and the largest unarchived ranges.

Archived ranges appear as <archived block="b3" range="m5–m40" ...>summary</archived>. Your archive calls show a placeholder instead of the summary you wrote; the summary was saved and is shown in the block. Archived blocks survive the host's compaction unchanged; compaction only summarises what was never archived.

When to archive: once tool output, exploration, or discussion has been consumed and you have extracted what you need. Do it in batches, not after every step. Never archive content you are actively using. Only the latest user message is protected; everything else can be archived, including work done earlier in the current turn.

Write summaries that let you continue without the original:
- Keep verbatim: file paths with line numbers, function signatures, exact error messages, commands, config keys and values, decisions with their reasons, and short user quotes with their message ID.
- Keep any user request that is still open, marked "Open:".
- Drop: verbose logs, repeated reads, dead ends (keep a one-line lesson).
- Prefer several focused ranges over one huge range.`

/**
 * Token count at which to nudge. Values up to 1 are a fraction of the context window
 * (needs a known limit); larger values are an absolute token count.
 */
export const nudgeThreshold = (nudgeAt: number, limit?: number) => {
  if (nudgeAt > 1) return nudgeAt
  return limit ? limit * nudgeAt : undefined
}

/** Growth past the previous nudge, as a fraction of the threshold, before nudging again. */
const NUDGE_STEP = 0.2

/**
 * Adds a nudge after `anchor` when the context is over the threshold and has grown enough since the last one.
 * Nudges are kept in state rather than added per request: a message that appears at the end of one request and
 * is gone from the next breaks the provider's prompt cache for the whole conversation.
 */
export const addNudge = (state: SessionState, anchor: string, tokens: number, threshold: number, limit?: number) => {
  if (tokens < threshold) {
    delete state.nudgedAt
    return false
  }
  if (state.nudgedAt !== undefined && tokens < state.nudgedAt + threshold * NUDGE_STEP) return false
  state.nudges = { ...state.nudges, [anchor]: nudge(tokens, limit) }
  state.nudgedAt = tokens
  return true
}

export const nudge = (tokens: number, limit?: number) => {
  const usage = limit ? ` of ${formatTokens(limit)} tokens used (${Math.round((tokens / limit) * 100)}%)` : " tokens in context"
  return `[context] ~${formatTokens(tokens)}${usage}. Archive consumed ranges soon; call context_status to see candidates.`
}
