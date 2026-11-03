import { API_BASE } from '../config';
import { apiFetch } from './client';
import type {
  AgencyAssignmentCommitRequest,
  AgencyAssignmentHistory,
  AgencyAssignmentOperation,
  AgencyAssignmentPreview,
  AgencyAssignmentProgress,
  AgencyAssignmentResult,
  AgencyMyContact,
  AgencyMyContactsQuery,
  AgencyMyContactsSummary,
} from '@magick-agency/contracts/api/agency/assignment';
import type { AgencyKeysetPage } from '@magick-agency/contracts/agency';

/**
 * Contact assignment (the wire: `packages/contracts/src/api/agency/assignment.ts`). Every
 * route answers `403 assignment_disabled` while `agency_contact_assignment_enabled` is off.
 *
 * Supervisor: preview and commit an assignment operation (a `409 preview_stale` carries the
 * fresh preview in its body), progress per agent, one contact's owner history.
 * Agent: the caller's own contacts, summary and list (the server decides whose: always the
 * caller).
 */

const AGENCY_BASE = `${API_BASE}/proxy/agency`;

/** What an operation would do now. Pass `preview_token` (and `seed`) back on the commit. */
export async function previewAssignment(
  campaignId: string,
  operation: AgencyAssignmentOperation,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyAssignmentPreview> {
  return apiFetch<AgencyAssignmentPreview>(
    `${AGENCY_BASE}/campaigns/${campaignId}/assignments/preview`,
    { method: 'POST', body: JSON.stringify(operation) },
    tenantId,
    accountId,
  );
}

/** Commit a previewed operation. */
export async function commitAssignment(
  campaignId: string,
  request: AgencyAssignmentCommitRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyAssignmentResult> {
  return apiFetch<AgencyAssignmentResult>(
    `${AGENCY_BASE}/campaigns/${campaignId}/assignments`,
    { method: 'POST', body: JSON.stringify(request) },
    tenantId,
    accountId,
  );
}

/** Per-agent progress. `absentAfterMinutes` defaults on the server. */
export async function getAssignmentProgress(
  campaignId: string,
  absentAfterMinutes?: number,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyAssignmentProgress> {
  const query = absentAfterMinutes === undefined ? '' : `?absent_after_minutes=${absentAfterMinutes}`;
  return apiFetch<AgencyAssignmentProgress>(
    `${AGENCY_BASE}/campaigns/${campaignId}/assignments/progress${query}`,
    {},
    tenantId,
    accountId,
  );
}

/** Who held one contact and when, newest first. */
export async function getContactAssignmentHistory(
  campaignId: string,
  contactId: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyAssignmentHistory> {
  return apiFetch<AgencyAssignmentHistory>(
    `${AGENCY_BASE}/campaigns/${campaignId}/contacts/${contactId}/assignments`,
    {},
    tenantId,
    accountId,
  );
}

/** The caller's contacts on a campaign, in counts. */
export async function getMyContactsSummary(
  campaignId: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyMyContactsSummary> {
  return apiFetch<AgencyMyContactsSummary>(
    `${AGENCY_BASE}/my-contacts/summary?campaign_id=${encodeURIComponent(campaignId)}`,
    {},
    tenantId,
    accountId,
  );
}

/** One page of the caller's contacts, in due order. */
export async function listMyContacts(
  query: AgencyMyContactsQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyKeysetPage<AgencyMyContact>> {
  const params = new URLSearchParams({ campaign_id: query.campaign_id });
  for (const bucket of query.bucket ?? []) params.append('bucket', bucket);
  if (query.phone) params.set('phone', query.phone);
  if (query.q) params.set('q', query.q);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  return apiFetch<AgencyKeysetPage<AgencyMyContact>>(
    `${AGENCY_BASE}/my-contacts?${params.toString()}`,
    {},
    tenantId,
    accountId,
  );
}
