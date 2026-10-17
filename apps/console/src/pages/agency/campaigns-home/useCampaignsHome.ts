import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMountedRef } from '../../../hooks/useMountedRef';
import { useRefetchOnReturn } from '../../../hooks/useRefetchOnReturn';
import { useVisibleInterval } from '../../../hooks/useVisibleInterval';
import {
  getAgencyCampaign,
  listAgencyCampaigns,
  listAgencyCampaignsPage,
  getAgencyCampaignStats,
} from '../../../api/agencyCampaigns';
import { mapWithConcurrency } from '@magick-agency/web-ui/concurrency';
import { campaignGroup, needsPolling, sortCampaigns } from '../../../utils/agencyCampaignsHome';
import type { AgencyCampaign, AgencyCampaignStats } from '../../../types/agency-campaign';

/** The cards' refresh, matching the campaign detail page's own poll. */
const REFRESH_MS = 10_000;

/** Rows per request; the server caps `limit` at 100. */
export const PAGE_SIZE = 100;

/** Every started-and-not-finished status: the ones read in full, however old. */
const ACTIVE_STATUSES = ['running', 'stopping', 'paused'];

export type StatsState =
  | { status: 'loading' }
  | { status: 'ready'; stats: AgencyCampaignStats }
  | { status: 'error' };

export function readyStats(state: StatsState | undefined): AgencyCampaignStats | null {
  return state?.status === 'ready' ? state.stats : null;
}

/**
 * A poll's first page laid over the history already on screen.
 *
 * Without older pages loaded, the first page simply replaces it. With them,
 * rows the poll did not return are kept after it: a campaign created since
 * pushes the last row of page one onto page two, and dropping it would make a
 * campaign disappear for no reason the supervisor can see.
 *
 * That reasoning rests on campaigns never being deleted (there is no delete
 * route), so a row missing from page one has moved down, not gone. It is also
 * why the history's length is a safe offset for the next page: inserts only
 * push rows down, so a later page can repeat a row already held (dropped by id)
 * but never skip one.
 */
function mergeFirstPage(prev: AgencyCampaign[] | null, page: AgencyCampaign[]): AgencyCampaign[] {
  if (!prev || prev.length <= PAGE_SIZE) return page;
  const ids = new Set(page.map((c) => c.id));
  return [...page, ...prev.filter((c) => !ids.has(c.id))];
}

/**
 * The history with every active campaign in it. An active campaign's row from
 * the active read replaces its history row, and one older than the loaded
 * pages is added, so the cards, the Active tab and the list all agree.
 */
function withActive(history: AgencyCampaign[], live: AgencyCampaign[]): AgencyCampaign[] {
  const byId = new Map(live.map((c) => [c.id, c]));
  const merged = history.map((c) => byId.get(c.id) ?? c);
  const held = new Set(history.map((c) => c.id));
  return [...merged, ...live.filter((c) => !held.has(c.id))];
}

export function isActive(c: AgencyCampaign): boolean {
  return campaignGroup(c.status) === 'active';
}

/**
 * The campaigns home's data: the paged history, every active campaign read in
 * full, the active cards' `/stats`, the visible-only poll while anything is
 * moving and the re-read on return. Out of `AgencyCampaignsPage`, which keeps the
 * filter, the search and the layout.
 *
 * ⚠️ One `/stats` request per active campaign per tick (`fetchStats`). Folding
 * them into one call needs a batch read the contract does not have yet.
 */
