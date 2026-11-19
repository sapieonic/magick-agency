import { useMemo } from 'react';
import type { AgencyFloorResponse } from '@magick-agency/contracts/api/agency/floor';
import { getAgencyFloor } from '../api/agencyFloor';
import { offsetFromSample } from '../utils/agencyClock';
import { todayWindow } from '../utils/agency/home';
import { usePolledRead } from './usePolledRead';

/** The floor's period while Live floor is open: the Live calls list's. */
export const FLOOR_POLL_MS = 5_000;

/** The floor is stale once its reads have failed for more than this many periods since one answered. */
const FLOOR_STALE_PERIODS = 2;

export interface AgentFloor {
  status: 'loading' | 'ready' | 'error' | 'refused';
  /** The last read that answered; kept through failed reads (marked `stale`). */
  floor: AgencyFloorResponse | null;
  /** The reads have failed for more than {@link FLOOR_STALE_PERIODS} periods since the last that answered. */
  stale: boolean;
  /**
   * Server clock correction from the last answer's `as_of` (ms: the server's clock minus the
   * viewer's, subtracted from server instants). Live floor measures everything on the floor by it:
   * the cards' clocks, the risks and the break rows (the viewer's now plus it), and Listen.
   */
  clockOffsetMs: number;
  reload: () => void;
}

/** One floor read, with the server clock correction measured over its round trip. */
async function readFloor(tenantId: string, accountId: string, now: Date) {
  const sentAt = Date.now();
  const floor = await getAgencyFloor({ from: todayWindow(now).from }, tenantId, accountId);
  const receivedAt = Date.now();
  const serverTs = Date.parse(floor.as_of);
  const clockOffsetMs = Number.isFinite(serverTs) ? offsetFromSample({ ts: sentAt, server_ts: serverTs, receivedAt }) : 0;
  return { floor, clockOffsetMs };
}

/**
 * The account's floor (`GET /proxy/agency/floor`, decision B28b) for Live floor, and only there:
 * one row per agent is read every {@link FLOOR_POLL_MS} while the page is visible, so no other page
 * (and not the sidebar badge) reads it.
 *
 *  - **`from` is the viewer's local midnight** (`todayWindow`, Today so far's), worked out at each
 *    read, so calls today turn over at midnight with the tiles.
 *  - **One read at a time, per scope** (the polling core's rules, `usePolledRead`). A tick or a
 *    return while one is in flight asks nothing; a new scope, Retry and a change the page made
 *    (`reload`, Make available's `onChanged`) read at once, overtaking a read in flight, and an
 *    answer for an older scope, or older than the latest read asked, never lands (nor frees the
 *    newer read's slot). A return to the tab reads only a floor older than a period.
 *  - **A failed read keeps the last floor**, and once reads have failed for more than two periods
 *    it is `stale` (the page says so); one that never answered is `error`.
 *  - **A 403 stops the asking** (`refused`) until Retry (`reload`) or a new scope or role (B28a):
 *    the role is part of the scope, as it is of the board's identity in `useHomeBoard`.
 */
export function useAgentFloor(
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
  enabled: boolean,
  role?: string | null,
): AgentFloor {
  const { state, reload } = usePolledRead({
    tenantId,
    accountId,
    enabled,
    role,
    read: readFloor,
    periodMs: FLOOR_POLL_MS,
    stopOnRefusal: true,
    staleAfterPeriods: FLOOR_STALE_PERIODS,
  });
  return useMemo<AgentFloor>(() => (state.status === 'ready'
    ? { status: 'ready', floor: state.value.floor, stale: state.stale, clockOffsetMs: state.value.clockOffsetMs, reload }
    : { status: state.status, floor: null, stale: false, clockOffsetMs: 0, reload }), [state, reload]);
}
