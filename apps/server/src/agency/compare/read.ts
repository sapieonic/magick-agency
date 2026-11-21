/**
 * Compare agents' read, with its guards (docs/compare-agents.md §7, CP6): it runs in the primary
 * against the live database, so it is bounded three ways.
 *
 *  - **One snapshot, one timeout.** Every statement of one read runs on one client in a read-only
 *    REPEATABLE READ transaction (so the figures agree with each other), whose first statement sets
 *    `statement_timeout` to `COMPARE_READ_TIMEOUT_MS` for that transaction only (`SET LOCAL`, or a
 *    lower ceiling the session already has: the pool's `DB_STATEMENT_TIMEOUT_MS` or the role's).
 *    A statement cancelled for it (`57014`) is `503 compare_timed_out`.
 *  - **At most `COMPARE_TENANT_CONCURRENT_READS` reads per tenant at once**, the query and the
 *    options together; past it `429 compare_busy`, at once, never queued (a queued read would hold
 *    the page while the earlier ones run). In-process: the server is one replica. A slot belongs to
 *    a read that runs SQL: a cached answer and a request that joins an identical read in flight take
 *    none. **A client that goes away gives its slot back at once** (the route aborts the request's
 *    signal when its connection closes before the answer, as the console does on a superseded
 *    read): a query read is aborted once no request waits on it any more, the options read at
 *    once, and the statement running is cancelled (`pg_cancel_backend`, the report cursor's
 *    pattern) with no further statement sent. Without that, a supervisor clicking quickly would
 *    hold slots for reads nobody reads and meet `compare_busy`.
 *  - **A 30 s cache** (`COMPARE_CACHE_TTL_MS`, `TtlCache`: single-flight, so identical reads at
 *    once share one load) keyed by the tenant, the caller's scope (the context account: the cohort
 *    is the account's roster), the campaign, the window, the zone, the agents in order and the
 *    metric ids in order plus the trend's. An answer from the cache takes no slot and is not timed.
 *    The ids do not carry an outcome set's label, so the cached answer's `metrics` and
 *    `trend_metric` are replaced by the request's own (same ids, same order).
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
import { withTransaction, type TransactionPool } from '@magick-agency/db/utils/transaction';
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
  /** The local dates, both inclusive, and the zone they are cut in. */
  from: string;
  to: string;
  timezone: string;
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
  /** Cancel the statement running on backend `pid` (`pg_cancel_backend`, as the report cursor does). */
  cancelBackend(pid: number): Promise<void>;
  now(): Date;
}

export const defaultCompareReadDeps = (): CompareReadDeps => ({
  pool: { connect: () => getPool().connect() },
  cancelBackend: async (pid) => { await getPool().query('SELECT pg_cancel_backend($1::int)', [pid]); },
  memberships: (ids, tenantId) => membershipRepository.findAnyByUsersAndTenant(ids, tenantId),
  names: (ids, tenantId) => agentNamesOrNone(ids, tenantId, 'compare agents'),
  now: () => new Date(),
});

/** Answers held at once: far above the comparisons a process's supervisors open in 30 s. */
export const COMPARE_CACHE_MAX_ENTRIES = 500;

/**
 * The transaction's `statement_timeout`: `$1` milliseconds, or the session's own when it is set and
 * lower (`pg_settings.setting` is in milliseconds for this one). `is_local`: this transaction only.
 */
export const COMPARE_STATEMENT_TIMEOUT_SQL = `SELECT set_config('statement_timeout',
         (CASE WHEN setting::bigint > 0 THEN LEAST(setting::bigint, $1::bigint) ELSE $1::bigint END)::text, true)
    FROM pg_settings WHERE name = 'statement_timeout'`;

/** `57014 query_canceled`: what a statement past its `statement_timeout` raises. */
function isStatementTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '57014';
}

/**
 * At most `limit` reads per tenant at once. Non-blocking: a caller past the limit is refused, never
 * queued. The release is idempotent, so a double call cannot free a slot someone else holds.
 */
