import { activeSpans, refsOf } from "./state.ts"
import type { Block, Msg, Part, SessionState, Unit } from "./types.ts"
import { messagesText } from "./units.ts"

const refTag = (ref: string, unit: Unit) => `<ref id="${ref}" kind="${unit.label}"/>`

/** Count projected text, including archive wrappers and content that remains visible. */
export const contextCharacters = (state: SessionState, units: readonly Unit[]): number => messagesText(projectContext(state, units).messages).length

const blockText = (block: Block) => {
  const topic = block.topic ? ` topic="${block.topic.replaceAll('"', "'")}"` : ""
  // A summary quoting the closing tag would otherwise end the block early.
  const summary = block.summary.replaceAll("</archived>", "<\\/archived>")
  return `<archived block="${block.id}" range="${block.start}–${block.end}"${topic}>\n${summary}\n</archived>`
}

// Full-format ref tags only, so prose that mentions a short `<ref id="…"/>` is left alone.
const ECHOED_TAG = /[ \t]*<ref id="[^"]*" kind="[^"]*"\/>[ \t]*\n?/g

/**
 * Models imitate the ref tags they see, and the host stores that text.
 * Strip them so they are not duplicated, counted, or shown to the model as part of the message.
 */
export const stripEchoedTags = (message: Msg): Msg | undefined => {
  if (message.role !== "assistant") return undefined
  let changed = false
  const content = message.content.flatMap((part) => {
    if (part.type !== "text" || typeof part.text !== "string" || !part.text.includes("<ref id=")) return [part]
    const text = part.text.replace(ECHOED_TAG, "")
    if (text === part.text) return [part]
    changed = true
    return text.trim() ? [{ ...part, text }] : []
  })
  return changed ? { ...message, content } : undefined
}

/** Message factory, so the adapter can build host-native message objects. */
export type MakeMessage = (message: Msg) => Msg

interface ContextProjection {
  readonly messages: Msg[]
  readonly tokens: number
  readonly originalTokens: number
  /** Top-level blocks with no surviving members in this transcript. */
  readonly unresolved: readonly string[]
}

const prependText = (message: Msg, text: string): Part[] => [{ type: "text", text }, ...message.content]

/**
 * Put a tag at the start of a tool result's output. Returns undefined for result shapes it cannot carry.
 * Tags never go inside assistant messages: the model imitates whatever its own turns start with.
 */
const tagToolResult = (part: Part, tag: string): Part | undefined => {
  const result = part.result as { type?: string; value?: unknown } | undefined
  if (!result || typeof result !== "object") return undefined
  switch (result.type) {
    case "text":
    case "error-text":
      return { ...part, result: { ...result, value: `${tag}\n${String(result.value ?? "")}` } }
    case "content":
      return Array.isArray(result.value) ? { ...part, result: { ...result, value: [{ type: "text", text: tag }, ...result.value] } } : undefined
    case "json":
    case "error-json":
      return { ...part, result: { type: result.type === "json" ? "text" : "error-text", value: `${tag}\n${JSON.stringify(result.value)}` } }
    default:
      return undefined
  }
}

/** Tags the unit's first tool result. Returns the new messages, or undefined if no result could carry the tag. */
const tagUnitResults = (unit: Unit, tag: string, make: MakeMessage): Msg[] | undefined => {
  let tagged = false
  const messages = unit.messages.map((message) => {
    if (tagged || message.role !== "tool") return message
    const index = message.content.findIndex((part) => part.type === "tool-result")
    if (index === -1) return message
    const part = tagToolResult(message.content[index]!, tag)
    if (!part) return message
    tagged = true
    return make({ ...message, content: message.content.map((existing, j) => (j === index ? part : existing)) })
  })
  return tagged ? messages : undefined
}

export const projectContext = (state: SessionState, units: readonly Unit[], make: MakeMessage = (message) => message): ContextProjection => {
  const refs = refsOf(state, units)
  const active = activeSpans(state, units)
  const resolved = new Set(active.map((span) => span.block.id))
  const unresolved = Object.values(state.blocks).filter((block) => !block.parent && !resolved.has(block.id)).map((block) => block.id)
  const spans = new Map(active.flatMap((span) => span.indexes.map((index) => [index, span] as const)))
  const messages: Msg[] = []
  let tokens = 0
  let originalTokens = 0
  // Tags for assistant replies without tool results ride on the next user-role message.
  let pending: string[] = []
  const takePending = () => {
    const prefix = pending.length ? `${pending.join("\n")}\n` : ""
    pending = []
    return prefix
  }

  for (let i = 0; i < units.length; i++) {
    const span = spans.get(i)
    if (span) {
      if (i === span.from) {
        const text = takePending() + blockText(span.block)
        messages.push(make({ role: "user", content: [{ type: "text", text }] }))
        tokens += Math.ceil(text.length / 4)
      }
      const unit = units[i]!
      originalTokens += unit.tokens
      // Mid-conversation system messages carry host state, so they survive archiving.
      if (unit.role === "system") {
        messages.push(...unit.messages)
        tokens += unit.tokens
      }
      continue
    }

    const unit = units[i]!
    const ref = refs[i]
    const tag = ref ? refTag(ref, unit) : ""
    originalTokens += unit.tokens
    tokens += unit.tokens
    if (unit.role === "system") messages.push(...unit.messages)
    else if (unit.role === "user") {
      const prefix = takePending() + tag
      unit.messages.forEach((message, index) =>
        messages.push(index === 0 && prefix ? make({ ...message, content: prependText(message, prefix) }) : message),
      )
    } else {
      const tagged = ref ? tagUnitResults(unit, tag, make) : undefined
      if (tagged) messages.push(...tagged)
      else {
        messages.push(...unit.messages)
        if (ref) pending.push(tag)
      }
    }
  }

  return { messages, tokens, originalTokens, unresolved }
}
