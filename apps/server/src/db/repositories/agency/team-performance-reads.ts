/**
 * Team performance's own reads (docs/team-performance.md §3, §4): the sources the roster does not
 * serve, each ONE statement for the whole scope over the window, on one campaign or across the
 * account. The cohort itself and its call counts, talk, wrap-up and logged-in time are the roster's
 * statements (`agent-roster-stats.ts`), which the read runs on the same client.
 *
 * Every statement runs on the caller's client (`db`), inside the team read's read-only REPEATABLE
 * READ transaction under its `statement_timeout` (`agency/team-performance/read.ts`), and is scoped
 * by the tenant AND the account. Every definition is Compare agents' (TP2, CP9; `compare-reads.ts`),
 * widened from one campaign to the scope:
 *
 *  - **The scope** ({@link TeamScope}): one campaign of the account, or every campaign of it. The
 *    campaign predicate is two SQL strings, chosen when the statement is built, never
 *    `$n IS NULL OR`: a promise, a soft-phone or an inbound call is on the campaign (`= $n::uuid`),
 *    or on a campaign at all (`IS NOT NULL`: "All campaigns" leaves out a call that belongs to
 *    none). A call-back is on the campaign, or on any campaign of the account, named as an array the
 *    planner can take `idx_agency_attempts_campaign_callback` with.
 *  - **The scope's campaigns** ({@link teamScopeCampaignsSql}): the campaign itself, or the
 *    account's campaigns a report covers (`accountCoveredCampaignIds`' rule: live now, or a rollup
 *    bucket with dials in the range), with what the answer reads off them: the allowed wrap-up, the
 *    catalog, and the rollup's freshness.
 *  - **The rollup** ({@link TEAM_ROLLUP_CODES_SQL}, {@link TEAM_ROLLUP_DAYS_SQL}): the Insights
 *    rollup's conversations by code (`agency_insights_rollup_codes`), dialler only, the team's,
 *    through the campaign row matched on id, tenant AND account (the rollup carries none), on the
 *    scope's campaigns (`uq_agency_insights_rollup_codes` leads with them).
 *  - **Promises** ({@link teamPromisesSql}, {@link teamPromiseDaysSql}): CP2, as
 *    `COMPARE_PROMISES_SQL` counts them: recorded (`dispositioned_at`) in the window on the three
 *    call tables, by the agent who took the call, each table on its 0050 index
 *    (`idx_*_promise_written`); beside them the soft-phone conversations (`SOFTPHONE_CONNECTED_SQL`,
 *    `created_at`) and the answered inbound calls (`arrived_at`) the rate is over. Per cohort agent
 *    over the window; per local day, the team's, over the chart's range.
 *  - **Call-backs** ({@link teamCallbacksSql}): IN4's classes of the call-backs each cohort agent
 *    booked whose booked time is in the window, `COMPARE_CALLBACKS_SQL`'s columns and CASE.
 *
 * The per-day reads are the team's, not only the window's cohort: the chart's earlier days (a short
 * window looks back 14 days, TP12) are the team's whoever worked them. Over the window itself every
 * dialler conversation is a cohort agent's (the roster is who dialled).
 */
import { AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES } from '@magick-agency/contracts/api/agency/insights';
import { AGENCY_HOME_ACTIVE_STATUSES } from '@magick-agency/contracts/api/agency/home';
import type { AgencyDisposition } from '@magick-agency/contracts/agency';
import type { InsightsCallbackClass } from './insights-range-reads.js';
import { CALLBACK_BOOKING_COLUMNS_SQL, callbackClassSql } from './insights-range-reads.js';
import { SOFTPHONE_CONNECTED_SQL } from './softphone-campaign-sql.js';
import type { RosterQueryable } from './agent-roster-stats.js';
import { ZERO_CALLBACKS, type CompareCallbackClasses } from './compare-reads.js';

/** One campaign of the account, or all of them ("All campaigns", TP7). */
export type TeamScope = { kind: 'campaign'; campaignId: string } | { kind: 'account' };

/** A window of instants, `[from, to)`. */
export interface TeamInstantWindow {
  from: Date;
  to: Date;
}

