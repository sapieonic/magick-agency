import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgencyHomeBoard } from '../api/agencyHome';
import { REFRESH_MS } from '../pages/agency/campaigns-home/useCampaignsHome';
import type { HomeCampaignRead } from '../utils/agency/home';
import { useMountedRef } from './useMountedRef';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import { useVisibleInterval } from './useVisibleInterval';
import { MISSED_COUNT_POLL_MS } from './useMissedCallsCount';
import { homeAttentionAge } from './useHomeAttentionCount';

/** Home's refresh while it is open: the campaigns home's own (and the campaign detail page's). */
export const HOME_FAST_MS = REFRESH_MS;
/**
 * The sidebar badge's refresh away from Home, and today's totals': the missed-calls badge's
 * period (a follow-up count, not a live queue).
 */
export const HOME_SLOW_MS = MISSED_COUNT_POLL_MS;
/** Away from Home, a count published this recently is fresh enough not to read again. */
export const HOME_BACKGROUND_FRESH_MS = HOME_SLOW_MS - 5_000;

export interface HomeBoardOptions {
  tenantId: string | null | undefined;
  accountId: string | null | undefined;
  enabled: boolean;
  /**
   * `live`: the Home page. Reads at once, then every {@link HOME_FAST_MS} and on return.
   * `background`: the sidebar badge away from Home. Every {@link HOME_SLOW_MS} and on return,
   * never while the tab is hidden, and skipped while the shared count (`attentionKey`) is fresh.
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
  /** Whether the account has any campaign at all; null until the first read answers. */
  anyCampaign: boolean | null;
  /**
   * `Date.now()` of the last read that answered, 0 before the first. Changes on every one, even
   * when nothing else did, so a caller can publish on every refresh.
   */
  refreshedAt: number;
  reload: () => void;
}

type Kind = 'full' | 'tick';

const IDLE: Omit<HomeBoard, 'reload'> = {
  status: 'idle',
  error: null,
  reads: [],
  activeTotal: 0,
  anyCampaign: null,
  refreshedAt: 0,
};

/**
 * Home's reads: ONE request per refresh, `GET /proxy/agency/home` (`api/agencyHome.ts`), which
 * answers the active campaigns (at most `HOME_CAMPAIGN_CAP`, 25, running first), each with the
 * fields of `/stats` Home reads and its overdue callbacks. The server reuses a still campaign's
 * stats and every overdue count for a minute, so asking every 10 s costs what the campaigns
 * home's own poll does.
 *
 *  - **Every read is complete**, so a tick that falls due while a read is in flight is answered by
 *    that read rather than dropped: no kind of refresh can be lost to another.
 *  - **A failed read keeps the last good numbers**, and so does a campaign whose stats or overdue
 *    count the server could not read this time (`null` on the board): it keeps what it had.
 *  - **A new scope starts clean**, and a read still in flight for the old one is discarded.
 */
export function useHomeBoard({ tenantId, accountId, enabled, mode, attentionKey = null }: HomeBoardOptions): HomeBoard {
  const [state, setState] = useState<Omit<HomeBoard, 'reload'>>(IDLE);
  const mounted = useMountedRef();
  const generation = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  const last = useRef(new Map<string, HomeCampaignRead>());
  const ready = enabled && Boolean(tenantId && accountId);

  const refresh = useCallback(
    (kind: Kind): Promise<void> => {
      if (!ready || !tenantId || !accountId) return Promise.resolve();
      if (kind === 'tick' && inFlight.current) return inFlight.current;
      const mine = (generation.current += 1);
      if (kind === 'full') setState((prev) => (prev.status === 'ready' ? prev : { ...prev, status: 'loading', error: null }));
      const run = (async () => {
        try {
          const board = await getAgencyHomeBoard(tenantId, accountId);
          if (!mounted.current || generation.current !== mine) return;
          const reads = board.campaigns.map((c): HomeCampaignRead => {
            const before = last.current.get(c.id);
            return {
              campaign: { id: c.id, name: c.name, status: c.status },
              stats: c.stats ?? before?.stats ?? null,
              overdue: c.callbacks_overdue ?? before?.overdue ?? null,
            };
          });
          last.current = new Map(reads.map((r) => [r.campaign.id, r]));
          setState({
            status: 'ready',
            error: null,
            reads,
            activeTotal: board.active_total,
            anyCampaign: board.any_campaign,
            refreshedAt: Date.now(),
          });
        } catch (err: unknown) {
          // A failed read keeps what is on screen; only a board never read has nothing to show.
          if (!mounted.current || generation.current !== mine) return;
          setState((prev) => (prev.status === 'ready'
            ? prev
            : { ...prev, status: 'error', error: err instanceof Error ? err.message : 'Could not load your campaigns.' }));
        }
      })();
      inFlight.current = run;
      void run.finally(() => {
        if (inFlight.current === run) inFlight.current = null;
      });
      return run;
    },
    [ready, tenantId, accountId],
  );

  const skip = useCallback(
    () => mode === 'background'
      && (document.visibilityState !== 'visible'
        || (attentionKey !== null && homeAttentionAge(attentionKey) < HOME_BACKGROUND_FRESH_MS)),
    [mode, attentionKey],
  );

  useEffect(() => {
    // A new scope starts clean: nothing read for another account may show here, and a read still
    // in flight for the old scope must not land (the generation it carries is no longer current).
    generation.current += 1;
    inFlight.current = null;
    last.current = new Map();
    setState(IDLE);
    if (!ready || skip()) return;
    void refresh('full');
    // `skip` is read once, at mount or on a scope change, on purpose.
  }, [refresh]);

  useVisibleInterval(
    () => (skip() ? undefined : refresh('tick')),
    mode === 'live' ? HOME_FAST_MS : HOME_SLOW_MS,
    ready,
  );
  useRefetchOnReturn(() => (!ready || skip() ? undefined : refresh('tick')));

  const reload = useCallback(() => void refresh('full'), [refresh]);
  return { ...state, reload };
}
