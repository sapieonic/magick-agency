/**
 * Team performance's read, with its guards (docs/team-performance.md §4, TP20): it runs in the
 * primary against the live database over the whole account's cohort, so it is bounded on every side
 * by Compare agents' guards (`agency/compare/read.ts`, whose rules this reuses rather than restates),
 * through the same mechanics (`agency/budgeted-read.ts`) with Team performance's limits, codes and
 * metrics:
 *
 *  - **One snapshot, one deadline.** Every statement runs on one connection in a read-only REPEATABLE
 *    READ transaction (`withCancellableRead`), so the figures agree with each other, under
 *    `TEAM_PERFORMANCE_READ_TIMEOUT_MS` counted from before the connection is taken: each statement
 *    under a `statement_timeout` of what is left less Compare's margin, the deadline the backstop,
 *    one parallel worker (`COMPARE_MAX_PARALLEL_WORKERS_PER_GATHER`). Past either
 *    `503 team_timed_out`.
 *  - **Slots.** At most `TEAM_PERFORMANCE_TENANT_CONCURRENT_READS` reads per tenant and Compare's
 *    process-wide share of the pool (`compareGlobalReadLimit`), team reads having their own; past
 *    either, `429 team_busy` at once, never queued. A slot is given back when the read's statement
 *    has ENDED.
 *  - **A client that goes away** (the route aborts the request's signal): the read is aborted once
 *    no request waits on it, its statement cancelled as `withCancellableRead` does it.
 *  - **A 30 s cache** (`TEAM_PERFORMANCE_CACHE_TTL_MS`) of the answer, keyed by the tenant, the
 *    account, the campaign (or all), the window and the zone ({@link teamPerformanceCacheKey}); an
 *    identical read already running is joined. A cached or joined answer takes no slot and is not
 *    timed.
 *
 * The snapshot, in this order: the scope's campaigns, the rollup by code over the window, the
 * campaigns with promises in it (All campaigns only, and only when a campaign of the scope records
 * promises); from those the main outcome, decided over the campaigns worked in the window (TP8);
 * the roster's attempt aggregate for the scope (`rosterAttemptTotals`, the cohort: who dialled in the
 * window, TP5), its occupancy for the whole cohort (the break column), the rollup by day over the
 * chart's range (TP12, TP13), the promises and the promises per day
 * (promises only), the call-backs. Then, on the pool (a read never holds two connections), the
 * membership filter (`filterRowsByMembership`, a departed member kept and flagged, an id with no
 * membership in the tenant dropped, as the roster route does) and the cohort's names.
 *
 * Metrics: `agency_team_performance_read_seconds{result}` per read that ran,
 * `agency_team_performance_reads_refused_total{reason}` per guard refusal.
 */
import { TtlCache } from '@magick-agency/db/utils/ttl-cache';
import {
  TEAM_PERFORMANCE_CACHE_TTL_MS,
  TEAM_PERFORMANCE_READ_TIMEOUT_MS,
  TEAM_PERFORMANCE_TENANT_CONCURRENT_READS,
  type AgencyTeamPerformance,
} from '@magick-agency/contracts/api/agency/team-performance';
import {
  agencyTeamPerformanceReadSeconds,
  agencyTeamPerformanceReadsRefusedTotal,
} from '@magick-agency/observability/metrics/agency';
import {
  agencyTeamPerformanceReadRepository as repo,
  rosterAttemptTotals,
  rosterOccupancyTotals,
  ZERO_CALLBACKS,
  type TeamScope,
} from '../../db/repositories/agency.repository.js';
import { foldOccupancy, rosterParams } from '../agent-record.js';
import { agentNamesOrNone } from '../agency-agent-identity.js';
import { BudgetedReads, SharedReads } from '../budgeted-read.js';
import { effectiveCatalog } from '../disposition-policy.js';
import { localDayBounds } from '../reports/schedule.js';
import {
  COMPARE_STATEMENT_BUDGET,
  cohortMembership,
  compareGlobalReadLimit,
  defaultCompareReadDeps,
  groupBy,
  type CompareReadDeps,
} from '../compare/read.js';
import {
  assembleTeamPerformance,
  mainOutcomeFor,
  recordsPromises,
  teamTrendRange,
  workedCampaigns,
  type TeamAgentSources,
  type TeamCampaign,
} from './assemble.js';

