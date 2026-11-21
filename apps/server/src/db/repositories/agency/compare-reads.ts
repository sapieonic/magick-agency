/**
 * Compare agents' own reads (docs/compare-agents.md §3, §7): the sources the roster does not
 * serve, each ONE statement for the whole cohort of one campaign over a window, never one per
 * agent or per metric. The cohort itself and its call counts, talk, wrap-up and logged-in time are
 * the roster's statements (`agent-roster-stats.ts`), which the read runs on the same client.
 *
 * Every statement runs on the caller's client (`db`), inside the compare read's read-only
 * REPEATABLE READ transaction under its `statement_timeout` (`agency/compare/read.ts`), and is
 * scoped to the campaign AND the tenant (and, where the table carries one, the account); the agent
 * ids are the cohort's, read by the roster from the account's own sessions. Every definition is an
 * existing one, never a second spelling:
 *
 *  - outcome sets and no outcome chosen: the Insights rollup's conversations per agent per code
 *    (`agency_insights_rollup_codes`), dialler only, the 15-minute buckets whose start is in the
 *    window (a local-midnight window is bucket aligned: every zone's offset is a multiple of 15
 *    minutes). "No outcome" is a NULL code or the reaper's auto-stamp: the rollup's `no_outcome`
 *    facet counts exactly those conversations (Insights reconciles the two,
 *    `no_outcome_vs_unclassified_codes`), and the facet carries no agent, so the codes table is
 *    the by-agent read of the same number;
 *  - promises (CP2): the promise columns of 0041 on the three call tables, recorded
 *    (`dispositioned_at`) in the window, by the agent who took the call, as My day counts them
 *    (`MY_DAY_COUNTS_SQL`) and the Live floor's summary sums them (`PROMISE_SUMMARY_SQL`); the
 *    soft-phone and inbound conversations beside the roster's dialler ones: a soft-phone call
 *    tagged to the campaign that connected (`SOFTPHONE_CONNECTED_SQL`, `created_at` in the window,
 *    Insights' rule) and an inbound call the agent answered that matched a contact of the
 *    campaign (`outcome = 'answered'`, `arrived_at` in the window, the inbound summary's rule);
 *  - call-backs: IN4's classes of the call-backs the agent booked whose booked time is in the
 *    window (`CALLBACK_BOOKING_COLUMNS_SQL`, `callbackClassSql`, the agent review's
 *    `agentCallbackTiming` scoped to the campaign);
 *  - breaks over their limit: 0060's `break_overrun_seconds` on the events of the campaign's
 *    sessions in the window (the agent review's `agentBreakOverruns` scoped to the campaign);
 *  - the trend's days: each agent's local days with logged-in time on the campaign, from their
 *    campaign sessions' online spans (the session's start and its offline boundaries, clipped as
 *    the roster's occupancy intervals clip the shift; `COMPARE_LOGGED_IN_DAYS_SQL`).
 */
import { AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES } from '@magick-agency/contracts/api/agency/insights';
import type { InsightsCallbackClass } from './insights-range-reads.js';
import { CALLBACK_BOOKING_COLUMNS_SQL, callbackClassSql } from './insights-range-reads.js';
import { SOFTPHONE_CONNECTED_SQL } from './softphone-campaign-sql.js';
import type { RosterQueryable } from './agent-roster-stats.js';

/** One campaign's cohort over `[from, to)`. */
export interface CompareCohortScope {
  campaignId: string;
  tenantId: string;
  accountId: string;
  from: Date;
  to: Date;
  /** The cohort's agent ids (the roster's rows). */
  agentIds: readonly string[];
}

/** One agent's dialler conversations on the campaign by outcome code (null: closed without one). */
export interface CompareRollupCodeRow {
  agent_user_id: string;
  disposition_code: string | null;
  conversations: number;
}

/** One agent's figure on one local day. */
export interface CompareDayCountRow {
  agent_user_id: string;
  date: string;
  n: number;
}

/** One agent's promises on the campaign and the conversations they are counted over beside the dialler's. */
export interface ComparePromiseRow {
  agent_user_id: string;
  promises: number;
  /** The sum of `promise_amount`, no currency (PT5). */
  amount: number;
  /** Soft-phone and inbound conversations on the campaign (the dialler's are the roster's `connected`). */
  other_conversations: number;
}

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * The cohort's promises (CP2): recorded on the campaign in the window, every call type, by the
 * agent who took the call; and their soft-phone and inbound conversations. Each call table on its
 * 0050 promise index (`idx_*_promise_written`: tenant, account, `dispositioned_at`), the soft-phone
 * conversations on `idx_agency_manual_calls_campaign`, the inbound on
 * `idx_agency_inbound_calls_account_arrived`.
 */
