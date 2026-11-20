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
 * it comes back and goes again (the contract says so). A detach records the time with the session's
 * tenant and account; an attach (a reconnect, or another device taking the station) forgets it, and
 * so does the session ending: the leave (`leaveSession`, through `StationRegistry.sessionEnded`, and
 * over IPC to the primary's directory), and the alerts read, which forgets its account's gone
 * sessions the database no longer holds open (any other way a session ended, in any process).
 * {@link STATION_DETACH_TIMES_MAX} is only a backstop. So the alerts poll filters its account's
 * entries in memory and sends the database only those: a handful, not every station that ever went.
 */

/** The most entries kept; past it the oldest detach is forgotten first (a backstop: entries leave on their own). */
export const STATION_DETACH_TIMES_MAX = 10_000;

/** Whose station it was: the alerts read keeps its own account's in memory, before any SQL. */
export interface StationDetachScope {
  tenantId: string;
  accountId: string;
}

/** What a reader of the detach times needs (the runtime's floor and alerts reads). */
export interface StationDisconnectsReader {
  /** For each of `sessionIds` whose station went and has not come back here: when it went. */
  disconnectedSince(sessionIds: readonly string[]): Map<string, Date>;
  /**
   * Every session whose station went and has not come back here (the alerts read's candidates),
   * only `scope`'s when given (a detach recorded with no scope is nobody's).
   */
  goneSessionIds(scope?: StationDetachScope): string[];
  /**
   * These sessions have ended (left): forget them. The alerts read calls it for its account's gone
   * sessions the database no longer holds open, whichever process ended them.
   */
  forgetEnded(sessionIds: readonly string[]): void;
}

interface Detach {
  at: number;
  scope: StationDetachScope | null;
}

export class StationDetachTimes implements StationDisconnectsReader {
  /** Session id → the detach, oldest first (a re-detach moves to the end). */
  private readonly detachedAt = new Map<string, Detach>();

  constructor(private readonly max: number = STATION_DETACH_TIMES_MAX) {}

  /** The station of `sessionId` (in `scope`, when known) went at `at` (now by default). */
  detached(sessionId: string, scope: StationDetachScope | null, at: number = Date.now()): void {
    this.detachedAt.delete(sessionId);
    this.detachedAt.set(sessionId, { at, scope });
    while (this.detachedAt.size > this.max) {
      const oldest = this.detachedAt.keys().next().value;
      if (oldest === undefined) break;
      this.detachedAt.delete(oldest);
    }
  }

  /**
   * A station for `sessionId` is attached again: it is not gone. Returns when it went (epoch ms),
   * when it had (the time-to-reconnect metric's start), else undefined.
   */
  attached(sessionId: string): number | undefined {
    const was = this.detachedAt.get(sessionId);
    this.detachedAt.delete(sessionId);
    return was?.at;
  }

  /** `sessionId` ended (left): it will never attach again, so it is forgotten now. */
  ended(sessionId: string): void {
    this.detachedAt.delete(sessionId);
  }

  forgetEnded(sessionIds: readonly string[]): void {
    for (const id of sessionIds) this.detachedAt.delete(id);
  }

  disconnectedSince(sessionIds: readonly string[]): Map<string, Date> {
    const out = new Map<string, Date>();
    for (const id of sessionIds) {
      const d = this.detachedAt.get(id);
      if (d !== undefined) out.set(id, new Date(d.at));
    }
    return out;
  }

  goneSessionIds(scope?: StationDetachScope): string[] {
    if (!scope) return [...this.detachedAt.keys()];
    const out: string[] = [];
    for (const [id, d] of this.detachedAt) {
      if (d.scope && d.scope.tenantId === scope.tenantId && d.scope.accountId === scope.accountId) out.push(id);
    }
    return out;
  }

  size(): number {
    return this.detachedAt.size;
  }
}
