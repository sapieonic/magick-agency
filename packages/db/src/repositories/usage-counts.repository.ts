import { getPool } from '../connection.js';

/**
 * The read behind the super-admin usage-counts
 * view (`GET /super-admin/usage`, contract `UsageCountsQuery` /
 * `UsageCountsResponse` in `@magick-agency/contracts/api/platform/super-admin-usage`).
 *
 * Read-only and charges nothing. It counts facts agency already records:
 *
 *  - `dials` — `agency_call_attempts` with `dialed_at` in the window, plus
 *    soft-phone dials (`agency_manual_calls`) the same way (placed calls only:
 *    inbound calls have their own columns, below);
 *  - `answered_calls` — those with `answered_at IS NOT NULL`;
 *  - `connected_calls` — those with `bridged_at IS NOT NULL`;
 *  - `talk_seconds` — Σ `talk_seconds` over those dials;
 *  - `analysis_audio_seconds` — Σ `dialer_analysis_jobs.analysis_audio_seconds`
 *    for the jobs on those dials' calls.
 *
 * ── Manual calls are counted at the agency rate (SP5) ──────────────────────
 * A soft-phone dial (docs/softphone.md) is an agency call, metered like a campaign
 * dial: its row in `agency_manual_calls` carries the same four columns
 * (`dialed_at`, `answered_at`, `bridged_at`, `talk_seconds`) and the same
 * `webrtc_call_id` correlation, so the two spines are UNION ALLed into one set of
 * dials before the per-account roll-up and every column keeps one meaning. The two
 * tables are disjoint by construction (a manual call never writes an attempt), so
 * the union cannot double-count. `agency_manual_calls` has no `dialed_at` index: the
 * soft phone's volume is a small fraction of pacing's, and a usage report is not on
 * a hot path; add one when a plan on real volume says so.
 *
 * ── Inbound calls are counted apart (docs/inbound.md §9) ─────────────────────
 * A customer's call to an inbound route (`agency_inbound_calls`, 0024) is an agency call too,
 * but it is not a dial and the carrier bills it differently: its own columns, never folded into
 * the five above (which count placed calls only, campaign and soft phone):
 *  - `inbound_calls`: every call that arrived in the window (`arrived_at`, the same half-open
 *    rule), refused ones included (a refused call is answered with a hangup and never billed:
 *    `inbound_answered_calls` leaves it out);
 *  - `inbound_answered_calls`: answered by our answer XML (`answered_at`): a message played or
 *    spoken, a queue, a voicemail, each one billed by the carrier;
 *  - `inbound_connected_calls`: an agent was bridged (`bridged_at`);
 *  - `inbound_seconds`: carrier time, over the answered calls that have ended: each call's
 *    `carrier_seconds` (the carrier's own duration from its hangup callback, 0029) when it has
 *    one, else (`ended_at` - `answered_at`): what the carrier bills an inbound call for, messages
 *    and holding included. A call answered with a message the carrier speaks (`<Speak>`) ends on
 *    our side at the answer while the carrier goes on speaking, so only its own duration counts
 *    it (SWE-F8);
 *  - `inbound_hold_seconds`: queue time, the sum of (`bridged_at`, else `ended_at`, -
 *    `queued_at`) over the ended calls that queued: the part of the carrier time a caller spent
 *    waiting on our hold audio (billed as call and stream minutes like the rest);
 *  - `inbound_talk_seconds`: the sum of `talk_seconds` (from the bridge);
 *  - `inbound_analysis_audio_seconds`: the analysis seconds of the jobs on those calls' legs.
 * The two durations are exact sums of timestamp differences, rounded once to whole seconds per
 * row (no per-call rounding rule: that is a pricing decision, as for the dials). A call not yet
 * ended counts as a call and adds no seconds until it ends. A call that reached no account (the
 * tenant default, §8.3: `account_id` NULL, the closed message spoken by the carrier) has no row
 * to land in and is left out; it never has a media leg, so it carries no talk or analysis time.
 * The spine is disjoint from the other two by construction (an inbound call writes no attempt and
 * no manual call). No `arrived_at` index, for the soft phone's reason.
 *
 * ── One window rule for every column ───────────────────────────────────────
 * Half-open `[from, to)` on the ATTEMPT's `dialed_at`. Analysis seconds are
 * attributed to the dial they analysed, not to when the job ran, so every
 * number on a row describes the same set of dials and consecutive windows tile.
 * The join is `dialer_analysis_jobs.call_id = agency_call_attempts.webrtc_call_id`
 * (the attempt's media leg, an `agency_calls.id`); `uq_dialer_analysis_jobs_call`
 * makes it at most one job per call, so the LEFT JOIN cannot multiply an attempt
 * and the dial counts stay exact.
 *
 * ── The index ──────────────────────────────────────────────────────────────
 * `idx_agency_attempts_billing (dialed_at, campaign_id) WHERE dialed_at IS NOT
 * NULL`. The range predicate on `dialed_at` implies `IS NOT NULL`, so
 * the partial index qualifies, and `dialed_at` leading makes it a range scan
 * across every campaign. Tenant/account narrowing filters inside that range.
 *
 * ── Names ──────────────────────────────────────────────────────────────────
 * Joined from `tenants` / `accounts`. `agency_call_attempts` carries no FK to
 * either, so an attempt whose tenant or account row is gone is still COUNTED
 * (dropping it would make the totals disagree with the attempts table) and is
 * labelled with its id instead of a name.
 *
 * Each parameter is typed at its use (`$3::uuid` twice): an untyped parameter
 * used in two contexts is Postgres 42P08.
 */

