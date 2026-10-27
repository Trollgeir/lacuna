import assert from "node:assert/strict"
import { test } from "node:test"
import type { ArchiveJobStatus } from "../src/core/archive/status.ts"
import type { Stats } from "../src/opencode/rpc.ts"
import { connectStatusFeed, StatusFeed } from "../src/opencode/tui/state.ts"

const job = (status: ArchiveJobStatus["status"] = "running"): ArchiveJobStatus => ({
  id: "j1", status, startedAt: 1000, updatedAt: 62000,
  ranges: [{ start: "m1", end: "m20", topic: "Config investigation" }],
})
const stats = (status: ArchiveJobStatus["status"] = "running", sessionID = "s1"): Stats => ({
  sessionID, archived: 100, job: job(status),
})

test("footer snapshots and events use the session location", async () => {
  const location = { directory: "/workspace/lacuna", workspaceID: "w1" }
  const current: Stats = { sessionID: "s1", archived: 300_000, unresolved: ["b1"] }
  let event!: (value: { location: typeof location; data: Stats }) => void
  const { feed, dispose } = connectStatusFeed({
    stats: async (_input, options) => {
      assert.deepEqual(options?.location, location)
      return { stats: current }
    },
    events: { on: (_name, handler) => { event = handler; return () => {} } },
  }, () => location, () => {})
  try {
    await feed.fetch("s1")
    assert.equal(feed.get("s1")!.archived, current.archived)
    assert.deepEqual(feed.get("s1")!.unresolved, ["b1"])
    for (const other of [
      { directory: "/workspace", workspaceID: "w1" },
      { directory: location.directory, workspaceID: "w2" },
    ]) {
      event({ location: other, data: { sessionID: "s1", archived: 0 } })
      assert.equal(feed.get("s1")!.archived, current.archived)
    }
    event({ location, data: { sessionID: "s1", archived: 0, unresolved: [] } })
    assert.equal(feed.get("s1")!.archived, 0)
    assert.deepEqual(feed.get("s1")!.unresolved, [])
  } finally {
    dispose()
  }
})

test("live status wins over an older snapshot; empty snapshots clear only their session", async () => {
  let resolve!: (value: Stats | undefined) => void
  const snapshot = new Promise<Stats | undefined>((yes) => { resolve = yes })
  const feed = new StatusFeed(() => snapshot, () => {})
  try {
    const fetch = feed.fetch("s1")
    feed.update(stats("ready"))
    resolve(stats("running"))
    await fetch
    assert.equal(feed.get("s1")!.job!.status, "ready")
  } finally {
    feed.dispose()
  }

  const empty = new StatusFeed(async () => undefined, () => {})
  try {
    empty.update(stats("running", "s1"))
    empty.update(stats("ready", "s2"))
    await empty.fetch("s1")
    assert.equal(empty.get("s1")!.job, undefined)
    assert.equal(empty.get("s2")!.job!.status, "ready")
  } finally {
    empty.dispose()
  }
})