export const COMPARE_PROMISES_SQL = `
  WITH promised AS (
    SELECT s.agent_user_id, p.promise_amount
      FROM agency_call_attempts p
      JOIN agency_agent_sessions s ON s.id = p.reserved_agent_id
     WHERE p.tenant_id = $2::uuid AND p.account_id = $3::uuid AND p.promise_date IS NOT NULL
       AND p.dispositioned_at >= $4::timestamptz AND p.dispositioned_at < $5::timestamptz
       AND p.campaign_id = $1::uuid
       AND s.tenant_id = $2::uuid AND s.account_id = $3::uuid
       AND s.agent_user_id = ANY($6::uuid[])
    UNION ALL
    SELECT m.agent_user_id, m.promise_amount
      FROM agency_manual_calls m
     WHERE m.tenant_id = $2::uuid AND m.account_id = $3::uuid AND m.promise_date IS NOT NULL
       AND m.dispositioned_at >= $4::timestamptz AND m.dispositioned_at < $5::timestamptz
       AND m.campaign_id = $1::uuid
       AND m.agent_user_id = ANY($6::uuid[])
    UNION ALL
    SELECT i.answered_by_user_id, i.promise_amount
      FROM agency_inbound_calls i
     WHERE i.tenant_id = $2::uuid AND i.account_id = $3::uuid AND i.promise_date IS NOT NULL
       AND i.dispositioned_at >= $4::timestamptz AND i.dispositioned_at < $5::timestamptz
       AND i.matched_campaign_id = $1::uuid
       AND i.answered_by_user_id = ANY($6::uuid[])
  ), conversations AS (
    SELECT m.agent_user_id, COUNT(*) AS n
      FROM agency_manual_calls m
     WHERE m.campaign_id = $1::uuid
       AND m.created_at >= $4::timestamptz AND m.created_at < $5::timestamptz
       AND m.tenant_id = $2::uuid AND m.account_id = $3::uuid
       AND ${SOFTPHONE_CONNECTED_SQL}
       AND m.agent_user_id = ANY($6::uuid[])
     GROUP BY m.agent_user_id
    UNION ALL
    SELECT i.answered_by_user_id, COUNT(*)
      FROM agency_inbound_calls i
     WHERE i.tenant_id = $2::uuid AND i.account_id = $3::uuid
       AND i.arrived_at >= $4::timestamptz AND i.arrived_at < $5::timestamptz AND i.state = 'ended'
       AND i.outcome = 'answered'
       AND i.matched_campaign_id = $1::uuid
       AND i.answered_by_user_id = ANY($6::uuid[])
     GROUP BY i.answered_by_user_id
  )
  SELECT x.agent_user_id,
         SUM(x.promises)::text AS promises,
         COALESCE(SUM(x.amount), 0::numeric)::text AS amount,
         SUM(x.conversations)::text AS other_conversations
    FROM (
      SELECT agent_user_id, 1 AS promises, promise_amount AS amount, 0::bigint AS conversations FROM promised
      UNION ALL
      SELECT agent_user_id, 0, NULL::numeric, n FROM conversations
    ) x
   GROUP BY x.agent_user_id`;

/** The cohort's promises per local day of `dispositioned_at` in `$7` (the trend of `promises_rate`). */
export const COMPARE_PROMISE_DAYS_SQL = `
  SELECT x.agent_user_id, to_char(x.at AT TIME ZONE $7::text, 'YYYY-MM-DD') AS date, COUNT(*)::text AS n
    FROM (
      SELECT s.agent_user_id, p.dispositioned_at AS at
        FROM agency_call_attempts p
        JOIN agency_agent_sessions s ON s.id = p.reserved_agent_id
       WHERE p.tenant_id = $2::uuid AND p.account_id = $3::uuid AND p.promise_date IS NOT NULL
         AND p.dispositioned_at >= $4::timestamptz AND p.dispositioned_at < $5::timestamptz
         AND p.campaign_id = $1::uuid
         AND s.tenant_id = $2::uuid AND s.account_id = $3::uuid
         AND s.agent_user_id = ANY($6::uuid[])
      UNION ALL
      SELECT m.agent_user_id, m.dispositioned_at
        FROM agency_manual_calls m
       WHERE m.tenant_id = $2::uuid AND m.account_id = $3::uuid AND m.promise_date IS NOT NULL
         AND m.dispositioned_at >= $4::timestamptz AND m.dispositioned_at < $5::timestamptz
         AND m.campaign_id = $1::uuid
         AND m.agent_user_id = ANY($6::uuid[])
      UNION ALL
      SELECT i.answered_by_user_id, i.dispositioned_at
        FROM agency_inbound_calls i
       WHERE i.tenant_id = $2::uuid AND i.account_id = $3::uuid AND i.promise_date IS NOT NULL
         AND i.dispositioned_at >= $4::timestamptz AND i.dispositioned_at < $5::timestamptz
         AND i.matched_campaign_id = $1::uuid
         AND i.answered_by_user_id = ANY($6::uuid[])
    ) x
   GROUP BY 1, 2`;

