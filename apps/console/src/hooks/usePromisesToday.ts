import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgencyPromisesSummaryResponse } from '@magick-agency/contracts/api/agency/promises';
import { getAgencyPromisesSummary } from '../api/agencyFloor';
import { localDay, todayWindow } from '../utils/agency/home';
import { errorStatus } from '../utils/agencyErrors';
import { useMountedRef } from './useMountedRef';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import { useVisibleInterval } from './useVisibleInterval';
import { HOME_SLOW_MS } from './useHomeBoard';

export type PromisesToday =
  | { status: 'loading' }
  | { status: 'ready'; summary: AgencyPromisesSummaryResponse; day: string }
  /** The read failed (or the account cannot read it): the tile stays Successes. */
  | { status: 'unavailable' };

/** The read, and Retry: asks again at once, a refused read included. */
export type PromisesTodayRead = PromisesToday & { reload: () => void };

/**
 * Today's promises to pay (`GET /proxy/agency/promises/summary`, decision B28b) for Live floor's
 * Will pay tile and its campaign cards: Today so far's window (the viewer's local midnight to now)
 * on Today so far's period (a minute) and rules (`useTodaySoFar`): one read at a time, a return to
 * the tab reads only once the figures are a minute old, and a failed refresh keeps them only while
 * they are still today's. A 403 stops the asking (the tile stays Successes) until Retry (`reload`)
 * or a new scope or role (B28a).
 */
export function usePromisesToday(
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
  enabled: boolean,
  role?: string | null,
): PromisesTodayRead {
  const [state, setState] = useState<PromisesToday>({ status: 'loading' });
  const mounted = useMountedRef();
  const seq = useRef(0);
  const inFlight = useRef<number | null>(null);
  const lastOk = useRef<{ at: number; day: string } | null>(null);
  /** The server refused (403): no more asking in this scope (a new account or role is a new one) until Retry. */
  const refused = useRef(false);
  const ready = enabled && Boolean(tenantId && accountId);
  /** Who asks for what: a new account or role is a new scope, which asks again after a refusal. */
  const scope = ready ? `${tenantId}/${accountId}/${role ?? ''}` : null;

  const load = useCallback(async (reason: 'mount' | 'tick' | 'return') => {
    if (!scope || !tenantId || !accountId || refused.current) return;
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
    } catch (err) {
      if (mounted.current && seq.current === mine && errorStatus(err) === 403) {
        refused.current = true;
        setState({ status: 'unavailable' });
        return;
      }
      if (mounted.current && seq.current === mine) {
        setState((prev) => (prev.status === 'ready' && prev.day === day ? prev : { status: 'unavailable' }));
      }
    } finally {
      if (inFlight.current === mine) inFlight.current = null;
    }
  }, [scope, tenantId, accountId, mounted]);

  useEffect(() => {
    lastOk.current = null;
    refused.current = false;
    setState({ status: 'loading' });
    void load('mount');
  }, [load]);
  useVisibleInterval(() => load('tick'), HOME_SLOW_MS, ready);
  useRefetchOnReturn(() => load('return'));

  const reload = useCallback(() => {
    refused.current = false;
    void load('mount');
  }, [load]);
  return { ...state, reload };
}
