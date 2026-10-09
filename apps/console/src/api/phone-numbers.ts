import { apiFetch } from './client';
import { ENDPOINTS } from '../config';
import type { TenantPhoneAssignment } from '../types/phone-number';

export async function listMyPhoneNumbers(tenantId: string, accountId?: string): Promise<TenantPhoneAssignment[]> {
  const res = await apiFetch<{ phone_numbers: TenantPhoneAssignment[] }>(
    ENDPOINTS.phoneNumbers.base, {}, tenantId, accountId
  );
  return res.phone_numbers;
}

// There are no tag/untag or inbound-configuration calls (`tagPhoneNumber`,
// `untagPhoneNumber`, `listInboundConfig`, `putInboundConfig`,
// `deleteInboundConfig`, `checkInboundConflict`): that is AI-platform number
// management, with no console caller in agency.
