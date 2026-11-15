/**
 * The stats strip read through the internal handler: `liveStats` for the summary's strip
 * (`computeSummary`'s `liveStats`), shared by the summary route
 * (`api/routes/proxy-agency-insights/as-of-now.ts`) and the campaign report's builder
 * (`agency/reports/datasets/campaign.ts`), so the report's headline is the route's own read; and
 * `liveStatsRead` for Home's board (`proxy-agency-insights/home.ts`), which needs to know whether
 * the answer was read for it and may read past the shared read (`agency/campaign-stats-reads.ts`).
 * A `callCore` caller, so it stays in the public API layer (B16) beside `core-campaign.ts`,
 * the other internal-handler hop the reports builders share with the routes.
 */
import type { AgencyCampaignStats } from '@magick-agency/contracts/agency';
import { callCore } from '../../core-dispatch.js';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import { CAMPAIGN_STATS_FRESH_HEADER, CAMPAIGN_STATS_READ_HEADER } from '../../../agency/campaign-stats-reads.js';

/** A stats payload, and whether its SQL half was a read another request began (one that may predate this call). */
export interface LiveStatsRead {
  stats: Partial<AgencyCampaignStats>;
  shared: boolean;
}

/**
 * The stats strip's payload, through the internal handler that serves it, under the campaign's
 * own (proved) account; with `fresh`, read past the campaign's shared read. Null when it refuses.
 * `shared` unless the handler says the read ran for this call: an answer that does not say is
 * treated as one that may be older.
 */
export async function liveStatsRead(
  campaign: AgencyCampaignRecord,
  opts: { fresh?: boolean } = {},
): Promise<LiveStatsRead | null> {
  const result = await callCore({
    method: 'GET',
    path: `/agency-campaigns/${campaign.id}/stats`,
    tenantId: campaign.tenant_id,
    accountId: campaign.account_id,
    ...(opts.fresh ? { headers: { [CAMPAIGN_STATS_FRESH_HEADER]: '1' } } : {}),
  });
  if (!(result.status < 400 && result.body && typeof result.body === 'object')) return null;
  return {
    stats: result.body as Partial<AgencyCampaignStats>,
    shared: result.headers.get(CAMPAIGN_STATS_READ_HEADER) !== 'scanned',
  };
}

/**
 * The stats strip's payload, through the internal handler that serves it, under the campaign's
 * own (proved) account. Null when it refuses (the summary then reports what it can read itself).
 */
export async function liveStats(campaign: AgencyCampaignRecord): Promise<Partial<AgencyCampaignStats> | null> {
  return (await liveStatsRead(campaign))?.stats ?? null;
}
