import type { Plugin } from "@opencode/plugin"
import { ArchiveError } from "../../core/state.ts"
import { emptyState, type Msg, type SessionState } from "../../core/types.ts"

type Context = Plugin.Context
type Fork = NonNullable<Awaited<ReturnType<Context["session"]["get"]>>["fork"]>
type History = Awaited<ReturnType<Context["session"]["context"]>>[number]

const signature = (message: History) => JSON.stringify([message.type, message.time.created])
const tools = (message: History) => message.type === "assistant"
  ? message.content.flatMap((part) => part.type === "tool" ? [`tool:${part.id}`] : [])
  : []

/** Translate the parent's identities to the copies OpenCode gave the fork. */
const identities = (parent: History[], child: History[], fork: Fork, created: number, state: SessionState, sessionID: string) => {
  const boundary = parent.findIndex((message) => message.id === fork.boundary.messageID)
  if (boundary < 0) throw new ArchiveError("Cannot find the fork boundary in the parent's active history. No context was sent.")
  const included = parent.slice(0, boundary + (fork.boundary.type === "through" ? 1 : 0))
  const candidates = child.filter((message) => message.time.created <= created)
  const bySignature = (messages: History[]) => {
    const grouped = new Map<string, History[]>()
    for (const message of messages) {
      const key = signature(message)
      const group = grouped.get(key)
      if (group) group.push(message)
      else grouped.set(key, [message])
    }
    return grouped
  }
  const parents = bySignature(included)
  const children = bySignature(candidates)
  const parentKeys = new Set(parent.flatMap((message) => [message.id, ...tools(message)]))
  const mapped = new Map<string, string>()
  for (const message of included) {
    const key = signature(message)
    const matches = children.get(key) ?? []
    if (parents.get(key)!.length !== 1 || matches.length !== 1) continue
    const copy = matches[0]!
    mapped.set(message.id, copy.id)
    const copiedTools = new Set(tools(copy))
    for (const tool of tools(message)) if (copiedTools.has(tool)) mapped.set(tool, tool)
  }
  // Compacted originals no longer appear in either active history. They are safe to inherit only
  // when the fork contains the same checkpoint that made the parent's snapshots detached.
  const checkpoint = parent.findLast((message) => message.type === "compaction" && message.status === "completed")
  if (checkpoint && mapped.has(checkpoint.id)) {
    for (const key of state.compactedKeys ?? []) {
      const ref = state.refs[key]
      if (ref && state.snapshots?.[ref] && !mapped.has(key) && !parentKeys.has(key)) {
        mapped.set(key, `lacuna-fork:${sessionID}:${ref}`)
      }
    }
  }
  const before = new Set(included.flatMap((message) => [message.id, ...tools(message)]))
  const translate = (key: string) => {
    const result = mapped.get(key)
    if (result) return result
    if (!parentKeys.has(key) || before.has(key)) throw new ArchiveError("Cannot safely match archived messages in the fork. No context was sent.")
    return undefined
  }
  return { mapped, translate }
}

/** Copy only complete summaries, promoting complete children of a block cut by the fork. */
export const inheritFork = async (ctx: Context, sessionID: string, fork: Fork, created: number, original: SessionState): Promise<SessionState> => {
  if (!Object.keys(original.blocks).length && !Object.keys(original.snapshots ?? {}).length) return emptyState()
  const [parent, child] = await Promise.all([ctx.session.context({ sessionID: fork.sessionID }), ctx.session.context({ sessionID })])
  const { mapped, translate } = identities(parent, child, fork, created, original, sessionID)
  const state = structuredClone(original)
  state.refs = Object.fromEntries(Object.entries(original.refs).flatMap(([key, ref]) => {
    const copy = mapped.get(key)
    return copy ? [[copy, ref]] : []
  }))
  state.blocks = Object.fromEntries(Object.entries(original.blocks).flatMap(([id, block]) => {
    const keys = block.unitKeys.map(translate)
    return keys.every((key): key is string => key !== undefined) ? [[id, { ...block, unitKeys: keys }]] : []
  }))
  const covered = new Set(Object.values(state.blocks).flatMap((block) => block.unitKeys))
  for (const block of Object.values(original.blocks)) {
    if (block.parent || state.blocks[block.id]) continue
    if (block.unitKeys.some((key) => mapped.has(key) && !covered.has(mapped.get(key)!))) {
      throw new ArchiveError("The fork cuts through an archived block. Restore that block in the parent before forking. No context was sent.")
    }
  }
  state.blocks = Object.fromEntries(Object.entries(state.blocks).map(([id, block]) => {
    const { parent, ...rest } = block
    return [id, { ...rest, ...(parent && state.blocks[parent] ? { parent } : {}), children: block.children.filter((child) => state.blocks[child]) }]
  }))
  if (state.compactedKeys) state.compactedKeys = state.compactedKeys.flatMap((key) => mapped.get(key) ? [mapped.get(key)!] : [])
  const refs = new Set(Object.values(state.refs))
  state.snapshots = Object.fromEntries(Object.keys(original.snapshots ?? {}).filter((ref) => refs.has(ref)).map((ref) => [ref, true]))
  const snapshots = Object.keys(state.snapshots)
  for (let i = 0; i < snapshots.length; i += 32) {
    await Promise.all(snapshots.slice(i, i + 32).map(async (ref) => {
      const stored = await ctx.storage.get(`snapshot/${fork.sessionID}/${ref}`) as { key?: string; messages?: Msg[] } | undefined
      if (!stored?.key || !Array.isArray(stored.messages) || !mapped.has(stored.key)) {
        throw new ArchiveError("Cannot copy an archived original into the fork. No context was sent.")
      }
      const messages = stored.messages.map((message) => message.id && mapped.has(message.id) ? { ...message, id: mapped.get(message.id) } : message)
      await ctx.storage.set(`snapshot/${sessionID}/${ref}`, JSON.parse(JSON.stringify({ key: mapped.get(stored.key), messages })))
    }))
  }
  return state
}
