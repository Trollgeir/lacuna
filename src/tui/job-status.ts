import type { ArchiveJobStatus } from "../core/archive/status.ts"

const KEPT = "The job did not change your context. Originals were kept; the agent can retry archiving."

const STATUS: Record<ArchiveJobStatus["status"], { label: (time: string) => string; detail: string; warn?: true }> = {
  running: {
    label: (time) => `running ${time}`,
    detail: "Summarizing in the background. Originals remain visible; you can keep working.",
  },
  ready: {
    label: () => "ready — next request",
    detail: "Summaries are ready. They will replace the originals before the next model request.",
  },
  applied: {
    label: () => "applied",
    detail: "Summaries are now in context. Saved originals can still be restored.",
  },
  skipped: {
    label: () => "nothing to archive",
    detail: "The archive agent chose to keep the current context unchanged.",
  },
  failed: { label: () => "failed — originals kept", detail: KEPT, warn: true },
  discarded: { label: () => "discarded — originals kept", detail: KEPT, warn: true },
}

export const elapsed = (job: ArchiveJobStatus, now: number): string => {
  const end = job.status === "running" ? now : job.updatedAt
  const seconds = Math.max(0, Math.floor((end - job.startedAt) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export const jobWarns = (job: ArchiveJobStatus): boolean => STATUS[job.status].warn === true

export const jobLabel = (job: ArchiveJobStatus, now: number): string =>
  `archive ${job.id} · ${STATUS[job.status].label(elapsed(job, now))}`

export const jobDetails = (job: ArchiveJobStatus, now: number): string => [
  jobLabel(job, now),
  "",
  ...job.ranges.map((range) => `${range.start}–${range.end}${range.topic ? ` · ${range.topic}` : ""}`),
  "",
  STATUS[job.status].detail,
  ...(job.detail ? ["", job.detail] : []),
].join("\n")
