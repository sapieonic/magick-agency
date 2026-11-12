import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgencyGroupedStats } from '../api/agencyStats';
import { localDay, todayTotals, todayWindow, type TodayTotals } from '../utils/agency/home';
import { useMountedRef } from './useMountedRef';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import { useVisibleInterval } from './useVisibleInterval';
import { HOME_SLOW_MS } from './useHomeBoard';

/** The grouped read's own ceiling (1..1000): one row per campaign that dialled today. */
export const TODAY_ROW_LIMIT = 1000;

export type TodayState =
  | { status: 'loading' }
  /** `day`: the viewer's local day the totals are for (`localDay`). */
  | { status: 'ready'; totals: TodayTotals; day: string }
  /** The read failed, or the server held rows back: nothing honest to print. */
  | { status: 'unavailable' };

/** Why a read is asked for: the first (or a new scope's), the slow tick, or a return to the tab. */
type Reason = 'mount' | 'tick' | 'return';

/**
 * Today so far for the whole account: ONE grouped read
 * (`GET /proxy/agency/agents/grouped-stats`, `group_by=campaign`, the viewer's local midnight to
 * now), the same read and the same counters as a campaign's contribution total. Refreshed on the
 * slow tick and on return. `agency.supervise`, which Home's gate already requires.
 *
 *  - **One read at a time.** A tick or a return while a read is in flight asks nothing; a new
 *    scope reads at once, and an older read that answers after it is ignored.
 *  - **A return reads only when the totals are old**: a switch of tab fires both `focus` and
 *    `visibilitychange`, and each would otherwise be an account-wide read of up to 1000 rows.
 *    Totals younger than {@link HOME_SLOW_MS} and still today's are kept.
 *  - **A failed refresh keeps today's totals**, never yesterday's: once the local day has turned,
 *    a failed read shows nothing rather than the day before under "Today so far".
 */
export function useTodaySoFar(tenantId: string | null | undefined, accountId: string | null | undefined, enabled: boolean): TodayState {
  const [state, setState] = useState<TodayState>({ status: 'loading' });
  const mounted = useMountedRef();
  const seq = useRef(0);
  /** The read in flight (its `seq`), or null. */
  const inFlight = useRef<number | null>(null);
  /** When the last read that answered finished, and the day it counted; null before one. */
  const lastOk = useRef<{ at: number; day: string } | null>(null);
  const ready = enabled && Boolean(tenantId && accountId);

  const load = useCallback(async (reason: Reason) => {
    if (!ready || !tenantId || !accountId) return;
    const now = new Date();
    const day = localDay(now);
    if (reason !== 'mount') {
      if (inFlight.current !== null) return;
      const ok = lastOk.current;
      if (reason === 'return' && ok && ok.day === day && now.getTime() - ok.at < HOME_SLOW_MS) return;
    }
    const mine = (seq.current += 1);
    inFlight.current = mine;
    try {
      const page = await getAgencyGroupedStats(
        { ...todayWindow(now), group_by: ['campaign'], limit: TODAY_ROW_LIMIT },
        tenantId,
        accountId,
      );
      if (!mounted.current || seq.current !== mine) return;
      lastOk.current = { at: Date.now(), day };
      const totals = todayTotals(page);
      setState(totals ? { status: 'ready', totals, day } : { status: 'unavailable' });
    } catch {
      // A failed refresh keeps the numbers shown while they are still today's; a first read that
      // fails, or one after midnight, shows none.
      if (mounted.current && seq.current === mine) {
        setState((prev) => (prev.status === 'ready' && prev.day === day ? prev : { status: 'unavailable' }));
      }
    } finally {
      if (inFlight.current === mine) inFlight.current = null;
    }
  }, [ready, tenantId, accountId]);

  useEffect(() => {
    lastOk.current = null;
    setState({ status: 'loading' });
    void load('mount');
  }, [load]);
  useVisibleInterval(() => load('tick'), HOME_SLOW_MS, ready);
  useRefetchOnReturn(() => load('return'));

  return state;
}