/**
 * The cohort's dialler conversations on the campaign by code: the rollup's codes table through
 * the campaign row matched on id AND tenant (the rollup carries no tenant, as every Insights read
 * opens). `uq_agency_insights_rollup_codes` leads with (campaign_id, bucket_start).
 */
export const COMPARE_ROLLUP_CODES_SQL = `
  SELECT r.agent_user_id, r.disposition_code, SUM(r.conversations)::text AS conversations
    FROM agency_insights_rollup_codes r
    JOIN agency_campaigns c ON c.id = r.campaign_id AND c.tenant_id = $2::uuid
   WHERE r.campaign_id = $1::uuid
     AND r.bucket_start >= $3::timestamptz AND r.bucket_start < $4::timestamptz
     AND r.agent_user_id = ANY($5::uuid[])
     AND r.conversations > 0
   GROUP BY r.agent_user_id, r.disposition_code`;

/**
 * The cohort's conversations ending in any of `$6` per local day (in `$7`) of the bucket: an
 * outcome set's trend. A 15-minute bucket never straddles a local midnight.
 */
export const COMPARE_ROLLUP_CODE_DAYS_SQL = `
  SELECT r.agent_user_id, to_char(r.bucket_start AT TIME ZONE $7::text, 'YYYY-MM-DD') AS date,
         SUM(r.conversations)::text AS n
    FROM agency_insights_rollup_codes r
    JOIN agency_campaigns c ON c.id = r.campaign_id AND c.tenant_id = $2::uuid
   WHERE r.campaign_id = $1::uuid
     AND r.bucket_start >= $3::timestamptz AND r.bucket_start < $4::timestamptz
     AND r.agent_user_id = ANY($5::uuid[])
     AND r.disposition_code = ANY($6::text[])
     AND r.conversations > 0
   GROUP BY 1, 2`;

/**
 * IN4's classes of the call-backs each cohort agent booked on the campaign whose booked time is
 * in the window: `agentCallbackTiming`'s columns, CASE and predicates, the campaign named
 * (`idx_agency_attempts_campaign_callback`) and the agents batched.
 */
export const COMPARE_CALLBACKS_SQL = `
  WITH booked AS (
    SELECT s.agent_user_id,
           ${CALLBACK_BOOKING_COLUMNS_SQL},
           c.status IN ('completed', 'stopped') AS campaign_ended
      FROM agency_call_attempts b
      JOIN agency_agent_sessions s ON s.id = b.reserved_agent_id
      JOIN agency_campaigns c ON c.id = b.campaign_id
      LEFT JOIN agency_contacts ct ON ct.id = b.contact_id
     WHERE b.campaign_id = $1::uuid
       AND c.tenant_id = $2::uuid
       AND s.tenant_id = $2::uuid
       AND s.account_id = $3::uuid
       AND s.agent_user_id = ANY($6::uuid[])
       AND b.dialed_at IS NOT NULL
       AND b.dialed_at < $5::timestamptz
       AND b.callback_at IS NOT NULL
       AND b.callback_at >= $4::timestamptz AND b.callback_at < $5::timestamptz
  )
  SELECT agent_user_id, ${callbackClassSql('$7', '$8')} AS cls, count(*)::int AS n
    FROM booked
   GROUP BY 1, 2`;

/**
 * Breaks that ended over their reason's limit, per cohort agent, on the campaign's sessions in the
 * window: 0060's column, set only on the event that ended a break that ran over (a reserved break
 * never), read on `idx_agency_session_events_campaign_at` (campaign_id, at).
 */
