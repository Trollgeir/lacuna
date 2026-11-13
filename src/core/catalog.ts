import { createHash } from "node:crypto"
import { refsOf } from "./state.ts"
import type { CatalogMarker, SessionState, Unit } from "./types.ts"

const UPDATE = "The Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.\n\n# Code Mode\n"

const catalog = (unit: Unit) => {
  const content = unit.messages[0]?.content
  return unit.role === "system" && unit.messages.length === 1 && content?.length === 1 &&
    content[0]?.type === "text" && typeof content[0].text === "string" && content[0].text.startsWith(UPDATE)
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const key = (marker: CatalogMarker) => JSON.stringify(marker)
// Hook-only metadata may change without changing the model's transcript. IDs are
// represented by refs and can be remapped when a session is forked.
const fingerprint = (units: readonly Unit[]) => digest(structuredClone(units.map((unit) => unit.messages.map((message) => {
  const { id, metadata, ...visible } = message
  return visible
}))))

/**
 * OpenCode's system messages lack IDs. Anchor each anonymous run to the next durable
 * ref and fingerprint the entire run, so later appends cannot acquire its identity.
 * An unanchored tail is left visible rather than risking a false match.
 */
const markers = (state: SessionState, units: readonly Unit[]) => {
  const refs = refsOf(state, units)
  const found: { unit: Unit; marker: CatalogMarker; index: number }[] = []
  let start = 0
  for (let i = 0; i < units.length; i++) {
    const ref = refs[i]
    if (!ref) continue
    const gap = units.slice(start, i)
    if (gap.some(catalog)) {
      const hash = fingerprint(gap)
      gap.forEach((unit, offset) => {
        if (catalog(unit)) found.push({ unit, marker: { before: ref, offset, digest: hash }, index: start + offset })
      })
    }
    const unit = units[i]!
    if (catalog(unit)) found.push({ unit, marker: { ref, digest: fingerprint([unit]) }, index: i })
    start = i + 1
  }
  return found
}

/** Only previously committed decisions apply; losing the replacement makes the original visible again. */
export const hiddenCatalogs = (state: SessionState, units: readonly Unit[]): ReadonlySet<Unit> => {
  if (!state.catalogPruning?.length) return new Set()
  const available = new Map(markers(state, units).map((entry) => [key(entry.marker), entry]))
  const hidden = new Set<Unit>()
  for (const { target, replacement } of state.catalogPruning) {
    const old = available.get(key(target))
    const next = available.get(key(replacement))
    if (old && next && old.index < next.index) hidden.add(old.unit)
  }
  return hidden
}

/** Stage pruning together with archive summaries, without touching the original transcript. */
export const pruneCatalogs = (state: SessionState, units: readonly Unit[]) => {
  const found = markers(state, units)
  // A catalog in the anonymous tail cannot be safely identified, even as a replacement.
  const lastCatalog = units.findLastIndex(catalog)
  const replacement = found.find((entry) => entry.index === lastCatalog)
  if (!replacement) return
  const hidden = hiddenCatalogs(state, units)
  const decisions = found.slice(0, -1).filter(({ unit }) => !hidden.has(unit))
    .map(({ marker: target }) => ({ target, replacement: replacement.marker }))
  if (decisions.length) state.catalogPruning = [...(state.catalogPruning ?? []), ...decisions]
}
