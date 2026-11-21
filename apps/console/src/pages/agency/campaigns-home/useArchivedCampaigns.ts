import { useCallback, useEffect, useRef, useState } from 'react';
import { useMountedRef } from '../../../hooks/useMountedRef';
import { useRefetchOnReturn } from '../../../hooks/useRefetchOnReturn';
import { listArchivedAgencyCampaignsPage } from '../../../api/agencyCampaigns';
import type { AgencyCampaign } from '../../../types/agency-campaign';

/** Rows per request; the server caps `limit` at 100. */
export const ARCHIVED_PAGE_SIZE = 100;

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
      const mine = (generation.current += 1);
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      try {
        const page = await listArchivedAgencyCampaignsPage(tenantId, accountId, 0, ARCHIVED_PAGE_SIZE);
        if (!mounted.current || generation.current !== mine) return;
        // A quiet re-read keeps the older pages already loaded after the first, as the Campaigns
        // page does: newly archived rows push older ones down, they do not remove them.
        setCampaigns((prev) => {
          if (!quiet || !prev || prev.length <= ARCHIVED_PAGE_SIZE) return page.campaigns;
          const ids = new Set(page.campaigns.map((c) => c.id));
          return [...page.campaigns, ...prev.filter((c) => !ids.has(c.id))];
        });
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
      const page = await listArchivedAgencyCampaignsPage(tenantId, accountId, campaigns.length, ARCHIVED_PAGE_SIZE);
      if (!mounted.current || generation.current !== mine) return;
      setCampaigns((prev) => {
        const have = new Set((prev ?? []).map((c) => c.id));
        return [...(prev ?? []), ...page.campaigns.filter((c) => !have.has(c.id))];
      });
      setTotal(page.total);
    } catch (err: unknown) {
      if (mounted.current) setMoreError(err instanceof Error ? err.message : 'Could not load more archived campaigns.');
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }, [tenantId, accountId, campaigns]);

  const removed = useCallback((id: string) => {
    setCampaigns((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
    setTotal((n) => Math.max(0, n - 1));
  }, []);

  return { campaigns, total, error, loading, loadingMore, moreError, load, loadMore, removed };
}

/**
 * How many campaigns the account has archived, for the Campaigns page's link to them: one
 * one-row read of the archived list, re-read on return. `null` until known, or when the read
 * failed (the link is then left out rather than showing a wrong count).
 */
export function useArchivedCount(tenantId: string | null, accountId: string | null): number | null {
  const [count, setCount] = useState<number | null>(null);
  const mounted = useMountedRef();
  const read = useCallback(async () => {
    if (!tenantId || !accountId) return;
    try {
      const page = await listArchivedAgencyCampaignsPage(tenantId, accountId, 0, 1);
      if (mounted.current) setCount(page.total);
    } catch {
      if (mounted.current) setCount(null);
    }
  }, [tenantId, accountId]);
  useEffect(() => {
    void read();
  }, [read]);
  useRefetchOnReturn(() => read());
  return count;
}
