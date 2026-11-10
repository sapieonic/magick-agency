/**
 * The insights rollup's ORACLE: every number the rollup reads return, computed straight from
 * `agency_call_attempts` with the definitions `/stats` counts with (`AGENCY_ATTEMPT_METRICS_SQL`
 * for conversations, successes, talk and wrap-up; `ABANDONED_ATTEMPT_PREDICATE_SQL`;
 * `CONVERSATION_ATTEMPT_SQL`; `/stats`' connected and answered), never through the rollup's own
 * SQL. The successes go through `successDispositionSql` over the campaign's catalog, not through
 * the caller-given code list the rollup filters by, so the test also proves the two agree.
 */
import type pg from 'pg';
import { ABANDONED_ATTEMPT_PREDICATE_SQL } from '@magick-agency/domain/abandonment-predicate';
import {
  AGENCY_ATTEMPT_METRICS_SQL,
  CONVERSATION_ATTEMPT_SQL,
  WRAPUP_MEASURED_RESOLUTIONS_SQL,
} from '../../../src/db/repositories/agency/sql-fragments.js';

export interface OracleRange { campaignId: string; from: Date; to: Date }

const RANGE = 'a.campaign_id = $1::uuid AND a.dialed_at >= $2::timestamptz AND a.dialed_at < $3::timestamptz';
const MEASURED = `a.wrapup_started_at IS NOT NULL AND a.wrapup_ended_at IS NOT NULL
                  AND ${WRAPUP_MEASURED_RESOLUTIONS_SQL.replace('wrapup_resolution', 'a.wrapup_resolution')}`;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
/**
 * `/stats` `human_connects`, spelled here on its own (not the shared HUMAN_CONNECT_ATTEMPT_SQL the
 * rollup and `/stats` interpolate), so a drift in that fragment is a disagreement with this file.
 */
const HUMAN = `(${CONVERSATION_ATTEMPT_SQL} AND a.disposition_code IS NOT NULL
                 AND a.disposition_code NOT IN ('voicemail', 'no_disposition'))`;

