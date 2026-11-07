import { API_BASE } from '../config';
import { apiFetch } from './client';
import type { AgencyCarrier, AgencyCarriersResponse } from '../types/agency-campaign';

/**
 * `GET /proxy/agency/carriers` (`agency.campaigns.write`): the carrier accounts this
 * tenant's campaigns may dial on, the service's own first, then the tenant's own accounts.
 * Takes `accountId` like every `/proxy/agency` call (see `api/agencyCampaigns.ts`).
 */
export async function listAgencyCarriers(tenantId: string, accountId: string): Promise<AgencyCarrier[]> {
  const res = await apiFetch<AgencyCarriersResponse>(`${API_BASE}/proxy/agency/carriers`, {}, tenantId, accountId);
  return res.carriers;
}
