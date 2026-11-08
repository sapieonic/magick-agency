/**
 * The insights page's range reads that are NOT rollup reads but share its time-bucket code:
 * agent state time and the online peak per trend bucket (from `agency_agent_session_events`,
 * through the shared occupancy intervals), and callback timing (IN4, from the booking attempts
 * through `idx_agency_attempts_campaign_callback`). Bodies of `AgencyInsightsRollupRepository`'s
 * methods of the same names.
 *
 * Neither reads a rollup, so both scale with the range they are asked about: the state reads
 * with the campaign's state transitions in it (`idx_agency_session_events_campaign_at`), the
 * callback read with the callbacks whose time falls in it.
 */
import { getPool } from '@magick-agency/db';
import type { AgencyInsightsBucket } from '@magick-agency/contracts/api/agency/insights';
import { AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES } from '@magick-agency/contracts/api/agency/insights';
import { foldOccupancy } from '../../../agency/agent-record/stats.js';
import { occupancyIntervalsCtes } from './sql-fragments.js';
import { resolvedZoneCte, trendBoundariesSql, trendLabelSql, type InsightsRangeQuery } from './insights-rollup-reads.js';

export interface InsightsAgentStateRow {
  agent_user_id: string;
  /** Every non-offline second (the occupancy reads' `shift_seconds`). */
  online_seconds: number;
  /** `reserved` folds into `available`, as the occupancy reads' consumers do. */
  available: number;
  on_call: number;
  wrapup: number;
  /** Break seconds by the reason carried on the transition; `unspecified` when none. */
  break_by_reason: Record<string, number>;
}

/**
 * Seconds per state per agent on the campaign over `[from, to)`, from the shared occupancy
 * intervals (`occupancyIntervalsCtes('campaign', …)`): the same clips, carried-in state and
 * tiebreaks the per-agent record and the roster read with, so the three agree.
 */
export async function insightsAgentStateSeconds(q: InsightsRangeQuery): Promise<InsightsAgentStateRow[]> {
  const { rows } = await getPool().query<{ agent_user_id: string; state: string; break_reason: string | null; seconds: string }>(
    `${occupancyIntervalsCtes('campaign', '')}       SELECT i.agent_user_id, i.state, i.break_reason,
              SUM(EXTRACT(EPOCH FROM (i.ended - i.started)))::text AS seconds
         FROM intervals i
        WHERE i.ended > i.started
        GROUP BY i.agent_user_id, i.state, i.break_reason`,
    [q.campaignId, q.from, q.to, q.tenantId],
  );
  const byAgent = new Map<string, typeof rows>();
  for (const r of rows) byAgent.set(r.agent_user_id, [...(byAgent.get(r.agent_user_id) ?? []), r]);
  return [...byAgent].map(([agentUserId, list]) => {
    const occupancy = foldOccupancy(list.map((r) => ({ state: r.state, seconds: Number(r.seconds) })));
    const breakByReason: Record<string, number> = {};
    for (const r of list) {
      if (r.state !== 'break') continue;
      const key = r.break_reason ?? 'unspecified';
      breakByReason[key] = (breakByReason[key] ?? 0) + Math.max(0, Number(r.seconds));
    }
    return {
      agent_user_id: agentUserId,
      online_seconds: occupancy.shift_seconds,
      available: occupancy.by_state.available + occupancy.by_state.reserved,
      on_call: occupancy.by_state.on_call,
      wrapup: occupancy.by_state.wrapup,
      break_by_reason: breakByReason,
    };
  }).sort((a, b) => b.online_seconds - a.online_seconds || a.agent_user_id.localeCompare(b.agent_user_id));
}

/**
 * The most agents online (any state but offline) at once within each trend bucket, every
 * bucket of the range present (zeros included), labelled as `insightsTrends` labels them.
 *
 * A sweep over the campaign's non-offline intervals: +1 at each start, -1 at each end, and a
 * 0 at each bucket's start instant (`trendBoundariesSql`), summed per instant (an agent's state
 * change ends one interval and starts the next at the same instant, a net 0, so it never reads
 * as two agents) into a running total: the number online from that instant to the next. A
 * bucket's peak is the largest total at any instant in it, its own start included (which
 * carries the level across the boundary), so every bucket is present and nothing is expanded
 * per interval. One live session per agent per tenant (`uq_agency_agent_live_tenant`), so
 * concurrent intervals are distinct agents.
 */
