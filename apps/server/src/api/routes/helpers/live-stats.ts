/**
 * The summary's stats strip read (`computeSummary`'s `liveStats`), shared by the summary route
 * (`api/routes/proxy-agency-insights/as-of-now.ts`) and the campaign report's builder
 * (`agency/reports/datasets/campaign.ts`), so the report's headline is the route's own read.
 * A `callCore` caller, so it stays in the public API layer (B16) beside `core-campaign.ts`,
 * the other internal-handler hop the reports builders share with the routes.
 */
import type { AgencyCampaignStats } from '@magick-agency/contracts/agency';
import { callCore } from '../../core-dispatch.js';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';

/**
 * The stats strip's payload, through the internal handler that serves it, under the campaign's
 * own (proved) account. Null when it refuses (the summary then reports what it can read itself).
 */
export async function liveStats(campaign: AgencyCampaignRecord): Promise<Partial<AgencyCampaignStats> | null> {
  const result = await callCore({
    method: 'GET',
    path: `/agency-campaigns/${campaign.id}/stats`,
    tenantId: campaign.tenant_id,
    accountId: campaign.account_id,
  });
  return result.status < 400 && result.body && typeof result.body === 'object'
    ? result.body as Partial<AgencyCampaignStats>
    : null;
}