export interface UsageCountsFilter {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
  tenantId?: string;
  accountId?: string;
}

export interface UsageCountsRow {
  tenant_id: string;
  tenant_name: string;
  account_id: string;
  account_name: string;
  dials: number;
  answered_calls: number;
  connected_calls: number;
  talk_seconds: number;
  analysis_audio_seconds: number;
  inbound_calls: number;
  inbound_answered_calls: number;
  inbound_connected_calls: number;
  inbound_seconds: number;
  inbound_hold_seconds: number;
  inbound_talk_seconds: number;
  inbound_analysis_audio_seconds: number;
}

interface RawUsageCountsRow {
  tenant_id: string;
  tenant_name: string;
  account_id: string;
  account_name: string;
  dials: string;
  answered_calls: string;
  connected_calls: string;
  talk_seconds: string;
  analysis_audio_seconds: string;
  inbound_calls: string;
  inbound_answered_calls: string;
  inbound_connected_calls: string;
  inbound_seconds: string;
  inbound_hold_seconds: string;
  inbound_talk_seconds: string;
  inbound_analysis_audio_seconds: string;
}

/**
 * pg returns `bigint` (COUNT, SUM of integers) as a string. The sums here are
 * seconds and counts, far below 2^53, so `Number` is exact; a value that is not
 * a safe integer would be a corrupt sum, and is refused rather than rounded.
 */
function exactCount(raw: string): number {
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`usage count ${raw} is not a safe integer`);
  }
  return n;
}

