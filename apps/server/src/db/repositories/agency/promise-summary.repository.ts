/**
 * `AgencyPromiseSummaryRepository`: the promises to pay (PT1–PT14) recorded in an account over a
 * window, per campaign (the Live floor's "Will pay", decision B28b; the wire is
 * `packages/contracts/src/api/agency/promises.ts`).
 *
 * A promise lives on the call it was recorded with (0041): a dialler attempt
 * (`agency_call_attempts`, written by `recordDisposition`), a soft-phone call
 * (`agency_manual_calls`, the soft phone's outcome write) or an inbound call
 * (`agency_inbound_calls`, the inbound outcome write). Every one of those writes stamps
 * `dispositioned_at = now()` in the statement that sets `promise_date`, so "recorded in the window"
 * is `dispositioned_at` in `[from, to)` with a `promise_date`. A same-code replay that corrects the
 * promise re-stamps it (last-write-wins, PT1). The contact's denormalised latest promise (PT6) is
 * not read: it keeps one promise per contact, and the summary counts every promise.
 *
 * The amount is summed as `NUMERIC` and turned into text in SQL (its exact decimal, never a
 * float), and each table is read on its 0050 index (`idx_*_promise_written`: tenant, account,
 * `dispositioned_at`, only the rows with a promise), so the read is the size of the window's
 * promises (`test/integration/agency/promise-summary-repository.test.ts` pins the plans).
 */
import { getPool } from '@magick-agency/db';
import { AGENCY_HOME_ACTIVE_STATUSES } from '@magick-agency/contracts/api/agency/home';

/** One campaign's promises in a window, as the summary serves it. */
export interface AgencyPromiseSummaryRow {
  campaign_id: string | null;
  promises: number;
  with_amount: number;
  /** Exact, two places (`"240000.00"`). */
  amount_total: string;
}

/** $1 tenant, $2 account, $3 from (inclusive), $4 to (exclusive). Exported for its plan test. */
export const PROMISE_SUMMARY_SQL = `
  WITH promised AS (
    SELECT a.campaign_id, a.promise_amount
      FROM agency_call_attempts a
     WHERE a.tenant_id = $1::uuid AND a.account_id = $2::uuid AND a.promise_date IS NOT NULL
       AND a.dispositioned_at >= $3::timestamptz AND a.dispositioned_at < $4::timestamptz
    UNION ALL
    SELECT m.campaign_id, m.promise_amount
      FROM agency_manual_calls m
     WHERE m.tenant_id = $1::uuid AND m.account_id = $2::uuid AND m.promise_date IS NOT NULL
       AND m.dispositioned_at >= $3::timestamptz AND m.dispositioned_at < $4::timestamptz
    UNION ALL
    SELECT i.matched_campaign_id, i.promise_amount
      FROM agency_inbound_calls i
     WHERE i.tenant_id = $1::uuid AND i.account_id = $2::uuid AND i.promise_date IS NOT NULL
       AND i.dispositioned_at >= $3::timestamptz AND i.dispositioned_at < $4::timestamptz
  )
  SELECT p.campaign_id,
         COUNT(*)::text AS promises,
         COUNT(p.promise_amount)::text AS with_amount,
         -- NUMERIC(14,2) summed as NUMERIC: exact, any size. round(…, 2) fixes the scale at two
         -- places (an empty sum's 0 reads "0.00"); NUMERIC's text form is its exact decimal.
         round(COALESCE(SUM(p.promise_amount), 0::numeric), 2)::text AS amount_total
    FROM promised p
   GROUP BY p.campaign_id
   ORDER BY p.campaign_id NULLS LAST`;

/**
 * The account's active campaigns whose stored outcome catalog has an entry with
 * `requires_promise: true` ($1 tenant, $2 account, $3 the active statuses: Home's, {@link AGENCY_HOME_ACTIVE_STATUSES}). An empty catalog means
 * the default one, which has none. Only a campaign's catalog can ask for a promise: the soft
 * phone's and an inbound route's refuse `requires_promise` when saved (`allowPromise: false`), and
 * a call outside a campaign resolves to one of those or the default, so no other catalog is read.
 * Tested through {@link AgencyPromiseSummaryRepository.promiseCampaignIds}.
 */
const PROMISE_CAMPAIGNS_SQL = `
  SELECT c.id
    FROM agency_campaigns c
   WHERE c.tenant_id = $1::uuid AND c.account_id = $2::uuid AND c.status = ANY($3::text[])
     AND jsonb_typeof(c.disposition_catalog) = 'array'
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(c.disposition_catalog) e
        WHERE jsonb_typeof(e) = 'object' AND e -> 'requires_promise' = 'true'::jsonb)
   ORDER BY c.id`;

export class AgencyPromiseSummaryRepository {
  /** Per campaign (and one row for no campaign), the promises recorded in `[from, to)`; campaigns without any are absent. */
  async summary(tenantId: string, accountId: string, from: Date, to: Date): Promise<AgencyPromiseSummaryRow[]> {
    const { rows } = await getPool().query<{ campaign_id: string | null; promises: string; with_amount: string; amount_total: string }>(
      PROMISE_SUMMARY_SQL, [tenantId, accountId, from, to],
    );
    return rows.map((r) => ({
      campaign_id: r.campaign_id,
      promises: Number(r.promises),
      with_amount: Number(r.with_amount),
      amount_total: r.amount_total,
    }));
  }

  /** The account's active campaigns (Home's set: running, stopping, paused) whose catalog asks for a promise, by id. */
  async promiseCampaignIds(tenantId: string, accountId: string): Promise<string[]> {
    const { rows } = await getPool().query<{ id: string }>(PROMISE_CAMPAIGNS_SQL, [tenantId, accountId, [...AGENCY_HOME_ACTIVE_STATUSES]]);
    return rows.map((r) => r.id);
  }
}

export const agencyPromiseSummaryRepository = new AgencyPromiseSummaryRepository();
