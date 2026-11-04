/**
 * The insights rollup's SQL: the bucket width, the measures, the claim and the recompute
 * (migration 0012, `docs/insights.md` "Shape"). A leaf: it imports the domain's definitions and
 * `sql-fragments.ts`, nothing else in this folder.
 *
 * The rollup is a pure function of `agency_call_attempts`. Every measure below is spelled from
 * the definition the supervisor dashboard (`campaign-stats.ts`) counts with, imported rather
 * than restated wherever one is exported: abandonment is `ABANDONED_ATTEMPT_PREDICATE_SQL`, a
 * conversation is `CONVERSATION_ATTEMPT_SQL`, measured wrap-up is
 * `WRAPUP_MEASURED_RESOLUTIONS_SQL`. The three that `/stats` spells inline are restated here with
 * the line they copy, and `insights-rollup-oracle.test.ts` holds every one against the attempts
 * table read through `/stats`' own expressions (`AGENCY_ATTEMPT_METRICS_SQL` for talk, wrap-up,
 * conversations and successes).
 */
import { ABANDONED_ATTEMPT_PREDICATE_SQL } from '@magick-agency/domain/abandonment-predicate';
import { AGENCY_REDIALED_DISPOSITION_CODE, AGENCY_WRAPUP_REDIAL_LIMIT } from '@magick-agency/contracts/agency';
import { AUTO_DISPOSITION_CODE } from '../../../agency/disposition.js';
import { CONVERSATION_ATTEMPT_SQL, HUMAN_CONNECT_ATTEMPT_SQL, WRAPUP_MEASURED_RESOLUTIONS_SQL } from './sql-fragments.js';

/**
 * The bucket width, in minutes: `agency_insights_bucket()` (0012) bins `dialed_at` on it from
 * `2000-01-01T00:00:00Z`. Fifteen because UTC+05:30 and UTC+05:45 hours do not align to UTC
 * hours; every zone's offset is a multiple of it, so a local hour or day is whole buckets.
 * `insights-rollup-migration.test.ts` holds this number to the SQL function.
 */
export const INSIGHTS_BUCKET_MINUTES = 15;
export const INSIGHTS_BUCKET_SQL_INTERVAL = `interval '${INSIGHTS_BUCKET_MINUTES} minutes'`;

/**
 * The measures each rollup row carries, as `[column, aggregate over src a]`, in the column
 * order of `agency_insights_rollup_buckets` and `_agents` (both carry all of them).
 *
 * Evaluated over the recompute's `src a` ONLY: `ABANDONED_ATTEMPT_PREDICATE_SQL` names its
 * columns unqualified, and `src` is the one relation in that FROM clause (its sources join the
 * session, contact and call rows, which carry a `state` and an `outcome` of their own).
 */