/** A guard's refusal: the route answers it with the code's status and the reviewed body. */
export class TeamRefusal extends Error {
  constructor(readonly code: 'team_busy' | 'team_timed_out') {
    super(code);
    this.name = 'TeamRefusal';
  }
}

/** The caller went away (its `signal` aborted) before the answer: nobody is left to answer. */
export class TeamAborted extends Error {
  constructor() {
    super('team performance read aborted: the client went away');
    this.name = 'TeamAborted';
  }
}

/** One read as the route resolved it. */
export interface TeamPerformanceRead {
  tenantId: string;
  accountId: string;
  /** One campaign of the account (lower-cased), or null for All campaigns. */
  campaignId: string | null;
  /** The local dates, both inclusive, and the request's zone: what the answer echoes and the cache keys. */
  from: string;
  to: string;
  timezone: string;
  /** The name Postgres cuts the days in (`postgresZoneName`). */
  databaseTimezone: string;
}

/** What the read reaches besides the agency tables: Compare's (`CompareReadDeps`). Tests replace any of it. */
export type TeamReadDeps = CompareReadDeps;

export const defaultTeamReadDeps = (): TeamReadDeps => ({
  ...defaultCompareReadDeps(),
  names: (ids, tenantId) => agentNamesOrNone(ids, tenantId, 'team performance'),
});

/** Answers held at once: far above the team pages a process's supervisors open in 30 s. */
const TEAM_PERFORMANCE_CACHE_MAX_ENTRIES = 500;

/** The cache key: the tenant, the account, the campaign (or all), the window and the zone. */
export function teamPerformanceCacheKey(q: TeamPerformanceRead): string {
  return JSON.stringify([q.tenantId, q.accountId, q.campaignId, q.from, q.to, q.timezone]);
}

export class TeamPerformanceReads {
  private readonly answers: SharedReads<AgencyTeamPerformance>;
  private readonly reads: BudgetedReads;
  private readonly deps: TeamReadDeps;

  constructor(opts: {
    deps?: Partial<TeamReadDeps>;
    ttlMs?: number;
    perTenant?: number;
    /** The process-wide limit; default Compare's share of the pool (`compareGlobalReadLimit`). */
    global?: number;
    timeoutMs?: number;
  } = {}) {
    this.deps = { ...defaultTeamReadDeps(), ...opts.deps };
    this.reads = new BudgetedReads({
      deps: this.deps,
      perTenant: opts.perTenant ?? TEAM_PERFORMANCE_TENANT_CONCURRENT_READS,
      global: opts.global ?? (() => compareGlobalReadLimit(this.deps.poolMax())),
      timeoutMs: opts.timeoutMs ?? TEAM_PERFORMANCE_READ_TIMEOUT_MS,
      budget: COMPARE_STATEMENT_BUDGET,
      busy: () => new TeamRefusal('team_busy'),
      timedOut: () => new TeamRefusal('team_timed_out'),
      aborted: () => new TeamAborted(),
      refused: (reason) => agencyTeamPerformanceReadsRefusedTotal.inc({ reason }),
    });
    this.answers = new SharedReads(this.reads, new TtlCache<AgencyTeamPerformance>({
      ttlMs: opts.ttlMs ?? TEAM_PERFORMANCE_CACHE_TTL_MS, maxEntries: TEAM_PERFORMANCE_CACHE_MAX_ENTRIES, name: 'agency-team-performance',
    }));
  }

  /**
   * The answer: from the cache (no slot), joined to the same read in flight (no slot), or a new read
   * under the limits. Throws {@link TeamRefusal}; {@link TeamAborted} when `signal` aborts first.
   */
  async read(q: TeamPerformanceRead, signal?: AbortSignal): Promise<AgencyTeamPerformance> {
    return this.answers.get(teamPerformanceCacheKey(q), q.tenantId, (gone) => this.readAnswer(q, gone), signal);
  }

  /** Slots the tenant holds now. Test and diagnostic use. */
  inFlight(tenantId: string): number {
    return this.reads.inFlight(tenantId);
  }

  /** Drop every cached answer. */
  clear(): void {
    this.answers.clear();
  }

