/**
 * Compare agents' read, with its guards (docs/compare-agents.md §7, CP6): it runs in the primary
 * against the live database, so it is bounded on every side.
 *
 *  - **One snapshot, one deadline.** Every statement of one read runs on one connection in a
 *    read-only REPEATABLE READ transaction (so the figures agree with each other). The WHOLE read
 *    has `COMPARE_READ_TIMEOUT_MS`, counted from before the connection is taken (a read sends one
 *    statement per source it needs, several in all). Its second statement sets, for that
 *    transaction only, `statement_timeout` to what is left of that budget less
 *    {@link COMPARE_STATEMENT_TIMEOUT_MARGIN_MS} (or a lower ceiling the session already has: the
 *    pool's `DB_STATEMENT_TIMEOUT_MS` or the role's), and before a later statement it is lowered
 *    again to what is left by then, when that is lower by more than
 *    {@link COMPARE_STATEMENT_TIMEOUT_SLACK_MS}. So Postgres ends a slow statement just before the
 *    whole read's deadline: the transaction is rolled back and the connection goes back to the pool
 *    to be reused. The deadline itself is the client's backstop (and stops a read between
 *    statements): past it the statement running is cancelled and no further one is sent. Either is
 *    `503 compare_timed_out`. The same statement caps `max_parallel_workers_per_gather` at
 *    {@link COMPARE_MAX_PARALLEL_WORKERS_PER_GATHER}, so five reads at once cannot take every core.
 *  - **Slots.** At most `COMPARE_TENANT_CONCURRENT_READS` reads per tenant, and at most
 *    {@link compareGlobalReadLimit} in the process (a share of the pool, so compare reads can never
 *    take the connections the dialler needs), the query and the options together; past either,
 *    `429 compare_busy` at once, never queued. A slot belongs to a read that runs SQL: a cached
 *    answer, and a request that joins an identical query read in flight, take none. A slot is
 *    given back when the read's statement has ENDED, never before (a slot freed early would let a
 *    new read start beside a statement still running).
 *  - **A client that goes away** (the route aborts the request's signal when its connection closes
 *    before the answer, as when the console aborts a superseded read): a query read is aborted once
 *    no request waits on it, the options read at once. The statement running is cancelled on a
 *    connection of its own (`cancelBackend`, never through the shared pool, where it would queue
 *    behind every borrower), by the backend's own pid (`pg_backend_pid()`, read by the second
 *    statement: `processID` is a pooler's number behind the session pooler), the cancel is
 *    AWAITED, and a connection that was sent a cancel is destroyed rather than returned to the
 *    pool, so a late cancel can never stop another borrower's statement. A cancelled statement
 *    that has not ended `COMPARE_CANCEL_GRACE_MS` after the cancel is abandoned with its
 *    connection; when the cancel could not be sent at all (no connection for it, the server
 *    refusing it), the statement runs on until its own `statement_timeout`, so the read waits for
 *    it until that bound has passed (plus the grace) before it abandons it. Then the slot comes
 *    back.
 *  - **30 s caches** (`COMPARE_CACHE_TTL_MS`): the query's answer keyed by the tenant, the caller's
 *    scope (the context account: the cohort is the account's roster), the campaign, the window, the
 *    zone, the agents in order and the metric ids in order plus the trend's (the ids do not carry an
 *    outcome set's label, so a cached answer is served with the request's own `metrics` and
 *    `trend_metric`); and the options' cohort on its own key (tenant, account, campaign, window,
 *    zone). An answer from either takes no slot and is not timed.
 *
 * The read itself (`readQuery`): the roster's attempt aggregate scoped to the campaign
 * (`rosterAttemptTotals`, the cohort: who dialled the campaign in the window, the roster screen's
 * statement), the membership filter (`filterRowsByMembership`, a departed agent kept, CP8, an id
 * with no membership in the tenant dropped, as the roster route drops it), then only the sources the
 * requested metrics need, each one statement for the whole cohort (`compare-reads.ts`), and the
 * trend's day counts and logged-in days when a trend is asked. The roster's occupancy statement is
 * read for the whole cohort when `calls_per_hour` is on screen, else for the picked agents only (it
 * feeds their day split). Picked agents are checked against the roster's rows before any other
 * source is read, and again after the membership filter (`compare_agent_not_in_cohort`).
 *
 * Metrics: `agency_compare_read_seconds{read,result}` per read that ran,
 * `agency_compare_reads_refused_total{reason}` per guard refusal.
 */
