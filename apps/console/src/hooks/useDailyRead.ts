import { useMemo } from 'react';
import { todayWindow } from '../utils/agency/home';
import { usePolledRead } from './usePolledRead';
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

/** A failed refresh keeps the figures shown only while they are still today's. */
const keepToday = (kept: { day: string }, failedDay: string) => kept.day === failedDay;

/**
 * A figure for today so far, polled: the read Today so far and Live floor's promises share
 * (`useTodaySoFar`, `usePromisesToday`), on the polling core (`usePolledRead`, whose rules it
 * takes: one read at a time per scope, a new scope or Retry overtaking a read in flight). The
 * window is the viewer's local midnight to now, worked out at each read; it is read on the slow
 * tick ({@link HOME_SLOW_MS}) while the tab is visible and on a return to the tab.
 *
 *  - **A return reads only when the figures are old**: figures younger than {@link HOME_SLOW_MS}
 *    and still today's are kept.
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
  const { state: polled, reload } = usePolledRead<T | null>({
    tenantId,
    accountId,
    enabled,
    role,
    read: (t, a, now) => read(todayWindow(now), t, a),
    periodMs: HOME_SLOW_MS,
    stopOnRefusal,
    keepOnFailure: keepToday,
    turnOfDay: true,
  });
  const state = useMemo<DailyRead<T>>(() => {
    if (polled.status === 'loading') return polled;
    if (polled.status === 'ready' && polled.value !== null) return { status: 'ready', value: polled.value, day: polled.day };
    return { status: 'unavailable' };
  }, [polled]);
  return { state, reload };
}
