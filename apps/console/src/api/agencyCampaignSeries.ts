import { ENDPOINTS } from '../config';
import { apiFetch } from './client';
import type { AgencyCampaignSeries } from '../types/agency-campaign-series';
import type { AgencyStatsBucketWidth } from '../types/agency-stats';

/**
 * One campaign's numbers over time, through master's `/proxy/agency`.
 *
 * ── The window is HALF-OPEN `[from, to)` ───────────────────────────────────
 * The same convention as `/agency/my-stats`, and deliberately **not** the
 * inclusive `to` the attempt LIST uses (`agencyAttemptFilters.ts` states both
 * and why). This is a stats read: its rows are filtered on when a call was
 * placed, so an inclusive end would count a call from the following day into
 * the last bucket, and the buckets would stop summing to the totals — which is
 * the one property this whole series can be checked against.
 *
 * Both conventions are correct on their own surface and neither is to be
 * "unified". The range builder that feeds this (`campaignSeriesRange`) is the
 * only place that decides an instant, and it derives the exclusive end rather
 * than writing `T23:59:59.999` — a literal that is ambiguous wherever the
 * clocks go back at midnight.
 *
 * ── `agency.supervise`, and the caller must have checked ───────────────────
 * Master floors this route exactly there. Every affordance that reaches it is
 * already inside a section gated on `agency.supervise` (`CAMPAIGN_TABS`), so
 * there is no second check here — but a new call site that is not must add one,
 * for the reason `getAgentStats` states: a panel whose first read 403s is worse
 * than a panel that was never offered.
 *
 * **`accountId` is not optional in practice.** `apiFetch` sends `X-Account-Id`
 * only when the fourth argument is present, and core answers a missing one with
 * `400 Missing required header: x-mgkvc-account` — an error with nothing in it
 * pointing back here. See the longer note in `agencyCampaigns.ts`.
 */

export interface AgencyCampaignSeriesQuery {
  /** ISO-8601 instant. **Inclusive** start. */
  from: string;
  /** ISO-8601 instant. **Exclusive** end — see the module note. */
  to: string;
  bucket: AgencyStatsBucketWidth;
}

export async function getAgencyCampaignSeries(
  campaignId: string,
  query: AgencyCampaignSeriesQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaignSeries> {
  const qs = new URLSearchParams({ from: query.from, to: query.to, bucket: query.bucket });
  return apiFetch<AgencyCampaignSeries>(
    `${ENDPOINTS.proxy.agency.campaignStatsSeries(campaignId)}?${qs.toString()}`,
    {},
    tenantId,
    accountId,
  );
}