import { getPool } from '@magick-agency/db';
import { beginStatement, type TransactionPool } from '@magick-agency/db/utils/transaction';
import { cancelBackend } from '@magick-agency/db/utils/cancel-backend';
import { TtlCache } from '@magick-agency/db/utils/ttl-cache';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import {
  AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
} from '@magick-agency/contracts/agency';
import {
  COMPARE_CACHE_TTL_MS,
  COMPARE_READ_TIMEOUT_MS,
  COMPARE_TENANT_CONCURRENT_READS,
  type AgencyCompareCohortAgent,
  type AgencyCompareMetricInfo,
  type AgencyCompareResponse,
} from '@magick-agency/contracts/api/agency/compare';
import {
  agencyCompareReadSeconds,
  agencyCompareReadsRefusedTotal,
  type CompareReadKind,
  type CompareReadResult,
} from '@magick-agency/observability/metrics/agency';
import type { PoolClient } from 'pg';
import {
  agencyCompareReadRepository,
  rosterAttemptTotals,
  rosterOccupancyTotals,
  type CompareCohortScope,
  type RosterAttemptTotalsRow,
} from '../../db/repositories/agency.repository.js';
import { foldOccupancy } from '../agent-record.js';
import { agentNamesOrNone, filterRowsByMembership, type RosterMembershipRef } from '../agency-agent-identity.js';
import { localDates, rosterParams } from '../reports/datasets/shared.js';
import {
  assembleCompareResponse,
  metricSources,
  type CompareAgentSources,
  type CompareSource,
  type CompareTrendSources,
} from './assemble.js';

/** A guard's refusal: the route answers it with the code's status and the reviewed body. */
export class CompareRefusal extends Error {
  constructor(readonly code: 'compare_busy' | 'compare_timed_out') {
    super(code);
    this.name = 'CompareRefusal';
  }
}

/** The caller went away (its `signal` aborted) before the answer: nobody is left to answer. */
export class CompareAborted extends Error {
  constructor() {
    super('compare read aborted: the client went away');
    this.name = 'CompareAborted';
  }
}

/** One campaign's cohort over a window of local dates, as the routes resolved it. */
export interface CompareWindowScope {
  tenantId: string;
  accountId: string;
  campaignId: string;
  /** The local dates, both inclusive, and the request's zone: what the answer echoes and the caches key. */
  from: string;
  to: string;
  timezone: string;
  /**
   * The name Postgres cuts the days in (`postgresZoneName`): the request's zone as Postgres spells it,
   * or the current name of a legacy one it does not know (`Asia/Calcutta` → `Asia/Kolkata`).
   */
  databaseTimezone: string;
  /** `[local midnight of from, local midnight after to)`. */
  start: Date;
  end: Date;
}

/** A query's resolved request. */
export interface CompareQueryRead extends CompareWindowScope {
  /** Lower-cased, in the page's order. */
  agentIds: readonly string[];
  metrics: readonly AgencyCompareMetricInfo[];
  trend: AgencyCompareMetricInfo | null;
}

/** What a query read answers. */
export type CompareQueryOutcome =
  | { kind: 'ok'; response: AgencyCompareResponse }
  | { kind: 'not_in_cohort' };

/** What the read reaches besides the agency tables. Tests replace any of it. */
export interface CompareReadDeps {
  pool: TransactionPool;
  memberships(userIds: readonly string[], tenantId: string): Promise<RosterMembershipRef[]>;
  names(userIds: readonly string[], tenantId: string): Promise<Map<string, string | null>>;
  /**
   * Cancel the statement running on backend `pid` (`pg_backend_pid()`), on a connection of its own;
   * awaited before the read's connection is given up. True when the backend was signalled. Never
   * throws: the read treats a throw or a rejection as `false`.
   */
  cancelBackend(pid: number): Promise<boolean>;
  /** The pool's size, which the process-wide limit is a share of. */
  poolMax(): number;
  now(): Date;
}

export const defaultCompareReadDeps = (): CompareReadDeps => ({
  pool: { connect: () => getPool().connect() },
  // The pool's options are read inside the cancel, which never throws: no throw in an abort listener.
  cancelBackend: (pid) => cancelBackend(pid, () => getPool().options),
  poolMax: () => getPool().options.max ?? DEFAULT_DB_POOL_MAX,
  memberships: (ids, tenantId) => membershipRepository.findAnyByUsersAndTenant(ids, tenantId),
  names: (ids, tenantId) => agentNamesOrNone(ids, tenantId, 'compare agents'),
  now: () => new Date(),
});

/** Answers held at once: far above the comparisons a process's supervisors open in 30 s. */
export const COMPARE_CACHE_MAX_ENTRIES = 500;