/** The tenant, the account and the scope every team statement is bound by. */
export interface TeamReadScope {
  tenantId: string;
  accountId: string;
  scope: TeamScope;
}

/** The per-agent statements' scope: the window and the cohort's agent ids (the roster's rows). */
export interface TeamCohortScope extends TeamReadScope, TeamInstantWindow {
  agentIds: readonly string[];
}

/** The rollup statements' scope: the window and the scope's campaigns. */
export interface TeamCampaignsScope extends TeamInstantWindow {
  tenantId: string;
  accountId: string;
  campaignIds: readonly string[];
}

/** One campaign of the scope, with what the answer reads off it. */
export interface TeamScopeCampaignRow {
  id: string;
  /** The allowed time to choose an outcome (0: no limit). */
  wrapup_seconds: number;
  /** As stored; `effectiveCatalog` turns an empty one into the default. */
  disposition_catalog: AgencyDisposition[] | null;
  /** The campaign's newest folded attempt change in the rollup (ISO instant); null when the rollup holds none. */
  rollup_as_of: string | null;
}

/** The team's dialler conversations on one campaign ending in one code (null: closed without one). */
export interface TeamRollupCodeRow {
  campaign_id: string;
  disposition_code: string | null;
  conversations: number;
}

/** {@link TeamRollupCodeRow} on one local day. */
export interface TeamRollupDayRow extends TeamRollupCodeRow {
  date: string;
}

/** One agent's promises in scope and the conversations beside the dialler's they are counted over. */
export interface TeamPromiseRow {
  agent_user_id: string;
  promises: number;
  /** Soft-phone and inbound conversations in scope (the dialler's are the roster's `connected`). */
  other_conversations: number;
}

/** The team's promises on one local day. */
export interface TeamPromiseDayRow {
  date: string;
  promises: number;
}

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * A call's campaign column in scope: the campaign (`param`), or any campaign at all. The two
 * spellings of the optional predicate (module note).
 */
function onCampaign(column: string, scope: TeamScope, param: string): string {
  return scope.kind === 'campaign' ? `${column} = ${param}::uuid` : `${column} IS NOT NULL`;
}

/** The campaign's id appended to `values` when the statement names it. */
function withCampaign(values: unknown[], scope: TeamScope): unknown[] {
  return scope.kind === 'campaign' ? [...values, scope.campaignId] : values;
}

/**
 * The scope's campaigns: `$1` tenant, `$2` account, then the campaign (`$3`), or the live statuses
 * (`$3`, `AGENCY_HOME_ACTIVE_STATUSES`) and the range (`$4`, `$5`) whose rollup dials bring a
 * campaign that is no longer live into the account's scope. Each campaign's rollup freshness is
 * Insights' `as_of` (the newest `source_updated_at` of its buckets).
 */
export function teamScopeCampaignsSql(scope: TeamScope): string {
  const which = scope.kind === 'campaign'
    ? 'c.id = $3::uuid'
    : `(c.status = ANY($3::text[])
          OR EXISTS (SELECT 1 FROM agency_insights_rollup_buckets b
                      WHERE b.campaign_id = c.id
                        AND b.bucket_start >= $4::timestamptz AND b.bucket_start < $5::timestamptz
                        AND b.dials > 0))`;
  return `
  SELECT c.id, c.wrapup_seconds, c.disposition_catalog,
         to_char((SELECT MAX(r.source_updated_at) FROM agency_insights_rollup_buckets r WHERE r.campaign_id = c.id)
                 AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS rollup_as_of
    FROM agency_campaigns c
   WHERE c.tenant_id = $1::uuid AND c.account_id = $2::uuid
     AND ${which}
   ORDER BY c.id`;
}

/**
 * The team's dialler conversations on the scope's campaigns (`$3`) in `[$4, $5)`: the rollup's
 * codes table through the campaign row matched on id, tenant (`$1`) and account (`$2`). Shared by
 * {@link TEAM_ROLLUP_CODES_SQL} and {@link TEAM_ROLLUP_DAYS_SQL}.
 */
