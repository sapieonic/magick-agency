import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgencyGroupedStats } from '../api/agencyStats';
import { todayTotals, todayWindow, type TodayTotals } from '../utils/agency/home';
import { useMountedRef } from './useMountedRef';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import { useVisibleInterval } from './useVisibleInterval';
import { HOME_SLOW_MS } from './useHomeBoard';

/** The grouped read's own ceiling (1..1000): one row per campaign that dialled today. */
export const TODAY_ROW_LIMIT = 1000;

export type TodayState =
  | { status: 'loading' }
  | { status: 'ready'; totals: TodayTotals }
  /** The read failed, or the server held rows back: nothing honest to print. */
  | { status: 'unavailable' };

/**
 * Today so far for the whole account: ONE grouped read
 * (`GET /proxy/agency/agents/grouped-stats`, `group_by=campaign`, the viewer's local midnight to
 * now), the same read and the same counters as a campaign's contribution total. Refreshed on the
 * slow tick and on return. `agency.supervise`, which Home's gate already requires.
 */
export function useTodaySoFar(tenantId: string | null | undefined, accountId: string | null | undefined, enabled: boolean): TodayState {
  const [state, setState] = useState<TodayState>({ status: 'loading' });
  const mounted = useMountedRef();
  const seq = useRef(0);
  const ready = enabled && Boolean(tenantId && accountId);

  const load = useCallback(async () => {
    if (!ready || !tenantId || !accountId) return;
    const mine = (seq.current += 1);
    try {
      const page = await getAgencyGroupedStats(
        { ...todayWindow(new Date()), group_by: ['campaign'], limit: TODAY_ROW_LIMIT },
        tenantId,
        accountId,
      );
      if (!mounted.current || seq.current !== mine) return;
      const totals = todayTotals(page);
      setState(totals ? { status: 'ready', totals } : { status: 'unavailable' });
    } catch {
      // A failed refresh keeps numbers already shown; a first read that fails shows none.
      if (mounted.current && seq.current === mine) {
        setState((prev) => (prev.status === 'ready' ? prev : { status: 'unavailable' }));
      }
    }
  }, [ready, tenantId, accountId]);

  useEffect(() => {
    setState({ status: 'loading' });
    void load();
  }, [load]);
  useVisibleInterval(load, HOME_SLOW_MS, ready);
  useRefetchOnReturn(load);

  return state;
}
