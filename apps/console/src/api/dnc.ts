import { ENDPOINTS } from '../config';
import { apiFetch } from './client';
import type {
  DncAddSummary,
  DncEntry,
  DncListParams,
  DncListResponse,
  DncSource,
} from '../types/dnc';

/**
 * The Do Not Call list.
 *
 * **Master-native.** These are not `/proxy/*` routes — master owns the table and
 * core only receives a derived Redis set. So unlike the rest of the agency
 * client, nothing here has a core route behind it, and a failure here is a
 * master failure.
 *
 * Two floors apply, and the UI should respect both: reading is `agency.dnc.read`
 * (`viewer`), while adding and removing are `agency.dnc.manage`
 * (`account_admin`). The agent-facing mark-DNC is a different route entirely —
 * `POST /proxy/agency/attempts/:id/dnc` in `agency.ts`, attempt-scoped and
 * floored at `agent`.
 */

export async function listDncEntries(
  params: DncListParams = {},
  tenantId?: string,
  accountId?: string,
): Promise<DncListResponse> {
  const qs = new URLSearchParams();
  if (params.phone) qs.set('phone', params.phone);
  if (params.account_id) qs.set('account_id', params.account_id);
  if (params.campaign_id) qs.set('campaign_id', params.campaign_id);
  if (params.source) qs.set('source', params.source);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));

  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch<DncListResponse>(`${ENDPOINTS.dnc.base}${suffix}`, {}, tenantId, accountId);
}

/**
 * Add numbers.
 *
 * Answers **200 with a per-number breakdown**, never a bare success: a bulk add
 * is normally partially redundant, and "412 added, 88 already there, 3 invalid"
 * is the answer an operator needs. Invalid numbers do NOT fail the request, so
 * the caller must read `summary.results` rather than assuming everything landed.
 *
 * `accountId` is deliberately **not** defaulted into the body. Omitting
 * `account_id` means tenant-wide, and tenant-wide is the only scope core's flat
 * `dnc:{tenantId}` Redis set can express — an account-scoped row never reaches
 * core and so never suppresses a dial. Passing the active account here would
 * silently produce entries that look suppressed in this list and are not
 * suppressed on the wire. The header still carries the account for auth; the
 * body scope is a separate, deliberate decision.
 */
export async function addDncEntries(
  input: {
    phone_numbers: string[];
    source?: DncSource;
    reason?: string;
    /** Pass explicitly to scope the rows. Omit for tenant-wide, which is what suppresses dials. */
    account_id?: string | null;
    campaign_id?: string | null;
  },
  tenantId?: string,
  accountId?: string,
): Promise<DncAddSummary> {
  return apiFetch<DncAddSummary>(
    ENDPOINTS.dnc.base,
    { method: 'POST', body: JSON.stringify(input) },
    tenantId,
    accountId,
  );
}

/** Remove one entry, making the number dialable again. 404 for an unknown id. */
export async function removeDncEntry(
  id: string,
  tenantId?: string,
  accountId?: string,
): Promise<{ removed: DncEntry }> {
  return apiFetch<{ removed: DncEntry }>(
    ENDPOINTS.dnc.get(id),
    { method: 'DELETE' },
    tenantId,
    accountId,
  );
}