const TEAM_ROLLUP_FROM_SQL = `
    FROM agency_insights_rollup_codes r
    JOIN agency_campaigns c ON c.id = r.campaign_id AND c.tenant_id = $1::uuid AND c.account_id = $2::uuid
   WHERE r.campaign_id = ANY($3::uuid[])
     AND r.bucket_start >= $4::timestamptz AND r.bucket_start < $5::timestamptz
     AND r.conversations > 0`;

/** The team's dialler conversations by campaign and code over the window ({@link TEAM_ROLLUP_FROM_SQL}). */
export const TEAM_ROLLUP_CODES_SQL = `
  SELECT r.campaign_id, r.disposition_code, SUM(r.conversations)::text AS conversations${TEAM_ROLLUP_FROM_SQL}
   GROUP BY 1, 2`;

/**
 * The same per local day (in `$6`) of the bucket, over the chart's range: the working days and the
 * successes per day (TP12). A 15-minute bucket never straddles a local midnight.
 */
export const TEAM_ROLLUP_DAYS_SQL = `
  SELECT r.campaign_id, to_char(r.bucket_start AT TIME ZONE $6::text, 'YYYY-MM-DD') AS date,
         r.disposition_code, SUM(r.conversations)::text AS conversations${TEAM_ROLLUP_FROM_SQL}
   GROUP BY 1, 2, 3`;

/**
 * Every promise recorded in `[$3, $4)` in scope on the three call tables, each by the agent who took
 * the call, tenant `$1` and account `$2`: `(agent_user_id, at)`. `COMPARE_PROMISES_SQL`'s rows with
 * the campaign in scope ({@link onCampaign}, `campaignParam`); of the cohort's agents (`$5`) when
 * `cohort`, else the team's.
 */
function promisedRowsSql(scope: TeamScope, campaignParam: string, cohort: boolean): string {
  const of = (column: string): string => (cohort ? `\n       AND ${column} = ANY($5::uuid[])` : '');
  return `
    SELECT s.agent_user_id, p.dispositioned_at AS at
      FROM agency_call_attempts p
      JOIN agency_agent_sessions s ON s.id = p.reserved_agent_id
     WHERE p.tenant_id = $1::uuid AND p.account_id = $2::uuid AND p.promise_date IS NOT NULL
       AND p.dispositioned_at >= $3::timestamptz AND p.dispositioned_at < $4::timestamptz
       AND ${onCampaign('p.campaign_id', scope, campaignParam)}
       AND s.tenant_id = $1::uuid AND s.account_id = $2::uuid${of('s.agent_user_id')}
    UNION ALL
    SELECT m.agent_user_id, m.dispositioned_at
      FROM agency_manual_calls m
     WHERE m.tenant_id = $1::uuid AND m.account_id = $2::uuid AND m.promise_date IS NOT NULL
       AND m.dispositioned_at >= $3::timestamptz AND m.dispositioned_at < $4::timestamptz
       AND ${onCampaign('m.campaign_id', scope, campaignParam)}${of('m.agent_user_id')}
    UNION ALL
    SELECT i.answered_by_user_id, i.dispositioned_at
      FROM agency_inbound_calls i
     WHERE i.tenant_id = $1::uuid AND i.account_id = $2::uuid AND i.promise_date IS NOT NULL
       AND i.dispositioned_at >= $3::timestamptz AND i.dispositioned_at < $4::timestamptz
       AND ${onCampaign('i.matched_campaign_id', scope, campaignParam)}${of('i.answered_by_user_id')}`;
}

/**
 * The cohort's promises ({@link promisedRowsSql}) and their soft-phone and inbound conversations in
 * scope, per agent: `$1` tenant, `$2` account, `$3`–`$4` the window, `$5` the cohort, `$6` the
 * campaign when the scope is one.
 */
