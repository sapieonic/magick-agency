/**
 * When each session's station socket went (agent station BE-11, AS16): the in-memory record behind
 * `AgencyFloorAgent.disconnected_since` and the supervisors' `disconnected` alert
 * (`GET /proxy/agency/floor/alerts`, `agency/floor-alerts.ts`).
 *
 * Kept by whoever knows the stations of this process: the `StationRegistry` in one process (its
 * attach and detach), the primary's `StationDirectory` with media workers (the workers'
 * `station.attached` / `station.detached` events, and a worker's exit). Not a second source of
 * truth for presence: whether a station is held is still the registry's question
 * (`connectedBySession`); this only remembers WHEN a held one went, which nothing else records.
 *
 * **Memory only**, so it is empty after a restart: a station that went before it has no time until
 * it comes back and goes again (the contract says so). A detach records the time; an attach (a
 * reconnect, or another device taking the station) forgets it. A session that ends detaches its
 * station and never attaches again, so its entry stays until it is the oldest of
 * {@link STATION_DETACH_TIMES_MAX} (the readers only ask about open sessions, so a stale one is never
 * read as anything but memory).
 */

/** The most entries kept; past it the oldest detach is forgotten first. */
export const STATION_DETACH_TIMES_MAX = 10_000;

/** What a reader of the detach times needs (the runtime's floor and alerts reads). */
export interface StationDisconnectsReader {
  /** For each of `sessionIds` whose station went and has not come back here: when it went. */
  disconnectedSince(sessionIds: readonly string[]): Map<string, Date>;
  /** Every session whose station went and has not come back here (the alerts read's candidates). */
  goneSessionIds(): string[];
}

export class StationDetachTimes implements StationDisconnectsReader {
  /** Session id → epoch ms of the detach, oldest first (a re-detach moves to the end). */
  private readonly detachedAt = new Map<string, number>();

  constructor(private readonly max: number = STATION_DETACH_TIMES_MAX) {}

  /** The station of `sessionId` went at `at` (now by default). */
  detached(sessionId: string, at: number = Date.now()): void {
    this.detachedAt.delete(sessionId);
    this.detachedAt.set(sessionId, at);
    while (this.detachedAt.size > this.max) {
      const oldest = this.detachedAt.keys().next().value;
      if (oldest === undefined) break;
      this.detachedAt.delete(oldest);
    }
  }

  /** A station for `sessionId` is attached again: it is not gone. */
  attached(sessionId: string): void {
    this.detachedAt.delete(sessionId);
  }

  disconnectedSince(sessionIds: readonly string[]): Map<string, Date> {
    const out = new Map<string, Date>();
    for (const id of sessionIds) {
      const at = this.detachedAt.get(id);
      if (at !== undefined) out.set(id, new Date(at));
    }
    return out;
  }

  goneSessionIds(): string[] {
    return [...this.detachedAt.keys()];
  }

  size(): number {
    return this.detachedAt.size;
  }
}