/** Totals: the activity section's calls block, plus the trend-only measures. */
export async function oracleTotals(pool: pg.Pool, r: OracleRange, overrideCodes: string[]) {
  const { rows } = await pool.query<Record<string, string>>(
    `SELECT ${AGENCY_ATTEMPT_METRICS_SQL},
            COUNT(*) FILTER (WHERE a.outcome = 'connected' AND a.redial_number = 0)::text AS connected_stats,
            COUNT(*) FILTER (WHERE ${HUMAN})::text AS human_stats,
            COUNT(*) FILTER (WHERE ${ABANDONED_ATTEMPT_PREDICATE_SQL})::text AS abandoned,
            COUNT(*) FILTER (WHERE a.state = 'ended' AND a.answered_at IS NOT NULL)::text AS answered,
            COUNT(*) FILTER (WHERE ${MEASURED})::text AS wrapup_measured,
            COUNT(*) FILTER (WHERE a.redial_number > 0)::text AS redials_placed,
            COUNT(*) FILTER (WHERE a.redial_number > 0 AND a.outcome = 'connected')::text AS redials_connected,
            COUNT(*) FILTER (WHERE a.redial_number = 2)::text AS chains_at_limit,
            COUNT(*) FILTER (WHERE a.agent_reopened)::text AS reopened_dials,
            COUNT(*) FILTER (WHERE a.agent_reopened AND a.outcome = 'connected')::text AS reopened_connected,
            COUNT(*) FILTER (WHERE a.agent_manual)::text AS manual_dials,
            COUNT(*) FILTER (WHERE a.agent_manual AND a.outcome = 'connected')::text AS manual_connected,
            COUNT(*) FILTER (WHERE cardinality(a.override_applied) > 0)::text AS overrides_used,
            COUNT(*) FILTER (WHERE a.callback_at IS NOT NULL)::text AS callbacks_booked,
            COUNT(*) FILTER (WHERE a.outcome = 'connected' AND a.redial_number = 0
                               AND EXISTS (SELECT 1 FROM agency_calls k WHERE k.id = a.webrtc_call_id AND k.recording_url IS NOT NULL))::text AS recorded_connected,
            COUNT(*) FILTER (WHERE a.outcome = 'failed')::text AS failed,
            MAX(a.updated_at) AS as_of
       FROM agency_call_attempts a JOIN agency_campaigns c ON c.id = a.campaign_id
      WHERE ${RANGE}`,
    [r.campaignId, r.from, r.to],
  );
  const t = rows[0]!;
  const n = (k: string) => Number(t[k] ?? 0);
  const outcomes = await pool.query<{ outcome: string | null; n: string }>(
    `SELECT a.outcome, COUNT(*)::text AS n FROM agency_call_attempts a WHERE ${RANGE} GROUP BY 1`, [r.campaignId, r.from, r.to]);
  const byOutcome: Record<string, number> = {};
  for (const o of outcomes.rows) byOutcome[o.outcome ?? 'null_outcome'] = Number(o.n);
  const codes = await pool.query<{ code: string | null; n: string }>(
    `SELECT a.disposition_code AS code, COUNT(*)::text AS n FROM agency_call_attempts a
      WHERE ${RANGE} AND ${CONVERSATION_ATTEMPT_SQL} GROUP BY 1`, [r.campaignId, r.from, r.to]);
  const noOutcome = await pool.query<{ k: string | null; n: string }>(
    `SELECT a.wrapup_resolution AS k, COUNT(*)::text AS n FROM agency_call_attempts a
      WHERE ${RANGE} AND ${CONVERSATION_ATTEMPT_SQL} AND (a.disposition_code IS NULL OR a.disposition_code = 'no_disposition')
      GROUP BY 1`, [r.campaignId, r.from, r.to]);
  const overrides = await oracleOverrides(pool, r, overrideCodes);
  // Carrier failures by the call row's error code (no call row: null).
  const errors = await pool.query<{ code: string | null; n: string }>(
    `SELECT k.error_code AS code, COUNT(*)::text AS n FROM agency_call_attempts a
       LEFT JOIN agency_calls k ON k.id = a.webrtc_call_id
      WHERE ${RANGE} AND a.outcome = 'failed' GROUP BY 1`, [r.campaignId, r.from, r.to]);
  return {
    calls: {
      dials: n('attempts'),
      connected: n('connected_stats'),
      conversations: n('connected'),
      human_connects: n('human_stats'),
      successes: n('successes'),
      talk_seconds: round6(n('talk_seconds')),
      wrapup_seconds: round6(n('wrapup_seconds')),
      wrapup_measured: n('wrapup_measured'),
      redials: { placed: n('redials_placed'), connected: n('redials_connected'), chains_at_limit: n('chains_at_limit') },
      agent_retries: {
        reopened_dials: n('reopened_dials'), reopened_connected: n('reopened_connected'),
        manual_dials: n('manual_dials'), manual_connected: n('manual_connected'),
      },
      callbacks_booked: n('callbacks_booked'),
      recorded_connected: n('recorded_connected'),
    },
    failed: n('failed'),
    failed_by_code: Object.fromEntries(errors.rows.map((e) => [String(e.code), Number(e.n)])),
    abandoned: n('abandoned'),
    answered: n('answered'),
    by_outcome: byOutcome,
    outcomes: Object.fromEntries(codes.rows.map((c) => [String(c.code), Number(c.n)])),
    no_outcome: Object.fromEntries(noOutcome.rows.map((c) => [c.k ?? 'none', Number(c.n)])),
    overrides,
    overrides_used: n('overrides_used'),
    as_of: t['as_of'] ? new Date(t['as_of']).toISOString() : null,
  };
}

