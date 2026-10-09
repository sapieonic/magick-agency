import { apiFetch } from './client';
import { ENDPOINTS } from '../config';
import type { TenantPhoneAssignment } from '../types/phone-number';

export async function listMyPhoneNumbers(tenantId: string, accountId?: string): Promise<TenantPhoneAssignment[]> {
  const res = await apiFetch<{ phone_numbers: TenantPhoneAssignment[] }>(
    ENDPOINTS.phoneNumbers.base, {}, tenantId, accountId
  );
  return res.phone_numbers;
}

// PORT NOTE (magick-agency): cusui's tag/untag and inbound-configuration calls
// (`tagPhoneNumber`, `untagPhoneNumber`, `listInboundConfig`, `putInboundConfig`,
// `deleteInboundConfig`, `checkInboundConflict`) are not ported — AI-platform
// number management, with no console caller in agency.
