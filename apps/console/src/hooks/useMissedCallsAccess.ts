import { useTenant } from '../contexts/TenantContext';
import { hasPermission } from '../utils/permissions';
import { INBOUND_FLAG } from '../utils/inbound/inboundFlag';
import { useFeatureFlagEnabled } from './useFeatureFlagEnabled';
import { useMissedCallsCount } from './useMissedCallsCount';
import type { AgencyInboundMissedCountResponse } from '../types/inbound';

/**
 * The caller's role and scope, failing closed (`undefined`, nulls) with no provider above, the
 * same reasoning as `useFeatureFlagEnabled`: `useTenant` reads its context before it throws, so
 * the hook order is stable.
 */
function useTenantOrNone(): { role: ReturnType<typeof useTenant>['role']; tenantId: string | null; accountId: string | null } {
  try {
    const { role, tenantId, accountId } = useTenant();
    return { role, tenantId: tenantId ?? null, accountId: accountId ?? null };
  } catch {
    return { role: undefined, tenantId: null, accountId: null };
  }
}

export interface MissedCallsAccess {
  /** The caller gets "Missed calls": `agency.inbound.read`, and inbound on or rows to read. */
  available: boolean;
  /** `agency_inbound_enabled`: off, the list is read-only history (the kill switch). */
  inboundOn: boolean;
  /** The caller's open Missed calls and whether they have any (null until the first answer). */
  count: AgencyInboundMissedCountResponse | null;
  /** Whether {@link available} is final: with inbound off it waits on the count's first answer. */
  settled: boolean;
}

/**
 * Whether this caller gets "Missed calls", and the badge's count. `agency.inbound.read`, and
 * either `agency_inbound_enabled` on for the account, or rows already there to read: switching
 * inbound off stops new calls reaching the queue, never the follow-up of the calls that came in
 * (`docs/inbound.md` §8.4). With the flag on the count is polled for the badge; off, it is read
 * once (and when the reader comes back) only to decide whether the list is still worth showing.
 */
export function useMissedCallsAccess(): MissedCallsAccess {
  const { role, tenantId, accountId } = useTenantOrNone();
  const inboundOn = useFeatureFlagEnabled(INBOUND_FLAG);
  const permitted = hasPermission(role, 'agency.inbound.read');
  const { count, settled } = useMissedCallsCount({ tenantId, accountId, enabled: permitted, poll: inboundOn });
  return {
    available: permitted && (inboundOn || count?.has_rows === true),
    inboundOn,
    count,
    settled: !permitted || inboundOn || settled,
  };
}

