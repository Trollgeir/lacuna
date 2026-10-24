import type { Stats } from "../rpc.ts"

interface Location {
  directory: string
  workspaceID?: string
}

interface StatsClient {
  stats(input: { sessionID: string }, options?: { location: Location }): Promise<unknown>
  events: { on(name: "stats", handler: (event: { location: Location; data: unknown }) => void): () => void }
}

/** RPC defaults and events can span locations; use the session's current instance for both. */
export const connectStatusFeed = (
  rpc: StatsClient,
  locationFor: (sessionID: string) => Location,
  onChange: (stats: Stats) => void,
) => {
  const feed = new StatusFeed(
    async (sessionID) => (await rpc.stats({ sessionID }, { location: locationFor(sessionID) }) as { stats?: Stats }).stats,
    onChange,
  )
  const stop = rpc.events.on("stats", (event) => {
    const stats = event.data as Stats
    const location = locationFor(stats.sessionID)
    if (event.location.directory !== location.directory || event.location.workspaceID !== location.workspaceID) return
    feed.update(stats)
  })
  return { feed, dispose: () => { stop(); feed.dispose() } }
}

/** Live events win over an older in-flight snapshot. Fetch on mount so revisits recover missed events. */
export class StatusFeed {
  private readonly values = new Map<string, Stats>()
  private readonly revisions = new Map<string, number>()
  private readonly pending = new Map<string, Promise<void>>()
  private disposed = false
  private readonly read: (sessionID: string) => Promise<Stats | undefined>
  private readonly onChange: (stats: Stats) => void

  constructor(
    read: (sessionID: string) => Promise<Stats | undefined>,
    onChange: (stats: Stats) => void,
  ) {
    this.read = read
    this.onChange = onChange
  }

  update(stats: Stats) {
    if (this.disposed) return
    this.revisions.set(stats.sessionID, (this.revisions.get(stats.sessionID) ?? 0) + 1)
    this.values.set(stats.sessionID, stats)
    this.onChange(stats)
  }

  async fetch(sessionID: string): Promise<void> {
    if (this.disposed) return
    const existing = this.pending.get(sessionID)
    if (existing) return existing
    const revision = this.revisions.get(sessionID) ?? 0
    const request = Promise.resolve().then(() => this.read(sessionID)).then((stats) => {
      if ((this.revisions.get(sessionID) ?? 0) === revision) this.update(stats ?? { sessionID, archived: 0 })
    }).catch(() => {
      // The server may be reloading or disconnected. The next mount/detail request retries.
    }).finally(() => this.pending.delete(sessionID))
    this.pending.set(sessionID, request)
    return request
  }

  get(sessionID: string): Stats | undefined {
    return this.values.get(sessionID)
  }

  dispose() {
    this.disposed = true
  }
}
