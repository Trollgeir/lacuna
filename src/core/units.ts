import type { Msg, Part, Unit } from "./types.ts"

const MEDIA_TOKENS = 1_000

const estimateTokens = (chars: number) => Math.ceil(chars / 4)

const stringify = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}

const toolResultText = (result: unknown): string => {
  if (!result || typeof result !== "object") return stringify(result)
  const { type, value } = result as { type?: string; value?: unknown }
  if (type === "content" && Array.isArray(value)) {
    return value.map((item) => (item?.type === "text" ? String(item.text) : `[file ${item?.name ?? item?.uri ?? ""}]`)).join("\n")
  }
  return stringify(value)
}

const partText = (part: Part): string => {
  switch (part.type) {
    case "text":
    case "reasoning":
      return String(part.text ?? "")
    case "tool-call":
      return `${String(part.name)}(${stringify(part.input)})`
    case "tool-result":
      return toolResultText(part.result)
    case "media":
      return "[media]"
    default:
      return ""
  }
}

const partTokens = (part: Part) => (part.type === "media" ? MEDIA_TOKENS : estimateTokens(partText(part).length))

/** Provider-independent text representation, shared by size checks and unit previews. */
export const messagesText = (messages: readonly Msg[]): string => messages
  .flatMap((message) => message.content)
  .map(partText)
  .filter(Boolean)
  .join("\n")

const messageTokens = (message: Msg) => message.content.reduce((sum, part) => sum + partTokens(part), 4)

const unitKey = (message: Msg) => {
  if (message.id) return message.id
  const result = message.content.find((part) => part.type === "tool-result")
  if (result && typeof result.id === "string") return `tool:${result.id}`
  return undefined
}

const labelFor = (role: Unit["role"], messages: readonly Msg[]) => {
  if (role !== "assistant") return role
  const tools = [
    ...new Set(
      messages
        .flatMap((message) => message.content)
        .filter((part) => part.type === "tool-call")
        .map((part) => String(part.name)),
    ),
  ]
  return tools.length ? `tools:${tools.join(",")}` : "assistant"
}

const makeUnit = (key: string | undefined, role: Unit["role"], messages: Msg[]): Unit => ({
  key,
  role,
  messages,
  tokens: messages.reduce((sum, message) => sum + messageTokens(message), 0),
  label: labelFor(role, messages),
  text: messagesText(messages),
})

export const groupUnits = (messages: readonly Msg[]): Unit[] => {
  const groups: { key?: string; role: Unit["role"]; messages: Msg[] }[] = []
  messages.forEach((message) => {
    const last = groups.at(-1)
    if (message.role === "tool" && last?.role === "assistant") {
      last.messages.push(message)
      return
    }
    const role = message.role === "tool" ? "user" : message.role
    groups.push({ key: unitKey(message), role, messages: [message] })
  })
  return groups.map((group) => makeUnit(group.key, group.role, group.messages))
}
