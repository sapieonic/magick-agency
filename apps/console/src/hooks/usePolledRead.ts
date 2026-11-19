import { useCallback, useEffect, useRef, useState } from 'react';
import { localDay } from '../utils/agency/home';
import { errorStatus } from '../utils/agencyErrors';
import { useAtLocalMidnight } from './useAtLocalMidnight';
import { useLatestRef } from './useLatestRef';
import { useMountedRef } from './useMountedRef';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import { useVisibleInterval } from './useVisibleInterval';

export type PolledRead<T> =
  | { status: 'loading' }
  /**
   * `value`: the last read that answered in this scope, kept through failed reads the reader lets
   * it survive. `day`: the viewer's local day (`localDay`) when that read was asked. `stale`: the
   * reads have failed for more than `staleAfterPeriods` periods since it answered.
   */
  | { status: 'ready'; value: T; day: string; stale: boolean }
  /** A read failed with nothing kept to show. */
  | { status: 'error' }
  /** A 403 with `stopOnRefusal`: no more asking in this scope until `reload`. */
  | { status: 'refused' };

export interface PolledReadOptions<T> {
  tenantId: string | null | undefined;
  accountId: string | null | undefined;
  enabled: boolean;
  /** Part of the scope when given: a new role is a new scope, which asks again after a refusal. */
  role?: string | null;
  /** One read; `now` is when it was asked (a "today" window is worked out from it). */
  read: (tenantId: string, accountId: string, now: Date) => Promise<T>;
  /** The poll's period while the tab is visible; a return to the tab reads only figures older than it. */
  periodMs: number;
  /** A 403 stops the asking (`refused`) until `reload` or a new scope or role (B28a). */
  stopOnRefusal?: boolean;
  /**
   * Whether a failed read keeps the last answer (default: always). `failedDay` is the local day
   * the failed read was asked on: the daily reads keep only today's figures.
   */
  keepOnFailure?: (kept: { value: T; day: string }, failedDay: string) => boolean;
  /** A kept answer is `stale` once reads have failed for more than this many periods since it. */
  staleAfterPeriods?: number;
  /**
   * The figures turn over at the viewer's local midnight: read again then (`useAtLocalMidnight`),
   * and a return to the tab reads figures from an earlier day however young they are.
   */
  turnOfDay?: boolean;
}

/**
 * Why a read is asked for: `now` (a new scope's first, local midnight's, or `reload`'s: Retry or a
 * change the reader made), the period's `tick`, or a `return` to the tab.
 */
type Reason = 'now' | 'tick' | 'return';

/**
 * The polling core under Live floor's floor (`useAgentFloor`) and the "today" reads
 * (`useDailyRead`, so `useTodaySoFar` and `usePromisesToday`), so their rules live in one place:
 *
 *  - **Scope**: tenant, account and, when given, role. A new scope starts clean (nothing of the
 *    last one's answer, its refusal forgotten) and reads at once.
 *  - **One read at a time, per scope.** A tick or a return while this scope's read is in flight
 *    asks nothing. A read asked `now` (a new scope, midnight, `reload`) never waits: it overtakes
 *    the read in flight, and an answer for an older scope, or older than the latest read asked,
 *    never lands. The in-flight slot holds its own read's token, so only that read frees it: an
 *    older read finishing late never frees a newer one's.
 *  - **A return reads only old figures**: a switch of tab fires both `focus` and
 *    `visibilitychange`. Figures younger than a period (and, with `turnOfDay`, still today's) are
 *    kept.
 *  - **A failed read keeps the last answer** while `keepOnFailure` allows, marked `stale` past
 *    `staleAfterPeriods`; with nothing kept it is `error`.
 *  - **A 403** stops the asking only with `stopOnRefusal`; otherwise it is a failed read.
 */
export function usePolledRead<T>({
  tenantId,
  accountId,
  enabled,
  role,
  read,
  periodMs,
  stopOnRefusal = false,
  keepOnFailure,
  staleAfterPeriods,
  turnOfDay = false,
}: PolledReadOptions<T>): { state: PolledRead<T>; reload: () => void } {
  const [state, setState] = useState<PolledRead<T>>({ status: 'loading' });
  const mounted = useMountedRef();
  const readRef = useLatestRef(read);
  const rules = useLatestRef({ periodMs, keepOnFailure, staleAfterPeriods, turnOfDay });
  const seq = useRef(0);
  /** The read in flight: its scope and sequence number, so only that read can clear it. */
  const inFlight = useRef<{ scope: string; seq: number } | null>(null);
  /** When the last read that answered finished, and the day it was asked on; null before one. */
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
    const { periodMs: period, keepOnFailure: keep, staleAfterPeriods: stalePeriods, turnOfDay: daily } = rules.current;
    if (reason !== 'now') {
      if (inFlight.current?.scope === scope) return;
      const ok = lastOk.current;
      if (reason === 'return' && ok && (!daily || ok.day === day) && now.getTime() - ok.at < period) return;
    }
    const asked = scope;
    const mine = (seq.current += 1);
    const token = { scope: asked, seq: mine };
    inFlight.current = token;
    // This read's answer lands only while it is still the scope's latest read.
    const current = () => mounted.current && scopeRef.current === asked && seq.current === mine;
    try {
      const value = await readRef.current(tenantId, accountId, now);
      if (!current()) return;
      lastOk.current = { at: Date.now(), day };
      setState({ status: 'ready', value, day, stale: false });
    } catch (err) {
      if (!current()) return;
      if (stopOnRefusal && errorStatus(err) === 403) {
        refused.current = true;
        setState({ status: 'refused' });
        return;
      }
      const since = lastOk.current;
      setState((prev) => {
        if (prev.status !== 'ready' || !since || (keep && !keep(prev, day))) return { status: 'error' };
        const stale = stalePeriods !== undefined && Date.now() - since.at > stalePeriods * period;
        return stale === prev.stale ? prev : { ...prev, stale };
      });
    } finally {
      if (inFlight.current === token) inFlight.current = null;
    }
  }, [scope, tenantId, accountId, stopOnRefusal, mounted, readRef, rules]);

  // A new scope starts clean, and asks at once (a refusal in the last scope included).
  useEffect(() => {
    lastOk.current = null;
    refused.current = false;
    setState({ status: 'loading' });
    void load('now');
  }, [load]);
  useVisibleInterval(() => load('tick'), periodMs, ready);
  useRefetchOnReturn(() => load('return'));
  // The day turns at the viewer's midnight, not on the period's tick: read the new day's then.
  useAtLocalMidnight(() => void load('now'), ready && turnOfDay);

  const reload = useCallback(() => {
    refused.current = false;
    void load('now');
  }, [load]);
  return { state, reload };
}
