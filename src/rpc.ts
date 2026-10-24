import { Rpc } from "@opencode/plugin/rpc"
import { Schema } from "effect"
import { archiveJobStatus } from "./core/archive/status.ts"

const stats = Schema.Struct({
  sessionID: Schema.String,
  /** Estimated tokens currently removed from the context by archiving. */
  archived: Schema.Finite,
  /** Block IDs whose summaries cannot be placed because no captured members are present. */
  unresolved: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Summaries await application, or context changes await a completed primary response. */
  changed: Schema.optionalKey(Schema.Boolean),
  job: Schema.optionalKey(archiveJobStatus),
})

export type Stats = typeof stats.Type

const statsJsonSchema = {
  ...Schema.toJsonSchemaDocument(stats, { onExcessProperty: "error" }).schema,
  type: "object" as const,
}

/** Contract between the server plugin and the terminal's context/job status. */
export const Lacuna = Rpc.define({
  id: "lacuna",
  methods: {
    stats: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { stats: statsJsonSchema },
        additionalProperties: false,
      },
    },
  },
  events: {
    stats: { schema: statsJsonSchema },
  },
})
