import type { AgencyFloorAlertsResponse } from '@magick-agency/contracts/api/agency/floor';
import { getAgencyFloorAlerts } from '../api/agencyFloor';
import { usePolledRead } from './usePolledRead';

/** The alerts' period: Live floor's (AS16, "polled every 5 s from the console shell"). */
export const FLOOR_ALERTS_POLL_MS = 5_000;

/** Kept alerts are dropped once reads have failed for more than this many periods since one answered. */
const FLOOR_ALERTS_STALE_PERIODS = 2;

const readAlerts = (tenantId: string, accountId: string) => getAgencyFloorAlerts(tenantId, accountId);

/**
 * The account's open supervisor alerts (`GET /proxy/agency/floor/alerts`, AS16) for the console's
 * shell, on the polling core's rules (`usePolledRead`): every {@link FLOOR_ALERTS_POLL_MS} while the
 * tab is visible and nothing while it is hidden (a return reads at once if the last answer is older
 * than a period), one read in flight at a time, a new scope (tenant, account, role) starting clean.
 *
 * Quiet by design: `enabled` is false for anyone without `agency.supervise` or with the dialer off,
 * so they never ask; a 403 (the role or the dialer flag changed under the page) stops the asking
 * for the scope; and a read that fails keeps the last answer for two periods and then gives
 * nothing, so a banner never lingers on alerts that cannot be checked. Null means "nothing to show".
 */
export function useFloorAlerts(
  tenantId: string | null | undefined,
  accountId: string | null | undefined,
  enabled: boolean,
  role?: string | null,
): AgencyFloorAlertsResponse | null {
  const { state } = usePolledRead({
    tenantId,
    accountId,
    enabled,
    role,
    read: readAlerts,
    periodMs: FLOOR_ALERTS_POLL_MS,
    stopOnRefusal: true,
    staleAfterPeriods: FLOOR_ALERTS_STALE_PERIODS,
  });
  return enabled && state.status === 'ready' && !state.stale ? state.value : null;
}
