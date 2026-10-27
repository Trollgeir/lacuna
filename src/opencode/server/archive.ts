import type { Model, Plugin } from "@opencode/plugin"
import { ArchiveError } from "../../core/state.ts"
import { forkRequest, modelKey, type ModelContext } from "./host.ts"
import type { Options } from "./options.ts"

export const archiveExecution = async (
  ctx: Pick<Plugin.Context, "model" | "session">,
  config: Options["archiveModel"],
  factorFor: (model: string) => Promise<number>,
) => {
  const forks = new Map<string, { sessionID: string; ownerID: string; request: ModelContext; model: Model.Ref }>()
  let disposed = false

  await ctx.session.hook("generate", (event) => {
    // Match our unique suffix, not just the session: /btw may run concurrently.
    const suffix = event.messages.at(-1)
    const prompt = suffix?.role === "user" && suffix.content.length === 1 && suffix.content[0]?.type === "text"
      ? suffix.content[0].text : undefined
    const fork = typeof prompt === "string" ? forks.get(prompt) : undefined
    if (!fork || fork.sessionID !== event.sessionID) return
    const request = fork.request
    if (disposed || modelKey(event.model) !== modelKey(fork.model)) {
      throw new ArchiveError("The model changed before the archive fork could start.")
    }
    if (!config?.model && Object.keys(request.tools).some((name) => !(name in event.tools))) {
      throw new ArchiveError("The tool catalog changed before the archive fork could start.")
    }
    event.system = request.system
    event.messages = [...request.messages, suffix!]
    event.tools = request.tools
    event.options = config ? { ...(config.model ? event.options : request.options), ...structuredClone(config.options) } : request.options
  })

  return {
    /** Capture now, not after waiting for an earlier worker to stop. */
    capture(primary: ModelContext) {
      const request = forkRequest(primary)
      const ownerID = request.sessionID
      const marker = `<lacuna-job id="${crypto.randomUUID()}"/>`
      return async (instructions: string, signal: AbortSignal): Promise<string> => {
        if (disposed) throw new ArchiveError("Lacuna has unloaded.")
        signal.throwIfAborted()
        const prompt = `${marker}\n${instructions}`
        let temporaryID: string | undefined
        try {
          const model = config?.model ?? request.model
          if (config && (config.model || Object.keys(config.options).length)) {
            const { data } = await ctx.model.list(undefined, { signal })
            const selected = data.find((info) => info.providerID === model.providerID && info.id === model.id && info.enabled !== false)
            if (!selected) throw new ArchiveError(`archiveModel ${model.providerID}/${model.id} is not available in OpenCode.`)
            if (model.variant && !selected.variants.some((variant) => variant.id === model.variant)) {
              throw new ArchiveError(`archiveModel variant ${model.variant} is not registered for ${model.providerID}/${model.id}.`)
            }
            const factor = await factorFor(`${model.providerID}/${model.id}`)
            const estimate = Math.ceil(JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools, prompt }).length / 4 * factor)
            const output = config.options.maxTokens ?? (config.model ? undefined : request.options.maxTokens) ?? selected.limit.output
            if (output > selected.limit.output) {
              throw new ArchiveError(`archiveModel.options.maxTokens exceeds ${model.providerID}/${model.id}'s output limit of ${selected.limit.output}.`)
            }
            const budget = Math.min(selected.limit.input ?? Infinity, selected.limit.context - output)
            if (!(budget > 0) || estimate > budget) {
              throw new ArchiveError(`archiveModel ${model.providerID}/${model.id} has insufficient input capacity: approximately ${estimate} tokens needed, ${Math.max(0, budget)} available.`)
            }
            if (config.model) {
              const parent = await ctx.session.get({ sessionID: ownerID }, { signal })
              const child = await ctx.session.create({ parentID: ownerID, title: "Lacuna archive", agent: request.agent, model, location: parent.location }, { signal })
              temporaryID = child.id
            }
          }
          signal.throwIfAborted()
          const sessionID = temporaryID ?? ownerID
          forks.set(prompt, { sessionID, ownerID, request, model })
          const result = await ctx.session.generate({ sessionID, prompt }, { signal })
          return result.text
        } finally {
          forks.delete(prompt)
          if (temporaryID) await ctx.session.remove({ sessionID: temporaryID })
        }
      }
    },
    forget(sessionID: string) {
      for (const [prompt, fork] of forks) if (fork.ownerID === sessionID) forks.delete(prompt)
    },
    dispose() {
      disposed = true
      forks.clear()
    },
  }
}
