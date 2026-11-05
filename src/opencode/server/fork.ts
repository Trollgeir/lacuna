import type { Plugin } from "@opencode/plugin"
import { ArchiveError } from "../../core/state.ts"
import type { Msg, SessionState } from "../../core/types.ts"

type Context = Plugin.Context
type Fork = NonNullable<Awaited<ReturnType<Context["session"]["get"]>>["fork"]>
type History = Awaited<ReturnType<Context["session"]["context"]>>[number]

const signature = (message: History) => JSON.stringify([message.type, message.time.created])
const tools = (message: History) => message.type === "assistant"
  ? message.content.flatMap((part) => part.type === "tool" ? [`tool:${part.id}`] : [])
  : []
const nativeMessages = (message: History) => {
  const value = message.type === "compaction" && message.status === "completed" ? message.native?.messages : undefined
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !("role" in item) || typeof item.role !== "string") return []
    return [{ id: item.id, role: item.role }]
  })
}

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
  const keys = (message: History) => [message.id, ...tools(message), ...nativeMessages(message).map((item) => item.id)]
  const parentKeys = new Set(parent.flatMap(keys))
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
  // Native checkpoints can retain messages under their original IDs, unlike ordinary forked rows.
  // Match them only inside the copied checkpoint, and only when each ID occurs once in both windows.
  const checkpoint = parent.findLast((message) => message.type === "compaction" && message.status === "completed")
  if (checkpoint && mapped.has(checkpoint.id)) {
    const copy = candidates.find((message) => message.id === mapped.get(checkpoint.id))
    const windowIDs = (message: History) => {
      const ids = new Map<string, string | undefined>()
      for (const item of nativeMessages(message)) ids.set(item.id, ids.has(item.id) ? undefined : item.role)
      return ids
    }
    const parentWindow = windowIDs(checkpoint)
    const childWindow = copy ? windowIDs(copy) : new Map<string, string | undefined>()
    for (const [id, role] of parentWindow) {
      if (role && role === childWindow.get(id) && !mapped.has(id)) mapped.set(id, id)
    }
    // Compacted originals absent from both windows have only their Lacuna snapshots.
    for (const key of state.compactedKeys ?? []) {
      const ref = state.refs[key]
      if (ref && state.snapshots?.[ref] && !mapped.has(key) && !parentKeys.has(key) && !childWindow.has(key)) {
        mapped.set(key, `lacuna-fork:${sessionID}:${ref}`)
      }
    }
  }
  const before = new Set(included.flatMap(keys))
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
  if (!Object.keys(original.refs).length && !Object.keys(original.blocks).length && !Object.keys(original.snapshots ?? {}).length) return structuredClone(original)
  const [parent, child] = await Promise.all([ctx.session.context({ sessionID: fork.sessionID }), ctx.session.context({ sessionID })])
  // An old boundary can disappear from the parent's active history. Without archives there is no
  // content to protect, so preserve the allocation watermark rather than blocking the fork.
  if (!Object.keys(original.blocks).length && !Object.keys(original.snapshots ?? {}).length && !parent.some((message) => message.id === fork.boundary.messageID)) {
    return { ...structuredClone(original), refs: {} }
  }
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
