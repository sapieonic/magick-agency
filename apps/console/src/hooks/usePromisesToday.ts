import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgencyPromisesSummaryResponse } from '@magick-agency/contracts/api/agency/promises';
import { getAgencyPromisesSummary } from '../api/agencyFloor';
import { localDay, todayWindow } from '../utils/agency/home';
import { useMountedRef } from './useMountedRef';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import { useVisibleInterval } from './useVisibleInterval';
import { HOME_SLOW_MS } from './useHomeBoard';

export type PromisesToday =
  | { status: 'loading' }
  | { status: 'ready'; summary: AgencyPromisesSummaryResponse; day: string }
  /** The read failed (or the account cannot read it): the tile stays Successes. */
  | { status: 'unavailable' };

/**
 * Today's promises to pay (`GET /proxy/agency/promises/summary`, decision B28b) for Live floor's
 * Will pay tile and its campaign cards: Today so far's window (the viewer's local midnight to now)
 * on Today so far's period (a minute) and rules (`useTodaySoFar`): one read at a time, a return to
 * the tab reads only once the figures are a minute old, and a failed refresh keeps them only while
 * they are still today's.
 */
export function usePromisesToday(
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
  enabled: boolean,
): PromisesToday {
  const [state, setState] = useState<PromisesToday>({ status: 'loading' });
  const mounted = useMountedRef();
  const seq = useRef(0);
  const inFlight = useRef<number | null>(null);
  const lastOk = useRef<{ at: number; day: string } | null>(null);
  const ready = enabled && Boolean(tenantId && accountId);

  const load = useCallback(async (reason: 'mount' | 'tick' | 'return') => {
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
      const summary = await getAgencyPromisesSummary(todayWindow(now), tenantId, accountId);
      if (!mounted.current || seq.current !== mine) return;
      lastOk.current = { at: Date.now(), day };
      setState({ status: 'ready', summary, day });
    } catch {
      if (mounted.current && seq.current === mine) {
        setState((prev) => (prev.status === 'ready' && prev.day === day ? prev : { status: 'unavailable' }));
      }
    } finally {
      if (inFlight.current === mine) inFlight.current = null;
    }
  }, [ready, tenantId, accountId, mounted]);

  useEffect(() => {
    lastOk.current = null;
    setState({ status: 'loading' });
    void load('mount');
  }, [load]);
  useVisibleInterval(() => load('tick'), HOME_SLOW_MS, ready);
  useRefetchOnReturn(() => load('return'));

  return state;
}
