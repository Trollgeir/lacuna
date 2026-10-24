import { Schema } from "effect"

export const archiveJobStatus = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["running", "ready", "applied", "skipped", "failed", "discarded"]),
  startedAt: Schema.Finite,
  updatedAt: Schema.Finite,
  ranges: Schema.Array(Schema.Struct({
    start: Schema.String,
    end: Schema.String,
    topic: Schema.optionalKey(Schema.String),
  })),
  detail: Schema.optionalKey(Schema.String),
})

export type ArchiveJobStatus = typeof archiveJobStatus.Type
