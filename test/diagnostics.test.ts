import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Schema } from "effect"
import { writeDiagnostic } from "../src/opencode/server/diagnostics.ts"

test("diagnostics redact output and schema input and restrict file permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lacuna-diagnostic-"))
  try {
    let error: unknown
    try { Schema.asserts(Schema.Struct({ count: Schema.Number }), { count: "SECRET_SCHEMA_INPUT" }) } catch (caught) { error = caught }
    assert.ok(error instanceof Error)
    const failure = { jobID: "j2", model: "test/model", error, outputAvailable: true }
    const path = await writeDiagnostic(failure, directory)
    const contents = await readFile(path, "utf8")
    assert.doesNotMatch(contents, /SECRET_/)
    assert.match(contents, /InvalidType/)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