export function useCampaignsHome(tenantId: string | null, accountId: string | null) {
  /** The paged history, newest first. Its length is the next page's offset. */
  const [history, setHistory] = useState<AgencyCampaign[] | null>(null);
  /** Every active campaign, whatever page its history row is on. */
  const [live, setLive] = useState<AgencyCampaign[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, StatsState>>({});

  const historyRef = useRef(history);
  historyRef.current = history;
  const generation = useRef(0);
  /** Per campaign, the newest stats request. An older answer arriving later is dropped. */
  const statsSeq = useRef(new Map<string, number>());
  const statsRef = useRef(stats);
  statsRef.current = stats;
  const mounted = useMountedRef();

  /** `quiet` is the poll: it refreshes in place, without the spinner or a cleared error. */
  const load = useCallback(
    async (quiet = false) => {
      if (!tenantId || !accountId) return;
      // Only a full load starts a new generation. A poll answers for the one
      // already on screen, and must not orphan a retry that is still in flight.
      const mine = quiet ? generation.current : (generation.current += 1);
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      try {
        const page = await listAgencyCampaignsPage(tenantId, accountId, 0, PAGE_SIZE);
        // When the first page is the whole account, its active rows are all of
        // them. Otherwise they are read in full. Filtered here as well, so a
        // server that ignored `status` could not put a draft on a card.
        const liveRows = (
          page.total > page.campaigns.length
            ? await listAgencyCampaigns(tenantId, accountId, ACTIVE_STATUSES)
            : page.campaigns
        ).filter(isActive);
        // Only page one is re-read on a poll. A row on an older loaded page that
        // still says active, but is missing from the complete active read, has
        // finished since: re-read it, so it shows how it ended rather than a
        // stale Paused. Usually there are none, and so no requests.
        const liveIds = new Set(liveRows.map((c) => c.id));
        const firstIds = new Set(page.campaigns.map((c) => c.id));
        const stale = quiet
          ? (historyRef.current ?? []).filter((c) => isActive(c) && !liveIds.has(c.id) && !firstIds.has(c.id))
          : [];
        const reread = await mapWithConcurrency(stale, (c) => getAgencyCampaign(c.id, tenantId, accountId));
        const ended = new Map(
          reread.flatMap((o) => (o.status === 'fulfilled' ? [[o.value.id, o.value] as const] : [])),
        );
        if (!mounted.current || generation.current !== mine) return;
        setHistory((prev) => {
          const next = quiet ? mergeFirstPage(prev, page.campaigns) : page.campaigns;
          return ended.size > 0 ? next.map((c) => ended.get(c.id) ?? c) : next;
        });
        setLive(liveRows);
        setTotal(page.total);
      } catch (err: unknown) {
        // A failed poll keeps the list already on screen; only a full load has
        // nothing better to show than the error.
        if (mounted.current && generation.current === mine && !quiet) {
          setError(err instanceof Error ? err.message : 'Could not load campaigns.');
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

  const loadMore = useCallback(async () => {
    if (!tenantId || !accountId || !history) return;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreError(null);
    try {
      // The history's own length, never the merged list's: active campaigns
      // added from the active read were not served by these pages, and counting
      // them would skip as many rows.
      const page = await listAgencyCampaignsPage(tenantId, accountId, history.length, PAGE_SIZE);
      if (!mounted.current || generation.current !== mine) return;
      setHistory((prev) => {
        const have = new Set((prev ?? []).map((c) => c.id));
        return [...(prev ?? []), ...page.campaigns.filter((c) => !have.has(c.id))];
      });
      setTotal(page.total);
    } catch (err: unknown) {
      if (mounted.current) setMoreError(err instanceof Error ? err.message : 'Could not load more campaigns.');
    } finally {
      if (mounted.current) setLoadingMore(false);
    }
  }, [tenantId, accountId, history]);

  const campaigns = useMemo(() => (history ? withActive(history, live) : null), [history, live]);
  const sorted = useMemo(() => (campaigns ? sortCampaigns(campaigns) : []), [campaigns]);
  const active = useMemo(() => sorted.filter(isActive), [sorted]);
  const activeIds = useRef<Set<string>>(new Set());
  activeIds.current = new Set(active.map((c) => c.id));

  /**
   * Read `/stats` for the given campaigns and merge the answers in.
   *
   * Merged per campaign rather than rebuilt, and guarded per campaign by
   * `statsSeq`, so a slow answer can neither overwrite a newer one nor wipe the
   * entries of campaigns it was not asked about. A failed refresh keeps the last
   * good numbers rather than blanking a card the supervisor is reading.
   */
  const fetchStats = useCallback(
    async (ids: string[]) => {
      if (!tenantId || !accountId || ids.length === 0) return;
      const tickets = ids.map((id) => {
        const next = (statsSeq.current.get(id) ?? 0) + 1;
        statsSeq.current.set(id, next);
        return next;
      });
      const settled = await mapWithConcurrency(ids, (id) =>
        getAgencyCampaignStats(id, tenantId, accountId),
      );
      if (!mounted.current) return;
      setStats((prev) => {
        const next: Record<string, StatsState> = {};
        // Campaigns that have left the active set have no card; drop their entries.
        for (const [id, state] of Object.entries(prev)) {
          if (activeIds.current.has(id)) next[id] = state;
        }
        ids.forEach((id, i) => {
          if (!activeIds.current.has(id) || statsSeq.current.get(id) !== tickets[i]) return;
          const outcome = settled[i]!;
          if (outcome.status === 'fulfilled') {
            next[id] = { status: 'ready', stats: outcome.value };
          } else if (prev[id]?.status !== 'ready') {
            next[id] = { status: 'error' };
          }
        });
        return next;
      });
    },
    [tenantId, accountId],
  );

  /*
    A campaign entering the active set, or changing status within it (paused in
    another tab, say), gets read straight away rather than at the next tick. The
    key carries status for exactly that reason.
  */
  const activeKey = active.map((c) => `${c.id}:${c.status}`).join(',');
  const seenKey = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const changed = active
      .filter((c) => seenKey.current.get(c.id) !== c.status)
      .map((c) => c.id);
    seenKey.current = new Map(active.map((c) => [c.id, c.status]));
    void fetchStats(changed);
    // `activeKey` stands in for `active`: a re-sorted list with the same
    // campaigns in the same states must not refetch.
  }, [activeKey, fetchStats]);

  const polling = active.some((c) => needsPolling(c.status, readyStats(stats[c.id])));
  // Read through a ref so `refresh` stays stable: every poll replaces the list,
  // and a callback that changed with it would restart the interval each time.
  const sortedRef = useRef(sorted);
  sortedRef.current = sorted;
  const tickBusy = useRef(false);
  const refresh = useCallback(
    async (only: 'polling' | 'all') => {
      // One refresh at a time: a slow backend must not stack ticks on top of each other.
      if (tickBusy.current) return;
      tickBusy.current = true;
      try {
        const ids = sortedRef.current
          .filter(isActive)
          .filter((c) => only === 'all' || needsPolling(c.status, readyStats(statsRef.current[c.id])))
          .map((c) => c.id);
        await Promise.all([load(true), fetchStats(ids)]);
      } finally {
        tickBusy.current = false;
      }
    },
    [load, fetchStats],
  );

  useVisibleInterval(() => refresh('polling'), REFRESH_MS, polling);

  /*
    Coming back to the tab re-reads everything once, polling or not: that is the
    only way to notice a campaign resumed or started from another window when
    nothing here was moving (the detail page does the same).
  */
  useRefetchOnReturn(() => refresh('all'));

  return {
    history,
    total,
    error,
    loading,
    loadingMore,
    moreError,
    stats,
    campaigns,
    sorted,
    active,
    load,
    loadMore,
  };
}