/** The pool's size when none is configured (`DEFAULT_DB_POOL_MAX` of `packages/db`). */
const DEFAULT_DB_POOL_MAX = 30;

/**
 * The share of the pool compare reads may hold at once, process-wide: one connection in six (5 of
 * the default 30). A read holds one connection for its whole snapshot, so this bounds what compare
 * can take from the dialler and every other screen however many tenants open the page.
 */
export const COMPARE_POOL_SHARE_DIVISOR = 6;

/** The process-wide limit for a pool of `poolMax`: its share, never fewer than one tenant's limit. */
export function compareGlobalReadLimit(poolMax: number): number {
  return Math.max(COMPARE_TENANT_CONCURRENT_READS, Math.floor(poolMax / COMPARE_POOL_SHARE_DIVISOR));
}

/**
 * How long a cancelled statement may take to end before its connection is abandoned (destroyed,
 * the read failed) so the slot can come back. The cancel is awaited first. When the cancel could
 * not be sent, the statement's own `statement_timeout` bound is waited for as well (module note).
 */
export const COMPARE_CANCEL_GRACE_MS = 1_000;

/**
 * How much earlier than the whole read's deadline Postgres's `statement_timeout` ends a statement:
 * room for the error to come back and the deadline's timer to be late, so the server's timeout
 * (the transaction rolled back, the connection reused) wins over the client's cancel (the
 * connection destroyed).
 */
export const COMPARE_STATEMENT_TIMEOUT_MARGIN_MS = 200;

/**
 * Before a statement, `statement_timeout` is lowered to what is left of the budget only when that is
 * lower than the value set by more than this: a fast read sends no extra statement, and a statement
 * still ends at least `COMPARE_STATEMENT_TIMEOUT_MARGIN_MS - COMPARE_STATEMENT_TIMEOUT_SLACK_MS`
 * before the deadline.
 */
export const COMPARE_STATEMENT_TIMEOUT_SLACK_MS = 50;

/**
 * `max_parallel_workers_per_gather` inside a compare read's transaction (Postgres's default is 2),
 * so the five reads the process allows at once ({@link compareGlobalReadLimit}) take at most ten
 * processes (each read's backend and one worker), not fifteen, on an instance that may have two
 * cores. One, not none: only the cohort's attempt statement runs in parallel (a Gather Merge over
 * the campaign's window), and `EXPLAIN ANALYZE` of it on 930,000 attempts (100 agents, 31 days)
 * took 1.30 s with no worker, 1.00 s with one and 0.90 s with two (a 7-day window: 0.39, 0.28 and
 * 0.30 s); the whole cohort's occupancy statement does not run in parallel at any setting
 * (docs/compare-agents.md §7 "Cost, measured"). One worker keeps most of the gain for half the cores.
 */
export const COMPARE_MAX_PARALLEL_WORKERS_PER_GATHER = 1;

/**
 * The transaction's settings, one round trip: `statement_timeout` to `$1` milliseconds, or the
 * session's own when it is set and lower (`pg_settings.setting` is in milliseconds for this one, read
 * before the `set_config` in the same row); `max_parallel_workers_per_gather` to `$2`; and the
 * backend's own pid, the one a cancel must name (never `processID`, see `cancelBackend`).
 * `is_local`: this transaction only.
 */
export const COMPARE_TRANSACTION_SETTINGS_SQL = `SELECT pg_backend_pid() AS pid,
         setting::bigint AS session_ms,
         (CASE WHEN setting::bigint > 0 THEN LEAST(setting::bigint, $1::bigint) ELSE $1::bigint END) AS applied_ms,
         set_config('statement_timeout',
           (CASE WHEN setting::bigint > 0 THEN LEAST(setting::bigint, $1::bigint) ELSE $1::bigint END)::text, true) AS statement_timeout,
         set_config('max_parallel_workers_per_gather', $2::text, true) AS parallel_workers
    FROM pg_settings WHERE name = 'statement_timeout'`;

/** Lower this transaction's `statement_timeout` to `$1` milliseconds. */
export const COMPARE_LOWER_STATEMENT_TIMEOUT_SQL = `SELECT set_config('statement_timeout', $1::text, true)`;

/** `57014 query_canceled`: what a statement past its `statement_timeout` raises. */
function isStatementTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '57014';
}

/**
 * At most `limit` reads per tenant and `globalLimit` in the process at once. Non-blocking: a caller
 * past either is refused, never queued. The release is idempotent, so a double call cannot free a
 * slot someone else holds. `globalLimit` may be a function, read at the first acquire (the pool it
 * is a share of exists only once the server has started).
 */
export class TenantReadLimiter {
  private readonly held = new Map<string, number>();
  private total = 0;
  private globalResolved: number | null = null;

