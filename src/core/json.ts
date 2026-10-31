export type JsonResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string }

const parse = (text: string): JsonResult => {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    const match = /\bposition (\d+)/.exec(error.message)
    const position = match ? Math.min(text.length, Number(match[1]))
      : /unexpected end|unterminated/i.test(error.message) ? text.length : undefined
    const description = error.message.replace(/ at position \d+.*$/, "")
    const excerpt = position === undefined
      ? `Response starts with: ${JSON.stringify(text.slice(0, 120))}`
      : `Nearby response excerpt: ${JSON.stringify(text.slice(Math.max(0, position - 60), position))} ${position === text.length ? "⟦UNEXPECTED END⟧" : "⟦ERROR HERE⟧"} ${JSON.stringify(text.slice(position, position + 60))}`
    return { ok: false, error: `Invalid JSON: ${description}. ${excerpt}` }
  }
}

/** Parse any JSON value, including a whole fenced block, with bounded feedback for syntax errors. */
export const parseJson = (text: string): JsonResult => {
  const result = parse(text)
  if (result.ok) return result
  const fenced = /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*\s*$/i.exec(text)
  return fenced ? parse(fenced[1]!) : result
}
