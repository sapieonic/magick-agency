import { ENDPOINTS } from '../config';
import { apiFetch } from './client';
import type {
  AgencyInsightsActivity,
  AgencyInsightsAllocation,
  AgencyInsightsBucket,
  AgencyInsightsHealth,
  AgencyInsightsReadiness,
  AgencyInsightsSummary,
  AgencyInsightsTrends,
  AgencyInsightsUploads,
} from '../types/agency-insights';

/**
 * The campaign Insights tab's reads, one function per section of
 * `GET /proxy/agency/campaigns/:id/insights/*` (the contract's header lists them).
 *
 * ── Ranges are half-open `[from, to)` instants, and absent means lifetime ──
 * The same convention as `/agency/my-stats`: a stats read filtered on when a
 * call was placed, so an exclusive end keeps the buckets summing to the totals
 * (and deliberately not the inclusive `to` the attempt LIST uses;
 * `agencyAttemptFilters.ts` states both and why). `insightsRangeQuery` (`utils/agency/insights/range.ts`) is the only
 * place that turns the page's chosen range into those instants. A lifetime range
 * sends neither key, which the server reads as "first dial to now".
 *
 * ── `agency.supervise`, and the caller has checked ─────────────────────────
 * Every read is floored there on the server. The only caller is the Insights
 * tab, which `CAMPAIGN_TABS` gates on the same permission, so there is no second
 * check here: a section whose first read 403s is worse than one never offered.
 *
 * `accountId` is not optional in practice: `apiFetch` sends `X-Account-Id` only
 * when it is passed, and the server answers a missing one with a 400 about a
 * header this client never sent (the longer note is in `agencyCampaigns.ts`).
 */

/** `[from, to)` as ISO-8601 instants; both absent for a lifetime read. */
export interface AgencyInsightsRangeQuery {
  from?: string;
  to?: string;
}

function rangeQs(range: AgencyInsightsRangeQuery, extra: Record<string, string> = {}): string {
  const qs = new URLSearchParams();
  if (range.from) qs.set('from', range.from);
  if (range.to) qs.set('to', range.to);
  for (const [key, value] of Object.entries(extra)) qs.set(key, value);
  const text = qs.toString();
  return text ? `?${text}` : '';
}

function read<T>(campaignId: string, section: string, qs: string, tenantId?: string, accountId?: string): Promise<T> {
  return apiFetch<T>(`${ENDPOINTS.proxy.agency.campaignInsights(campaignId, section)}${qs}`, {}, tenantId, accountId);
}

/** Header, settings, the status headline and the roster buckets, as of now. Polled. */
export function getInsightsSummary(campaignId: string, tenantId?: string, accountId?: string): Promise<AgencyInsightsSummary> {
  return read(campaignId, 'summary', '', tenantId, accountId);
}

/** The draft "Ready to launch?" checklist. */
export function getInsightsReadiness(campaignId: string, tenantId?: string, accountId?: string): Promise<AgencyInsightsReadiness> {
  return read(campaignId, 'readiness', '', tenantId, accountId);
}

/** The per-agent allocation table, as of now. Polled with the summary. */
export function getInsightsAllocation(campaignId: string, tenantId?: string, accountId?: string): Promise<AgencyInsightsAllocation> {
  return read(campaignId, 'allocation', '', tenantId, accountId);
}

/** Calls, outcomes, callbacks, overrides and per-agent activity over a range. */
export function getInsightsActivity(
  campaignId: string,
  range: AgencyInsightsRangeQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyInsightsActivity> {
  return read(campaignId, 'activity', rangeQs(range), tenantId, accountId);
}

/** The series by bucket, and the best hours of day, over a range. */
export function getInsightsTrends(
  campaignId: string,
  range: AgencyInsightsRangeQuery,
  bucket: AgencyInsightsBucket,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyInsightsTrends> {
  return read(campaignId, 'trends', rangeQs(range, { bucket }), tenantId, accountId);
}

/** Abandonment, pre-dial blocks, caller IDs, pacing history and recording, over a range. */
export function getInsightsHealth(
  campaignId: string,
  range: AgencyInsightsRangeQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyInsightsHealth> {
  return read(campaignId, 'health', rangeQs(range), tenantId, accountId);
}

/** The roster upload history, newest first. */
export function getInsightsUploads(campaignId: string, tenantId?: string, accountId?: string): Promise<AgencyInsightsUploads> {
  return read(campaignId, 'uploads', '', tenantId, accountId);
}
