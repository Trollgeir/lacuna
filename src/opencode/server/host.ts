import type { Plugin } from "@opencode/plugin"
import { Media, Message } from "@opencode/ai/effect"
import { stripEchoedTags, type MakeMessage } from "../../core/projection.ts"
import type { Msg } from "../../core/types.ts"

export type ModelContext = Extract<Parameters<Parameters<Plugin.Context["session"]["hook"]>[1]>[0], { tools: unknown; messages: unknown }>

export const modelKey = (model: ModelContext["model"]) => `${model.providerID}/${model.id}#${model.variant === "default" ? "" : model.variant ?? ""}`

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
  const messages = request.messages.map((message) => {
    // Host and plugin can load distinct copies of @opencode/ai. Each validates
    // Media.Asset by identity, so preserve the constructors from the host.
    const MessageCtor = message.constructor === Object ? Message : message.constructor as typeof Message
    return new MessageCtor({
      ...structuredClone({ ...message, content: [] }),
      content: message.content.map((part) => {
        if (part.type !== "media") return structuredClone(part)
        const AssetCtor = part.media.constructor as typeof Media.Asset
        return {
          ...structuredClone({ ...part, media: undefined }),
          media: new AssetCtor({
            source: structuredClone(part.media.source),
            info: structuredClone(part.media.info),
            providerMetadata: structuredClone(part.media.providerMetadata),
            headers: structuredClone(part.media.headers),
          }),
        }
      }),
    })
  })
  return {
    ...request,
    model: { ...request.model },
    system: structuredClone(request.system),
    messages,
    tools: structuredClone(request.tools),
    options: structuredClone(request.options),
  }
}
