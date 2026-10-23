type Role = "system" | "user" | "assistant" | "tool"

export interface Part {
  readonly type: string
  readonly [key: string]: unknown
}

export interface Msg {
  readonly id?: string
  readonly role: Role
  readonly content: readonly Part[]
  readonly [key: string]: unknown
}

/**
 * An archivable step in the conversation: a user message, a system message, or an
 * assistant message together with the tool results that answer its tool calls.
 * Grouping this way means archiving can never split a tool call from its result.
 */
export interface Unit {
  readonly key: string
  readonly role: "system" | "user" | "assistant"
  readonly messages: readonly Msg[]
  readonly tokens: number
  readonly label: string
  readonly text: string
}

export interface Block {
  readonly id: string
  readonly start: string
  readonly end: string
  readonly summary: string
  readonly topic?: string
  /** Estimated tokens of the original messages the block replaces. */
  readonly tokens: number
  readonly createdAt: number
  /** Blocks that were archived into this one and come back when it is restored. */
  readonly children: readonly string[]
  parent?: string
}

export interface SessionState {
  version: 1
  nextRef: number
  nextBlock: number
  /** Unit key to ref ID, e.g. `msg_abc` → `m12`. */
  refs: Record<string, string>
  blocks: Record<string, Block>
  /** Refs whose original messages are stored, so they outlive compaction. */
  snapshots?: Record<string, true>
  /** Highest ref number a compaction has summarised; stored units up to it are no longer sent by the host. */
  compactedThrough?: number
  /** Nudge text by the ref it follows. Nudges stay where they were first shown, so the prompt prefix stays cacheable. */
  nudges?: Record<string, string>
  /** Context size at the latest nudge; cleared once the context drops below the threshold. */
  nudgedAt?: number
}

export const emptyState = (): SessionState => ({
  version: 1,
  nextRef: 1,
  nextBlock: 1,
  refs: {},
  blocks: {},
})