export const INSIGHTS_MEASURES: ReadonlyArray<readonly [column: string, aggregate: string]> = [
  // Every placed dial (src holds only rows with dialed_at in the bucket), wrap-up redials included.
  ['dials', 'COUNT(*)'],
  // /stats attempts_connected: `outcome = 'connected' AND redial_number = 0` ("a wrap-up redial
  // continues a conversation the original already counted").
  ['connected', "COUNT(*) FILTER (WHERE a.outcome = 'connected' AND a.redial_number = 0)"],
  // /stats' connect buckets and the series' `connected`: one per conversation.
  ['conversations', `COUNT(*) FILTER (WHERE ${CONVERSATION_ATTEMPT_SQL})`],
  ['bridged', 'COUNT(*) FILTER (WHERE a.bridged_at IS NOT NULL)'],
  ['abandoned', `COUNT(*) FILTER (WHERE ${ABANDONED_ATTEMPT_PREDICATE_SQL})`],
  // /stats answered_24h's population (the abandonment rate's denominator), without the window.
  ['answered', "COUNT(*) FILTER (WHERE a.state = 'ended' AND a.answered_at IS NOT NULL)"],
  // AGENCY_ATTEMPT_METRICS_SQL talk_seconds: the agent's leg, orphans excluded. Microseconds.
  ['talk_us', `COALESCE(SUM((EXTRACT(EPOCH FROM (a.ended_at - a.bridged_at)) * 1000000)::bigint) FILTER (
                WHERE a.bridged_at IS NOT NULL
                  AND a.ended_at IS NOT NULL
                  AND a.outcome IS DISTINCT FROM 'orphaned'), 0)`],
  // AGENCY_ATTEMPT_METRICS_SQL wrapup_seconds: measured, never the allotment. Microseconds.
  ['wrapup_us', `COALESCE(SUM((EXTRACT(EPOCH FROM (a.wrapup_ended_at - a.wrapup_started_at)) * 1000000)::bigint) FILTER (
                WHERE ${WRAPUP_MEASURED_SQL()}), 0)`],
  ['wrapup_measured', `COUNT(*) FILTER (WHERE ${WRAPUP_MEASURED_SQL()})`],
  // /stats attempts_redialed (every row here is placed).
  ['redials_placed', 'COUNT(*) FILTER (WHERE a.redial_number > 0)'],
  ['redials_connected', "COUNT(*) FILTER (WHERE a.redial_number > 0 AND a.outcome = 'connected')"],
  // A chain that used its last redial.
  ['redial_chains_at_limit', `COUNT(*) FILTER (WHERE a.redial_number = ${AGENCY_WRAPUP_REDIAL_LIMIT})`],
  ['reopened_dials', 'COUNT(*) FILTER (WHERE a.agent_reopened)'],
  ['reopened_connected', "COUNT(*) FILTER (WHERE a.agent_reopened AND a.outcome = 'connected')"],
  ['manual_dials', 'COUNT(*) FILTER (WHERE a.agent_manual)'],
  ['manual_connected', "COUNT(*) FILTER (WHERE a.agent_manual AND a.outcome = 'connected')"],
  ['overrides_used', 'COUNT(*) FILTER (WHERE cardinality(a.override_applied) > 0)'],
  // The connected calls (as `connected`) whose call row carries a recording.
  ['recorded_connected', "COUNT(*) FILTER (WHERE a.outcome = 'connected' AND a.redial_number = 0 AND a.recorded)"],
  // Bookings, at the booking attempt's dial time.
  ['callbacks_booked', 'COUNT(*) FILTER (WHERE a.callback_at IS NOT NULL)'],
  // The connect rate's numerator (0014), the product's one spelling (/stats human_connects);
  // its denominator is dials - redials_placed (every row here is placed).
  ['human_connects', `COUNT(*) FILTER (WHERE ${HUMAN_CONNECT_ATTEMPT_SQL})`],
];

function WRAPUP_MEASURED_SQL(): string {
  return `a.wrapup_started_at IS NOT NULL
                  AND a.wrapup_ended_at IS NOT NULL
                  AND ${WRAPUP_MEASURED_RESOLUTIONS_SQL.replace('wrapup_resolution', 'a.wrapup_resolution')}`;
}

export const INSIGHTS_MEASURE_COLUMNS = INSIGHTS_MEASURES.map(([column]) => column);

/** The facets of `agency_insights_rollup_facets` (its CHECK; `carrier_error` from 0014). */
export const INSIGHTS_FACETS = ['outcome', 'caller_id', 'local_hour', 'no_outcome', 'override', 'carrier_error'] as const;
export type InsightsFacet = (typeof INSIGHTS_FACETS)[number];

/**
 * Claim up to `$1` marks, oldest first, and delete them with every other unlocked mark of the
 * same buckets (the collapse), returning the distinct buckets, how many marks were picked (fewer
 * than `$1`: the backlog is empty) and how many were deleted. Runs inside the recompute's
 * transaction: a rollback puts every mark back.
 *
 * `picked` is the `MATERIALIZED` CTE with `FOR UPDATE SKIP LOCKED` (`packages/db/CLAUDE.md`
 * "Claiming rows"), so the planner cannot re-run the LIMIT per outer row and hand out more
 * than `$1` marks; at most `$1` marks means at most `$1` buckets. The collapse (`rest`) has no
 * LIMIT, so re-running it would find nothing new. It skips marks another claim holds: that
 * claim recomputes the bucket too, serialized on the header row.
 */
