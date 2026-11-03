import { API_BASE } from '../config';
import { apiFetch } from './client';
import { toQuery } from './agencySpine';
import type { AgencyKeysetPage } from '../types/agency-spine';
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

/**
 * Contact assignment: the supervisor's operations and progress, and the agent's
 * reads of their own contacts (`packages/contracts/src/api/agency/assignment.ts`
 * lists every route; the agent's two writes are in `agencyMyContacts.ts`).
 *
 * Every route is behind the `agency_contact_assignment_enabled` flag and answers
 * `403 assignment_disabled` when it is off, so no surface calls these without
 * reading the flag first. Every function takes `accountId` and must be given it,
 * like the rest of `/proxy/agency` (see `agencyCampaigns.ts`).
 */

const AGENCY_BASE = `${API_BASE}/proxy/agency`;

// ─── Supervisor (`agency.supervise`) ────────────────────────────────────────

/**
 * What an operation would do, computed against the roster as it is now. Nothing
 * is written; the commit sends back `preview_token` (and the `seed` the preview
 * used for a random split) so it applies exactly what was shown.
 */
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

/**
 * Apply a previewed operation. Refused `409 preview_stale` (with the fresh preview
 * in the body, see `stalePreviewOf`) when the roster moved since the preview.
 */
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

/** Per-agent progress on the campaign, the pool, and the strict-mode unassigned count. */
export async function getAssignmentProgress(
  campaignId: string,
  options: { absentAfterMinutes?: number } = {},
  tenantId?: string,
  accountId?: string,
): Promise<AgencyAssignmentProgress> {
  const extra: Record<string, string> = {};
  if (options.absentAfterMinutes !== undefined) {
    extra['absent_after_minutes'] = String(options.absentAfterMinutes);
  }
  return apiFetch<AgencyAssignmentProgress>(
    `${AGENCY_BASE}/campaigns/${campaignId}/assignments/progress${toQuery({}, extra)}`,
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

// ─── Agent (`agency.contacts.own`; the subject is always the caller) ─────────

/** The caller's contacts on one campaign, in counts, with their queue and retry allowance. */
export async function getMyContactsSummary(
  campaignId: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyMyContactsSummary> {
  return apiFetch<AgencyMyContactsSummary>(
    `${AGENCY_BASE}/my-contacts/summary${toQuery({ campaign_id: campaignId })}`,
    {},
    tenantId,
    accountId,
  );
}

/**
 * One keyset page of the caller's contacts. `bucket` is a repeated param, like
 * every list filter on `/proxy/agency`; a blank `phone` or `q` is dropped.
 */
export async function listMyContacts(
  query: AgencyMyContactsQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyKeysetPage<AgencyMyContact>> {
  const extra: Record<string, string> = {};
  if (query.cursor) extra['cursor'] = query.cursor;
  if (query.limit !== undefined) extra['limit'] = String(query.limit);
  const filters = {
    campaign_id: query.campaign_id,
    bucket: query.bucket,
    phone: query.phone?.trim(),
    q: query.q?.trim(),
  };
  return apiFetch<AgencyKeysetPage<AgencyMyContact>>(
    `${AGENCY_BASE}/my-contacts${toQuery(filters, extra)}`,
    {},
    tenantId,
    accountId,
  );
}
