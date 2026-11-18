import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgencyFloorResponse } from '@magick-agency/contracts/api/agency/floor';
import { getAgencyFloor } from '../api/agencyFloor';
import { offsetFromSample } from '../utils/agencyClock';
import { errorStatus } from '../utils/agencyErrors';
import { todayWindow } from '../utils/agency/home';
import { useMountedRef } from './useMountedRef';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import { useVisibleInterval } from './useVisibleInterval';

/** The floor's period while Live floor is open: the Live calls list's. */
export const FLOOR_POLL_MS = 5_000;

/** The floor is stale once its reads have failed for more than this many periods since one answered. */
export const FLOOR_STALE_PERIODS = 2;

export interface AgentFloor {
  status: 'loading' | 'ready' | 'error' | 'refused';
  /** The last read that answered; kept through failed reads (marked `stale`). */
  floor: AgencyFloorResponse | null;
  /** The reads have failed for more than {@link FLOOR_STALE_PERIODS} periods since the last that answered. */
  stale: boolean;
  /** Server clock correction from the last answer's `as_of` (ms, subtracted from server instants), for Listen. */
  clockOffsetMs: number;
  reload: () => void;
}

/**
 * The account's floor (`GET /proxy/agency/floor`, decision B28b) for Live floor, and only there:
 * one row per agent is read every {@link FLOOR_POLL_MS} while the page is visible, so no other page
 * (and not the sidebar badge) reads it.
 *
 *  - **`from` is the viewer's local midnight** (`todayWindow`, Today so far's), worked out at each
 *    read, so calls today turn over at midnight with the tiles.
 *  - **One read at a time.** A tick or a return while one is in flight asks nothing; an answer for
 *    an older scope, or older than the latest read asked, never lands.
 *  - **A failed read keeps the last floor**, and once reads have failed for more than two periods
 *    it is `stale` (the page says so); one that never answered is `error`.
 *  - **A 403 stops the asking** (`refused`) until Retry or a new scope.
 */
export function useAgentFloor(
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
  enabled: boolean,
): AgentFloor {
  const scope = enabled && tenantId && accountId ? `${tenantId}/${accountId}` : null;
  const [state, setState] = useState<Omit<AgentFloor, 'reload'>>({ status: 'loading', floor: null, stale: false, clockOffsetMs: 0 });
  const mounted = useMountedRef();
  const seq = useRef(0);
  const inFlight = useRef(false);
  const lastOk = useRef<number | null>(null);
  const refused = useRef(false);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const read = useCallback(async () => {
    if (!scope || !tenantId || !accountId || inFlight.current || refused.current) return;
    const asked = scope;
    const mine = (seq.current += 1);
    inFlight.current = true;
    const sentAt = Date.now();
    try {
      const floor = await getAgencyFloor({ from: todayWindow(new Date()).from }, tenantId, accountId);
      if (!mounted.current || scopeRef.current !== asked || seq.current !== mine) return;
      const now = Date.now();
      lastOk.current = now;
      const serverTs = Date.parse(floor.as_of);
      const clockOffsetMs = Number.isFinite(serverTs) ? offsetFromSample({ ts: sentAt, server_ts: serverTs, receivedAt: now }) : 0;
      setState({ status: 'ready', floor, stale: false, clockOffsetMs });
    } catch (err) {
      if (!mounted.current || scopeRef.current !== asked || seq.current !== mine) return;
      if (errorStatus(err) === 403) {
        refused.current = true;
        setState({ status: 'refused', floor: null, stale: false, clockOffsetMs: 0 });
        return;
      }
      const since = lastOk.current;
      setState((prev) => (since === null
        ? { ...prev, status: 'error', floor: null }
        : { ...prev, stale: Date.now() - since > FLOOR_STALE_PERIODS * FLOOR_POLL_MS }));
    } finally {
      inFlight.current = false;
    }
  }, [scope, tenantId, accountId, mounted]);

  // A new scope starts clean: nothing of the last account's floor, and asked at once.
  useEffect(() => {
    lastOk.current = null;
    refused.current = false;
    inFlight.current = false;
    setState({ status: 'loading', floor: null, stale: false, clockOffsetMs: 0 });
    void read();
  }, [read]);
  useVisibleInterval(read, FLOOR_POLL_MS, scope !== null);
  useRefetchOnReturn(() => read());

  const reload = useCallback(() => {
    refused.current = false;
    void read();
  }, [read]);
  return { ...state, reload };
}