  constructor(private readonly limit: number, private readonly globalLimit: number | (() => number) = Number.POSITIVE_INFINITY) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`TenantReadLimiter: limit must be a positive integer, got ${limit}`);
  }

  private global(): number {
    this.globalResolved ??= typeof this.globalLimit === 'function' ? this.globalLimit() : this.globalLimit;
    return this.globalResolved;
  }

  /** A release function when a slot was free (the tenant's and the process's), else null. */
  tryAcquire(tenantId: string): (() => void) | null {
    const n = this.held.get(tenantId) ?? 0;
    if (n >= this.limit || this.total >= this.global()) return null;
    this.held.set(tenantId, n + 1);
    this.total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const left = (this.held.get(tenantId) ?? 1) - 1;
      if (left <= 0) this.held.delete(tenantId);
      else this.held.set(tenantId, left);
    };
  }

  /** Slots the tenant holds now. Test and diagnostic use. */
  inFlight(tenantId: string): number {
    return this.held.get(tenantId) ?? 0;
  }

  /** Slots held in the process now. Test and diagnostic use. */
  inFlightTotal(): number {
    return this.total;
  }
}

/** The cache key of a query read (see the module note). */
export function compareCacheKey(q: CompareQueryRead): string {
  return JSON.stringify([
    q.tenantId, q.accountId, q.campaignId, q.from, q.to, q.timezone,
    q.agentIds, q.metrics.map((m) => m.id), q.trend?.id ?? null,
  ]);
}

/** The cohort agents for the options read. */
export interface CompareCohortList {
  agents: AgencyCompareCohortAgent[];
}

/** The options cohort's cache key: the tenant, the account, the campaign, the window and the zone. */
export function compareCohortCacheKey(q: CompareWindowScope): string {
  return JSON.stringify([q.tenantId, q.accountId, q.campaignId, q.from, q.to, q.timezone]);
}

/** The whole read's deadline: its signal, and when it fires (`performance.now()` time). */
interface ReadDeadline {
  signal: AbortSignal;
  at: number;
}

/** The deadline of a read that starts now and may take `ms`. */
function readDeadline(ms: number): ReadDeadline {
  return { signal: AbortSignal.timeout(ms), at: performance.now() + ms };
}

/** Why a snapshot stops early: the client went away, or the whole read's deadline passed. */
interface SnapshotStops {
  gone?: AbortSignal | undefined;
  deadline: ReadDeadline;
}

/**
 * One query read in flight, shared by every request for its key that arrives before it settles
 * (a joiner takes no slot: it runs nothing). The load holds ONE slot, released when it settles.
 * When every request waiting on it has gone it is aborted: its statement is cancelled, and the
 * load settles (and gives its slot back) once that statement has ended.
 */
interface SharedLoad {
  promise: Promise<CompareQueryOutcome>;
  controller: AbortController;
  release: () => void;
  waiters: number;
  settled: boolean;
}

const noop = (): void => undefined;

export class CompareReads {
  private readonly cache: TtlCache<CompareQueryOutcome>;
  private readonly cohortCache: TtlCache<CompareCohortList>;
  private readonly loads = new Map<string, SharedLoad>();
  private readonly limiter: TenantReadLimiter;
  private readonly timeoutMs: number;
  private readonly deps: CompareReadDeps;

  constructor(opts: {
    deps?: Partial<CompareReadDeps>;
    ttlMs?: number;
    perTenant?: number;
    /** The process-wide limit; default {@link compareGlobalReadLimit} of the pool. */
    global?: number;
    timeoutMs?: number;
    maxEntries?: number;
  } = {}) {
    this.deps = { ...defaultCompareReadDeps(), ...opts.deps };
    const ttlMs = opts.ttlMs ?? COMPARE_CACHE_TTL_MS;
    const maxEntries = opts.maxEntries ?? COMPARE_CACHE_MAX_ENTRIES;
    this.cache = new TtlCache<CompareQueryOutcome>({ ttlMs, maxEntries, name: 'agency-compare' });
    this.cohortCache = new TtlCache<CompareCohortList>({ ttlMs, maxEntries, name: 'agency-compare-cohort' });
    this.limiter = new TenantReadLimiter(
      opts.perTenant ?? COMPARE_TENANT_CONCURRENT_READS,
      opts.global ?? (() => compareGlobalReadLimit(this.deps.poolMax())),
    );
    this.timeoutMs = opts.timeoutMs ?? COMPARE_READ_TIMEOUT_MS;
  }

