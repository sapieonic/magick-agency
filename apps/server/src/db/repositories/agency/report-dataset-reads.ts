/**
 * The report builders' own reads (docs/reports.md "Datasets", `agency/reports/datasets/`): the
 * blocks no console screen serves (the agent's day-by-day presence and attempts in the REPORT's
 * zone, the representative day, outcomes, follow-through, call sentiment, the account's covered
 * campaigns) and the detail sheets' row statements. Every figure a screen already serves is read
 * by the screen's own code, never here (RP1).
 *
 * Every definition is an existing fragment, never a second spelling:
 *  - time in state: the shared occupancy intervals (`occupancyIntervalsCtes`, the same clips,
 *    carried-in state and tiebreaks as the agent record, the roster and Insights);
 *  - the attempt counters: `AGENCY_ATTEMPT_METRICS_SQL` (the agent record's five plus the connect
 *    rate's two) and the rollup's measure expressions (`INSIGHTS_MEASURES`: redials, agent
 *    retries, overrides, callbacks booked);
 *  - one row's talk and wrap-up: `AGENT_LEG_TALK_ATTEMPT_SQL`, `MEASURED_WRAPUP_ATTEMPT_SQL`;
 *  - conversations: `CONVERSATION_ATTEMPT_SQL`; callback classes: IN4's
 *    (`CALLBACK_BOOKING_COLUMNS_SQL`, `callbackClassSql`); sentiment: `callSentimentLabelSql`.
 *
 * Scope: every agent read is the agent's sessions in the run's tenant AND account
 * (`agency_agent_sessions.tenant_id`/`account_id`, the record's own predicate); campaign reads
 * are by campaign id and tenant. Every id is bound and cast; callers pass ids read from the run
 * row and the campaign table, never from a client.
 *
 * Detail rows are streamed through a server-side cursor ({@link reportCursorRows}) on a client
 * of its own, released in `finally` however the consumer stops.
 */
import { getPool } from '@magick-agency/db';
import { callSentimentLabelSql } from '@magick-agency/db/repositories/agency-call.repository';
import { AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES } from '@magick-agency/contracts/api/agency/insights';
import type { SentimentLabel } from '@magick-agency/contracts/api/agency/webrtc-call';
import type { InsightsCallbackClass } from './insights-range-reads.js';
import { CALLBACK_BOOKING_COLUMNS_SQL, callbackClassSql } from './insights-range-reads.js';
import { INSIGHTS_MEASURES } from './insights-rollup-sql.js';
import {
  AGENCY_ATTEMPT_METRICS_SQL,
  AGENT_LEG_TALK_ATTEMPT_SQL,
  CONVERSATION_ATTEMPT_SQL,
  MEASURED_WRAPUP_ATTEMPT_SQL,
  occupancyIntervalsCtes,
} from './sql-fragments.js';

/** The rows a detail cursor fetches per round trip. */
export const REPORT_CURSOR_BATCH = 1000;

/** One agent in one account over `[from, to)`. */
export interface ReportAgentScope {
  agentUserId: string;
  tenantId: string;
  accountId: string;
  from: Date;
  to: Date;
}

/** One non-offline state interval of the agent, clipped to the window (the occupancy intervals). */
export interface ReportStateIntervalRow {
  session_id: string;
  campaign_id: string | null;
  /** `campaign` or `softphone`. */
  kind: string;
  /** `available`, `reserved`, `on_call`, `wrapup` or `break`. */
  state: string;
  break_reason: string | null;
  started: Date;
  ended: Date;
}

/** One local day's attempt counters for the agent. */
export interface ReportAgentAttemptDayRow {
  date: string;
  attempts: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  human_connects: number;
  first_dials: number;
  redials_placed: number;
  redials_connected: number;
  reopened_dials: number;
  manual_dials: number;
  overrides_used: number;
  callbacks_booked: number;
  /** Ended `agent_disconnected`: the agent's station went away mid-call. */
  drops: number;
}

/** Conversations by disposition code. */
export interface ReportAgentOutcomeRow {
  code: string | null;
  conversations: number;
  /** Of them, closed with a success code of their campaign's current catalog. */
  successes: number;
  talk_seconds: number;
}

/** The rollup measure's aggregate expression by column name (`INSIGHTS_MEASURES`). */
function measure(column: string): string {
  const found = INSIGHTS_MEASURES.find(([name]) => name === column);
  if (!found) throw new Error(`report reads: no rollup measure named ${column}`);
  return found[1];
}

