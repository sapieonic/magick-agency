import { useCallback, useEffect, useRef, useState } from 'react';
import { mapWithConcurrency } from '@magick-agency/web-ui/concurrency';
import {
  getAgencyCampaignStats,
  listAgencyCampaigns,
  listAgencyCampaignsPage,
} from '../api/agencyCampaigns';
import { getInsightsAllocation } from '../api/agencyInsights';
import { ACTIVE_STATUSES, REFRESH_MS, isActive } from '../pages/agency/campaigns-home/useCampaignsHome';
import { needsPolling } from '../utils/agencyCampaignsHome';
import { homeCampaigns, type HomeCampaignRead } from '../utils/agency/home';
import type { AgencyCampaignStats } from '../types/agency-campaign';
import { useMountedRef } from './useMountedRef';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import { useVisibleInterval } from './useVisibleInterval';
import { MISSED_COUNT_POLL_MS } from './useMissedCallsCount';
import { homeAttentionAge } from './useHomeAttentionCount';

/** The fast refresh: the campaigns home's own (and the campaign detail page's). */
export const HOME_FAST_MS = REFRESH_MS;
/**
 * The slow refresh: every capped campaign's stats and overdue callbacks, and the sidebar
 * badge's read away from Home. The missed-calls badge's period: a follow-up count, not a live
 * queue.
 */
export const HOME_SLOW_MS = MISSED_COUNT_POLL_MS;
/** Away from Home, a count published this recently is fresh enough not to read again. */
const BACKGROUND_FRESH_MS = HOME_SLOW_MS - 5_000;

export interface HomeBoardOptions {
  tenantId: string | null | undefined;
  accountId: string | null | undefined;
  enabled: boolean;
  /**
   * `live`: the Home page. Reads at once, the fast tick re-reads the list and the stats of every
   * campaign that is moving, the slow tick re-reads everything.
   * `background`: the sidebar badge away from Home. The slow tick only, and skipped while the
   * shared count (`attentionKey`) is fresh.
   */
  mode: 'live' | 'background';
  /** The shared count's key, for `background`'s freshness check. */
  attentionKey?: string | null;
}

export interface HomeBoard {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** The capped active campaigns, in Campaigns-page order, with what was read for each. */
  reads: HomeCampaignRead[];
  /** Active campaigns before the cap. */
  activeTotal: number;
  /** Whether the account has any campaign at all; null until asked (only asked with none active). */
  anyCampaign: boolean | null;
  reload: () => void;
}

type Kind = 'full' | 'fast' | 'slow';

/**
 * What Home reads, bounded:
 *
 *  - the active campaigns (running, stopping, paused): one list read, paged by the client;
 *  - per campaign, at most {@link HOME_CAMPAIGN_CAP} of them: `/stats` (the stall, abandonment
 *    and the floor) and the insights allocation (`totals.callbacks_overdue`, the same read and
 *    server cache the campaign's Callbacks badge uses);
 *  - with no active campaign, one one-row page to tell "nothing running" from "no campaigns".
 *
 * The fast tick re-reads the list and only the stats of campaigns that are moving
 * (`needsPolling`, the campaigns home's rule), are new, or changed status; allocations are read
 * on the slow tick. A failed tick keeps the last good numbers.
 */