/** Per agent, through the reserved session. */
export async function oracleAgents(pool: pg.Pool, r: OracleRange) {
  const { rows } = await pool.query<Record<string, string | null>>(
    `SELECT s.agent_user_id, ${AGENCY_ATTEMPT_METRICS_SQL},
            COUNT(*) FILTER (WHERE a.outcome = 'connected' AND a.redial_number = 0)::text AS connected_stats,
            COUNT(*) FILTER (WHERE ${HUMAN})::text AS human_stats,
            COUNT(*) FILTER (WHERE ${MEASURED})::text AS wrapup_measured,
            COUNT(*) FILTER (WHERE a.redial_number > 0)::text AS redials,
            COUNT(*) FILTER (WHERE a.agent_reopened OR a.agent_manual)::text AS retries_any,
            (COUNT(*) FILTER (WHERE a.agent_reopened) + COUNT(*) FILTER (WHERE a.agent_manual))::text AS retries,
            COUNT(*) FILTER (WHERE cardinality(a.override_applied) > 0)::text AS overrides
       FROM agency_call_attempts a
       JOIN agency_campaigns c ON c.id = a.campaign_id
       LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
      WHERE ${RANGE}
      GROUP BY s.agent_user_id`,
    [r.campaignId, r.from, r.to],
  );
  return Object.fromEntries(rows.map((x) => [String(x['agent_user_id']), {
    // AGENCY_ATTEMPT_METRICS_SQL's `connected` is one per conversation (the totals' `conversations`).
    dials: Number(x['attempts']), connected: Number(x['connected_stats']), conversations: Number(x['connected']),
    human_connects: Number(x['human_stats']), successes: Number(x['successes']),
    talk_seconds: round6(Number(x['talk_seconds'])), wrapup_seconds: round6(Number(x['wrapup_seconds'])),
    wrapup_measured: Number(x['wrapup_measured']), redials: Number(x['redials']), retries: Number(x['retries']),
    overrides: Number(x['overrides']),
  }]));
}

/** Override grants (dials dispositioned with a granting code) and uses (by the granting code), by agent. */
async function oracleOverrides(pool: pg.Pool, r: OracleRange, overrideCodes: string[]) {
  const { rows } = await pool.query<{ code: string; agent: string | null; granted: string; used: string }>(
    `WITH x AS (
       SELECT s.agent_user_id AS agent, a.disposition_code AS code, 'granted' AS k FROM agency_call_attempts a
         LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
        WHERE ${RANGE} AND a.disposition_code = ANY($4::text[])
       UNION ALL
       SELECT s.agent_user_id, (SELECT p.disposition_code FROM agency_call_attempts p
                                 WHERE p.contact_id = a.contact_id AND p.attempt_number < a.attempt_number
                                   AND p.disposition_code IS NOT NULL AND p.disposition_code NOT IN ('redialed', 'inbound_call')
                                 ORDER BY p.attempt_number DESC LIMIT 1), 'used'
         FROM agency_call_attempts a
         LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
        WHERE ${RANGE} AND cardinality(a.override_applied) > 0
     )
     SELECT code, agent, COUNT(*) FILTER (WHERE k = 'granted')::text AS granted, COUNT(*) FILTER (WHERE k = 'used')::text AS used
       FROM x WHERE code = ANY($4::text[]) GROUP BY code, agent`,
    [r.campaignId, r.from, r.to, overrideCodes],
  );
  const out: Record<string, { granted: number; used: number; by_agent: Record<string, { granted: number; used: number }> }> = {};
  for (const code of overrideCodes) out[code] = { granted: 0, used: 0, by_agent: {} };
  for (const row of rows) {
    const entry = out[row.code]!;
    entry.granted += Number(row.granted);
    entry.used += Number(row.used);
    entry.by_agent[String(row.agent)] = { granted: Number(row.granted), used: Number(row.used) };
  }
  return out;
}

