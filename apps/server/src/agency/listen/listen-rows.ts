import { createChildLogger } from '@magick-agency/observability';
import { trackListenSessionEnded } from '@magick-agency/observability/metrics/agency';
import type {
  ListenSessionCloseInput,
  ListenSessionOpenInput,
} from '../../db/repositories/agency.repository.js';

const log = createChildLogger({ component: 'agency-listen-rows' });

/**
 * The session rows of one process's listens (`agency_listen_sessions`, docs/listening.md §6): the
 * socket opens and closes them through this, and the registry's re-check tick has it repair them
 * ({@link ListenRowKeeper.maintain}, LS16 o). A row left open while its process lives would show
 * a listener nobody is (the live list's listeners and its per-call cap, "Listened to by" with no
 * end, a cross-process supersede aimed at nothing), and nothing else would close it until a
 * restart. So:
 *
 *  - **A failed close is retried** with its own reason and counters, on every tick until it
 *    lands (or the row is found already closed). At most {@link MAX_QUEUED_CLOSES} wait; past
 *    that the oldest is let go to the sweep.
 *  - **The sweep** closes the rows of this process (`replica_id`) still open that nothing here
 *    holds: not an open session or a reservation of the registry (an upgrade between its slot and
 *    its admission), not a close in flight or waiting to be retried, and older than
 *    {@link LOST_ROW_MIN_AGE_MS} (so a row written after the held ids were read, just before the
 *    sweep's statement, is never one). Such
 *    a row's listen is gone from this process without its close: the insert that answered an error
 *    after it committed, a close let go from the queue. It closes `server_restarted` (the session
 *    outlived the process's knowledge of it, as a dead process's rows do; the contract has no
 *    other reason for it), its counters unknown.
 *  - **Dead processes' rows** ({@link ListenRowKeeper.closeDeadProcesses}, the primary's): at boot,
 *    and when the primary reaps a dead media worker, every open row of a process not running now
 *    closes `server_restarted`. Nothing else would close them (each live process sweeps its own
 *    `replica_id` only), so a close that fails is retried on every tick until it lands, with the
 *    live processes read afresh each time (LS22 r).
 * `agency_listen_sessions_ended_total{reason="server_restarted"}` counts only the swept rows that
 * went live (`live_at` set), as the socket counts only live sessions: a row the upgrade wrote and
 * then refused carried no audio.
 */
export interface ListenRowStore {
  open(input: ListenSessionOpenInput): Promise<unknown>;
  /** Null (or any falsy value) when the row was already closed: the first close won. */
  close(id: string, input: ListenSessionCloseInput): Promise<unknown>;
  /** Close this replica's open rows not in `keep` that started over `minAgeMs` ago; answers them. */
  closeOrphans(replicaId: string, opts: { keep: readonly string[]; minAgeMs: number }): Promise<SweptRow[]>;
  /** Close every open row of a replica not in `liveReplicaIds`; answers them. */
  closeOrphansExcept(liveReplicaIds: readonly string[]): Promise<SweptRow[]>;
  /** Stamp the row's `live_at` (the session went live); false when it was stamped already. */
  markLive(id: string): Promise<unknown>;
}

/** A row a sweep closed: its id, and whether it had gone live. */
export interface SweptRow {
  id: string;
  live_at?: Date | string | null;
}

/** Count the swept rows that carried audio (`live_at` set) as ended `server_restarted`. */
function countRestarted(rows: readonly SweptRow[]): void {
  for (const r of rows) {
    if (r.live_at === null || r.live_at === undefined) continue;
    try { trackListenSessionEnded('server_restarted'); } catch { /* a metric is never worth the sweep */ }
  }
}

/** Closes that may wait for a retry at once. */
export const MAX_QUEUED_CLOSES = 1_000;

/** The sweep leaves a row younger than this alone, whatever holds it. */
export const LOST_ROW_MIN_AGE_MS = 60_000;

interface PendingClose {
  input: ListenSessionCloseInput;
  /** A close is running for it now (the first, or a retry). */
  inFlight: boolean;
}

export class ListenRowKeeper {
  /** Closes in flight or waiting for a retry, by listen id (Map order: oldest first). */
  private readonly pending = new Map<string, PendingClose>();
  /** A {@link closeDeadProcesses} failed: the next {@link maintain} runs it again. */
  private deadSweepPending = false;

  constructor(
    private readonly store: ListenRowStore,
    /** This process (`agency_listen_sessions.replica_id`). */
    private readonly replicaId: string,
    /** The OTHER processes running now (the primary's media workers); none in one process. */
    private readonly otherLiveReplicaIds: () => readonly string[] = () => [],
  ) {}