export const COMPARE_BREAK_OVERRUNS_SQL = `
  SELECT e.agent_user_id, count(*)::int AS breaks
    FROM agency_agent_session_events e
   WHERE e.campaign_id = $1::uuid
     AND e.at >= $4::timestamptz AND e.at < $5::timestamptz
     AND e.tenant_id = $2::uuid AND e.account_id = $3::uuid
     AND e.agent_user_id = ANY($6::uuid[])
     AND e.break_overrun_seconds IS NOT NULL
   GROUP BY e.agent_user_id`;

/**
 * The partial index's predicate, byte for byte as 0065 writes it, so the planner proves the index
 * applies: the events where a session goes offline or comes back from it.
 */
export const OFFLINE_BOUNDARY_EVENT_SQL = "(e.to_state = 'offline' OR e.from_state = 'offline')";

/**
 * Each cohort agent's local days (in `$7`) with logged-in time on the campaign: the days their
 * campaign sessions were ONLINE (any state but `offline`), each online span clipped to the window,
 * to the session's `left_at` and to now, as the occupancy intervals clip the shift.
 *
 * A session row is not one stretch of logged-in time. A live session goes `offline` without
 * `left_at` (the station closed or its heartbeat lapsed, `markAllOffline` at a restart, the dialler
 * releasing it), and the agent's next join REUSES the row (the join's upsert: `offline → break`,
 * `joined_at` unchanged). So one row can span a week of nights and weekends off. The spans come from
 * the session's start and its offline boundaries only (an event whose `to_state` or `from_state` is
 * `offline`): online from `joined_at`, off at each move to `offline`, on again at each move out of
 * it. Those boundaries are two or three a day per agent, read on
 * `idx_agency_session_events_offline` (0065: `(session_id, at)` where {@link OFFLINE_BOUNDARY_EVENT_SQL}),
 * every boundary of a session before the window's end (the state at the window's start is the last
 * boundary before it), never the state changes of a working day, which the roster's occupancy
 * statement walks (1.4M on a busy month).
 */
export const COMPARE_LOGGED_IN_DAYS_SQL = `
  WITH sess AS MATERIALIZED (
    SELECT s.id, s.agent_user_id, s.joined_at, s.left_at
      FROM agency_agent_sessions s
     WHERE s.agent_user_id = ANY($6::uuid[])
       AND s.campaign_id = $1::uuid
       AND s.tenant_id = $2::uuid AND s.account_id = $3::uuid
       AND s.joined_at < $5::timestamptz
       AND (s.left_at IS NULL OR s.left_at > $4::timestamptz)
  ), marks AS (
    -- The session's start: online.
    SELECT sess.id AS session_id, sess.joined_at AS at, true AS online, 0 AS ord, NULL::uuid AS event_id
      FROM sess
    UNION ALL
    -- Each offline boundary: off when it goes to offline, on when it comes back from it.
    SELECT e.session_id, e.at, e.to_state <> 'offline', 1, e.id
      FROM sess
      JOIN agency_agent_session_events e ON e.session_id = sess.id
     WHERE ${OFFLINE_BOUNDARY_EVENT_SQL}
       AND e.at < $5::timestamptz
  ), spans AS (
    SELECT sess.agent_user_id, m.online,
           GREATEST(m.at, $4::timestamptz) AS started,
           LEAST(
             COALESCE(lead(m.at) OVER (PARTITION BY m.session_id ORDER BY m.at, m.ord, m.event_id), 'infinity'::timestamptz),
             COALESCE(sess.left_at, 'infinity'::timestamptz),
             $5::timestamptz,
             now()
           ) AS ended
      FROM marks m
      JOIN sess ON sess.id = m.session_id
  )
  SELECT DISTINCT sp.agent_user_id, to_char(d, 'YYYY-MM-DD') AS date
    FROM spans sp
    CROSS JOIN LATERAL generate_series(
           date_trunc('day', sp.started AT TIME ZONE $7::text),
           date_trunc('day', (sp.ended - interval '1 microsecond') AT TIME ZONE $7::text),
           interval '1 day') d
   WHERE sp.online AND sp.ended > sp.started`;

const scopeValues = (q: CompareCohortScope): unknown[] =>
  [q.campaignId, q.tenantId, q.accountId, q.from, q.to, [...q.agentIds]];

export class AgencyCompareReadRepository {
  /** {@link COMPARE_ROLLUP_CODES_SQL}. */
  async rollupCodes(db: RosterQueryable, q: CompareCohortScope): Promise<CompareRollupCodeRow[]> {
    if (q.agentIds.length === 0) return [];
    const { rows } = await db.query<{ agent_user_id: string; disposition_code: string | null; conversations: string }>(
      COMPARE_ROLLUP_CODES_SQL,
      [q.campaignId, q.tenantId, q.from, q.to, [...q.agentIds]],
    );
    return rows.map((r) => ({ agent_user_id: r.agent_user_id, disposition_code: r.disposition_code, conversations: n(r.conversations) }));
  }

