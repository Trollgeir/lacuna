/** Values up to 1 are a fraction of the context window; larger values are absolute token counts. */
export const archiveThreshold = (archiveAt: number, limit?: number) =>
  archiveAt > 1 ? archiveAt : limit ? limit * archiveAt : undefined

/** Every attempt, including no-ops and failures, requires 20% of the threshold in new context before retrying. */
export class ArchiveTrigger {
  private baseline?: number

  recordAttempt(tokens: number): void {
    this.baseline = tokens
  }

  shouldStart(tokens: number, threshold: number | undefined): boolean {
    if (threshold === undefined) return false
    if (tokens < threshold) {
      this.baseline = undefined
      return false
    }
    if (this.baseline !== undefined) {
      this.baseline = Math.min(this.baseline, tokens)
      if (tokens < this.baseline + threshold * 0.2) return false
    }
    this.recordAttempt(tokens)
    return true
  }
}
