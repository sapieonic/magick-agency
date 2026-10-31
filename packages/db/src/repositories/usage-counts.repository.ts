import { getPool } from '../connection.js';

/**
 * The read behind the super-admin usage-counts
 * view (`GET /super-admin/usage`, contract `UsageCountsQuery` /
 * `UsageCountsResponse` in `@magick-agency/contracts/api/platform/super-admin-usage`).
 *
 * Read-only and charges nothing. It counts facts agency already records:
 *
 *  - `dials` — `agency_call_attempts` with `dialed_at` in the window, plus
 *    soft-phone dials (`agency_manual_calls`) the same way;
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
  /** One row per (tenant, account) with any dial in the window. */
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
       ), per_account AS (
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
       )
       SELECT p.tenant_id,
              COALESCE(t.name, p.tenant_id::text)   AS tenant_name,
              p.account_id,
              COALESCE(ac.name, p.account_id::text) AS account_name,
              p.dials::text,
              p.answered_calls::text,
              p.connected_calls::text,
              p.talk_seconds::text,
              p.analysis_audio_seconds::text
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
    }));
  }
}

export const usageCountsRepository = new UsageCountsRepository();
