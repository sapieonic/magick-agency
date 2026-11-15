import { ENDPOINTS } from '../config';
import { apiFetch } from './client';
import type {
  DncAddRequest,
  DncAddSummary,
  DncEntry,
  DncListParams,
  DncListResponse,
} from '../types/dnc';

/**
 * The Do Not Call list.
 *
 * **Served directly, not through `/proxy/*`.** The server's `/dnc` routes read and write
 * `dnc_entries`, the one table every check reads (decision B8): the dial-time check, the roster
 * import and the soft phone. There is no copy of it anywhere else, so every scope added here is
 * enforced where it says.
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
  if (params.scope) qs.set('scope', params.scope);
  if (params.source) qs.set('source', params.source);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));

  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiFetch<DncListResponse>(`${ENDPOINTS.dnc.base}${suffix}`, {}, tenantId, accountId);
}

/**
 * Add numbers, at the scope the operator chose.
 *
 * Answers **200 with a per-number breakdown**, never a bare success: a bulk add
 * is normally partially redundant, and "412 added, 88 already there, 3 invalid"
 * is the answer an operator needs. Invalid numbers do NOT fail the request, so
 * the caller must read `summary.results` rather than assuming everything landed.
 *
 * The scope is always STATED (`scope`, with the account or campaign it names): leaving the ids
 * out means every campaign, so a body that lost its `campaign_id` on the way would otherwise
 * widen an add to the whole organisation. With `scope` the server refuses a body whose ids do
 * not agree with it (`invalid_dnc_scope`). The `X-Account-Id` header is for auth only and is
 * never read as the scope.
 */
export async function addDncEntries(
  input: DncAddRequest & Required<Pick<DncAddRequest, 'scope'>>,
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