  /** Closes waiting for a retry now (in flight ones not counted). */
  get queued(): number {
    let n = 0;
    for (const p of this.pending.values()) if (!p.inFlight) n++;
    return n;
  }

  open(input: ListenSessionOpenInput): Promise<unknown> {
    return this.store.open(input);
  }

  /**
   * The session went live: stamp its row's `live_at` ("Listened to by" reads only live rows,
   * LS22). Not awaited by the socket, so audio is never held for it; a stamp that fails is logged,
   * and the session's close writes it (`live: true`). Never rejects.
   */
  async markLive(id: string): Promise<void> {
    try {
      await this.store.markLive(id);
    } catch (err) {
      log.warn({ err, listenId: id }, 'Could not stamp the listen session row live — its close will');
    }
  }

  /**
   * Close a session's row. The listen id is known to be closing from this call on (synchronously:
   * the sweep never races it). Rejects when the close failed; the close is queued for a retry.
   */
  async close(id: string, input: ListenSessionCloseInput): Promise<void> {
    this.pending.set(id, { input, inFlight: true });
    try {
      await this.store.close(id, input);
      this.pending.delete(id);
    } catch (err) {
      this.queue(id, input);
      throw err;
    }
  }

  private queue(id: string, input: ListenSessionCloseInput): void {
    this.pending.delete(id);
    this.pending.set(id, { input, inFlight: false });
    while (this.pending.size > MAX_QUEUED_CLOSES) {
      const oldest = [...this.pending.entries()].find(([, p]) => !p.inFlight);
      if (!oldest) break;
      this.pending.delete(oldest[0]);
      log.warn({ listenId: oldest[0] }, 'Too many listen session closes waiting — leaving this one to the sweep');
    }
  }

  /** A dead processes' close failed and waits for the next {@link maintain}. */
  get deadSweepWaiting(): boolean {
    return this.deadSweepPending;
  }

  /**
   * Close the open rows of every process not running now (`server_restarted`): this process and
   * {@link otherLiveReplicaIds} are read at the call. At boot (before any listener can attach and
   * any media worker exists) and when the primary reaps a dead media worker. A close that fails is
   * logged and run again by every {@link maintain} until it lands. Never rejects; answers the rows
   * it closed, or null when it failed.
   */
  async closeDeadProcesses(): Promise<number | null> {
    let rows: SweptRow[];
    try {
      rows = await this.store.closeOrphansExcept([this.replicaId, ...this.otherLiveReplicaIds()]);
    } catch (err) {
      this.deadSweepPending = true;
      log.error({ err }, 'Could not close the listen sessions of processes no longer running — retrying on the next re-check');
      return null;
    }
    this.deadSweepPending = false;
    countRestarted(rows);
    if (rows.length > 0) log.warn({ closed: rows.length }, 'Closed the listen sessions of processes no longer running');
    return rows.length;
  }

  /**
   * The tick's upkeep: retry the closes that failed (a dead processes' close among them), then
   * sweep the lost rows. `held`: the listen
   * ids the registry holds (open sessions and reservations), read right before the sweep, after
   * the retries: a retry against a slow database can take longer than the sweep's age floor, and
   * a listen admitted meanwhile must be in the keep list (LS22 k). Never rejects.
   */
  async maintain(held: () => ReadonlySet<string>): Promise<{ retried: number; swept: number; reaped: number }> {
    let retried = 0;
    for (const [id, p] of [...this.pending.entries()]) {
      if (p.inFlight) continue;
      p.inFlight = true;
      try {
        await this.store.close(id, p.input);
        this.pending.delete(id);
        retried++;
        log.info({ listenId: id, reason: p.input.reason }, 'Listen session row closed on a retry');
      } catch (err) {
        p.inFlight = false;
        log.warn({ err, listenId: id }, 'Listen session row close failed again — retrying on the next pass');
      }
    }
    let reaped = 0;
    if (this.deadSweepPending) reaped = (await this.closeDeadProcesses()) ?? 0;
    let swept = 0;
    try {
      const keep = [...new Set([...held(), ...this.pending.keys()])];
      const rows = await this.store.closeOrphans(this.replicaId, { keep, minAgeMs: LOST_ROW_MIN_AGE_MS });
      swept = rows.length;
      countRestarted(rows);
      if (swept > 0) log.warn({ closed: rows.map((r) => r.id) }, 'Closed listen session rows this process no longer held');
    } catch (err) {
      log.warn({ err }, 'Could not sweep the listen session rows this process no longer holds');
    }
    return { retried, swept, reaped };
  }
}
