import { useCallback, useEffect, useState } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { getIngestJob } from '../api/agencyCampaigns';
import { getInsightsUploads } from '../api/agencyInsights';
import { getCampaignContact, getCampaignContacts } from '../api/agencySpine';

/** The most imports whose columns are read: the newest, which name what agents see now. */
const CAMPAIGN_COLUMNS_IMPORTS_MAX = 3;

/** A campaign's customer list's columns, as {@link useCampaignColumns} reads them. */
export interface CampaignColumns {
  /** Every column the newest imports kept, each once (ignoring case), newest import first. */
  columns: string[];
  /**
   * The newest import's columns only (AS19 S9): "the latest upload" a fact is added from and a
   * fact's column is checked against. Empty with no upload.
   */
  latest: string[];
  loading: boolean;
  /** The read failed: nothing is known (not "no upload"); {@link CampaignColumns.reload} tries again. */
  failed: boolean;
  /** Read, and not failed: `columns` and `latest` are what the customer list has (empty: no upload). */
  ready: boolean;
  /** Read again (after a failure). */
  reload: () => void;
}

/** The two lists the read gives. */
interface ColumnsRead {
  columns: string[];
  latest: string[];
}

const NONE: ColumnsRead = { columns: [], latest: [] };

/**
 * The roster columns a campaign's customer list has (agent station BE-6), for campaign Settings'
 * customer-facts pickers: each column its newest completed imports kept
 * (`AgencyIngestJob.context_columns`), the campaign's own and, for a retry campaign, its lineage
 * root's, as the server's write checks them. Each name once, newest import first. Beside them the
 * newest import's own (`latest`), which alone is "the latest upload" (S9).
 *
 * Read from the upload history (`GET …/insights/uploads`, `agency.supervise`) and then each of the
 * newest {@link CAMPAIGN_COLUMNS_IMPORTS_MAX} imports. Read only once: the caller enables it only
 * once the campaign is loaded (so a retry campaign's one read already names its root), and an
 * absent root (`undefined`, not loaded) and no root (`null`) are the same read, so the campaign
 * arriving never reads it all again. A failure is said (`failed`, S9), never read as no upload: a
 * card on the old model is opened from these columns and cannot be until they are read; `reload`
 * tries again. An older import's job that cannot be read is left out; the newest one's failing is
 * a failure. Disabled, it is not loading (`useAsyncResource`).
 */
export function useCampaignColumns(
  campaignId: string | undefined,
  rootCampaignId: string | null | undefined,
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
  enabled: boolean,
): CampaignColumns {
  // One value for "no other root", whatever shape the campaign gave it: a new fetcher is a new read.
  const root = rootCampaignId && rootCampaignId !== campaignId ? rootCampaignId : null;
  const fetcher = useCallback(async (): Promise<ColumnsRead> => {
    if (!campaignId || !tenantId || !accountId) return NONE;
    const lineage = root ? [campaignId, root] : [campaignId];
    const pages = await Promise.all(lineage.map((id) => getInsightsUploads(id, tenantId, accountId)));
    const done = pages
      .flatMap((page) => page.uploads)
      .filter((upload) => upload.status === 'completed')
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, CAMPAIGN_COLUMNS_IMPORTS_MAX);
    const jobs = await Promise.all(done.map((upload, i) => {
      const read = getIngestJob(upload.job_id, tenantId, accountId);
      return i === 0 ? read : read.catch(() => null);
    }));
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
    const latest = (jobs[0]?.context_columns ?? []).filter((c) => c.trim() !== '');
    return { columns, latest };
  }, [campaignId, root, tenantId, accountId]);
  const on = enabled && Boolean(campaignId && tenantId && accountId);
  const { data, loading, error, reload } = useAsyncResource(fetcher, { initialData: NONE, enabled: on });
  const failed = on && !loading && error !== null;
  const retry = useCallback(() => { void reload(); }, [reload]);
  return {
    columns: failed ? [] : data.columns,
    latest: failed ? [] : data.latest,
    loading,
    failed,
    // `loading` is true from the first render the read is on, so "on and not loading" is "read".
    ready: on && !loading && !failed,
    reload: retry,
  };
}

/** The most customers campaign Settings reads as samples. */
export const CAMPAIGN_SAMPLE_ROWS_MAX = 3;

/**
 * A few of the campaign's customers' uploaded columns (`AgencyContactDetail.context`), for campaign
 * Settings' samples (AS19): the value beside each column in the add-fact picker, and the script's
 * "As the agent reads it" preview. The first {@link CAMPAIGN_SAMPLE_ROWS_MAX} contacts of the
 * roster list, then each one's detail (the list carries no columns). Read once, by an editor, as
 * {@link useCampaignColumns}. A failure is no samples (the picker then shows none, and the preview
 * says each value is not given), never an error on the page.
 *
 * Cancelled when the page goes (AS19 R12), or the campaign or the scope changes: the API client
 * takes no signal, so an abort controller stands as the read's ignore flag. Once it is aborted no
 * contact's detail is read and nothing is written.
 */
export function useCampaignSampleRows(
  campaignId: string | undefined,
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
  enabled: boolean,
): Array<Record<string, unknown>> {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const on = enabled && Boolean(campaignId && tenantId && accountId);
  useEffect(() => {
    if (!on || !campaignId || !tenantId || !accountId) {
      setRows((prev) => (prev.length === 0 ? prev : []));
      return undefined;
    }
    const read = new AbortController();
    const { signal } = read;
    void (async () => {
      try {
        const page = await getCampaignContacts(campaignId, {}, { limit: CAMPAIGN_SAMPLE_ROWS_MAX }, tenantId, accountId);
        if (signal.aborted) return;
        const details = await Promise.all(
          page.rows.slice(0, CAMPAIGN_SAMPLE_ROWS_MAX).map((row) =>
            getCampaignContact(campaignId, row.id, tenantId, accountId).catch(() => null)),
        );
        if (signal.aborted) return;
        setRows(details.flatMap((detail) => (detail && detail.context && typeof detail.context === 'object' ? [detail.context] : [])));
      } catch {
        if (!signal.aborted) setRows([]);
      }
    })();
    return () => read.abort();
  }, [on, campaignId, tenantId, accountId]);
  return rows;
}
