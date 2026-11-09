/**
 * `AgencyInboundReportRepository`: the inbound summary's reads (docs/inbound.md §11, "The inbound
 * summary"): one account's inbound calls over a date range, as totals and per agent, from the
 * spine (`agency_inbound_calls`). Two statements, each over
 * `idx_agency_inbound_calls_account_arrived (tenant_id, account_id, arrived_at)` (0028): the
 * range is a bounded scan of the account's calls, never the tenant's.
 *
 * ── What is counted ────────────────────────────────────────────────────────────
 * Calls that have ENDED and arrived in `[from, to)`; a call still live is counted once it ends.
 * The tenant default's calls (no account) are nobody's account and are not here.
 *  - **After hours**: the route was closed (`closed`, or a voicemail taken out of hours: its
 *    Missed reason is `closed`). Nobody could have answered them, so they are outside the rates.
 *  - **Refused**: `rejected` (turned away at the answer). Outside the rates too.
 *  - **Open-hours calls**: everything else. The denominator of the answer rate, the abandon rate
 *    and the sticky hit rate: every caller who rang while the line was open, whether they waited,
 *    were turned away as busy, or hung up.
 *  - **Time to answer**: from arrival to being put through (`bridged_at - arrived_at`), what the
 *    caller lived through, greeting included; the average and the 90th percentile over answered
 *    calls.
 *  - **Sticky hit rate**: open-hours calls answered by their sticky agent ÷ open-hours calls that
 *    had one (§4.1).
 *  - **Per agent**: the calls each agent answered and their talk time (`talk_seconds`).
 *
 * Every id is bound as a parameter and cast once; callers validate ids at the edge (`22P02`).
 */
import { getPool } from '@magick-agency/db';

/** Out of hours: the route was closed for this caller (the call's outcome, or its voicemail's reason). */
const AFTER_HOURS_SQL = `(c.outcome = 'closed' OR (c.outcome = 'voicemail' AND c.follow_up_reason = 'closed'))`;
/** A caller who rang while the line was open and was not refused at the answer. */
const OPEN_HOURS_SQL = `(NOT ${AFTER_HOURS_SQL} AND c.outcome <> 'rejected')`;
/** The range, over `idx_agency_inbound_calls_account_arrived`. */
const RANGE_SQL = `c.tenant_id = $1::uuid AND c.account_id = $2::uuid
          AND c.arrived_at >= $3::timestamptz AND c.arrived_at < $4::timestamptz AND c.state = 'ended'`;

export interface InboundSummaryTotalsRow {
  calls: number;
  open_hours: number;
  after_hours: number;
  answered: number;
  abandoned: number;
  overflow: number;
  voicemails: number;
  refused: number;
  failed: number;
  avg_answer_seconds: number | null;
  p90_answer_seconds: number | null;
  sticky_calls: number;
  sticky_answered: number;
  missed: number;
  missed_handled: number;
}

export interface InboundSummaryAgentRow {
  user_id: string;
  answered: number;
  talk_seconds: number;
}

/** How many agents the per-agent read returns (busiest first). */
export const INBOUND_SUMMARY_AGENTS_MAX = 200;

export class AgencyInboundReportRepository {
  /** The account's totals over `[from, to)`. */
  async summaryTotals(input: { tenantId: string; accountId: string; from: Date; to: Date }): Promise<InboundSummaryTotalsRow> {
    const { rows } = await getPool().query<InboundSummaryTotalsRow>(
      `SELECT COUNT(*)::int AS calls,
              COUNT(*) FILTER (WHERE ${OPEN_HOURS_SQL})::int AS open_hours,
              COUNT(*) FILTER (WHERE ${AFTER_HOURS_SQL})::int AS after_hours,
              COUNT(*) FILTER (WHERE c.outcome = 'answered')::int AS answered,
              COUNT(*) FILTER (WHERE c.outcome = 'abandoned_in_queue')::int AS abandoned,
              COUNT(*) FILTER (WHERE c.outcome IN ('overflow', 'overflow_no_capacity'))::int AS overflow,
              COUNT(*) FILTER (WHERE c.outcome = 'voicemail')::int AS voicemails,
              COUNT(*) FILTER (WHERE c.outcome = 'rejected')::int AS refused,
              COUNT(*) FILTER (WHERE c.outcome = 'failed')::int AS failed,
              (AVG(EXTRACT(EPOCH FROM c.bridged_at - c.arrived_at)) FILTER (WHERE c.outcome = 'answered'))::float8 AS avg_answer_seconds,
              (PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM c.bridged_at - c.arrived_at))
                 FILTER (WHERE c.outcome = 'answered'))::float8 AS p90_answer_seconds,
              COUNT(*) FILTER (WHERE ${OPEN_HOURS_SQL} AND c.sticky_user_id IS NOT NULL)::int AS sticky_calls,
              COUNT(*) FILTER (WHERE ${OPEN_HOURS_SQL} AND c.sticky_user_id IS NOT NULL
                                 AND c.answered_by_user_id = c.sticky_user_id)::int AS sticky_answered,
              COUNT(*) FILTER (WHERE c.follow_up_status IS NOT NULL)::int AS missed,
              COUNT(*) FILTER (WHERE c.follow_up_status = 'handled')::int AS missed_handled
         FROM agency_inbound_calls c
        WHERE ${RANGE_SQL}`,
      [input.tenantId, input.accountId, input.from, input.to],
    );
    return rows[0]!;
  }

  /** The calls each agent answered over `[from, to)` and their talk time, busiest first. */
  async summaryAgents(input: { tenantId: string; accountId: string; from: Date; to: Date }): Promise<InboundSummaryAgentRow[]> {
    const { rows } = await getPool().query<InboundSummaryAgentRow>(
      `SELECT c.answered_by_user_id AS user_id,
              COUNT(*)::int AS answered,
              COALESCE(SUM(c.talk_seconds), 0)::int AS talk_seconds
         FROM agency_inbound_calls c
        WHERE ${RANGE_SQL} AND c.outcome = 'answered'
        GROUP BY c.answered_by_user_id
        ORDER BY answered DESC, talk_seconds DESC, c.answered_by_user_id
        LIMIT ${INBOUND_SUMMARY_AGENTS_MAX}`,
      [input.tenantId, input.accountId, input.from, input.to],
    );
    return rows;
  }
}

export const agencyInboundReportRepository = new AgencyInboundReportRepository();
