import { refsOf } from "./state.ts"
import type { Block, SessionState, Unit } from "./types.ts"

interface SearchHit {
  readonly block: Block
  readonly score: number
  readonly snippets: readonly string[]
}

const terms = (query: string) =>
  query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 1)

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

const snippet = (text: string, term: string, radius = 120) => {
  const at = text.toLowerCase().indexOf(term)
  if (at === -1) return undefined
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + term.length + radius)
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ")}${end < text.length ? "…" : ""}`
}

/**
 * Ranks blocks by matches in their summary (weighted) and in the original
 * messages they replaced, so details dropped from a summary can still be found.
 */
export const search = (state: SessionState, units: readonly Unit[], query: string, limit = 5): SearchHit[] => {
  const words = terms(query)
  if (!words.length) return []
  const index = new Map(refsOf(state, units).map((ref, i) => [ref, i]))

  return Object.values(state.blocks)
    .map((block) => {
      const from = index.get(block.start)
      const to = index.get(block.end)
      const original = from === undefined || to === undefined ? "" : units.slice(from, to + 1).map((unit) => unit.text).join("\n")
      const summary = `${block.topic ?? ""}\n${block.summary}`
      const lowerSummary = summary.toLowerCase()
      const lowerOriginal = original.toLowerCase()
      const score = words.reduce((sum, word) => sum + 3 * count(lowerSummary, word) + count(lowerOriginal, word), 0)
      const snippets = words
        .map((word) => snippet(summary, word) ?? snippet(original, word))
        .filter((value): value is string => Boolean(value))
      return { block, score, snippets: [...new Set(snippets)].slice(0, 3) }
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
