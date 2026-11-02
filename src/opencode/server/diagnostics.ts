import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { SchemaIssue } from "effect"

/** Schema issue inputs, paths and custom messages can contain conversation data. */
const issueTags = (value: unknown): string[] => {
  if (!SchemaIssue.isIssue(value)) return []
  const tags: string[] = [value._tag]
  if ("issue" in value) tags.push(...issueTags(value.issue))
  if ("issues" in value) for (const issue of value.issues) tags.push(...issueTags(issue))
  return tags
}

export const writeDiagnostic = async (failure: {
  jobID: string
  model: string
  error: unknown
  outputAvailable: boolean
}, directory = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "lacuna", "diagnostics")): Promise<string> => {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${Date.now()}-${crypto.randomUUID()}.json`)
  const cause = failure.error instanceof Error ? failure.error.cause : undefined
  const diagnostic = {
    timestamp: new Date().toISOString(),
    jobID: failure.jobID,
    model: failure.model,
    errorType: failure.error instanceof Error ? failure.error.name : typeof failure.error,
    schemaIssueTags: issueTags(cause),
    outputAvailable: failure.outputAvailable,
  }
  await writeFile(path, JSON.stringify(diagnostic, null, 2) + "\n", { mode: 0o600, flag: "wx" })
  return path
}