/** The agent's placed attempts in the window: the agent record's join and predicate. */
const AGENT_ATTEMPTS_FROM = `FROM agency_call_attempts a
         JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
         JOIN agency_campaigns c ON c.id = a.campaign_id
        WHERE s.agent_user_id = $1::uuid
          AND s.tenant_id = $4::uuid
          AND s.account_id = $5::uuid
          AND a.dialed_at IS NOT NULL
          AND a.dialed_at >= $2::timestamptz
          AND a.dialed_at < $3::timestamptz`;

const agentValues = (q: ReportAgentScope): unknown[] => [q.agentUserId, q.from, q.to, q.tenantId, q.accountId];

/** The overall-sentiment labels the call analysis emits; the quality block counts these only. */
export const SENTIMENT_LABELS = ['positive', 'neutral', 'negative', 'mixed'] as const satisfies readonly SentimentLabel[];

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * Rows of `text` through a server-side cursor (`DECLARE … NO SCROLL CURSOR` in a read-only
 * REPEATABLE READ transaction, so every batch reads one snapshot), {@link REPORT_CURSOR_BATCH}
 * at a time, on a client of its own. Nothing is acquired until the first row is asked for. The
 * client is released in `finally`, so a consumer that stops early (the assembler's row cap calls
 * `return()`) or throws gives it back; a client that failed is destroyed rather than reused.
 */
export async function* reportCursorRows<T>(text: string, values: unknown[], batch = REPORT_CURSOR_BATCH): AsyncGenerator<T> {
  const client = await getPool().connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`DECLARE report_rows NO SCROLL CURSOR FOR ${text}`, values);
    for (;;) {
      const { rows } = await client.query(`FETCH ${batch} FROM report_rows`);
      for (const row of rows) yield row as T;
      if (rows.length < batch) break;
    }
  } catch (err) {
    broken = err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch (err) {
      broken ??= err instanceof Error ? err : new Error(String(err));
    }
    client.release(broken);
  }
}

export class AgencyReportDatasetRepository {
  /**
   * The agent's non-offline state intervals over the window, oldest first: the occupancy
   * intervals' agent variant (tenant and account scoped, every session overlapping the window,
   * soft-phone sessions included) with each interval's session kind and campaign. Offline is
   * left out: it is not logged-in time, and a closed session's offline interval runs to the
   * window's end by the intervals' own rule.
   */
  async agentStateIntervals(q: ReportAgentScope): Promise<ReportStateIntervalRow[]> {
    const { rows } = await getPool().query<ReportStateIntervalRow>(
      `${occupancyIntervalsCtes('agent', '')}       SELECT i.session_id, ss.campaign_id, ss.kind, i.state, i.break_reason, i.started, i.ended
         FROM intervals i
         JOIN agency_agent_sessions ss ON ss.id = i.session_id
        WHERE i.ended > i.started
          AND i.state <> 'offline'
        ORDER BY i.started, i.session_id`,
      agentValues(q),
    );
    return rows;
  }

  /**
   * The agent's placed attempts by local day of `dialed_at` in `timezone`: the agent record's
   * counters (`AGENCY_ATTEMPT_METRICS_SQL`, the same join and predicate as its attempt buckets,
   * so the days sum to its totals), the rollup's follow-through measures, and the drops.
   */
  async agentAttemptDays(q: ReportAgentScope & { timezone: string }): Promise<ReportAgentAttemptDayRow[]> {
    const { rows } = await getPool().query<Record<string, string>>(
      `SELECT to_char(a.dialed_at AT TIME ZONE $6::text, 'YYYY-MM-DD') AS date,
              ${AGENCY_ATTEMPT_METRICS_SQL},
              (${measure('redials_placed')})::text AS redials_placed,
              (${measure('redials_connected')})::text AS redials_connected,
              (${measure('reopened_dials')})::text AS reopened_dials,
              (${measure('manual_dials')})::text AS manual_dials,
              (${measure('overrides_used')})::text AS overrides_used,
              (${measure('callbacks_booked')})::text AS callbacks_booked,
              COUNT(*) FILTER (WHERE a.outcome = 'agent_disconnected')::text AS drops
         ${AGENT_ATTEMPTS_FROM}
        GROUP BY 1
        ORDER BY 1`,
      [...agentValues(q), q.timezone],
    );
    return rows.map((r) => ({
      date: String(r['date']),
      attempts: n(r['attempts']),
      connected: n(r['connected']),
      successes: n(r['successes']),
      talk_seconds: n(r['talk_seconds']),
      wrapup_seconds: n(r['wrapup_seconds']),
      human_connects: n(r['human_connects']),
      first_dials: n(r['first_dials']),
      redials_placed: n(r['redials_placed']),
      redials_connected: n(r['redials_connected']),
      reopened_dials: n(r['reopened_dials']),
      manual_dials: n(r['manual_dials']),
      overrides_used: n(r['overrides_used']),
      callbacks_booked: n(r['callbacks_booked']),
      drops: n(r['drops']),
    }));
  }

