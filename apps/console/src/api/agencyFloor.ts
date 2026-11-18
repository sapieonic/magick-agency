import { ENDPOINTS } from '../config';
import { apiFetch } from './client';
import type { AgencyFloorQuery, AgencyFloorResponse } from '@magick-agency/contracts/api/agency/floor';
import type {
  AgencyPromisesSummaryQuery,
  AgencyPromisesSummaryResponse,
} from '@magick-agency/contracts/api/agency/promises';

/**
 * The account's floor, `GET /proxy/agency/floor?from=` (decision B28b; the wire is
 * `contracts/api/agency/floor.ts`): one row per agent with an open session or staffed on an active
 * campaign, with the call in progress (the customer's name, never the number) and calls since
 * `from`. `agency.supervise`; never cached. Live floor reads it every 5 s (`useAgentFloor`).
 */
export function getAgencyFloor(query: AgencyFloorQuery, tenantId: string, accountId: string): Promise<AgencyFloorResponse> {
  const params = new URLSearchParams({ from: query.from });
  return apiFetch<AgencyFloorResponse>(`${ENDPOINTS.proxy.agency.floor}?${params.toString()}`, {}, tenantId, accountId);
}

/**
 * The promises to pay recorded over `[from, to)`, per campaign, `GET /proxy/agency/promises/summary`
 * (decision B28b; `contracts/api/agency/promises.ts`): Live floor's Will pay tile and the campaign
 * cards' "N will pay". `agency.supervise`; the window is at most 31 days.
 */
export function getAgencyPromisesSummary(
  query: AgencyPromisesSummaryQuery,
  tenantId: string,
  accountId: string,
): Promise<AgencyPromisesSummaryResponse> {
  const params = new URLSearchParams({ from: query.from, to: query.to });
  return apiFetch<AgencyPromisesSummaryResponse>(`${ENDPOINTS.proxy.agency.promisesSummary}?${params.toString()}`, {}, tenantId, accountId);
}
