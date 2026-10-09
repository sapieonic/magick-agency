import { getPool } from '../connection.js';

/**
 * NEW (magick-agency, plan §3.3): the read behind the super-admin usage-counts
 * view (`GET /super-admin/usage`, contract `UsageCountsQuery` /
 * `UsageCountsResponse` in `@magick-agency/contracts/api/platform/super-admin-usage`).
 *
 * Read-only and charges nothing. It counts facts agency already records:
 *
 *  - `dials` — `agency_call_attempts` with `dialed_at` in the window;
 *  - `answered_calls` — those with `answered_at IS NOT NULL`;
 *  - `connected_calls` — those with `bridged_at IS NOT NULL`;
 *  - `talk_seconds` — Σ `talk_seconds` over those attempts;
 *  - `analysis_audio_seconds` — Σ `dialer_analysis_jobs.analysis_audio_seconds`
 *    for the jobs on those attempts' calls.
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
 * NULL` (core 081). The range predicate on `dialed_at` implies `IS NOT NULL`, so
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
      `WITH per_account AS (
         SELECT a.tenant_id,
                a.account_id,
                COUNT(*)                                          AS dials,
                COUNT(*) FILTER (WHERE a.answered_at IS NOT NULL) AS answered_calls,
                COUNT(*) FILTER (WHERE a.bridged_at  IS NOT NULL) AS connected_calls,
                COALESCE(SUM(a.talk_seconds), 0)                  AS talk_seconds,
                COALESCE(SUM(j.analysis_audio_seconds), 0)        AS analysis_audio_seconds
           FROM agency_call_attempts a
           LEFT JOIN dialer_analysis_jobs j ON j.call_id = a.webrtc_call_id
          WHERE a.dialed_at >= $1::timestamptz
            AND a.dialed_at <  $2::timestamptz
            AND ($3::uuid IS NULL OR a.tenant_id  = $3::uuid)
            AND ($4::uuid IS NULL OR a.account_id = $4::uuid)
          GROUP BY a.tenant_id, a.account_id
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