  /**
   * The agent's conversations in the window by disposition code (`CONVERSATION_ATTEMPT_SQL`, a
   * redial chain once, at the attempt that carries its write-up), with the record's success and
   * talk expressions over them.
   */
  async agentOutcomes(q: ReportAgentScope): Promise<ReportAgentOutcomeRow[]> {
    const { rows } = await getPool().query<Record<string, string | null>>(
      `SELECT a.disposition_code AS code,
              ${AGENCY_ATTEMPT_METRICS_SQL}
         ${AGENT_ATTEMPTS_FROM}
          AND ${CONVERSATION_ATTEMPT_SQL}
        GROUP BY a.disposition_code`,
      agentValues(q),
    );
    return rows.map((r) => ({
      code: r['code'] ?? null,
      conversations: n(r['attempts']),
      successes: n(r['successes']),
      talk_seconds: n(r['talk_seconds']),
    }));
  }

  /**
   * IN4's classes for the callbacks the AGENT booked (the booking attempt reserved to one of
   * their sessions in this account) whose booked time falls in the window, by the Insights
   * callback read's own columns and CASE. A booking is dialled before its booked time, so the
   * booking attempts are bounded by `dialed_at < to` on the agent's dial index.
   */
  async agentCallbackTiming(q: ReportAgentScope & { now: Date }): Promise<Record<InsightsCallbackClass, number>> {
    const { rows } = await getPool().query<{ cls: InsightsCallbackClass; n: number }>(
      `WITH booked AS (
         SELECT ${CALLBACK_BOOKING_COLUMNS_SQL},
                c.status IN ('completed', 'stopped') AS campaign_ended
           FROM agency_call_attempts b
           JOIN agency_agent_sessions s ON s.id = b.reserved_agent_id
           JOIN agency_campaigns c ON c.id = b.campaign_id
           LEFT JOIN agency_contacts ct ON ct.id = b.contact_id
          WHERE s.agent_user_id = $1::uuid
            AND s.tenant_id = $4::uuid
            AND s.account_id = $5::uuid
            AND s.joined_at < $3::timestamptz
            AND b.dialed_at IS NOT NULL
            AND b.dialed_at < $3::timestamptz
            AND b.callback_at IS NOT NULL
            AND b.callback_at >= $2::timestamptz AND b.callback_at < $3::timestamptz
       )
       SELECT ${callbackClassSql('$6', '$7')} AS cls, count(*)::int AS n FROM booked GROUP BY 1`,
      [...agentValues(q), q.now, AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES],
    );
    const out: Record<InsightsCallbackClass, number> = { on_time: 0, late: 0, missed: 0, pending_future: 0, pending_due: 0 };
    for (const r of rows) out[r.cls] += n(r.n);
    return out;
  }