/** Caller IDs, best hours (each contact's zone, else the campaign's, else UTC). */
export async function oracleFacets(pool: pg.Pool, r: OracleRange) {
  const ids = await pool.query<{ k: string; dials: string; first_dials: string; human: string; connected: string }>(
    `SELECT a.caller_id AS k, COUNT(*)::text AS dials,
            COUNT(*) FILTER (WHERE a.redial_number = 0)::text AS first_dials,
            COUNT(*) FILTER (WHERE ${HUMAN})::text AS human,
            COUNT(*) FILTER (WHERE a.outcome = 'connected' AND a.redial_number = 0)::text AS connected
       FROM agency_call_attempts a WHERE ${RANGE} GROUP BY 1`, [r.campaignId, r.from, r.to]);
  const hours = await pool.query<{ k: number; dials: string; first_dials: string; human: string; connected: string }>(
    `SELECT EXTRACT(HOUR FROM a.dialed_at AT TIME ZONE COALESCE(
               (SELECT z.name FROM pg_timezone_names z WHERE lower(z.name) = lower(ct.timezone) LIMIT 1),
               (SELECT z.name FROM pg_timezone_names z WHERE lower(z.name) = lower(c.default_timezone) LIMIT 1),
               'UTC'))::int AS k,
            COUNT(*)::text AS dials,
            COUNT(*) FILTER (WHERE a.redial_number = 0)::text AS first_dials,
            COUNT(*) FILTER (WHERE ${HUMAN})::text AS human,
            COUNT(*) FILTER (WHERE a.outcome = 'connected' AND a.redial_number = 0)::text AS connected
       FROM agency_call_attempts a
       JOIN agency_contacts ct ON ct.id = a.contact_id
       JOIN agency_campaigns c ON c.id = a.campaign_id
      WHERE ${RANGE} GROUP BY 1`, [r.campaignId, r.from, r.to]);
  const byHour = new Map(hours.rows.map((h) => [Number(h.k), h]));
  return {
    caller_ids: Object.fromEntries(ids.rows.map((i) => [i.k, { dials: Number(i.dials), first_dials: Number(i.first_dials), human_connects: Number(i.human), connected: Number(i.connected) }])),
    best_hours: Array.from({ length: 24 }, (_, hour) => ({
      hour, dials: Number(byHour.get(hour)?.dials ?? 0), first_dials: Number(byHour.get(hour)?.first_dials ?? 0),
      human_connects: Number(byHour.get(hour)?.human ?? 0),
      connected: Number(byHour.get(hour)?.connected ?? 0),
    })),
  };
}

/**
 * Trend buckets with something in them, labelled from `dialed_at` by spellings independent of
 * the rollup's: the quarter hour from the epoch, the local hour as the instant minus its
 * minutes and seconds past the local hour (which keeps the two 01:00s of a fall-back night
 * apart, as real hours are), the day from the local date.
 */
export async function oracleTrend(pool: pg.Pool, r: OracleRange, bucket: 'quarter_hour' | 'hour' | 'day', zone: string) {
  const isoOf = (e: string) => `to_char((${e}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  const local = 'a.dialed_at AT TIME ZONE $4::text';
  const label = bucket === 'quarter_hour'
    ? isoOf(`to_timestamp(floor(extract(epoch FROM a.dialed_at) / 900) * 900)`)
    : bucket === 'hour'
      ? isoOf(`a.dialed_at - ((${local}) - date_trunc('hour', ${local}))`)
      : `to_char(a.dialed_at AT TIME ZONE $4::text, 'YYYY-MM-DD')`;
  const { rows } = await pool.query<Record<string, string>>(
    `SELECT ${label} AS label, ${AGENCY_ATTEMPT_METRICS_SQL},
            COUNT(*) FILTER (WHERE a.redial_number = 0)::text AS first_dials,
            COUNT(*) FILTER (WHERE ${HUMAN})::text AS human_stats,
            COUNT(*) FILTER (WHERE a.outcome = 'connected' AND a.redial_number = 0)::text AS connected_stats,
            COUNT(*) FILTER (WHERE ${ABANDONED_ATTEMPT_PREDICATE_SQL})::text AS abandoned,
            COUNT(*) FILTER (WHERE a.state = 'ended' AND a.answered_at IS NOT NULL)::text AS answered
       FROM agency_call_attempts a JOIN agency_campaigns c ON c.id = a.campaign_id
      WHERE ${RANGE} AND $4::text IS NOT NULL GROUP BY 1 ORDER BY 1`,
    [r.campaignId, r.from, r.to, zone],
  );
  return Object.fromEntries(rows.map((x) => [x['label']!, {
    dials: Number(x['attempts']), first_dials: Number(x['first_dials']), human_connects: Number(x['human_stats']),
    connected: Number(x['connected_stats']), conversations: Number(x['connected']),
    successes: Number(x['successes']), abandoned: Number(x['abandoned']), answered: Number(x['answered']),
  }]));
}