export const INSIGHTS_CLAIM_SQL = `WITH picked AS MATERIALIZED (
         SELECT id, campaign_id, bucket_start
           FROM agency_insights_rollup_dirty
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ), keys AS (
         SELECT DISTINCT campaign_id, bucket_start FROM picked
       ), rest AS MATERIALIZED (
         SELECT d.id
           FROM agency_insights_rollup_dirty d
           JOIN keys k ON k.campaign_id = d.campaign_id AND k.bucket_start = d.bucket_start
            FOR UPDATE OF d SKIP LOCKED
       ), gone AS (
         DELETE FROM agency_insights_rollup_dirty d
          WHERE d.id IN (SELECT id FROM picked UNION SELECT id FROM rest)
         RETURNING d.id
       )
       SELECT k.campaign_id, k.bucket_start,
              (SELECT count(*) FROM picked)::int AS picked,
              (SELECT count(*) FROM gone)::int AS marks
         FROM keys k
        ORDER BY k.campaign_id, k.bucket_start`;

/** The claimed buckets as two parallel arrays, `$1::uuid[]` and `$2::timestamptz[]`. */
const KEYS_SQL = 'SELECT * FROM unnest($1::uuid[], $2::timestamptz[]) AS k(campaign_id, bucket_start)';

/**
 * Upsert the claimed buckets' headers, in key order, which locks each one for the rest of the
 * transaction: two recomputes of one bucket serialize here (0012's header). Buckets of a
 * campaign that no longer exists are left out (its marks are already deleted, and the cascade
 * from `agency_campaigns` took its rollup).
 */
export const INSIGHTS_LOCK_HEADERS_SQL = `INSERT INTO agency_insights_rollup_buckets (campaign_id, bucket_start)
       SELECT k.campaign_id, k.bucket_start
         FROM (${KEYS_SQL}) k
        WHERE EXISTS (SELECT 1 FROM agency_campaigns c WHERE c.id = k.campaign_id)
        ORDER BY k.campaign_id, k.bucket_start
       ON CONFLICT (campaign_id, bucket_start) DO UPDATE SET computed_at = now()
       RETURNING campaign_id, bucket_start`;

/** Delete the locked buckets' breakdown rows (their header is rewritten by the recompute). */
export const INSIGHTS_CLEAR_SQL = `WITH k AS (${KEYS_SQL}),
       d1 AS (DELETE FROM agency_insights_rollup_agents r USING k
               WHERE r.campaign_id = k.campaign_id AND r.bucket_start = k.bucket_start),
       d2 AS (DELETE FROM agency_insights_rollup_codes r USING k
               WHERE r.campaign_id = k.campaign_id AND r.bucket_start = k.bucket_start),
       d3 AS (DELETE FROM agency_insights_rollup_facets r USING k
               WHERE r.campaign_id = k.campaign_id AND r.bucket_start = k.bucket_start)
       SELECT 1`;

const MEASURE_LIST = INSIGHTS_MEASURE_COLUMNS.join(', ');
const MEASURE_SELECT = INSIGHTS_MEASURES.map(([column, agg]) => `${agg} AS ${column}`).join(',\n              ');

/**
 * Recompute the locked buckets from the attempts in them: one statement, so one snapshot (taken
 * after the claim and the header locks) feeds every table. `src` reads each bucket's attempts
 * through `idx_agency_attempts_campaign_dialed` (campaign_id, dialed_at), one range per bucket
 * (a LATERAL per bucket, so the plan cannot turn the ranges into a filter over the campaign).
 *
 *  - The agent is the reserved session's `agent_user_id`.
 *  - The contact's local hour is `dialed_at` in the contact's zone, else the campaign's, else
 *    UTC, each resolved through `pg_timezone_names` case-insensitively as
 *    `AGENCY_RESOLVED_ZONE_JOIN_SQL` resolves a campaign's: a zone Postgres cannot resolve falls
 *    through rather than raising `22023` and poisoning the bucket. The zone list is read once
 *    per statement (`zones`), one row per lower-cased name so the join cannot duplicate an attempt.
 *  - `override_code` is the disposition that granted the override a dial spent: the contact's
 *    latest dispositioned attempt before this one (`uq_agency_attempt_number`), looked up only
 *    for the rare dial whose `override_applied` is non-empty. It reads an attempt that can sit in
 *    another bucket, so a re-disposition of that attempt after the override was spent does not
 *    re-mark this bucket; the overrides read can lag that one edit until the bucket is next written.
 *  - `recorded`: the call row (`webrtc_call_id`) carries a recording; `call_error_code` is that
 *    row's `error_code` (the `carrier_error` facet, 0014).
 *
 * Facet columns: `n` the key's dials (conversations for `no_outcome`); `connected` `/stats`'
 * `attempts_connected` for `caller_id` and `local_hour`; for those two facets also the connect
 * rate's two counts (0014): `first_dials` (the key's dials with `redial_number = 0`) and
 * `human_connects` (HUMAN_CONNECT_ATTEMPT_SQL). All three are 0 on the facets that do not read
 * them.
 */