  /** The snapshot (module note), then the membership filter and the names on the pool, then the answer. */
  private async readAnswer(q: TeamPerformanceRead, gone: AbortSignal): Promise<AgencyTeamPerformance> {
    const asOf = this.deps.now();
    const window = localDayBounds(q.from, q.to, q.timezone);
    const trendRange = teamTrendRange(q.from, q.to);
    const trendStart = localDayBounds(trendRange.from, trendRange.to, q.timezone).start;
    const scope: TeamScope = q.campaignId === null ? { kind: 'account' } : { kind: 'campaign', campaignId: q.campaignId };
    const tenancy = { tenantId: q.tenantId, accountId: q.accountId };
    const params = rosterParams({ from: window.start, to: window.end, ...(q.campaignId === null ? {} : { campaignId: q.campaignId }) });

    const read = await this.reads.snapshot(async (db) => {
      const campaigns: TeamCampaign[] = (await repo.scopeCampaigns(db, { ...tenancy, scope, range: { from: trendStart, to: window.end } }))
        .map((c) => ({ id: c.id, wrapup_seconds: c.wrapup_seconds, catalog: effectiveCatalog(c.disposition_catalog), rollup_as_of: c.rollup_as_of }));
      const campaignIds = campaigns.map((c) => c.id);
      const rollupCodes = await repo.rollupCodes(db, { ...tenancy, campaignIds, from: window.start, to: window.end });
      // The main outcome is decided over the campaigns worked in the window (TP8). Promises can tip
      // it only across the account, and only when some campaign of the scope records them.
      const promiseCampaigns = scope.kind === 'account' && campaigns.some(recordsPromises)
        ? await repo.promiseCampaigns(db, { ...tenancy, scope, from: window.start, to: window.end })
        : [];
      const main = mainOutcomeFor(campaigns, workedCampaigns(rollupCodes, promiseCampaigns));
      const attempts = await rosterAttemptTotals(tenancy, params, db);
      const agentIds = attempts.map((r) => r.agent_user_id);
      const occupancy = agentIds.length === 0 ? [] : await rosterOccupancyTotals(tenancy, params, agentIds, db);
      const cohort = { ...tenancy, scope, from: window.start, to: window.end, agentIds };
      const rollupDays = await repo.rollupDays(db, { ...tenancy, campaignIds, from: trendStart, to: window.end, timezone: q.databaseTimezone });
      const promises = main.kind === 'promises' ? await repo.promises(db, cohort) : null;
      const promiseDays = main.kind === 'promises'
        ? await repo.promiseDays(db, { ...tenancy, scope, from: trendStart, to: window.end, timezone: q.databaseTimezone })
        : [];
      const callbacks = await repo.callbacks(db, { ...cohort, now: asOf });
      return { campaigns, main, attempts, occupancy, rollupCodes, rollupDays, promises, promiseDays, callbacks };
    }, gone, (result, seconds) => agencyTeamPerformanceReadSeconds.observe({ result }, seconds));
    if (gone.aborted) throw new TeamAborted();

    // The memberships and the names together, on the pool: names are looked up only for the rows kept.
    const ids = read.attempts.map((r) => r.agent_user_id);
    const [memberships, names] = await Promise.all([this.deps.memberships(ids, q.tenantId), this.deps.names(ids, q.tenantId)]);
    const { rows, active } = cohortMembership(read.attempts, memberships, q.accountId);

    const occupancyByAgent = groupBy(read.occupancy, (o) => o.agent_user_id);
    const promisesByAgent = new Map((read.promises ?? []).map((p) => [p.agent_user_id, p]));
    const agents: TeamAgentSources[] = rows.map((r) => {
      // Folded exactly as the roster folds each row (`foldOccupancy`): the same shift and break seconds.
      const fold = foldOccupancy(occupancyByAgent.get(r.agent_user_id) ?? []);
      const p = promisesByAgent.get(r.agent_user_id);
      return {
        agent_user_id: r.agent_user_id,
        agent_name: names.get(r.agent_user_id) ?? null,
        departed: !active.has(r.agent_user_id),
        roster: r,
        occupancy: { shift_seconds: fold.shift_seconds, break_seconds: fold.by_state.break },
        promises: read.promises === null ? null : { promises: p?.promises ?? 0, other_conversations: p?.other_conversations ?? 0 },
        callbacks: read.callbacks.get(r.agent_user_id) ?? ZERO_CALLBACKS,
      };
    });

    return assembleTeamPerformance({
      campaignId: q.campaignId,
      from: q.from,
      to: q.to,
      timezone: q.timezone,
      asOf,
      main: read.main,
      campaigns: read.campaigns,
      agents,
      rollupCodes: read.rollupCodes,
      trendRange,
      rollupDays: read.rollupDays,
      promiseDays: new Map(read.promiseDays.map((d) => [d.date, d.promises])),
    });
  }
}