export class UsageCountsRepository {
  /** One row per (tenant, account) with any dial or inbound call in the window. */
  async countByAccount(filter: UsageCountsFilter): Promise<UsageCountsRow[]> {
    const pool = getPool();
    const result = await pool.query<RawUsageCountsRow>(
      `WITH dials AS (
         SELECT a.tenant_id, a.account_id, a.answered_at, a.bridged_at, a.talk_seconds, a.webrtc_call_id
           FROM agency_call_attempts a
          WHERE a.dialed_at >= $1::timestamptz
            AND a.dialed_at <  $2::timestamptz
            AND ($3::uuid IS NULL OR a.tenant_id  = $3::uuid)
            AND ($4::uuid IS NULL OR a.account_id = $4::uuid)
         UNION ALL
         -- Soft-phone dials, under the same window rule and filters (SP5).
         SELECT m.tenant_id, m.account_id, m.answered_at, m.bridged_at, m.talk_seconds, m.webrtc_call_id
           FROM agency_manual_calls m
          WHERE m.dialed_at >= $1::timestamptz
            AND m.dialed_at <  $2::timestamptz
            AND ($3::uuid IS NULL OR m.tenant_id  = $3::uuid)
            AND ($4::uuid IS NULL OR m.account_id = $4::uuid)
       ), dials_per_account AS (
         SELECT d.tenant_id,
                d.account_id,
                COUNT(*)                                          AS dials,
                COUNT(*) FILTER (WHERE d.answered_at IS NOT NULL) AS answered_calls,
                COUNT(*) FILTER (WHERE d.bridged_at  IS NOT NULL) AS connected_calls,
                COALESCE(SUM(d.talk_seconds), 0)                  AS talk_seconds,
                COALESCE(SUM(j.analysis_audio_seconds), 0)        AS analysis_audio_seconds
           FROM dials d
           LEFT JOIN dialer_analysis_jobs j ON j.call_id = d.webrtc_call_id
          GROUP BY d.tenant_id, d.account_id
       ), inbound_per_account AS (
         -- Inbound calls, apart: windowed on arrival under the same filters; only with an account.
         SELECT i.tenant_id,
                i.account_id,
                COUNT(*)                                          AS inbound_calls,
                COUNT(*) FILTER (WHERE i.answered_at IS NOT NULL) AS inbound_answered_calls,
                COUNT(*) FILTER (WHERE i.bridged_at  IS NOT NULL) AS inbound_connected_calls,
                ROUND(COALESCE(SUM(COALESCE(i.carrier_seconds::numeric, EXTRACT(EPOCH FROM (i.ended_at - i.answered_at))))
                  FILTER (WHERE i.answered_at IS NOT NULL AND i.ended_at IS NOT NULL), 0))::bigint AS inbound_seconds,
                ROUND(COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(i.bridged_at, i.ended_at) - i.queued_at)))
                  FILTER (WHERE i.queued_at IS NOT NULL AND i.ended_at IS NOT NULL), 0))::bigint AS inbound_hold_seconds,
                COALESCE(SUM(i.talk_seconds), 0)                  AS inbound_talk_seconds,
                COALESCE(SUM(j.analysis_audio_seconds), 0)        AS inbound_analysis_audio_seconds
           FROM agency_inbound_calls i
           LEFT JOIN dialer_analysis_jobs j ON j.call_id = i.webrtc_call_id
          WHERE i.arrived_at >= $1::timestamptz
            AND i.arrived_at <  $2::timestamptz
            AND i.account_id IS NOT NULL
            AND ($3::uuid IS NULL OR i.tenant_id  = $3::uuid)
            AND ($4::uuid IS NULL OR i.account_id = $4::uuid)
          GROUP BY i.tenant_id, i.account_id
       ), per_account AS (
         SELECT COALESCE(d.tenant_id, n.tenant_id)            AS tenant_id,
                COALESCE(d.account_id, n.account_id)          AS account_id,
                COALESCE(d.dials, 0)                          AS dials,
                COALESCE(d.answered_calls, 0)                 AS answered_calls,
                COALESCE(d.connected_calls, 0)                AS connected_calls,
                COALESCE(d.talk_seconds, 0)                   AS talk_seconds,
                COALESCE(d.analysis_audio_seconds, 0)         AS analysis_audio_seconds,
                COALESCE(n.inbound_calls, 0)                  AS inbound_calls,
                COALESCE(n.inbound_answered_calls, 0)         AS inbound_answered_calls,
                COALESCE(n.inbound_connected_calls, 0)        AS inbound_connected_calls,
                COALESCE(n.inbound_seconds, 0)                AS inbound_seconds,
                COALESCE(n.inbound_hold_seconds, 0)           AS inbound_hold_seconds,
                COALESCE(n.inbound_talk_seconds, 0)           AS inbound_talk_seconds,
                COALESCE(n.inbound_analysis_audio_seconds, 0) AS inbound_analysis_audio_seconds
           FROM dials_per_account d
           FULL JOIN inbound_per_account n ON n.tenant_id = d.tenant_id AND n.account_id = d.account_id
       )
       SELECT p.tenant_id,
              COALESCE(t.name, p.tenant_id::text)   AS tenant_name,
              p.account_id,
              COALESCE(ac.name, p.account_id::text) AS account_name,
              p.dials::text,
              p.answered_calls::text,
              p.connected_calls::text,
              p.talk_seconds::text,
              p.analysis_audio_seconds::text,
              p.inbound_calls::text,
              p.inbound_answered_calls::text,
              p.inbound_connected_calls::text,
              p.inbound_seconds::text,
              p.inbound_hold_seconds::text,
              p.inbound_talk_seconds::text,
              p.inbound_analysis_audio_seconds::text
         FROM per_account p
         LEFT JOIN tenants  t  ON t.id  = p.tenant_id
         LEFT JOIN accounts ac ON ac.id = p.account_id
        ORDER BY tenant_name, p.tenant_id, account_name, p.account_id`,
      [filter.from, filter.to, filter.tenantId ?? null, filter.accountId ?? null],
    );
    return result.rows.map((row) => ({
      tenant_id: row.tenant_id,
      tenant_name: row.tenant_name,
      account_id: row.account_id,
      account_name: row.account_name,
      dials: exactCount(row.dials),
      answered_calls: exactCount(row.answered_calls),
      connected_calls: exactCount(row.connected_calls),
      talk_seconds: exactCount(row.talk_seconds),
      analysis_audio_seconds: exactCount(row.analysis_audio_seconds),
      inbound_calls: exactCount(row.inbound_calls),
      inbound_answered_calls: exactCount(row.inbound_answered_calls),
      inbound_connected_calls: exactCount(row.inbound_connected_calls),
      inbound_seconds: exactCount(row.inbound_seconds),
      inbound_hold_seconds: exactCount(row.inbound_hold_seconds),
      inbound_talk_seconds: exactCount(row.inbound_talk_seconds),
      inbound_analysis_audio_seconds: exactCount(row.inbound_analysis_audio_seconds),
    }));
  }
}

export const usageCountsRepository = new UsageCountsRepository();
