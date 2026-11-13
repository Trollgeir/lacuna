import type { Plugin } from "@opencode/plugin"
import { Media, Message } from "@opencode/ai/effect"
import { stripEchoedTags, type MakeMessage } from "../../core/projection.ts"
import type { Msg } from "../../core/types.ts"

export type ModelContext = Extract<Parameters<Parameters<Plugin.Context["session"]["hook"]>[1]>[0], { tools: unknown; messages: unknown }>

export const modelKey = (model: ModelContext["model"]) => `${model.providerID}/${model.id}#${model.variant === "default" ? "" : model.variant ?? ""}`

// OpenCode adds hook-only metadata outside the Message schema; constructors discard it.
const withMetadata = <T extends object>(copy: T, metadata: unknown): T =>
  metadata === undefined ? copy : Object.assign(copy, { metadata })

export const makerFor = (incoming: readonly Msg[]): MakeMessage => {
  const constructors = new Map(incoming.map((message) => [message.role, message.constructor as new (input: Msg) => Msg]))
  return (message) => {
    try {
      const Ctor = constructors.get(message.role)
      const copy = Ctor ? new Ctor(message) : Message.make(message as Parameters<typeof Message.make>[0]) as unknown as Msg
      return withMetadata(copy, message.metadata)
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
    const copy = {
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
    } as typeof message
    const metadata = (copy as typeof copy & { readonly metadata?: unknown }).metadata
    if (message.constructor === Object) return withMetadata(Message.make(copy as Parameters<typeof Message.make>[0]), metadata)
    const MessageCtor = message.constructor as new (input: typeof message) => typeof message
    return withMetadata(new MessageCtor(copy), metadata)
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
