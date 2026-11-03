import { API_BASE } from '../config';
import { apiFetch } from './client';
import type {
  AgencyAgentRetryRequest,
  AgencyAgentRetryResponse,
  AgencyMyContactCallRequest,
  AgencyMyContactCallResponse,
} from '@magick-agency/contracts/api/agency/assignment';

/**
 * The agent's two acts on their own contacts (`agency.contacts.own`): reopen the
 * ones they did not reach into their queue, and dial one now from the station.
 * The reads are in `agencyAssignment.ts`. Refusals are `AgencyAgentRetryErrorCode`s;
 * their copy is `utils/agencyMyContactsCopy.ts`.
 */

const AGENCY_BASE = `${API_BASE}/proxy/agency`;

/** Reopen not-reached contacts (`all`, or the given ids) into the caller's queue; pacing dials them. */
export async function retryMyContacts(
  request: AgencyAgentRetryRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyAgentRetryResponse> {
  return apiFetch<AgencyAgentRetryResponse>(
    `${AGENCY_BASE}/my-contacts/retry`,
    { method: 'POST', body: JSON.stringify(request) },
    tenantId,
    accountId,
  );
}

/**
 * Dial one contact now on the campaign's normal path, from the caller's station
 * session (which must be `available` on that campaign). The call then arrives on
 * the station socket as any reservation does.
 */
export async function callMyContact(
  contactId: string,
  request: AgencyMyContactCallRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyMyContactCallResponse> {
  return apiFetch<AgencyMyContactCallResponse>(
    `${AGENCY_BASE}/my-contacts/${contactId}/call`,
    { method: 'POST', body: JSON.stringify(request) },
    tenantId,
    accountId,
  );
}
