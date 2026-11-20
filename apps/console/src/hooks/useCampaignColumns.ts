import { useCallback } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { getIngestJob } from '../api/agencyCampaigns';
import { getInsightsUploads } from '../api/agencyInsights';

/** The most imports whose columns are read: the newest, which name what agents see now. */
export const CAMPAIGN_COLUMNS_IMPORTS_MAX = 3;

/**
 * The roster columns a campaign's customer list has (agent station BE-6), for campaign Settings'
 * customer-facts pickers: each column its newest completed imports kept
 * (`AgencyIngestJob.context_columns`), the campaign's own and, for a retry campaign, its lineage
 * root's, as the server's write checks them. Each name once, newest import first.
 *
 * Read from the upload history (`GET …/insights/uploads`, `agency.supervise`) and then each of the
 * newest {@link CAMPAIGN_COLUMNS_IMPORTS_MAX} imports. Read only once; a failure is no columns
 * (the pickers then say to upload a list first), never an error on the page: the server still
 * checks every name a save sends, and lists the columns in its refusal.
 */
export function useCampaignColumns(
  campaignId: string | undefined,
  rootCampaignId: string | null | undefined,
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
  enabled: boolean,
): { columns: string[]; loading: boolean } {
  const fetcher = useCallback(async (): Promise<string[]> => {
    if (!campaignId || !tenantId || !accountId) return [];
    const lineage = rootCampaignId && rootCampaignId !== campaignId ? [campaignId, rootCampaignId] : [campaignId];
    try {
      const pages = await Promise.all(lineage.map((id) => getInsightsUploads(id, tenantId, accountId)));
      const done = pages
        .flatMap((page) => page.uploads)
        .filter((upload) => upload.status === 'completed')
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, CAMPAIGN_COLUMNS_IMPORTS_MAX);
      const jobs = await Promise.all(done.map((upload) => getIngestJob(upload.job_id, tenantId, accountId).catch(() => null)));
      const seen = new Set<string>();
      const columns: string[] = [];
      for (const job of jobs) {
        for (const column of job?.context_columns ?? []) {
          const key = column.trim().toLowerCase();
          if (key === '' || seen.has(key)) continue;
          seen.add(key);
          columns.push(column);
        }
      }
      return columns;
    } catch {
      return [];
    }
  }, [campaignId, rootCampaignId, tenantId, accountId]);
  const { data, loading } = useAsyncResource(fetcher, {
    initialData: [] as string[],
    enabled: enabled && Boolean(campaignId && tenantId && accountId),
  });
  return { columns: data, loading };
}