export async function insightsAgentsOnlinePeak(
  q: InsightsRangeQuery & { bucket: AgencyInsightsBucket; timezone: string },
): Promise<Array<{ bucket_start: string; agents_online_peak: number }>> {
  const { rows } = await getPool().query<{ bucket_start: string; peak: number }>(
    `${occupancyIntervalsCtes('campaign', '')}       , ${resolvedZoneCte('$5::text')},
       online AS (
         SELECT i.started, i.ended FROM intervals i WHERE i.state <> 'offline' AND i.ended > i.started
       ), pts AS (
         SELECT started AS t, 1 AS d FROM online
         UNION ALL
         SELECT ended AS t, -1 AS d FROM online
         UNION ALL
         SELECT x.b AS t, 0 AS d FROM tz, LATERAL ${trendBoundariesSql(q.bucket, '$2::timestamptz', '$3::timestamptz', 'tz.zone')} x
       ), lvl AS (
         SELECT t, SUM(SUM(d)) OVER (ORDER BY t) AS level FROM pts GROUP BY t
       )
       SELECT ${trendLabelSql(q.bucket, 'GREATEST(lvl.t, $2::timestamptz)', 'tz.zone')} AS bucket_start, MAX(lvl.level)::int AS peak
         FROM lvl, tz
        WHERE lvl.t < $3::timestamptz
        GROUP BY 1
        ORDER BY 1`,
    [q.campaignId, q.from, q.to, q.tenantId, q.timezone],
  );
  return rows.map((r) => ({ bucket_start: r.bucket_start, agents_online_peak: Number(r.peak) }));
}

/** How one booked callback went (IN4). */
export type InsightsCallbackClass = 'on_time' | 'late' | 'missed' | 'pending_future' | 'pending_due';

export interface InsightsCallbackTiming {
  /** Booking attempts whose `callback_at` is in range (each classified once below). */
  due_in_range: number;
  /** Followed by a dial no later than `callback_at` + 15 minutes (an early follow-up counts as kept). */
  kept_on_time: number;
  /** Followed by a dial after that. */
  kept_late: number;
  /** Never dialled, and the contact has closed (whatever `callback_at` says) or the campaign has ended. */
  missed: number;
  /** Never dialled yet, `callback_at` still after `now`, contact open, campaign not ended. */
  pending_future: number;
  /** Never dialled yet, `callback_at` passed, contact still open, campaign not ended (overdue). */
  pending_due: number;
  /** pending_future + pending_due. */
  pending: number;
  /** The unresolved ones (pending) by the contact's owner now (`assigned_user_id`, null = the pool). */
  by_owner: Array<{ agent_user_id: string | null; open: number; overdue: number }>;
}

/**
 * The columns IN4's classification reads off one booking attempt, aliased `b`, joined (LEFT) to
 * its contact as `ct`: `callback_at`, `contact_closed` (anything but `pending`, `in_flight` or
 * `connected`, or a contact row that is gone) and `next_dialed_at` (the contact's next placed
 * attempt, the first higher `attempt_number` with `dialed_at` set, `uq_agency_attempt_number`).
 * Shared with the agent review's follow-through (`report-dataset-reads.ts`), which classifies the
 * callbacks ONE AGENT booked by the same rules.
 */
export const CALLBACK_BOOKING_COLUMNS_SQL = `b.callback_at,
                COALESCE(ct.state NOT IN ('pending', 'in_flight', 'connected'), true) AS contact_closed,
                (SELECT n.dialed_at FROM agency_call_attempts n
                  WHERE n.contact_id = b.contact_id
                    AND n.attempt_number > b.attempt_number
                    AND n.dialed_at IS NOT NULL
                  ORDER BY n.attempt_number LIMIT 1) AS next_dialed_at`;

/**
 * IN4's class of one booked callback, over {@link CALLBACK_BOOKING_COLUMNS_SQL}'s columns plus a
 * boolean `campaign_ended` (`completed` or `stopped`). `nowParam` and `onTimeMinutesParam` are
 * the placeholders bound to the read's clock and `AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES`.
 * One spelling for the campaign read below and the agent review's.
 */
