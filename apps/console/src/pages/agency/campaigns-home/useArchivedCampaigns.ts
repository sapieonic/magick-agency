import { useCallback, useEffect, useRef, useState } from 'react';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { useMountedRef } from '../../../hooks/useMountedRef';
import { useRefetchOnReturn } from '../../../hooks/useRefetchOnReturn';
import { listArchivedAgencyCampaignsPage } from '../../../api/agencyCampaigns';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { appendNewById, mergeFirstPage, PAGE_SIZE, readPageAfter } from './useCampaignsHome';

/**
 * The Archived campaigns screen's list (AR3): the account's archived campaigns, newest archived
 * first, a page at a time, re-read on return to the tab. `removed` drops a row restored from this
 * screen at once, without a re-read: the restore's answer is the authority.
 */
export function useArchivedCampaigns(tenantId: string | null, accountId: string | null) {
  const [campaigns, setCampaigns] = useState<AgencyCampaign[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useMountedRef();

  /** `quiet` re-reads the first page in place, without the spinner (the return to the tab). */
  const load = useCallback(
    async (quiet = false) => {
      if (!tenantId || !accountId) return;
      // Only a full load starts a new generation, as on the Campaigns page: a quiet re-read (the
      // return to the tab) answers for the one on screen and must not orphan a full load or a
      // Show older that is still in flight.
      const mine = quiet ? generation.current : (generation.current += 1);
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      try {
        const page = await listArchivedAgencyCampaignsPage(tenantId, accountId, 0, PAGE_SIZE);
        if (!mounted.current || generation.current !== mine) return;
        // A quiet re-read keeps the older pages already loaded after the first, as the Campaigns
        // page does: newly archived rows push older ones down, they do not remove them.
        setCampaigns((prev) => (quiet ? mergeFirstPage(prev, page.campaigns) : page.campaigns));
        setTotal(page.total);
      } catch (err: unknown) {
        if (mounted.current && generation.current === mine && !quiet) {
          setError(err instanceof Error ? err.message : 'Could not load archived campaigns.');
        }
      } finally {
        if (mounted.current && generation.current === mine && !quiet) setLoading(false);
      }
    },
    [tenantId, accountId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useRefetchOnReturn(() => load(true));

  const loadMore = useCallback(async () => {
    if (!tenantId || !accountId || !campaigns) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await readPageAfter(
        (offset) => listArchivedAgencyCampaignsPage(tenantId, accountId, offset, PAGE_SIZE),
        campaigns.length,
        total,
      );
      if (!mounted.current || generation.current !== mine) return;
      setCampaigns((prev) => appendNewById(prev, page.campaigns));
      setTotal(page.total);
    } catch (err: unknown) {
      if (mounted.current) setMoreError(err instanceof Error ? err.message : 'Could not load more archived campaigns.');
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }, [tenantId, accountId, campaigns, total]);

  /*
    A restore's answer is newer than any read already in flight (a quiet re-read the click's own
    focus started, say), so it starts a new generation: an older answer that still lists the row
    cannot put it back.
  */
  const removed = useCallback((id: string) => {
    generation.current += 1;
    setCampaigns((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
    setTotal((n) => Math.max(0, n - 1));
  }, []);

  return { campaigns, total, error, loading, loadingMore, moreError, load, loadMore, removed };
}

/**
 * How many campaigns the account has archived, for the Campaigns page's link to them: one
 * one-row read of the archived list, re-read on return. `undefined` until the first read answers,
 * `null` when it failed (the link is then left out rather than showing a wrong count); a failed
 * re-read keeps the count already shown.
 */
export function useArchivedCount(tenantId: string | null, accountId: string | null): number | null | undefined {
  const read = useCallback(async (): Promise<number | undefined> => {
    if (!tenantId || !accountId) return undefined;
    return (await listArchivedAgencyCampaignsPage(tenantId, accountId, 0, 1)).total;
  }, [tenantId, accountId]);
  const { data, error, reload } = useAsyncResource(read, {
    initialData: undefined,
    enabled: Boolean(tenantId && accountId),
  });
  useRefetchOnReturn(() => reload());
  return data ?? (error ? null : undefined);
}
