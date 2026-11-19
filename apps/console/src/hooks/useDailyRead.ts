import { useCallback, useEffect, useRef, useState } from 'react';
import { localDay, todayWindow } from '../utils/agency/home';
import { errorStatus } from '../utils/agencyErrors';
import { useAtLocalMidnight } from './useAtLocalMidnight';
import { useLatestRef } from './useLatestRef';
import { useMountedRef } from './useMountedRef';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import { useVisibleInterval } from './useVisibleInterval';
import { HOME_SLOW_MS } from './useHomeBoard';

export type DailyRead<T> =
  | { status: 'loading' }
  /** `day`: the viewer's local day the figures are for (`localDay`). */
  | { status: 'ready'; value: T; day: string }
  /** The read failed, it answered with nothing honest to print, or (with `stopOnRefusal`) it was refused. */
  | { status: 'unavailable' };

export interface DailyReadOptions<T> {
  tenantId: string | null | undefined;
  accountId: string | null | undefined;
  enabled: boolean;
  /** Part of the scope when given: a new role is a new scope, which asks again after a refusal. */
  role?: string | null;
  /**
   * The read over today's window (the viewer's local midnight to now). `null` is an answer with
   * nothing honest to print (the server held rows back): `unavailable`, and still an answer.
   */
  read: (window: { from: string; to: string }, tenantId: string, accountId: string) => Promise<T | null>;
  /** A 403 stops the asking (`unavailable`) until `reload` or a new scope or role (B28a). */
  stopOnRefusal?: boolean;
}

/** Why a read is asked for: the first (or a new scope's, or midnight's, or Retry's), the slow tick, or a return to the tab. */
type Reason = 'mount' | 'tick' | 'return';

/**
 * A figure for today so far, polled: the read Today so far and Live floor's promises share
 * (`useTodaySoFar`, `usePromisesToday`). The window is the viewer's local midnight to now, worked
 * out at each read; it is read on the slow tick ({@link HOME_SLOW_MS}) while the tab is visible and
 * on a return to the tab.
 *
 *  - **One read at a time, per scope.** A tick or a return while a read is in flight asks nothing;
 *    a new scope reads at once, and an answer for an older scope, or older than the latest read
 *    asked, never lands (nor frees the newer read's slot).
 *  - **A return reads only when the figures are old**: a switch of tab fires both `focus` and
 *    `visibilitychange`. Figures younger than {@link HOME_SLOW_MS} and still today's are kept.
 *  - **A failed refresh keeps today's figures**, never yesterday's: once the local day has turned,
 *    a failed read shows nothing rather than the day before under "today".
 *  - **Read again at local midnight** (`useAtLocalMidnight`), so the new day shows at once, not on
 *    the next minute's tick; a read still in flight then is overtaken (its answer is ignored).
 *  - **A refusal** stops the asking only with `stopOnRefusal`; otherwise a 403 is a failed read.
 */
export function useDailyRead<T>({
  tenantId,
  accountId,
  enabled,
  role,
  read,
  stopOnRefusal = false,
}: DailyReadOptions<T>): { state: DailyRead<T>; reload: () => void } {
  const [state, setState] = useState<DailyRead<T>>({ status: 'loading' });
  const mounted = useMountedRef();
  const readRef = useLatestRef(read);
  const seq = useRef(0);
  /** The read in flight: its scope and sequence number, so only that read can clear it. */
  const inFlight = useRef<{ scope: string; seq: number } | null>(null);
  /** When the last read that answered finished, and the day it counted; null before one. */
  const lastOk = useRef<{ at: number; day: string } | null>(null);
  /** The server refused (403, `stopOnRefusal`): no more asking in this scope until `reload`. */
  const refused = useRef(false);
  const ready = enabled && Boolean(tenantId && accountId);
  const scope = ready ? `${tenantId}/${accountId}/${role ?? ''}` : null;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const load = useCallback(async (reason: Reason) => {
    if (!scope || !tenantId || !accountId || refused.current) return;
    const now = new Date();
    const day = localDay(now);
    if (reason !== 'mount') {
      if (inFlight.current !== null) return;
      const ok = lastOk.current;
      if (reason === 'return' && ok && ok.day === day && now.getTime() - ok.at < HOME_SLOW_MS) return;
    }
    const asked = scope;
    const mine = (seq.current += 1);
    const token = { scope: asked, seq: mine };
    inFlight.current = token;
    // This read's answer lands only while it is still the scope's latest read.
    const current = () => mounted.current && scopeRef.current === asked && seq.current === mine;
    try {
      const value = await readRef.current(todayWindow(now), tenantId, accountId);
      if (!current()) return;
      lastOk.current = { at: Date.now(), day };
      setState(value === null ? { status: 'unavailable' } : { status: 'ready', value, day });
    } catch (err) {
      if (!current()) return;
      if (stopOnRefusal && errorStatus(err) === 403) {
        refused.current = true;
        setState({ status: 'unavailable' });
        return;
      }
      // A failed refresh keeps the figures shown while they are still today's; a first read that
      // fails, or one after midnight, shows none.
      setState((prev) => (prev.status === 'ready' && prev.day === day ? prev : { status: 'unavailable' }));
    } finally {
      if (inFlight.current === token) inFlight.current = null;
    }
  }, [scope, tenantId, accountId, stopOnRefusal, mounted, readRef]);

  // A new scope starts clean, and asks at once (a refusal in the last scope included).
  useEffect(() => {
    lastOk.current = null;
    refused.current = false;
    setState({ status: 'loading' });
    void load('mount');
  }, [load]);
  useVisibleInterval(() => load('tick'), HOME_SLOW_MS, ready);
  useRefetchOnReturn(() => load('return'));
  // The day turns at the viewer's midnight, not on the minute's tick: read the new day's then.
  useAtLocalMidnight(() => void load('mount'), ready);

  const reload = useCallback(() => {
    refused.current = false;
    void load('mount');
  }, [load]);
  return { state, reload };
}