  /**
   * The comparison: from the cache (no slot), joined to the same read in flight (no slot), or a new
   * read under the limits. Throws {@link CompareRefusal}; {@link CompareAborted} when `signal`
   * aborts first (the client went away). When every request waiting on a read has gone, its
   * statement is cancelled and its slot comes back once that statement has ended.
   */
  async query(q: CompareQueryRead, signal?: AbortSignal): Promise<CompareQueryOutcome> {
    if (signal?.aborted) throw new CompareAborted();
    const key = compareCacheKey(q);
    const outcome = this.cache.get(key) ?? await this.wait(this.loadFor(key, q), key, signal);
    if (outcome.kind !== 'ok') return outcome;
    // Same ids in the same order; the request's own refs and labels (module note).
    return { kind: 'ok', response: { ...outcome.response, metrics: [...q.metrics], trend_metric: q.trend } };
  }

  /**
   * The cohort's agents for the chips: from its own 30 s cache (no slot), else a read under the
   * limits. Throws {@link CompareRefusal}; {@link CompareAborted} when `signal` aborts first, which
   * cancels the statement; the slot comes back once it has ended.
   */
  async cohort(q: CompareWindowScope, signal?: AbortSignal): Promise<CompareCohortList> {
    if (signal?.aborted) throw new CompareAborted();
    const key = compareCohortCacheKey(q);
    const cached = this.cohortCache.get(key);
    if (cached) return cached;
    const release = this.acquire(q.tenantId);
    try {
      const list = await this.readCohort(q, signal);
      this.cohortCache.set(key, list);
      return list;
    } finally {
      release();
    }
  }

  /** Slots the tenant holds now. Test and diagnostic use. */
  inFlight(tenantId: string): number {
    return this.limiter.inFlight(tenantId);
  }

  /** Slots held in the process now. Test and diagnostic use. */
  inFlightTotal(): number {
    return this.limiter.inFlightTotal();
  }

  /** Drop every cached answer. */
  clear(): void {
    this.cache.clear();
    this.cohortCache.clear();
  }

  /** A slot of the tenant's and the process's, or `compare_busy`. The release is idempotent. */
  private acquire(tenantId: string): () => void {
    const release = this.limiter.tryAcquire(tenantId);
    if (release === null) {
      agencyCompareReadsRefusedTotal.inc({ reason: 'busy' });
      throw new CompareRefusal('compare_busy');
    }
    return release;
  }

  /** The read in flight for `key`, or a new one holding a slot (`compare_busy` when none is free). */
  private loadFor(key: string, q: CompareQueryRead): SharedLoad {
    const running = this.loads.get(key);
    if (running) return running;
    const release = this.acquire(q.tenantId);
    const controller = new AbortController();
    const load: SharedLoad = {
      controller, release, waiters: 0, settled: false,
      promise: this.readQuery(q, controller.signal).then((out) => {
        // An aborted read's answer is nobody's; an answer is kept for the TTL.
        if (!controller.signal.aborted) this.cache.set(key, out);
        return out;
      }),
    };
    this.loads.set(key, load);
    load.promise
      .finally(() => {
        // The read has settled: its statement has ended (or its connection was abandoned).
        load.settled = true;
        release();
        if (this.loads.get(key) === load) this.loads.delete(key);
      })
      .catch(noop);
    return load;
  }

  /** Wait for `load` as one of its requests; leaving (an abort) may abort the load (see {@link SharedLoad}). */
  private wait(load: SharedLoad, key: string, signal: AbortSignal | undefined): Promise<CompareQueryOutcome> {
    load.waiters += 1;
    let done = false;
    return new Promise<CompareQueryOutcome>((resolve, reject) => {
      const leave = (): void => {
        if (done) return;
        done = true;
        load.waiters -= 1;
        if (load.waiters === 0 && !load.settled) {
          // Nobody is left to answer: stop the statement. The slot comes back when the load
          // settles, once the statement has ended; a new request for the key starts afresh.
          if (this.loads.get(key) === load) this.loads.delete(key);
          load.controller.abort();
        }
        reject(new CompareAborted());
      };
      signal?.addEventListener('abort', leave, { once: true });
      load.promise.then(
        (value) => { signal?.removeEventListener('abort', leave); if (!done) { done = true; resolve(value); } },
        (err: unknown) => { signal?.removeEventListener('abort', leave); if (!done) { done = true; reject(err); } },
      );
    });
  }

