import { API_BASE } from '../config';
import { apiFetch } from './client';
import type {
  AgencyAgentRetryRequest,
  AgencyAgentRetryResponse,
  AgencyMyContactCallRequest,
  AgencyMyContactCallResponse,
} from '@magick-agency/contracts/api/agency/assignment';

/**
 * The agent's own contacts (contact assignment): agent-led retry and the per-contact call.
 * Every route here answers about the signed-in agent only; the console never names another
 * agent. Behind the `agency_contact_assignment_enabled` flag (`403 assignment_disabled` when
 * off). Refusals are `AgencyAgentRetryErrorResponse` (read `code`, and `details` for
 * `contact_not_retryable`, `outside_calling_hours` and `override_note_invalid`).
 */

const MY_CONTACTS_BASE = `${API_BASE}/proxy/agency/my-contacts`;

/**
 * Reopen not-reached contacts into the agent's own queue (`contact_ids`, at most 500, or
 * `all: true`); pacing then dials them. Each reopened contact spends one agent retry round.
 * Contacts that are not the agent's are ignored, never reported.
 */
export async function retryMyContacts(
  request: AgencyAgentRetryRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyAgentRetryResponse> {
  return apiFetch<AgencyAgentRetryResponse>(
    `${MY_CONTACTS_BASE}/retry`,
    { method: 'POST', body: JSON.stringify(request) },
    tenantId,
    accountId,
  );
}

/**
 * Dial one of the agent's contacts now from their live `available` session on the campaign.
 * Success means the dial was placed; the call arrives on the station socket like a paced one
 * (`reserved`, `bridged`, `released`, wrap-up). `override_note` (10–500 characters) is needed
 * only to spend a calling-hours override outside the window.
 */
export async function callMyContact(
  contactId: string,
  request: AgencyMyContactCallRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyMyContactCallResponse> {
  return apiFetch<AgencyMyContactCallResponse>(
    `${MY_CONTACTS_BASE}/${contactId}/call`,
    { method: 'POST', body: JSON.stringify(request) },
    tenantId,
    accountId,
  );
}
