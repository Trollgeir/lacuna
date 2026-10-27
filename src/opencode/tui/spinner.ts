import type { ArchiveJobStatus } from "../../core/archive/status.ts"

const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
export const SPINNER_INTERVAL = 80

/** Only generation spins; ready summaries are waiting for the next request. */
export const archiveSpinner = (job: ArchiveJobStatus | undefined, now: number): string => {
  if (job?.status !== "running") return ""
  return frames[Math.floor(Math.max(0, now - job.startedAt) / SPINNER_INTERVAL) % frames.length]!
}