export class TenantReadLimiter {
  private readonly held = new Map<string, number>();

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`TenantReadLimiter: limit must be a positive integer, got ${limit}`);
  }

  /** A release function when a slot was free, else null. */
  tryAcquire(tenantId: string): (() => void) | null {
    const n = this.held.get(tenantId) ?? 0;
    if (n >= this.limit) return null;
    this.held.set(tenantId, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.held.get(tenantId) ?? 1) - 1;
      if (left <= 0) this.held.delete(tenantId);
      else this.held.set(tenantId, left);
    };
  }

  /** Slots the tenant holds now. Test and diagnostic use. */
  inFlight(tenantId: string): number {
    return this.held.get(tenantId) ?? 0;
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

/**
 * One query read in flight, shared by every request for its key that arrives before it settles
 * (a joiner takes no slot: it runs nothing). The load holds ONE slot, released when it settles, or
 * at once when every request waiting on it has gone, which also aborts it (the statement running
 * is cancelled).
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
  private readonly loads = new Map<string, SharedLoad>();
  private readonly limiter: TenantReadLimiter;
  private readonly timeoutMs: number;
  private readonly deps: CompareReadDeps;

  constructor(opts: {
    deps?: Partial<CompareReadDeps>;
    ttlMs?: number;
    perTenant?: number;
    timeoutMs?: number;
    maxEntries?: number;
  } = {}) {
    this.deps = { ...defaultCompareReadDeps(), ...opts.deps };
    this.cache = new TtlCache<CompareQueryOutcome>({
      ttlMs: opts.ttlMs ?? COMPARE_CACHE_TTL_MS,
      maxEntries: opts.maxEntries ?? COMPARE_CACHE_MAX_ENTRIES,
      name: 'agency-compare',
    });
    this.limiter = new TenantReadLimiter(opts.perTenant ?? COMPARE_TENANT_CONCURRENT_READS);
    this.timeoutMs = opts.timeoutMs ?? COMPARE_READ_TIMEOUT_MS;
  }

  /**
   * The comparison: from the cache (no slot), joined to the same read in flight (no slot), or a new
   * read under the tenant's limit. Throws {@link CompareRefusal}; {@link CompareAborted} when
   * `signal` aborts first (the client went away). When every request waiting on a read has gone,
   * its slot is released at once and its statement cancelled.
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
   * The cohort's agents for the chips, under the tenant's limit (never cached). Throws
   * {@link CompareRefusal}; {@link CompareAborted} when `signal` aborts first, which releases the
   * slot at once and cancels the statement.
   */
  async cohort(q: CompareWindowScope, signal?: AbortSignal): Promise<CompareCohortList> {
    if (signal?.aborted) throw new CompareAborted();
    const release = this.acquire(q.tenantId);
    signal?.addEventListener('abort', release, { once: true });
    try {
      return await this.readCohort(q, signal);
    } finally {
      signal?.removeEventListener('abort', release);
      release();
    }
  }

  /** Slots the tenant holds now. Test and diagnostic use. */
  inFlight(tenantId: string): number {
    return this.limiter.inFlight(tenantId);
  }

  /** Drop every cached answer. */
  clear(): void {
    this.cache.clear();
  }

  /** A slot of the tenant's, or `compare_busy`. The release is idempotent. */
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
          // Nobody is left to answer: free the slot now and stop the statement.
          if (this.loads.get(key) === load) this.loads.delete(key);
          load.release();
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
   * `fn` in one read-only snapshot under the statement timeout, timed. When `signal` aborts, the
   * statement running is cancelled (`pg_cancel_backend` on this client's backend, sent only while
   * one of its statements runs, as the report cursor does), no further statement is sent, and the
   * read ends {@link CompareAborted}.
   */
  private async snapshot<T>(read: CompareReadKind, fn: (db: PoolClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const started = performance.now();
    let result: CompareReadResult = 'failed';
    try {
      signal?.throwIfAborted();
      const out = await withTransaction(async (client) => {
        const pid = (client as unknown as { processID?: number | null }).processID;
        let running = false;
        const cancel = (): void => {
          if (running && pid != null) this.deps.cancelBackend(pid).catch(noop);
        };
        signal?.addEventListener('abort', cancel, { once: true });
        // Every statement of the read goes through here: none is sent once the caller has gone.
        const query = async (text: string, values?: unknown[]): Promise<unknown> => {
          signal?.throwIfAborted();
          running = true;
          try {
            return await client.query(text, values);
          } finally {
            running = false;
          }
        };
        const guarded = new Proxy(client, {
          get: (target, prop, receiver) => (prop === 'query' ? query : Reflect.get(target, prop, receiver)),
        });
        try {
          await query(COMPARE_STATEMENT_TIMEOUT_SQL, [this.timeoutMs]);
          return await fn(guarded);
        } finally {
          signal?.removeEventListener('abort', cancel);
        }
      }, { pool: this.deps.pool, isolation: 'REPEATABLE READ', readOnly: true });
      result = 'ok';
      return out;
    } catch (err) {
      if (signal?.aborted) {
        result = 'aborted';
        throw new CompareAborted();
      }
      if (isStatementTimeout(err)) {
        result = 'timed_out';
        agencyCompareReadsRefusedTotal.inc({ reason: 'timed_out' });
        throw new CompareRefusal('compare_timed_out');
      }
      throw err;
    } finally {
      agencyCompareReadSeconds.observe({ read, result }, (performance.now() - started) / 1000);
    }
  }

  /** The cohort's roster rows and their memberships, in one snapshot. */
  private async readCohort(q: CompareWindowScope, signal?: AbortSignal): Promise<CompareCohortList> {
    const params = rosterParams({ from: q.start, to: q.end, campaignId: q.campaignId });
    const scope = { tenantId: q.tenantId, accountId: q.accountId };
    const rows = await this.snapshot('options', (db) => rosterAttemptTotals(scope, params, db), signal);
    if (signal?.aborted) throw new CompareAborted();
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
    agents.sort((a, b) =>
      b.calls - a.calls
      || (a.name ?? '￿').localeCompare(b.name ?? '￿')
      || a.agent_user_id.localeCompare(b.agent_user_id));
    return { agents };
  }

  /** The comparison's read (module note). */
  private async readQuery(q: CompareQueryRead, signal: AbortSignal): Promise<CompareQueryOutcome> {
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
          ? await agencyCompareReadRepository.rollupCodeDays(db, { ...cohortScope, codes: ref.codes, timezone: q.timezone })
          : await agencyCompareReadRepository.promiseDays(db, { ...cohortScope, timezone: q.timezone });
        const loggedIn = await agencyCompareReadRepository.loggedInDays(db, { ...cohortScope, timezone: q.timezone });
        const counts = new Map<string, Map<string, number>>();
        for (const r of dayRows) {
          const days = counts.get(r.agent_user_id) ?? new Map<string, number>();
          days.set(r.date, (days.get(r.date) ?? 0) + r.n);
          counts.set(r.agent_user_id, days);
        }
        trend = { dates: localDates(q.from, q.to), counts, loggedIn };
      }

      return { attempts, occupancyRows, rollup, promises, callbacks, breaks, trend, occupancyIds };
    }, signal);
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