export function teamPromisesSql(scope: TeamScope): string {
  return `
  WITH promised AS (${promisedRowsSql(scope, '$6', true)}
  ), conversations AS (
    SELECT m.agent_user_id, COUNT(*) AS n
      FROM agency_manual_calls m
     WHERE ${onCampaign('m.campaign_id', scope, '$6')}
       AND m.created_at >= $3::timestamptz AND m.created_at < $4::timestamptz
       AND m.tenant_id = $1::uuid AND m.account_id = $2::uuid
       AND ${SOFTPHONE_CONNECTED_SQL}
       AND m.agent_user_id = ANY($5::uuid[])
     GROUP BY m.agent_user_id
    UNION ALL
    SELECT i.answered_by_user_id, COUNT(*)
      FROM agency_inbound_calls i
     WHERE i.tenant_id = $1::uuid AND i.account_id = $2::uuid
       AND i.arrived_at >= $3::timestamptz AND i.arrived_at < $4::timestamptz AND i.state = 'ended'
       AND i.outcome = 'answered'
       AND ${onCampaign('i.matched_campaign_id', scope, '$6')}
       AND i.answered_by_user_id = ANY($5::uuid[])
     GROUP BY i.answered_by_user_id
  )
  SELECT x.agent_user_id, SUM(x.promises)::text AS promises, SUM(x.conversations)::text AS other_conversations
    FROM (
      SELECT agent_user_id, 1 AS promises, 0::bigint AS conversations FROM promised
      UNION ALL
      SELECT agent_user_id, 0, n FROM conversations
    ) x
   GROUP BY x.agent_user_id`;
}

/**
 * The team's promises ({@link promisedRowsSql}, every agent's) per local day (in `$5`) of
 * `dispositioned_at` over `[$3, $4)`, the chart's range: `$6` the campaign when the scope is one.
 */
export function teamPromiseDaysSql(scope: TeamScope): string {
  return `
  SELECT to_char(x.at AT TIME ZONE $5::text, 'YYYY-MM-DD') AS date, COUNT(*)::text AS promises
    FROM (${promisedRowsSql(scope, '$6', false)}
    ) x
   GROUP BY 1`;
}

/**
 * IN4's classes of the call-backs each cohort agent (`$5`) booked in scope whose booked time is in
 * `[$3, $4)`, as `COMPARE_CALLBACKS_SQL`: its columns, CASE (`$6` now, `$7` the on-time minutes)
 * and predicates. The campaign (`$8`), or every campaign of the account as an array (an index
 * condition on `idx_agency_attempts_campaign_callback` either way, when the planner takes it).
 */
export function teamCallbacksSql(scope: TeamScope): string {
  const campaigns = scope.kind === 'campaign'
    ? 'b.campaign_id = $8::uuid'
    : 'b.campaign_id = ANY(ARRAY(SELECT a.id FROM agency_campaigns a WHERE a.tenant_id = $1::uuid AND a.account_id = $2::uuid))';
  return `
  WITH booked AS (
    SELECT s.agent_user_id,
           ${CALLBACK_BOOKING_COLUMNS_SQL},
           c.status IN ('completed', 'stopped') AS campaign_ended
      FROM agency_call_attempts b
      JOIN agency_agent_sessions s ON s.id = b.reserved_agent_id
      JOIN agency_campaigns c ON c.id = b.campaign_id
      LEFT JOIN agency_contacts ct ON ct.id = b.contact_id
     WHERE ${campaigns}
       AND c.tenant_id = $1::uuid AND c.account_id = $2::uuid
       AND s.tenant_id = $1::uuid AND s.account_id = $2::uuid
       AND s.agent_user_id = ANY($5::uuid[])
       AND b.dialed_at IS NOT NULL
       AND b.dialed_at < $4::timestamptz
       AND b.callback_at IS NOT NULL
       AND b.callback_at >= $3::timestamptz AND b.callback_at < $4::timestamptz
  )
  SELECT agent_user_id, ${callbackClassSql('$6', '$7')} AS cls, count(*)::int AS n
    FROM booked
   GROUP BY 1, 2`;
}

const cohortValues = (q: TeamCohortScope): unknown[] => [q.tenantId, q.accountId, q.from, q.to, [...q.agentIds]];
const campaignsValues = (q: TeamCampaignsScope): unknown[] => [q.tenantId, q.accountId, [...q.campaignIds], q.from, q.to];

