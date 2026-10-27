import { GenerationOptions } from "@opencode/ai/effect"
import { Model } from "@opencode/plugin"
import { Schema } from "effect"
import { ArchiveError } from "../../core/state.ts"
import type { ModelContext } from "./host.ts"

const requestOptions = Schema.StructWithRest(
  Schema.Struct(GenerationOptions.fields),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

export interface Options {
  /** Automatic archive threshold: a fraction of the context window (≤ 1) or an absolute token count (> 1). */
  readonly archiveAt: number
  readonly archiveMode: "background" | "blocking"
  readonly archiveModel?: {
    /** Omit to inherit the primary model, including its variant and request overrides. */
    readonly model?: Model.Ref
    readonly options: ModelContext["options"]
  }
}

export const readOptions = (raw: unknown): Options => {
  const { archiveAt, archiveMode = "background", archiveModel } = (raw ?? {}) as { archiveAt?: unknown; archiveMode?: unknown; archiveModel?: unknown }
  if (archiveMode !== "background" && archiveMode !== "blocking") {
    throw new ArchiveError('archiveMode must be "background" or "blocking".')
  }
  let archive: Options["archiveModel"]
  if (archiveModel !== undefined) {
    if (typeof archiveModel !== "object" || archiveModel === null || Array.isArray(archiveModel)) {
      throw new ArchiveError("archiveModel must be an object with an optional model reference and request options.")
    }
    const { model, options } = archiveModel as { model?: unknown; options?: unknown }
    if (model !== undefined && (typeof model !== "string" || !/^[^/\s#]+\/[^\s#]+(?:#[^\s#]+)?$/.test(model))) {
      throw new ArchiveError("archiveModel.model must be an OpenCode model reference: provider/model or provider/model#variant.")
    }
    if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) {
      throw new ArchiveError("archiveModel.options must be an object of request overrides.")
    }
    let overrides: ModelContext["options"]
    try {
      // Decoding returns readonly types; the isolated clone is owned by the mutable request hook.
      overrides = structuredClone(Schema.decodeUnknownSync(requestOptions)(options ?? {})) as ModelContext["options"]
    } catch (error) {
      throw new ArchiveError(`Invalid archiveModel.options: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (overrides.maxTokens !== undefined && (!Number.isSafeInteger(overrides.maxTokens) || overrides.maxTokens <= 0)) {
      throw new ArchiveError("archiveModel.options.maxTokens must be a positive integer.")
    }
    archive = { ...(typeof model === "string" ? { model: Model.Ref.parse(model) } : {}), options: structuredClone(overrides) }
  }
  return {
    archiveAt: typeof archiveAt === "number" && archiveAt > 0 ? archiveAt : 200_000,
    archiveMode,
    ...(archive ? { archiveModel: archive } : {}),
  }
}
