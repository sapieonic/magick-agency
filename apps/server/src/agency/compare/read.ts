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
 * The mechanics (the slots, the snapshot under its deadline, a query read shared and aborted when
 * its last request leaves) are `agency/budgeted-read.ts`, which Team performance's read uses too;
 * this file passes it Compare's limits, budget ({@link COMPARE_STATEMENT_BUDGET}), codes and metrics.
 *
 * Metrics: `agency_compare_read_seconds{read,result}` per read that ran,
 * `agency_compare_reads_refused_total{reason}` per guard refusal.
 */
import { getPool } from '@magick-agency/db';
import type { TransactionPool } from '@magick-agency/db/utils/transaction';
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
import { BudgetedReads, SharedReads, type StatementBudget } from '../budgeted-read.js';
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

/** Compare's statement budget (the constants above), which Team performance's read shares. */
export const COMPARE_STATEMENT_BUDGET: StatementBudget = Object.freeze({
  marginMs: COMPARE_STATEMENT_TIMEOUT_MARGIN_MS,
  slackMs: COMPARE_STATEMENT_TIMEOUT_SLACK_MS,
  graceMs: COMPARE_CANCEL_GRACE_MS,
  maxParallelWorkersPerGather: COMPARE_MAX_PARALLEL_WORKERS_PER_GATHER,
});

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

export class CompareReads {
  private readonly snapshots: SharedReads<CompareSnapshot>;
  private readonly cohortCache: TtlCache<CompareCohortList>;
  private readonly reads: BudgetedReads;
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
    this.reads = new BudgetedReads({
      deps: this.deps,
      perTenant: opts.perTenant ?? COMPARE_TENANT_CONCURRENT_READS,
      global: opts.global ?? (() => compareGlobalReadLimit(this.deps.poolMax())),
      timeoutMs: opts.timeoutMs ?? COMPARE_READ_TIMEOUT_MS,
      budget: COMPARE_STATEMENT_BUDGET,
      busy: () => new CompareRefusal('compare_busy'),
      timedOut: () => new CompareRefusal('compare_timed_out'),
      aborted: () => new CompareAborted(),
      refused: (reason) => agencyCompareReadsRefusedTotal.inc({ reason }),
    });
    this.snapshots = new SharedReads(this.reads, new TtlCache<CompareSnapshot>({ ttlMs, maxEntries, name: 'agency-compare' }));
    this.cohortCache = new TtlCache<CompareCohortList>({ ttlMs, maxEntries, name: 'agency-compare-cohort' });
  }

  /**
   * The comparison: its snapshot from the cache (no slot), joined to the same snapshot in flight (no
   * slot), or a new read under the limits; then the answer for this request's picks and metrics
   * (`compareAnswer`, no SQL). Throws {@link CompareRefusal}; {@link CompareAborted} when `signal`
   * aborts first (the client went away). When every request waiting on a read has gone, its
   * statement is cancelled and its slot comes back once that statement has ended.
   */
  async query(q: CompareQueryRead, signal?: AbortSignal): Promise<CompareQueryOutcome> {
    const snap = await this.snapshots.get(compareSnapshotKey(q), q.tenantId, (gone) => this.readSnapshot(q, gone), signal);
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
    const release = this.reads.acquire(q.tenantId);
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
    return this.reads.inFlight(tenantId);
  }

  /** Slots held in the process now. Test and diagnostic use. */
  inFlightTotal(): number {
    return this.reads.inFlightTotal();
  }

  /** Drop every cached answer. */
  clear(): void {
    this.snapshots.clear();
    this.cohortCache.clear();
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
    const { attempts, extra } = await this.reads.snapshot(async (db) => {
      const attempts = await rosterAttemptTotals(scope, params, db);
      return { attempts, extra: await fn(db, attempts) };
    }, gone, (result, seconds) => agencyCompareReadSeconds.observe({ read, result }, seconds));
    if (gone?.aborted) throw new CompareAborted();
    const memberships = await this.deps.memberships(attempts.map((r) => r.agent_user_id), q.tenantId);
    return { ...cohortMembership(attempts, memberships, q.accountId), extra };
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

/**
 * The account's members among a cohort's roster rows, a departed one kept (CP8; an id with no
 * membership in the tenant dropped, as the roster route drops it), and which of them are active.
 */
export function cohortMembership<R extends { agent_user_id: string }>(
  attempts: readonly R[],
  memberships: ReadonlyArray<RosterMembershipRef>,
  accountId: string,
): { rows: R[]; active: ReadonlySet<string> } {
  const agentOf = (r: R): string => r.agent_user_id;
  const rows = filterRowsByMembership(attempts, memberships, accountId, true, agentOf).rows;
  const active = new Set(filterRowsByMembership(rows, memberships, accountId, false, agentOf).rows.map(agentOf));
  return { rows, active };
}

/** `rows` grouped by `keyOf`, each group in the rows' order. */
export function groupBy<T, K>(rows: readonly T[], keyOf: (row: T) => K): Map<K, T[]> {
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