export function useHomeBoard({ tenantId, accountId, enabled, mode, attentionKey = null }: HomeBoardOptions): HomeBoard {
  const [state, setState] = useState<Omit<HomeBoard, 'reload'>>({
    status: 'idle',
    error: null,
    reads: [],
    activeTotal: 0,
    anyCampaign: null,
  });
  const mounted = useMountedRef();
  const generation = useRef(0);
  const busy = useRef(false);
  const stats = useRef(new Map<string, AgencyCampaignStats>());
  const overdue = useRef(new Map<string, number>());
  const seen = useRef(new Map<string, string>());
  const anyCampaign = useRef<boolean | null>(null);
  const ready = enabled && Boolean(tenantId && accountId);

  const refresh = useCallback(
    async (kind: Kind) => {
      if (!ready || !tenantId || !accountId) return;
      if (kind !== 'full' && busy.current) return;
      const mine = kind === 'full' ? (generation.current += 1) : generation.current;
      busy.current = true;
      if (kind === 'full') setState((prev) => ({ ...prev, status: prev.status === 'ready' ? 'ready' : 'loading', error: null }));
      try {
        const active = (await listAgencyCampaigns(tenantId, accountId, ACTIVE_STATUSES)).filter(isActive);
        const { campaigns, total } = homeCampaigns(active);

        const statIds = campaigns
          .filter((c) =>
            kind !== 'fast'
            || !stats.current.has(c.id)
            || seen.current.get(c.id) !== c.status
            || needsPolling(c.status, stats.current.get(c.id) ?? null))
          .map((c) => c.id);
        const allocIds = campaigns
          .filter((c) => kind !== 'fast' || !overdue.current.has(c.id))
          .map((c) => c.id);

        const [statsOut, allocOut] = await Promise.all([
          mapWithConcurrency(statIds, (id) => getAgencyCampaignStats(id, tenantId, accountId)),
          mapWithConcurrency(allocIds, (id) => getInsightsAllocation(id, tenantId, accountId)),
        ]);

        let any = anyCampaign.current;
        if (campaigns.length > 0) any = true;
        else if (any !== true && kind !== 'fast') {
          try {
            any = (await listAgencyCampaignsPage(tenantId, accountId, 0, 1)).total > 0;
          } catch {
            /* keep what was known */
          }
        }

        if (!mounted.current || generation.current !== mine) return;

        const ids = new Set(campaigns.map((c) => c.id));
        const nextStats = new Map([...stats.current].filter(([id]) => ids.has(id)));
        statIds.forEach((id, i) => {
          const out = statsOut[i]!;
          if (out.status === 'fulfilled') nextStats.set(id, out.value);
        });
        const nextOverdue = new Map([...overdue.current].filter(([id]) => ids.has(id)));
        allocIds.forEach((id, i) => {
          const out = allocOut[i]!;
          if (out.status === 'fulfilled') nextOverdue.set(id, out.value.totals.callbacks_overdue);
        });
        stats.current = nextStats;
        overdue.current = nextOverdue;
        seen.current = new Map(campaigns.map((c) => [c.id, c.status]));
        anyCampaign.current = any;

        setState({
          status: 'ready',
          error: null,
          reads: campaigns.map((campaign) => ({
            campaign,
            stats: nextStats.get(campaign.id) ?? null,
            overdue: nextOverdue.get(campaign.id) ?? null,
          })),
          activeTotal: total,
          anyCampaign: any,
        });
      } catch (err: unknown) {
        // A failed tick keeps what is on screen; only a full load has nothing better to show.
        if (mounted.current && generation.current === mine && kind === 'full') {
          setState((prev) => ({
            ...prev,
            status: prev.status === 'ready' ? 'ready' : 'error',
            error: err instanceof Error ? err.message : 'Could not load your campaigns.',
          }));
        }
      } finally {
        if (generation.current === mine) busy.current = false;
      }
    },
    [ready, tenantId, accountId],
  );

  const fresh = useCallback(
    () => mode === 'background' && attentionKey !== null && homeAttentionAge(attentionKey) < BACKGROUND_FRESH_MS,
    [mode, attentionKey],
  );

  useEffect(() => {
    // A new scope starts clean: nothing read for another account may show here.
    stats.current = new Map();
    overdue.current = new Map();
    seen.current = new Map();
    anyCampaign.current = null;
    setState({ status: 'idle', error: null, reads: [], activeTotal: 0, anyCampaign: null });
    if (!ready || fresh()) return;
    void refresh('full');
    // `fresh` is read once, at mount or on a scope change, on purpose.
  }, [refresh]);

  useVisibleInterval(() => refresh('fast'), HOME_FAST_MS, ready && mode === 'live');
  useVisibleInterval(
    () => (fresh() ? undefined : refresh(state.status === 'ready' ? 'slow' : 'full')),
    HOME_SLOW_MS,
    ready,
  );
  useRefetchOnReturn(() => {
    if (!ready || fresh()) return undefined;
    return refresh(state.status === 'ready' ? 'slow' : 'full');
  });

  const reload = useCallback(() => void refresh('full'), [refresh]);
  return { ...state, reload };
}
