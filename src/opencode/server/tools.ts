import type { Plugin } from "@opencode/plugin"
import { ArchiveError } from "../../core/state.ts"

interface Operations {
  archive(sessionID: string): Promise<string>
  restore(sessionID: string, block: string): Promise<string>
  search(sessionID: string, query: string, limit: number): Promise<string>
}

const run = async (fn: () => Promise<string>) => {
  try {
    return { content: await fn() }
  } catch (error) {
    if (error instanceof ArchiveError) return { content: `Error: ${error.message}` }
    throw error
  }
}

export const registerTools = (tool: Plugin.Context["tool"], operations: Operations) =>
  tool.transform((editor) => {
    editor.add({
      name: "archive",
      description: "Request background context cleanup after consuming large amounts of data. The archive agent chooses what to summarize or keep. Returns immediately; completion is silent.",
      input: { type: "object", properties: {}, additionalProperties: false } as never,
      options: { codemode: false },
      execute: async (_input: unknown, context) => run(() => operations.archive(context.sessionID)),
    })

    editor.add({
      name: "restore",
      description:
        "Bring an archived block back into context one level: its original messages come back, or the blocks it contained if it was nested. Use search_archive first to find the right block.",
      input: {
        type: "object",
        properties: { block: { type: "string", description: "Block ID, e.g. b3" } },
        required: ["block"],
        additionalProperties: false,
      } as never,
      options: { codemode: false },
      execute: async (input: unknown, context) =>
        run(() => operations.restore(context.sessionID, (input as { block: string }).block)),
    })

    editor.add({
      name: "search_archive",
      description: "Search archived blocks (their summaries and the original messages they replaced) by keyword.",
      input: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "Max results, default 5" },
        },
        required: ["query"],
        additionalProperties: false,
      } as never,
      options: { codemode: false },
      execute: async (input: unknown, context) => {
        const { query, limit } = input as { query: string; limit?: number }
        return run(() => operations.search(context.sessionID, query, limit ?? 5))
      },
    })
  })
