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
 *    the page while the earlier ones run). In-process: the server is one replica.
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
  now(): Date;
}

export const defaultCompareReadDeps = (): CompareReadDeps => ({
  pool: { connect: () => getPool().connect() },
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

export class CompareReads {
  private readonly cache: TtlCache<CompareQueryOutcome>;
  readonly limiter: TenantReadLimiter;
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

  /** The comparison: from the cache, or a read under the tenant's limit. Throws {@link CompareRefusal}. */
  async query(q: CompareQueryRead): Promise<CompareQueryOutcome> {
    const key = compareCacheKey(q);
    const outcome = this.cache.get(key)
      ?? await this.guarded(q.tenantId, () => this.cache.getOrLoad(key, () => this.readQuery(q)));
    if (outcome.kind !== 'ok') return outcome;
    // Same ids in the same order; the request's own refs and labels (module note).
    return { kind: 'ok', response: { ...outcome.response, metrics: [...q.metrics], trend_metric: q.trend } };
  }

  /** The cohort's agents for the chips, under the tenant's limit (never cached). Throws {@link CompareRefusal}. */
  async cohort(q: CompareWindowScope): Promise<CompareCohortList> {
    return this.guarded(q.tenantId, () => this.readCohort(q));
  }

  /** Drop every cached answer. */
  clear(): void {
    this.cache.clear();
  }

  private async guarded<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const release = this.limiter.tryAcquire(tenantId);
    if (release === null) {
      agencyCompareReadsRefusedTotal.inc({ reason: 'busy' });
      throw new CompareRefusal('compare_busy');
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** `fn` in one read-only snapshot under the statement timeout, timed. */
  private async snapshot<T>(read: CompareReadKind, fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const started = performance.now();
    let result: CompareReadResult = 'failed';
    try {
      const out = await withTransaction(async (client) => {
        await client.query(COMPARE_STATEMENT_TIMEOUT_SQL, [this.timeoutMs]);
        return fn(client);
      }, { pool: this.deps.pool, isolation: 'REPEATABLE READ', readOnly: true });
      result = 'ok';
      return out;
    } catch (err) {
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
  private async readCohort(q: CompareWindowScope): Promise<CompareCohortList> {
    const params = rosterParams({ from: q.start, to: q.end, campaignId: q.campaignId });
    const scope = { tenantId: q.tenantId, accountId: q.accountId };
    const rows = await this.snapshot('options', (db) => rosterAttemptTotals(scope, params, db));
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
  private async readQuery(q: CompareQueryRead): Promise<CompareQueryOutcome> {
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
    });
    if (read === null) return { kind: 'not_in_cohort' };
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