  /**
   * `fn` in one read-only snapshot, timed, stopped by `stops` (the client gone, or the whole read's
   * deadline): {@link CompareAborted} for the first, `compare_timed_out` for the second and for a
   * statement past `statement_timeout`.
   */
  private async snapshot<T>(read: CompareReadKind, fn: (db: PoolClient) => Promise<T>, stops: SnapshotStops): Promise<T> {
    const started = performance.now();
    let result: CompareReadResult = 'failed';
    const signal = stops.gone ? AbortSignal.any([stops.gone, stops.deadline.signal]) : stops.deadline.signal;
    try {
      signal.throwIfAborted();
      const out = await this.inSnapshot(fn, signal, stops.deadline.at);
      result = 'ok';
      return out;
    } catch (err) {
      if (stops.gone?.aborted) {
        result = 'aborted';
        throw new CompareAborted();
      }
      if (stops.deadline.signal.aborted || isStatementTimeout(err)) {
        result = 'timed_out';
        agencyCompareReadsRefusedTotal.inc({ reason: 'timed_out' });
        throw new CompareRefusal('compare_timed_out');
      }
      throw err;
    } finally {
      agencyCompareReadSeconds.observe({ read, result }, (performance.now() - started) / 1000);
    }
  }

  /**
   * The transaction itself, on a connection of its own from the pool, under `statement_timeout`s
   * that end each statement before `deadlineAt` (module note). When `signal` aborts while one of its
   * statements runs, the statement is cancelled on a separate connection (`deps.cancelBackend`, by
   * the backend's own pid) and the cancel awaited; no further statement is sent; a statement still
   * running `COMPARE_CANCEL_GRACE_MS` after the cancel (or, when the cancel was not sent, after its
   * own `statement_timeout` bound) is abandoned. A connection that was sent a cancel is destroyed,
   * never returned to the pool, so a cancel processed late cannot reach the next borrower.
   * Otherwise the read-only transaction is rolled back and the connection released, to be reused.
   */
  private async inSnapshot<T>(fn: (db: PoolClient) => Promise<T>, signal: AbortSignal, deadlineAt: number): Promise<T> {
    const client = await this.deps.pool.connect();
    /** The backend's pid, from `pg_backend_pid()`; null until the settings statement has answered. */
    let pid: number | null = null;
    /** The session's own `statement_timeout` ceiling in ms (none: infinite), and the one set now. */
    let ceilingMs = Number.POSITIVE_INFINITY;
    let appliedMs: number | null = null;
    /** When the statement running was sent (`performance.now()`), and the `statement_timeout` it runs under. */
    let runningSince = 0;
    let runningBoundMs: number | null = null;
    let running = false;
    let cancelling: Promise<boolean> | null = null;
    let abandon: () => void = noop;
    const abandoned = new Promise<never>((_, reject) => {
      abandon = () => reject(new CompareAborted());
    });
    abandoned.catch(noop);
    const onAbort = (): void => {
      if (!running || pid === null || cancelling !== null) return;
      const target = pid;
      const since = runningSince;
      const bound = runningBoundMs;
      // Never rejects: a cancel that throws or rejects is one that was not sent.
      const sent: Promise<boolean> = Promise.resolve()
        .then(() => this.deps.cancelBackend(target))
        .then((ok) => ok === true, () => false);
      cancelling = sent;
      void sent.then((ok) => {
        // Signalled: the statement ends at its next interrupt check. Not signalled: it runs on until
        // its own statement_timeout, so the slot is held until that bound has passed.
        const waitMs = ok || bound === null
          ? COMPARE_CANCEL_GRACE_MS
          : Math.max(COMPARE_CANCEL_GRACE_MS, since + bound - performance.now() + COMPARE_CANCEL_GRACE_MS);
        setTimeout(abandon, waitMs).unref();
      });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    /** What is left of the budget for the next statement, never 0 (0 would be no limit at all). */
    const budgetMs = (): number =>
      Math.max(1, Math.min(ceilingMs, Math.floor(deadlineAt - performance.now() - COMPARE_STATEMENT_TIMEOUT_MARGIN_MS)));
    const send = async (text: string, values?: unknown[]): Promise<{ rows: unknown[] }> => {
      signal.throwIfAborted();
      const sent = client.query(text, values) as unknown as Promise<{ rows: unknown[] }>;
      sent.catch(noop);
      running = true;
      runningSince = performance.now();
      runningBoundMs = appliedMs;
      try {
        return await Promise.race([sent, abandoned]);
      } finally {
        running = false;
      }
    };
    // Every statement of the read goes through here: none is sent once the read has stopped, and
    // each runs under a statement_timeout that ends it before the whole read's deadline.
    const query = async (text: string, values?: unknown[]): Promise<unknown> => {
      if (appliedMs !== null) {
        const wanted = budgetMs();
        if (appliedMs - wanted > COMPARE_STATEMENT_TIMEOUT_SLACK_MS) {
          await send(COMPARE_LOWER_STATEMENT_TIMEOUT_SQL, [wanted]);
          appliedMs = wanted;
        }
      }
      return send(text, values);
    };
    const guarded = new Proxy(client, {
      get: (target, prop, receiver) => (prop === 'query' ? query : Reflect.get(target, prop, receiver)),
    });
    let destroy = false;
    try {
      await send(beginStatement({ isolation: 'REPEATABLE READ', readOnly: true }));
      const { rows } = await send(COMPARE_TRANSACTION_SETTINGS_SQL, [budgetMs(), COMPARE_MAX_PARALLEL_WORKERS_PER_GATHER]);
      const settings = rows[0] as { pid: number; session_ms: string | number; applied_ms: string | number } | undefined;
      if (settings === undefined) throw new Error('compare read: the transaction settings answered no row');
      pid = Number(settings.pid);
      const sessionMs = Number(settings.session_ms);
      if (sessionMs > 0) ceilingMs = sessionMs;
      appliedMs = Number(settings.applied_ms);
      return await fn(guarded);
    } finally {
      signal.removeEventListener('abort', onAbort);
      try {
        if (cancelling !== null) {
          await cancelling;
          destroy = true;
        } else {
          try {
            await client.query('ROLLBACK');
          } catch {
            destroy = true;
          }
        }
      } finally {
        client.release(destroy ? true : undefined);
      }
    }
  }

  /** The cohort's roster rows and their memberships. */
  private async readCohort(q: CompareWindowScope, gone?: AbortSignal): Promise<CompareCohortList> {
    const params = rosterParams({ from: q.start, to: q.end, campaignId: q.campaignId });
    const scope = { tenantId: q.tenantId, accountId: q.accountId };
    const deadline = readDeadline(this.timeoutMs);
    const rows = await this.snapshot('options', (db) => rosterAttemptTotals(scope, params, db), { gone, deadline });
    if (gone?.aborted) throw new CompareAborted();
    // After the snapshot, on the pool: a read never holds two connections.
    const memberships = await this.deps.memberships(rows.map((r) => r.agent_user_id), q.tenantId);
    const cohort = filterRowsByMembership(rows, memberships, q.accountId, true, (r) => r.agent_user_id).rows;
    const active = new Set(filterRowsByMembership(rows, memberships, q.accountId, false, (r) => r.agent_user_id).rows.map((r) => r.agent_user_id));
    const names = await this.deps.names(cohort.map((r) => r.agent_user_id), q.tenantId);
    const agents: AgencyCompareCohortAgent[] = cohort.map((r) => ({
      agent_user_id: r.agent_user_id,
      name: names.get(r.agent_user_id) ?? null,
      calls: r.connected,
      reportable: r.connected >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
      active: active.has(r.agent_user_id),
    }));
    agents.sort((x, y) =>
      y.calls - x.calls
      || (x.name ?? '\uffff').localeCompare(y.name ?? '\uffff')
      || x.agent_user_id.localeCompare(y.agent_user_id));
    return { agents };
  }

  /** The comparison's read (module note). */
  private async readQuery(q: CompareQueryRead, signal: AbortSignal): Promise<CompareQueryOutcome> {
    const deadline = readDeadline(this.timeoutMs);
    const params = rosterParams({ from: q.start, to: q.end, campaignId: q.campaignId });
    const scope = { tenantId: q.tenantId, accountId: q.accountId };
    const needs = new Set<CompareSource>(q.metrics.flatMap((m) => metricSources(m)));
    const asOf = this.deps.now();

    const read = await this.snapshot('query', async (db) => {
      const attempts = await rosterAttemptTotals(scope, params, db);
      const rosterIds = attempts.map((r) => r.agent_user_id);
      const present = new Set(rosterIds);
      if (!q.agentIds.every((id) => present.has(id))) return null;

      const cohortScope: CompareCohortScope = {
        campaignId: q.campaignId, tenantId: q.tenantId, accountId: q.accountId, from: q.start, to: q.end, agentIds: rosterIds,
      };
      const occupancyIds = needs.has('occupancy') ? rosterIds : [...q.agentIds];
      const occupancyRows = await rosterOccupancyTotals(scope, params, occupancyIds, db);
      const rollup = needs.has('rollup') ? await agencyCompareReadRepository.rollupCodes(db, cohortScope) : null;
      const promises = needs.has('promises') ? await agencyCompareReadRepository.promises(db, cohortScope) : null;
      const callbacks = needs.has('callbacks') ? await agencyCompareReadRepository.callbacks(db, { ...cohortScope, now: asOf }) : null;
      const breaks = needs.has('breaks') ? await agencyCompareReadRepository.breakOverruns(db, cohortScope) : null;

      let trend: CompareTrendSources | null = null;
      if (q.trend !== null) {
        const ref = q.trend.ref;
        const dayRows = ref.kind === 'outcomes'
          ? await agencyCompareReadRepository.rollupCodeDays(db, { ...cohortScope, codes: ref.codes, timezone: q.databaseTimezone })
          : await agencyCompareReadRepository.promiseDays(db, { ...cohortScope, timezone: q.databaseTimezone });
        const loggedIn = await agencyCompareReadRepository.loggedInDays(db, { ...cohortScope, timezone: q.databaseTimezone });
        const counts = new Map<string, Map<string, number>>();
        for (const r of dayRows) {
          const days = counts.get(r.agent_user_id) ?? new Map<string, number>();
          days.set(r.date, (days.get(r.date) ?? 0) + r.n);
          counts.set(r.agent_user_id, days);
        }
        trend = { dates: localDates(q.from, q.to), counts, loggedIn };
      }

      return { attempts, occupancyRows, rollup, promises, callbacks, breaks, trend, occupancyIds };
    }, { gone: signal, deadline });
    if (read === null) return { kind: 'not_in_cohort' };
    if (signal.aborted) throw new CompareAborted();
    // After the snapshot, on the pool (keyed by user): a read never holds two connections.
    const memberships = await this.deps.memberships(read.attempts.map((r) => r.agent_user_id), q.tenantId);

    // The cohort: the roster's rows of the account's members, a departed one kept (CP8).
    const cohortRows: RosterAttemptTotalsRow[] = filterRowsByMembership(
      read.attempts, memberships, q.accountId, true, (r) => r.agent_user_id,
    ).rows;
    const inCohort = new Set(cohortRows.map((r) => r.agent_user_id));
    if (!q.agentIds.every((id) => inCohort.has(id))) return { kind: 'not_in_cohort' };

    const occupancyByAgent = new Map<string, Array<{ state: string; seconds: number }>>();
    for (const row of read.occupancyRows) {
      const list = occupancyByAgent.get(row.agent_user_id) ?? [];
      list.push(row);
      occupancyByAgent.set(row.agent_user_id, list);
    }
    const occupancyRead = new Set(read.occupancyIds);
    const rollupByAgent = new Map<string, Map<string | null, number>>();
    for (const r of read.rollup ?? []) {
      const codes = rollupByAgent.get(r.agent_user_id) ?? new Map<string | null, number>();
      codes.set(r.disposition_code, (codes.get(r.disposition_code) ?? 0) + r.conversations);
      rollupByAgent.set(r.agent_user_id, codes);
    }
    const promisesByAgent = new Map((read.promises ?? []).map((p) => [p.agent_user_id, p]));

    const cohort: CompareAgentSources[] = cohortRows.map((r) => ({
      agent_user_id: r.agent_user_id,
      roster: {
        connected: r.connected,
        successes: r.successes,
        talk_seconds: r.talk_seconds,
        wrapup_seconds: r.wrapup_seconds,
        measured_wrapups: r.measured_wrapups,
        human_connects: r.human_connects,
        first_dials: r.first_dials,
      },
      // Folded exactly as the roster folds each row (`foldOccupancy`): the same shift seconds.
      occupancy: occupancyRead.has(r.agent_user_id) ? foldOccupancy(occupancyByAgent.get(r.agent_user_id) ?? []) : null,
      rollup: read.rollup === null ? null : rollupByAgent.get(r.agent_user_id) ?? new Map(),
      promises: read.promises === null ? null : (() => {
        const p = promisesByAgent.get(r.agent_user_id);
        return { promises: p?.promises ?? 0, amount: p?.amount ?? 0, other_conversations: p?.other_conversations ?? 0 };
      })(),
      callbacks: read.callbacks === null ? null
        : read.callbacks.get(r.agent_user_id) ?? { on_time: 0, late: 0, missed: 0, pending_future: 0, pending_due: 0 },
      break_overruns: read.breaks === null ? null : read.breaks.get(r.agent_user_id) ?? 0,
    }));

    const names = await this.deps.names(q.agentIds, q.tenantId);
    return {
      kind: 'ok',
      response: assembleCompareResponse({
        campaignId: q.campaignId,
        from: q.from,
        to: q.to,
        timezone: q.timezone,
        asOf,
        metrics: q.metrics,
        trendMetric: q.trend,
        picked: q.agentIds,
        cohort,
        names,
        trend: read.trend,
      }),
    };
  }
}
