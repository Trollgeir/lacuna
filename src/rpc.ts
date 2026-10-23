import { Rpc } from "@opencode/plugin/rpc"

export interface Stats {
  readonly sessionID: string
  /** Estimated tokens currently removed from the context by archiving. */
  readonly archived: number
}

const stats = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    archived: { type: "number" },
  },
  required: ["sessionID", "archived"],
  additionalProperties: false,
} as const

/** Contract between the server plugin and the terminal footer. */
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
        properties: { stats: stats },
        additionalProperties: false,
      },
    },
  },
  events: {
    stats: { schema: stats },
  },
})