  /**
   * Do Not Call entries the agent wrote (`source = 'agent'`, `added_by` their user id, bare or
   * `user:`-prefixed) in the window, for this account's campaigns or tenant-wide. The tenant's
   * entries of the range on `idx_dnc_entries_tenant_created`, as Insights' DNC read takes them.
   */
  async agentDncMarked(q: ReportAgentScope): Promise<number> {
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM dnc_entries d
        WHERE d.tenant_id = $4::uuid
          AND d.created_at >= $2::timestamptz AND d.created_at < $3::timestamptz
          AND d.source = 'agent'
          AND (d.added_by = $1::text OR d.added_by = 'user:' || $1::text)
          AND (d.account_id = $5::uuid OR d.account_id IS NULL)`,
      agentValues(q),
    );
    return n(rows[0]?.n);
  }

  /**
   * Soft-phone calls the agent placed in this account: Insights' soft-phone count (`created_at`
   * in range, `dialed_at` set) by agent instead of by campaign tag, on the manual calls' agent
   * index.
   */
  async agentSoftphoneCalls(q: ReportAgentScope): Promise<number> {
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM agency_manual_calls m
        WHERE m.tenant_id = $4::uuid
          AND m.account_id = $5::uuid
          AND m.agent_user_id = $1::uuid
          AND m.created_at >= $2::timestamptz AND m.created_at < $3::timestamptz
          AND m.dialed_at IS NOT NULL`,
      agentValues(q),
    );
    return n(rows[0]?.n);
  }

  /**
   * Analysed calls (`analysis_status = 'completed'` with an overall sentiment label the analysis
   * emits: positive, neutral, negative or mixed, `SENTIMENT_LABELS`) among the agent's placed
   * campaign attempts and soft-phone calls in the window, by lower-cased label. A call with any
   * other label is not counted.
   */
  async agentSentiment(q: ReportAgentScope): Promise<Array<{ label: string; calls: number }>> {
    const label = callSentimentLabelSql('k.call_analysis');
    const { rows } = await getPool().query<{ label: string; n: number }>(
      `WITH calls AS (
         SELECT a.webrtc_call_id AS call_id
           ${AGENT_ATTEMPTS_FROM}
            AND a.webrtc_call_id IS NOT NULL
         UNION
         SELECT m.webrtc_call_id
           FROM agency_manual_calls m
          WHERE m.tenant_id = $4::uuid
            AND m.account_id = $5::uuid
            AND m.agent_user_id = $1::uuid
            AND m.created_at >= $2::timestamptz AND m.created_at < $3::timestamptz
            AND m.dialed_at IS NOT NULL
            AND m.webrtc_call_id IS NOT NULL
       )
       SELECT lower(${label}) AS label, count(*)::int AS n
         FROM calls x
         JOIN agency_calls k ON k.id = x.call_id
        WHERE k.tenant_id = $4::uuid
          AND k.analysis_status = 'completed'
          AND lower(${label}) = ANY($6::text[])
        GROUP BY 1`,
      [...agentValues(q), SENTIMENT_LABELS],
    );
    return rows.map((r) => ({ label: r.label, calls: n(r.n) }));
  }

  /**
   * The account's campaigns a report covers when the request names none: every campaign of the
   * account that placed a dial in the window (a rollup bucket with dials in it) or is running,
   * paused or stopping now. By name.
   */
  async accountCoveredCampaignIds(q: { tenantId: string; accountId: string; from: Date; to: Date }): Promise<string[]> {
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT c.id
         FROM agency_campaigns c
        WHERE c.tenant_id = $1::uuid
          AND c.account_id = $2::uuid
          AND (c.status IN ('running', 'paused', 'stopping')
               OR EXISTS (SELECT 1 FROM agency_insights_rollup_buckets r
                           WHERE r.campaign_id = c.id
                             AND r.bucket_start >= $3::timestamptz AND r.bucket_start < $4::timestamptz
                             AND r.dials > 0))
        ORDER BY c.name, c.id`,
      [q.tenantId, q.accountId, q.from, q.to],
    );
    return rows.map((r) => r.id);
  }
}

export const agencyReportDatasetRepository = new AgencyReportDatasetRepository();

// ─── Detail sheet statements ─────────────────────────────────────────────────
// Each is `{ text, values }` for `reportCursorRows`, ordered by time with the id breaking ties.

export interface ReportStatement {
  text: string;
  values: unknown[];
}

/** One session row: the session, its seconds per state in the window, its dials and drops. */
export interface ReportSessionDetailRow {
  id: string;
  agent_user_id: string;
  joined_at: Date;
  left_at: Date | null;
  kind: string;
  client_kind: string | null;
  campaign_name: string | null;
  available_s: number | null;
  on_call_s: number | null;
  wrapup_s: number | null;
  break_s: number | null;
  dials: string | null;
  drops: string | null;
}

/**
 * The per-session columns over the occupancy intervals of `sess` (whichever variant opened the
 * statement), and each session's placed attempts in the window.
 */
const SESSION_DETAIL_TAIL = `       , per_session AS (
         SELECT i.session_id,
                SUM(EXTRACT(EPOCH FROM (i.ended - i.started))) FILTER (WHERE i.state IN ('available', 'reserved')) AS available_s,
                SUM(EXTRACT(EPOCH FROM (i.ended - i.started))) FILTER (WHERE i.state = 'on_call') AS on_call_s,
                SUM(EXTRACT(EPOCH FROM (i.ended - i.started))) FILTER (WHERE i.state = 'wrapup') AS wrapup_s,
                SUM(EXTRACT(EPOCH FROM (i.ended - i.started))) FILTER (WHERE i.state = 'break') AS break_s
           FROM intervals i
          WHERE i.ended > i.started
          GROUP BY i.session_id
       ), per_session_dials AS (
         SELECT a.reserved_agent_id AS session_id,
                COUNT(*) AS dials,
                COUNT(*) FILTER (WHERE a.outcome = 'agent_disconnected') AS drops
           FROM agency_call_attempts a
           JOIN sess ON sess.id = a.reserved_agent_id
          WHERE a.dialed_at >= $2::timestamptz AND a.dialed_at < $3::timestamptz
          GROUP BY a.reserved_agent_id
       )
       SELECT ss.id, ss.agent_user_id, ss.joined_at, ss.left_at, ss.kind, ss.client_kind, cc.name AS campaign_name,
              p.available_s, p.on_call_s, p.wrapup_s, p.break_s, d.dials, d.drops
         FROM sess
         JOIN agency_agent_sessions ss ON ss.id = sess.id
         LEFT JOIN agency_campaigns cc ON cc.id = ss.campaign_id
         LEFT JOIN per_session p ON p.session_id = ss.id
         LEFT JOIN per_session_dials d ON d.session_id = ss.id
        ORDER BY ss.joined_at, ss.id`;

/** The agent's sessions in this account overlapping the window (campaign and soft phone). */
export function agentSessionsStatement(q: ReportAgentScope): ReportStatement {
  return { text: `${occupancyIntervalsCtes('agent', '')}${SESSION_DETAIL_TAIL}`, values: agentValues(q) };
}

/** Every session on the campaign overlapping the window, every agent. */
export function campaignSessionsStatement(q: { campaignId: string; tenantId: string; from: Date; to: Date }): ReportStatement {
  return { text: `${occupancyIntervalsCtes('campaign', '')}${SESSION_DETAIL_TAIL}`, values: [q.campaignId, q.from, q.to, q.tenantId] };
}

/** One state interval row. */
export interface ReportStateLogRow {
  started: Date;
  ended: Date;
  state: string;
  break_reason: string | null;
  kind: string;
  campaign_id: string | null;
  campaign_name: string | null;
  seconds: number;
}

/** Every non-offline state interval of the agent in the window, clipped to it, oldest first. */
export function agentStateLogStatement(q: ReportAgentScope): ReportStatement {
  return {
    text: `${occupancyIntervalsCtes('agent', '')}       SELECT i.started, i.ended, i.state, i.break_reason, ss.kind, ss.campaign_id,
              cc.name AS campaign_name, EXTRACT(EPOCH FROM (i.ended - i.started))::float8 AS seconds
         FROM intervals i
         JOIN agency_agent_sessions ss ON ss.id = i.session_id
         LEFT JOIN agency_campaigns cc ON cc.id = ss.campaign_id
        WHERE i.ended > i.started
          AND i.state <> 'offline'
        ORDER BY i.started, i.session_id`,
    values: agentValues(q),
  };
}

/** One call row of the agent's calls sheet. */
export interface ReportAgentCallRow {
  at: Date;
  id: string;
  origin: 'campaign' | 'softphone';
  campaign_id: string | null;
  campaign_name: string | null;
  phone: string | null;
  outcome: string | null;
  disposition_code: string | null;
  talk_s: number | null;
  wrapup_s: number | null;
  redial_number: number | null;
  callback_at: Date | null;
  /** Supervisor statement only. */
  recorded?: boolean;
  /** Supervisor statement only: the analysis's label once it completed. */
  sentiment?: string | null;
}

/**
 * Every call the agent was on in the window, oldest first: their placed campaign attempts
 * (reserved to their sessions in this account) and their placed soft-phone calls. With
 * `analysis`, each row also says whether its call was recorded and its sentiment label (the
 * supervisor audience); without it the call table is not read at all.
 */
export function agentCallsStatement(q: ReportAgentScope & { analysis: boolean }): ReportStatement {
  const label = callSentimentLabelSql('k.call_analysis');
  const extra = q.analysis
    ? `,
                (k.recording_url IS NOT NULL) AS recorded,
                CASE WHEN k.analysis_status = 'completed' THEN lower(${label}) END AS sentiment`
    : '';
  const callJoin = (alias: string) => (q.analysis ? `\n           LEFT JOIN agency_calls k ON k.id = ${alias}.webrtc_call_id` : '');
  return {
    text: `SELECT * FROM (
         SELECT a.dialed_at AS at, a.id, 'campaign' AS origin, a.campaign_id, c.name AS campaign_name,
                ct.phone_e164 AS phone, a.outcome, a.disposition_code,
                CASE WHEN ${AGENT_LEG_TALK_ATTEMPT_SQL} THEN EXTRACT(EPOCH FROM (a.ended_at - a.bridged_at))::float8 END AS talk_s,
                CASE WHEN ${MEASURED_WRAPUP_ATTEMPT_SQL} THEN EXTRACT(EPOCH FROM (a.wrapup_ended_at - a.wrapup_started_at))::float8 END AS wrapup_s,
                a.redial_number::int AS redial_number, a.callback_at${extra}
           ${AGENT_ATTEMPTS_FROM.replace('JOIN agency_campaigns c ON c.id = a.campaign_id', `JOIN agency_campaigns c ON c.id = a.campaign_id
           LEFT JOIN agency_contacts ct ON ct.id = a.contact_id${callJoin('a')}`)}
         UNION ALL
         SELECT a.dialed_at, a.id, 'softphone', a.campaign_id, c.name,
                a.destination_e164, a.outcome, a.disposition_code,
                CASE WHEN ${AGENT_LEG_TALK_ATTEMPT_SQL} THEN EXTRACT(EPOCH FROM (a.ended_at - a.bridged_at))::float8 END,
                NULL::float8, NULL::int, a.callback_at${extra}
           FROM agency_manual_calls a
           LEFT JOIN agency_campaigns c ON c.id = a.campaign_id${callJoin('a')}
          WHERE a.tenant_id = $4::uuid
            AND a.account_id = $5::uuid
            AND a.agent_user_id = $1::uuid
            AND a.created_at < $3::timestamptz
            AND a.dialed_at >= $2::timestamptz AND a.dialed_at < $3::timestamptz
       ) x
       ORDER BY x.at, x.id`,
    values: agentValues(q),
  };
}

/** One placed attempt of the attempts sheet. */
export interface ReportAttemptRow {
  id: string;
  dialed_at: Date;
  campaign_id: string;
  agent_user_id: string | null;
  phone: string | null;
  outcome: string | null;
  disposition_code: string | null;
  talk_s: number | null;
  wrapup_s: number | null;
  caller_id: string | null;
  redial_number: number;
  callback_at: Date | null;
}

/** Every placed attempt of the campaigns in the window, oldest first (`idx_agency_attempts_campaign_dialed`). */
export function campaignAttemptsStatement(q: { campaignIds: string[]; tenantId: string; from: Date; to: Date }): ReportStatement {
  return {
    text: `SELECT a.id, a.dialed_at, a.campaign_id, s.agent_user_id, ct.phone_e164 AS phone, a.outcome, a.disposition_code,
                CASE WHEN ${AGENT_LEG_TALK_ATTEMPT_SQL} THEN EXTRACT(EPOCH FROM (a.ended_at - a.bridged_at))::float8 END AS talk_s,
                CASE WHEN ${MEASURED_WRAPUP_ATTEMPT_SQL} THEN EXTRACT(EPOCH FROM (a.wrapup_ended_at - a.wrapup_started_at))::float8 END AS wrapup_s,
                a.caller_id, a.redial_number::int AS redial_number, a.callback_at
           FROM agency_call_attempts a
           LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
           LEFT JOIN agency_contacts ct ON ct.id = a.contact_id
          WHERE a.campaign_id = ANY($1::uuid[])
            AND a.tenant_id = $2::uuid
            AND a.dialed_at >= $3::timestamptz AND a.dialed_at < $4::timestamptz
          ORDER BY a.dialed_at, a.id`,
    values: [q.campaignIds, q.tenantId, q.from, q.to],
  };
}