export class AgencyTeamPerformanceReadRepository {
  /** {@link teamScopeCampaignsSql}; `range` brings an account's campaign with rollup dials in it into scope. */
  async scopeCampaigns(db: RosterQueryable, q: TeamReadScope & { range: TeamInstantWindow }): Promise<TeamScopeCampaignRow[]> {
    const values = q.scope.kind === 'campaign'
      ? [q.tenantId, q.accountId, q.scope.campaignId]
      : [q.tenantId, q.accountId, [...AGENCY_HOME_ACTIVE_STATUSES], q.range.from, q.range.to];
    const { rows } = await db.query<{ id: string; wrapup_seconds: number; disposition_catalog: AgencyDisposition[] | null; rollup_as_of: string | null }>(
      teamScopeCampaignsSql(q.scope), values,
    );
    return rows.map((r) => ({ id: r.id, wrapup_seconds: n(r.wrapup_seconds), disposition_catalog: r.disposition_catalog, rollup_as_of: r.rollup_as_of }));
  }

  /** {@link TEAM_ROLLUP_CODES_SQL}. */
  async rollupCodes(db: RosterQueryable, q: TeamCampaignsScope): Promise<TeamRollupCodeRow[]> {
    if (q.campaignIds.length === 0) return [];
    const { rows } = await db.query<{ campaign_id: string; disposition_code: string | null; conversations: string }>(
      TEAM_ROLLUP_CODES_SQL, campaignsValues(q),
    );
    return rows.map((r) => ({ campaign_id: r.campaign_id, disposition_code: r.disposition_code, conversations: n(r.conversations) }));
  }

  /** {@link TEAM_ROLLUP_DAYS_SQL}, the days cut in `timezone`. */
  async rollupDays(db: RosterQueryable, q: TeamCampaignsScope & { timezone: string }): Promise<TeamRollupDayRow[]> {
    if (q.campaignIds.length === 0) return [];
    const { rows } = await db.query<{ campaign_id: string; date: string; disposition_code: string | null; conversations: string }>(
      TEAM_ROLLUP_DAYS_SQL, [...campaignsValues(q), q.timezone],
    );
    return rows.map((r) => ({ campaign_id: r.campaign_id, date: r.date, disposition_code: r.disposition_code, conversations: n(r.conversations) }));
  }

  /** {@link teamPromisesSql}. */
  async promises(db: RosterQueryable, q: TeamCohortScope): Promise<TeamPromiseRow[]> {
    if (q.agentIds.length === 0) return [];
    const { rows } = await db.query<{ agent_user_id: string; promises: string; other_conversations: string }>(
      teamPromisesSql(q.scope), withCampaign(cohortValues(q), q.scope),
    );
    return rows.map((r) => ({ agent_user_id: r.agent_user_id, promises: n(r.promises), other_conversations: n(r.other_conversations) }));
  }

  /** {@link teamPromiseDaysSql}, the days cut in `timezone`. */
  async promiseDays(db: RosterQueryable, q: TeamReadScope & TeamInstantWindow & { timezone: string }): Promise<TeamPromiseDayRow[]> {
    const { rows } = await db.query<{ date: string; promises: string }>(
      teamPromiseDaysSql(q.scope), withCampaign([q.tenantId, q.accountId, q.from, q.to, q.timezone], q.scope),
    );
    return rows.map((r) => ({ date: r.date, promises: n(r.promises) }));
  }

  /** {@link teamCallbacksSql}: per agent, the count in each IN4 class (Compare's shape). */
  async callbacks(db: RosterQueryable, q: TeamCohortScope & { now: Date }): Promise<Map<string, CompareCallbackClasses>> {
    const out = new Map<string, Record<InsightsCallbackClass, number>>();
    if (q.agentIds.length === 0) return out;
    const { rows } = await db.query<{ agent_user_id: string; cls: InsightsCallbackClass; n: number }>(
      teamCallbacksSql(q.scope),
      withCampaign([...cohortValues(q), q.now, AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES], q.scope),
    );
    for (const r of rows) {
      const classes = out.get(r.agent_user_id) ?? { ...ZERO_CALLBACKS };
      classes[r.cls] += n(r.n);
      out.set(r.agent_user_id, classes);
    }
    return out;
  }
}

export const agencyTeamPerformanceReadRepository = new AgencyTeamPerformanceReadRepository();