export function callbackClassSql(nowParam: string, onTimeMinutesParam: string): string {
  return `CASE
                  WHEN next_dialed_at IS NOT NULL
                   AND next_dialed_at <= callback_at + make_interval(mins => ${onTimeMinutesParam}::int) THEN 'on_time'
                  WHEN next_dialed_at IS NOT NULL THEN 'late'
                  WHEN contact_closed THEN 'missed'
                  WHEN campaign_ended THEN 'missed'
                  WHEN callback_at > ${nowParam}::timestamptz THEN 'pending_future'
                  ELSE 'pending_due'
                END`;
}

/**
 * Callback timing (IN4) for the callbacks whose BOOKED time falls in `[from, to)`: the booking
 * attempts (`callback_at IS NOT NULL`) through `idx_agency_attempts_campaign_callback`, each
 * classified by the contact's next placed attempt after it (the first higher `attempt_number`
 * with `dialed_at` set, `uq_agency_attempt_number`).
 *
 * Kept: on time when that dial came no later than `callback_at` + 15 minutes
 * (`AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES`, the bound included), an EARLY dial included (IN4
 * counts a callback kept when the contact was reached for it, and a dial before the booked time
 * still is); late after that.
 *
 * Never dialled: `missed` when the contact closed first or the campaign ended (IN4), whatever
 * `callback_at` says: a closed contact (anything but `pending`, `in_flight` or `connected`, or a
 * contact row that is gone) will not be dialled again, so its callback cannot still be kept and
 * must not be counted open by its owner. The campaign has ended when it is `completed` or
 * `stopped`. Otherwise it is pending: `pending_future` while `callback_at > now`,
 * `pending_due` after (overdue).
 */
export async function insightsCallbackTiming(
  q: InsightsRangeQuery & { now: Date },
): Promise<InsightsCallbackTiming | null> {
  const { rows } = await getPool().query<{
    found: boolean; classes: Array<{ cls: InsightsCallbackClass; n: number }> | null;
    owners: Array<{ agent_user_id: string | null; open: number; overdue: number }> | null;
  }>(
    `WITH camp AS (
         SELECT c.id, c.status IN ('completed', 'stopped') AS ended
           FROM agency_campaigns c WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid
       ), booked AS (
         SELECT ${CALLBACK_BOOKING_COLUMNS_SQL},
                ct.assigned_user_id,
                camp.ended AS campaign_ended
           FROM agency_call_attempts b
           JOIN camp ON b.campaign_id = camp.id
           LEFT JOIN agency_contacts ct ON ct.id = b.contact_id
          WHERE b.callback_at IS NOT NULL
            AND b.callback_at >= $3::timestamptz AND b.callback_at < $4::timestamptz
       ), classified AS (
         SELECT assigned_user_id,
                ${callbackClassSql('$5', '$6')} AS cls
           FROM booked
       )
       SELECT EXISTS (SELECT 1 FROM camp) AS found,
              (SELECT json_agg(x) FROM (SELECT cls, count(*) AS n FROM classified GROUP BY cls) x) AS classes,
              (SELECT json_agg(o) FROM (
                 SELECT assigned_user_id AS agent_user_id,
                        count(*) AS open, count(*) FILTER (WHERE cls = 'pending_due') AS overdue
                   FROM classified WHERE cls IN ('pending_future', 'pending_due')
                  GROUP BY assigned_user_id) o) AS owners`,
    [q.campaignId, q.tenantId, q.from, q.to, q.now, AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES],
  );
  const row = rows[0];
  if (!row?.found) return null;
  const count: Record<InsightsCallbackClass, number> = { on_time: 0, late: 0, missed: 0, pending_future: 0, pending_due: 0 };
  for (const c of row.classes ?? []) count[c.cls] += Number(c.n);
  return {
    due_in_range: Object.values(count).reduce((s, n) => s + n, 0),
    kept_on_time: count.on_time,
    kept_late: count.late,
    missed: count.missed,
    pending_future: count.pending_future,
    pending_due: count.pending_due,
    pending: count.pending_future + count.pending_due,
    by_owner: (row.owners ?? []).map((o) => ({ agent_user_id: o.agent_user_id, open: Number(o.open), overdue: Number(o.overdue) }))
      .sort((a, b) => b.open - a.open || String(a.agent_user_id).localeCompare(String(b.agent_user_id))),
  };
}
