import type { Plugin } from "@opencode/plugin"
import { Media, Message } from "@opencode/ai"
import { stripEchoedTags, type MakeMessage } from "../core/projection.ts"
import type { Msg } from "../core/types.ts"

export type ModelContext = Extract<Parameters<Parameters<Plugin.Context["session"]["hook"]>[1]>[0], { tools: unknown; messages: unknown }>

export const makerFor = (incoming: readonly Msg[]): MakeMessage => {
  const Ctor = incoming[0]?.constructor as (new (input: Msg) => Msg) | undefined
  return (message) => {
    if (!Ctor) return message
    try {
      return new Ctor(message)
    } catch {
      return message
    }
  }
}

export const stripAll = (incoming: readonly Msg[], make: MakeMessage) =>
  incoming.map((message) => {
    const stripped = stripEchoedTags(message)
    return stripped ? make(stripped) : message
  })

export const forkRequest = (request: ModelContext): ModelContext => {
  // Assets have private caches and methods: structuredClone alone would destroy them.
  const messages = request.messages.map((message) => new Message({
    ...structuredClone({ ...message, content: [] }),
    content: message.content.map((part) => part.type === "media" ? {
      ...structuredClone({ ...part, media: undefined }),
      media: new Media.Asset({
        source: structuredClone(part.media.source),
        info: structuredClone(part.media.info),
        providerMetadata: structuredClone(part.media.providerMetadata),
        headers: structuredClone(part.media.headers),
      }),
    } : structuredClone(part)),
  }))
  return {
    ...request,
    model: { ...request.model },
    system: structuredClone(request.system),
    messages,
    tools: structuredClone(request.tools),
    options: structuredClone(request.options),
  }
}