export const INSIGHTS_RECOMPUTE_SQL = `WITH k AS (${KEYS_SQL}),
       zones AS MATERIALIZED (
         SELECT DISTINCT ON (lower(name)) lower(name) AS lname, name FROM pg_timezone_names ORDER BY lower(name), name
       ), src AS MATERIALIZED (
         SELECT k.campaign_id, k.bucket_start,
                a.state, a.outcome, a.disposition_code, a.redial_number, a.caller_id,
                a.answered_at, a.bridged_at, a.ended_at,
                a.wrapup_started_at, a.wrapup_ended_at, a.wrapup_resolution,
                a.agent_reopened, a.agent_manual, a.override_applied, a.callback_at, a.updated_at,
                s.agent_user_id,
                EXTRACT(HOUR FROM (a.dialed_at AT TIME ZONE COALESCE(zc.name, zk.name, 'UTC')))::int AS local_hour,
                CASE WHEN cardinality(a.override_applied) > 0 THEN (
                  SELECT p.disposition_code FROM agency_call_attempts p
                   WHERE p.contact_id = a.contact_id
                     AND p.attempt_number < a.attempt_number
                     AND p.disposition_code IS NOT NULL
                     AND p.disposition_code <> '${AGENCY_REDIALED_DISPOSITION_CODE}'
                   ORDER BY p.attempt_number DESC LIMIT 1)
                END AS override_code,
                (call.recording_url IS NOT NULL) AS recorded,
                call.error_code AS call_error_code,
                (${CONVERSATION_ATTEMPT_SQL}) AS is_conversation,
                (${HUMAN_CONNECT_ATTEMPT_SQL}) AS is_human_connect
           FROM k
           -- LATERAL, so each bucket is its own range scan of
           -- idx_agency_attempts_campaign_dialed. As a plain join the range is a join
           -- filter the planner may apply to a hash join over the campaign's whole
           -- history: 200 buckets of a 1M-attempt campaign read 1M rows and discarded
           -- 200M pairs (20 s) where the ranges read 69k (insights-rollup-scale.test.ts).
           CROSS JOIN LATERAL (
             SELECT * FROM agency_call_attempts x
              WHERE x.campaign_id = k.campaign_id
                AND x.dialed_at >= k.bucket_start
                AND x.dialed_at < k.bucket_start + ${INSIGHTS_BUCKET_SQL_INTERVAL}
             -- OFFSET 0 keeps the planner from pulling the subquery up into a plain
             -- join again (which it does, and which brings the hash join back).
             OFFSET 0
           ) a
           JOIN agency_campaigns c ON c.id = a.campaign_id
           LEFT JOIN agency_contacts ct ON ct.id = a.contact_id
           LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
           LEFT JOIN agency_calls call ON call.id = a.webrtc_call_id
           LEFT JOIN zones zc ON zc.lname = lower(ct.timezone)
           LEFT JOIN zones zk ON zk.lname = lower(c.default_timezone)
       ), ins_agents AS (
         INSERT INTO agency_insights_rollup_agents (campaign_id, bucket_start, agent_user_id, ${MEASURE_LIST})
         SELECT a.campaign_id, a.bucket_start, a.agent_user_id,
              ${MEASURE_SELECT}
           FROM src a
          GROUP BY a.campaign_id, a.bucket_start, a.agent_user_id
       ), ins_codes AS (
         INSERT INTO agency_insights_rollup_codes (campaign_id, bucket_start, agent_user_id, disposition_code, conversations, dials)
         SELECT a.campaign_id, a.bucket_start, a.agent_user_id, a.disposition_code,
                COUNT(*) FILTER (WHERE a.is_conversation), COUNT(*)
           FROM src a
          WHERE a.disposition_code IS NOT NULL OR a.is_conversation
          GROUP BY a.campaign_id, a.bucket_start, a.agent_user_id, a.disposition_code
       ), ins_facets AS (
         INSERT INTO agency_insights_rollup_facets (campaign_id, bucket_start, facet, key, agent_user_id, n, connected, first_dials, human_connects)
         SELECT a.campaign_id, a.bucket_start, 'outcome', a.outcome, NULL::uuid, COUNT(*), 0, 0, 0
           FROM src a GROUP BY a.campaign_id, a.bucket_start, a.outcome
         UNION ALL
         SELECT a.campaign_id, a.bucket_start, 'caller_id', a.caller_id, NULL::uuid, COUNT(*),
                COUNT(*) FILTER (WHERE a.outcome = 'connected' AND a.redial_number = 0),
                COUNT(*) FILTER (WHERE a.redial_number = 0),
                COUNT(*) FILTER (WHERE a.is_human_connect)
           FROM src a GROUP BY a.campaign_id, a.bucket_start, a.caller_id
         UNION ALL
         SELECT a.campaign_id, a.bucket_start, 'local_hour', a.local_hour::text, NULL::uuid, COUNT(*),
                COUNT(*) FILTER (WHERE a.outcome = 'connected' AND a.redial_number = 0),
                COUNT(*) FILTER (WHERE a.redial_number = 0),
                COUNT(*) FILTER (WHERE a.is_human_connect)
           FROM src a GROUP BY a.campaign_id, a.bucket_start, a.local_hour
         UNION ALL
         -- Connected calls closed with no outcome: a conversation whose code is absent or the
         -- reaper's auto-stamp (/stats' unclassified_connects), by how its wrap-up ended.
         SELECT a.campaign_id, a.bucket_start, 'no_outcome', a.wrapup_resolution, NULL::uuid, COUNT(*), 0, 0, 0
           FROM src a
          WHERE a.is_conversation
            AND (a.disposition_code IS NULL OR a.disposition_code = '${AUTO_DISPOSITION_CODE}')
          GROUP BY a.campaign_id, a.bucket_start, a.wrapup_resolution
         UNION ALL
         SELECT a.campaign_id, a.bucket_start, 'override', a.override_code, a.agent_user_id, COUNT(*), 0, 0, 0
           FROM src a
          WHERE cardinality(a.override_applied) > 0
          GROUP BY a.campaign_id, a.bucket_start, a.override_code, a.agent_user_id
         UNION ALL
         -- Carrier failures (outcome failed) by the call row's error code (0014).
         SELECT a.campaign_id, a.bucket_start, 'carrier_error', a.call_error_code, NULL::uuid, COUNT(*), 0, 0, 0
           FROM src a
          WHERE a.outcome = 'failed'
          GROUP BY a.campaign_id, a.bucket_start, a.call_error_code
       ), totals AS (
         SELECT a.campaign_id, a.bucket_start, MAX(a.updated_at) AS source_updated_at,
              ${MEASURE_SELECT}
           FROM src a
          GROUP BY a.campaign_id, a.bucket_start
       ), upd AS (
         -- Every locked header, including one whose bucket now holds no attempt: back to zeros.
         UPDATE agency_insights_rollup_buckets b
            SET computed_at = now(),
                source_updated_at = t.source_updated_at,
                ${INSIGHTS_MEASURE_COLUMNS.map((c) => `${c} = COALESCE(t.${c}, 0)`).join(',\n                ')}
           FROM k LEFT JOIN totals t ON t.campaign_id = k.campaign_id AND t.bucket_start = k.bucket_start
          WHERE b.campaign_id = k.campaign_id AND b.bucket_start = k.bucket_start
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM src)::int AS attempts, (SELECT count(*) FROM upd)::int AS buckets`;

/** Distinct dirty buckets and the oldest mark's age, for the backlog gauge. */
export const INSIGHTS_BACKLOG_SQL = `SELECT count(*)::int AS buckets,
              COALESCE(EXTRACT(EPOCH FROM (now() - min(oldest))), 0)::float8 AS oldest_seconds
         FROM (SELECT min(marked_at) AS oldest
                 FROM agency_insights_rollup_dirty
                GROUP BY campaign_id, bucket_start) b`;
