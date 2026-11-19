import { useMemo } from 'react';
import type { AgencyPromisesSummaryResponse } from '@magick-agency/contracts/api/agency/promises';
import { getAgencyPromisesSummary } from '../api/agencyFloor';
import { useDailyRead } from './useDailyRead';

type PromisesToday =
  | { status: 'loading' }
  | { status: 'ready'; summary: AgencyPromisesSummaryResponse; day: string }
  /** The read failed (or the account cannot read it): the tile stays Successes. */
  | { status: 'unavailable' };

/** The read, and Retry: asks again at once, a refused read included. */
type PromisesTodayRead = PromisesToday & { reload: () => void };

const readPromises = (window: { from: string; to: string }, tenantId: string, accountId: string) =>
  getAgencyPromisesSummary(window, tenantId, accountId);

/**
 * Today's promises to pay (`GET /proxy/agency/promises/summary`, decision B28b) for Live floor's
 * Will pay tile and its campaign cards: Today so far's window (the viewer's local midnight to now)
 * on Today so far's period (a minute) and rules (`useDailyRead`, which `useTodaySoFar` reads by
 * too): one read at a time, a return to the tab reads only once the figures are a minute old, and a
 * failed refresh keeps them only while they are still today's; it reads again at local midnight. A
 * 403 stops the asking (the tile stays Successes) until Retry (`reload`) or a new scope or role
 * (B28a).
 */
export function usePromisesToday(
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
  enabled: boolean,
  role?: string | null,
): PromisesTodayRead {
  const { state, reload } = useDailyRead({ tenantId, accountId, enabled, role, read: readPromises, stopOnRefusal: true });
  return useMemo(
    () => ({ ...(state.status === 'ready' ? { status: 'ready' as const, summary: state.value, day: state.day } : state), reload }),
    [state, reload],
  );
}
