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
 *    no request waits on it, the options read at once. The statement running is cancelled and the
 *    connection destroyed as `withCancellableRead` does it (`@magick-agency/db/utils/cancellable-read`),
 *    a statement still running {@link COMPARE_CANCEL_GRACE_MS} after its cancel (or after its own
 *    bound, when the cancel could not be sent) abandoned; then the slot comes back.
 *  - **30 s caches** (`COMPARE_CACHE_TTL_MS`): a query's SNAPSHOT (the cohort's sources, not an
 *    answer) keyed by what its SQL reads (`compareSnapshotKey`): the tenant, the caller's scope (the
 *    context account: the cohort is the account's roster), the campaign, the window, the zone, the
 *    sources its metrics need, the trend's id, and whose occupancy is read
 *    (`compareOccupancyAgents`: the cohort when `calls_per_hour` is on screen, else the picked
 *    agents, sorted). Every request is answered from it for its own picks, metrics, labels and order
 *    (`compareAnswer`, pure), so a chip toggled with calls per hour on screen, a reorder, or a metric
 *    of a source already read sends no SQL and takes no slot. And the options' cohort on its own key
 *    (tenant, account, campaign, window, zone). Either takes no slot and is not timed.
 *
 * The snapshot itself (`readSnapshot`): the roster's attempt aggregate scoped to the campaign
 * (`rosterAttemptTotals`, the cohort: who dialled the campaign in the window, the roster screen's
 * statement), then the occupancy (`compareOccupancyAgents`; the whole cohort's walks every state
 * change of the window, 3.3 s on a busy month against 0.1 s for three agents, so it is read only for
 * the metric that needs it), only the other sources the requested metrics need, each one statement
 * for the whole cohort (`compare-reads.ts`), and the trend's day counts and logged-in days when a
 * trend is asked, all in ONE transaction; then, on the pool, the membership filter
 * (`filterRowsByMembership`, a departed agent kept, CP8, an id with no membership in the tenant
 * dropped, as the roster route drops it) and the cohort's names. A picked agent not in the
 * snapshot's cohort is `compare_agent_not_in_cohort`.
 *
 * Metrics: `agency_compare_read_seconds{read,result}` per read that ran,
 * `agency_compare_reads_refused_total{reason}` per guard refusal.
 */
