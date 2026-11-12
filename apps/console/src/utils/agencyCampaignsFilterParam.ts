import type { CampaignFilter } from './agencyCampaignsHome';

/**
 * The campaigns home keeps its filter in the URL (`?status=draft`, absent for All), so a reload
 * and Back from a campaign keep the group the reader was looking at. Its own module: the
 * stats-consumer guard (`agencyStatsConsumers.ts`) reads `agencyCampaignsHome.ts` for quoted
 * payload keys, and this parameter's name is one.
 */
const CAMPAIGN_FILTER_PARAM = 'status';
const NARROWING_FILTERS: readonly CampaignFilter[] = ['active', 'draft', 'finished'];

/** The filter the URL names; anything else, or nothing, is All. */
export function campaignFilterFromParams(params: URLSearchParams): CampaignFilter {
  const value = params.get(CAMPAIGN_FILTER_PARAM);
  return NARROWING_FILTERS.find((f) => f === value) ?? 'all';
}

/** `params` with the filter set to `next`, every other key kept. */
export function withCampaignFilter(params: URLSearchParams, next: CampaignFilter): URLSearchParams {
  const updated = new URLSearchParams(params);
  if (next === 'all') updated.delete(CAMPAIGN_FILTER_PARAM);
  else updated.set(CAMPAIGN_FILTER_PARAM, next);
  return updated;
}