  /** {@link COMPARE_ROLLUP_CODE_DAYS_SQL}: conversations ending in any of `codes`, per agent per local day. */
  async rollupCodeDays(db: RosterQueryable, q: CompareCohortScope & { codes: readonly string[]; timezone: string }): Promise<CompareDayCountRow[]> {
    if (q.agentIds.length === 0 || q.codes.length === 0) return [];
    const { rows } = await db.query<{ agent_user_id: string; date: string; n: string }>(
      COMPARE_ROLLUP_CODE_DAYS_SQL,
      [q.campaignId, q.tenantId, q.from, q.to, [...q.agentIds], [...q.codes], q.timezone],
    );
    return rows.map((r) => ({ agent_user_id: r.agent_user_id, date: r.date, n: n(r.n) }));
  }

  /** {@link COMPARE_PROMISES_SQL}. */
  async promises(db: RosterQueryable, q: CompareCohortScope): Promise<ComparePromiseRow[]> {
    if (q.agentIds.length === 0) return [];
    const { rows } = await db.query<{ agent_user_id: string; promises: string; amount: string; other_conversations: string }>(
      COMPARE_PROMISES_SQL,
      scopeValues(q),
    );
    return rows.map((r) => ({
      agent_user_id: r.agent_user_id,
      promises: n(r.promises),
      amount: n(r.amount),
      other_conversations: n(r.other_conversations),
    }));
  }

  /** {@link COMPARE_PROMISE_DAYS_SQL}. */
  async promiseDays(db: RosterQueryable, q: CompareCohortScope & { timezone: string }): Promise<CompareDayCountRow[]> {
    if (q.agentIds.length === 0) return [];
    const { rows } = await db.query<{ agent_user_id: string; date: string; n: string }>(
      COMPARE_PROMISE_DAYS_SQL,
      [...scopeValues(q), q.timezone],
    );
    return rows.map((r) => ({ agent_user_id: r.agent_user_id, date: r.date, n: n(r.n) }));
  }

  /** {@link COMPARE_CALLBACKS_SQL}: per agent, the count in each IN4 class. */
  async callbacks(db: RosterQueryable, q: CompareCohortScope & { now: Date }): Promise<Map<string, Record<InsightsCallbackClass, number>>> {
    const out = new Map<string, Record<InsightsCallbackClass, number>>();
    if (q.agentIds.length === 0) return out;
    const { rows } = await db.query<{ agent_user_id: string; cls: InsightsCallbackClass; n: number }>(
      COMPARE_CALLBACKS_SQL,
      [...scopeValues(q), q.now, AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES],
    );
    for (const r of rows) {
      const classes = out.get(r.agent_user_id) ?? { on_time: 0, late: 0, missed: 0, pending_future: 0, pending_due: 0 };
      classes[r.cls] += n(r.n);
      out.set(r.agent_user_id, classes);
    }
    return out;
  }

  /** {@link COMPARE_BREAK_OVERRUNS_SQL}: per agent, breaks over their limit. */
  async breakOverruns(db: RosterQueryable, q: CompareCohortScope): Promise<Map<string, number>> {
    if (q.agentIds.length === 0) return new Map();
    const { rows } = await db.query<{ agent_user_id: string; breaks: number }>(COMPARE_BREAK_OVERRUNS_SQL, scopeValues(q));
    return new Map(rows.map((r) => [r.agent_user_id, n(r.breaks)]));
  }

  /** {@link COMPARE_LOGGED_IN_DAYS_SQL}: per agent, the local dates with logged-in time on the campaign. */
  async loggedInDays(db: RosterQueryable, q: CompareCohortScope & { timezone: string }): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    if (q.agentIds.length === 0) return out;
    const { rows } = await db.query<{ agent_user_id: string; date: string }>(
      COMPARE_LOGGED_IN_DAYS_SQL,
      [...scopeValues(q), q.timezone],
    );
    for (const r of rows) {
      const days = out.get(r.agent_user_id) ?? new Set<string>();
      days.add(r.date);
      out.set(r.agent_user_id, days);
    }
    return out;
  }
}

export const agencyCompareReadRepository = new AgencyCompareReadRepository();