import { getPool } from '@magick-agency/db';
import type { TransactionPool } from '@magick-agency/db/utils/transaction';
import { withCancellableRead } from '@magick-agency/db/utils/cancellable-read';
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
  ZERO_CALLBACKS,
  rosterAttemptTotals,
  rosterOccupancyTotals,
  type CompareCohortScope,
  type RosterAttemptTotalsRow,
} from '../../db/repositories/agency.repository.js';
import { foldOccupancy, rosterParams } from '../agent-record.js';
import { agentNamesOrNone, filterRowsByMembership, type RosterMembershipRef } from '../agency-agent-identity.js';
import { localDates } from '../reports/datasets/shared.js';
import {
  assembleCompareResponse,
  COMPARE_SOURCES,
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

/** How long a cancelled statement may take to end before it is abandoned with its connection (`graceMs`). */
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

/** `57014 query_canceled`: what a statement past its `statement_timeout` raises. */
export function isStatementTimeout(err: unknown): boolean {
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

/** The sources a query reads beyond the roster's attempts, in a fixed order (the key's and the read's). */
export function compareQuerySources(q: Pick<CompareQueryRead, 'metrics'>): CompareSource[] {
  const needs = new Set(q.metrics.flatMap((m) => metricSources(m)));
  return COMPARE_SOURCES.filter((s) => needs.has(s));
}

/**
 * Whose occupancy a query reads: the whole cohort when `calls_per_hour` is on screen (it rates every
 * cohort agent), else the picked agents only, for their day split, sorted (the order is the page's,
 * not the data's). The whole cohort's statement walks every state change of the window (4.3 s on a
 * busy month, docs/compare-agents.md §7 "Cost, measured"); three agents' takes 0.1 s.
 */
export function compareOccupancyAgents(q: Pick<CompareQueryRead, 'metrics' | 'agentIds'>): 'cohort' | string[] {
  return compareQuerySources(q).includes('occupancy') ? 'cohort' : [...q.agentIds].sort();
}

/**
 * The cache key of a query's snapshot (see the module note): what its SQL reads, never the order of
 * the picks or of the metrics, nor which metrics share a source.
 */
export function compareSnapshotKey(q: CompareQueryRead): string {
  return JSON.stringify([
    q.tenantId, q.accountId, q.campaignId, q.from, q.to, q.timezone,
    compareQuerySources(q), q.trend?.id ?? null, compareOccupancyAgents(q),
  ]);
}

/** What one query snapshot holds, cached and shared: everything an answer needs but its picks and metrics. */
export interface CompareSnapshot {
  /** When the read started: the answer's `as_of`. */
  asOf: Date;
  /** Every cohort agent's sources (the account's members among the roster's rows, a departed one kept). */
  cohort: CompareAgentSources[];
  /** The cohort's names. */
  names: ReadonlyMap<string, string | null>;
  trend: CompareTrendSources | null;
}

/** A query's answer from its snapshot: pure, run per request (a cached snapshot answers any picks and order). */
export function compareAnswer(q: CompareQueryRead, snap: CompareSnapshot): CompareQueryOutcome {
  const members = new Set(snap.cohort.map((a) => a.agent_user_id));
  if (!q.agentIds.every((id) => members.has(id))) return { kind: 'not_in_cohort' };
  return {
    kind: 'ok',
    response: assembleCompareResponse({
      campaignId: q.campaignId,
      from: q.from,
      to: q.to,
      timezone: q.timezone,
      asOf: snap.asOf,
      metrics: q.metrics,
      trendMetric: q.trend,
      picked: q.agentIds,
      cohort: snap.cohort,
      names: snap.names,
      trend: snap.trend,
    }),
  };
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
export interface ReadDeadline {
  signal: AbortSignal;
  at: number;
}

/** The deadline of a read that starts now and may take `ms`. */
export function readDeadline(ms: number): ReadDeadline {
  return { signal: AbortSignal.timeout(ms), at: performance.now() + ms };
}

/** Why a snapshot stops early: the client went away, or the whole read's deadline passed. */
interface SnapshotStops {
  gone?: AbortSignal | undefined;
  deadline: ReadDeadline;
}

/**
 * One query snapshot in flight, shared by every request for its key that arrives before it settles
 * (a joiner takes no slot: it runs nothing). The load holds ONE slot, released when it settles.
 * When every request waiting on it has gone it is aborted: its statement is cancelled, and the
 * load settles (and gives its slot back) once that statement has ended.
 */
interface SharedLoad {
  promise: Promise<CompareSnapshot>;
  controller: AbortController;
  release: () => void;
  waiters: number;
  settled: boolean;
}

const noop = (): void => undefined;

export class CompareReads {
  private readonly cache: TtlCache<CompareSnapshot>;
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
    this.cache = new TtlCache<CompareSnapshot>({ ttlMs, maxEntries, name: 'agency-compare' });
    this.cohortCache = new TtlCache<CompareCohortList>({ ttlMs, maxEntries, name: 'agency-compare-cohort' });
    this.limiter = new TenantReadLimiter(
      opts.perTenant ?? COMPARE_TENANT_CONCURRENT_READS,
      opts.global ?? (() => compareGlobalReadLimit(this.deps.poolMax())),
    );
    this.timeoutMs = opts.timeoutMs ?? COMPARE_READ_TIMEOUT_MS;
  }

  /**
   * The comparison: its snapshot from the cache (no slot), joined to the same snapshot in flight (no
   * slot), or a new read under the limits; then the answer for this request's picks and metrics
   * (`compareAnswer`, no SQL). Throws {@link CompareRefusal}; {@link CompareAborted} when `signal`
   * aborts first (the client went away). When every request waiting on a read has gone, its
   * statement is cancelled and its slot comes back once that statement has ended.
   */
  async query(q: CompareQueryRead, signal?: AbortSignal): Promise<CompareQueryOutcome> {
    if (signal?.aborted) throw new CompareAborted();
    const key = compareSnapshotKey(q);
    const snap = this.cache.get(key) ?? await this.wait(this.loadFor(key, q), key, signal);
    return compareAnswer(q, snap);
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
      promise: this.readSnapshot(q, controller.signal).then((out) => {
        // An aborted read's snapshot is nobody's; a snapshot is kept for the TTL.
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
  private wait(load: SharedLoad, key: string, signal: AbortSignal | undefined): Promise<CompareSnapshot> {
    load.waiters += 1;
    let done = false;
    return new Promise<CompareSnapshot>((resolve, reject) => {
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
   * The transaction itself (`withCancellableRead`, `@magick-agency/db/utils/cancellable-read`: the
   * cancel by pid, awaited, the connection destroyed after it, a statement abandoned after the
   * grace), under `statement_timeout`s that end each statement before `deadlineAt` (module note).
   */
  private inSnapshot<T>(fn: (db: PoolClient) => Promise<T>, signal: AbortSignal, deadlineAt: number): Promise<T> {
    return withCancellableRead(this.deps.pool, {
      signal,
      cancel: (pid) => this.deps.cancelBackend(pid),
      timeout: { deadlineAt, marginMs: COMPARE_STATEMENT_TIMEOUT_MARGIN_MS, slackMs: COMPARE_STATEMENT_TIMEOUT_SLACK_MS },
      // Inside every limit the pool sets: the compare read is the shortest reader there is.
      ceiling: 'session',
      settings: { max_parallel_workers_per_gather: COMPARE_MAX_PARALLEL_WORKERS_PER_GATHER },
      // Abandoned rather than waited for: the slot must come back (module note).
      graceMs: COMPARE_CANCEL_GRACE_MS,
    }, (tx) => fn(tx.client));
  }

  /**
   * The cohort's roster rows and `fn`'s reads in ONE snapshot, then (on the pool, after it: a read
   * never holds two connections) the account's members among the rows, a departed one kept (CP8),
   * and which of them are active.
   */
  private async cohortMembers<X>(
    q: CompareWindowScope,
    read: CompareReadKind,
    gone: AbortSignal | undefined,
    fn: (db: PoolClient, rows: readonly RosterAttemptTotalsRow[]) => Promise<X>,
  ): Promise<{ rows: RosterAttemptTotalsRow[]; active: ReadonlySet<string>; extra: X }> {
    const params = rosterParams({ from: q.start, to: q.end, campaignId: q.campaignId });
    const scope = { tenantId: q.tenantId, accountId: q.accountId };
    const deadline = readDeadline(this.timeoutMs);
    const { attempts, extra } = await this.snapshot(read, async (db) => {
      const attempts = await rosterAttemptTotals(scope, params, db);
      return { attempts, extra: await fn(db, attempts) };
    }, { gone, deadline });
    if (gone?.aborted) throw new CompareAborted();
    const memberships = await this.deps.memberships(attempts.map((r) => r.agent_user_id), q.tenantId);
    const agentOf = (r: RosterAttemptTotalsRow): string => r.agent_user_id;
    const rows = filterRowsByMembership(attempts, memberships, q.accountId, true, agentOf).rows;
    const active = new Set(filterRowsByMembership(rows, memberships, q.accountId, false, agentOf).rows.map(agentOf));
    return { rows, active, extra };
  }

  /** The options' cohort list. */
  private async readCohort(q: CompareWindowScope, gone?: AbortSignal): Promise<CompareCohortList> {
    const { rows, active } = await this.cohortMembers(q, 'options', gone, async () => null);
    const names = await this.deps.names(rows.map((r) => r.agent_user_id), q.tenantId);
    const agents: AgencyCompareCohortAgent[] = rows.map((r) => ({
      agent_user_id: r.agent_user_id,
      name: names.get(r.agent_user_id) ?? null,
      calls: r.connected,
      reportable: r.connected >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
      active: active.has(r.agent_user_id),
    }));
    agents.sort((x, y) =>
      y.calls - x.calls
      || (x.name ?? '￿').localeCompare(y.name ?? '￿')
      || x.agent_user_id.localeCompare(y.agent_user_id));
    return { agents };
  }

  /**
   * A query's snapshot (module note): the cohort, then each source its metrics need for the whole
   * cohort, the occupancy of {@link compareOccupancyAgents}, and the trend's day counts and
   * logged-in days when a trend is asked, all in one transaction; then the cohort's names.
   */
  private async readSnapshot(q: CompareQueryRead, signal: AbortSignal): Promise<CompareSnapshot> {
    const params = rosterParams({ from: q.start, to: q.end, campaignId: q.campaignId });
    const scope = { tenantId: q.tenantId, accountId: q.accountId };
    const needs = new Set(compareQuerySources(q));
    const occupancyFor = compareOccupancyAgents(q);
    const asOf = this.deps.now();

    const { rows, extra: read } = await this.cohortMembers(q, 'query', signal, async (db, attempts) => {
      const rosterIds = attempts.map((r) => r.agent_user_id);
      const cohortScope: CompareCohortScope = {
        campaignId: q.campaignId, tenantId: q.tenantId, accountId: q.accountId, from: q.start, to: q.end, agentIds: rosterIds,
      };
      const occupancyIds = occupancyFor === 'cohort' ? rosterIds : occupancyFor;
      const occupancy = await rosterOccupancyTotals(scope, params, occupancyIds, db);
      const rollup = needs.has('rollup') ? await agencyCompareReadRepository.rollupCodes(db, cohortScope) : null;
      const promises = needs.has('promises') ? await agencyCompareReadRepository.promises(db, cohortScope) : null;
      const callbacks = needs.has('callbacks') ? await agencyCompareReadRepository.callbacks(db, { ...cohortScope, now: asOf }) : null;
      const breaks = needs.has('breaks') ? await agencyCompareReadRepository.breakOverruns(db, cohortScope) : null;
      let trend: CompareTrendSources | null = null;
      if (q.trend !== null) {
        const ref = q.trend.ref;
        const days = { ...cohortScope, timezone: q.databaseTimezone };
        const dayRows = ref.kind === 'outcomes'
          ? await agencyCompareReadRepository.rollupCodeDays(db, { ...days, codes: ref.codes })
          : await agencyCompareReadRepository.promiseDays(db, days);
        const loggedIn = await agencyCompareReadRepository.loggedInDays(db, days);
        const counts = new Map<string, Map<string, number>>();
        for (const [agent, agentRows] of groupBy(dayRows, (r) => r.agent_user_id)) {
          counts.set(agent, sumBy(agentRows, (r) => r.date, (r) => r.n));
        }
        trend = { dates: localDates(q.from, q.to), counts, loggedIn };
      }
      return { occupancy, occupancyIds: new Set(occupancyIds), rollup, promises, callbacks, breaks, trend };
    });

    const occupancyByAgent = groupBy(read.occupancy, (r) => r.agent_user_id);
    const rollupByAgent = groupBy(read.rollup ?? [], (r) => r.agent_user_id);
    const promisesByAgent = new Map((read.promises ?? []).map((p) => [p.agent_user_id, p]));

    const cohort: CompareAgentSources[] = rows.map((r) => ({
      agent_user_id: r.agent_user_id,
      roster: r,
      // Folded exactly as the roster folds each row (`foldOccupancy`): the same shift seconds.
      occupancy: read.occupancyIds.has(r.agent_user_id) ? foldOccupancy(occupancyByAgent.get(r.agent_user_id) ?? []) : null,
      rollup: read.rollup === null ? null
        : sumBy(rollupByAgent.get(r.agent_user_id) ?? [], (c) => c.disposition_code, (c) => c.conversations),
      promises: read.promises === null ? null : { ...ZERO_PROMISES, ...promisesByAgent.get(r.agent_user_id) },
      callbacks: read.callbacks === null ? null : read.callbacks.get(r.agent_user_id) ?? ZERO_CALLBACKS,
      break_overruns: read.breaks === null ? null : read.breaks.get(r.agent_user_id) ?? 0,
    }));
    const names = await this.deps.names(cohort.map((a) => a.agent_user_id), q.tenantId);
    return { asOf, cohort, names, trend: read.trend };
  }
}

/** `rows` grouped by `keyOf`, each group in the rows' order. */
function groupBy<T, K>(rows: readonly T[], keyOf: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = out.get(key);
    if (list) list.push(row);
    else out.set(key, [row]);
  }
  return out;
}

/** `rows` summed by `keyOf`. */
function sumBy<T, K>(rows: readonly T[], keyOf: (row: T) => K, valueOf: (row: T) => number): Map<K, number> {
  const out = new Map<K, number>();
  for (const row of rows) out.set(keyOf(row), (out.get(keyOf(row)) ?? 0) + valueOf(row));
  return out;
}

/** An agent with no promise row: none recorded, no other conversations. */
const ZERO_PROMISES = { promises: 0, amount: 0, other_conversations: 0 } as const;
