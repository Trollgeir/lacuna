import assert from "node:assert/strict"
import { test } from "node:test"
import { parseJson } from "../src/core/json.ts"

test("parses arbitrary JSON values without imposing an archive schema", () => {
  for (const value of [null, true, 42, "hello", [], { nested: [1, "two"] }]) {
    assert.deepEqual(parseJson(JSON.stringify(value)), { ok: true, value })
  }
})

test("malformed JSON returns model-friendly excerpts around the fault", () => {
  for (const [text, excerpt] of [
    ['{"value":1}}', '⟦ERROR HERE⟧ "}"'],
    ['[1, 2,]', 'Response starts with: "[1, 2,]"'],
    ['{"value":}', 'Response starts with: "{\\"value\\":}"'],
    ['{"value":"unterminated', '⟦UNEXPECTED END⟧ ""'],
    ['{"value":1', '⟦UNEXPECTED END⟧ ""'],
    ["", '⟦UNEXPECTED END⟧ ""'],
  ]) {
    const result = parseJson(text)
    assert.equal(result.ok, false, text)
    if (result.ok) continue
    assert.match(result.error, /^Invalid JSON:/)
    assert.ok(result.error.includes(excerpt), result.error)
    assert.doesNotMatch(result.error, /at position \d+/)
  }
})

test("JSON feedback remains bounded for large responses and faults without a position", () => {
  for (const text of ['{"value":"' + "a".repeat(10_000) + '"}}', "not JSON " + "a".repeat(10_000)]) {
    const result = parseJson(text)
    assert.equal(result.ok, false)
    if (result.ok) continue
    assert.ok(result.error.length < 500, result.error)
    assert.match(result.error, /Nearby response excerpt:|Response starts with:/)
  }
})
