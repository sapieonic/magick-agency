import { API_BASE } from '../config';
import { apiFetch } from './client';
import type {
  AgencySupervisorMessageRequest,
  AgencySupervisorMessageResponse,
} from '@magick-agency/contracts/agency/floor-assist';
import type { AgencyCallbacksPage, AgencyCallbacksQuery } from '@magick-agency/contracts/api/agency/callbacks';

/**
 * The Live floor's Phase 3 reads and writes (decisions LF5, LF22): a supervisor's message to an
 * agent's station (Talk to agent and Send reminder) and the account's callbacks list. Both
 * `agency.supervise`, both take `accountId` (the server answers `400 account_scope_required`
 * without it).
 */

const AGENCY_BASE = `${API_BASE}/proxy/agency`;

/**
 * `POST /proxy/agency/sessions/:id/messages` (LF5, LF17): the text, trimmed, 1 to 500 characters,
 * shown on the agent's station. `201` once the station took it; refused `409 agent_not_live` (no
 * station that can show it), `400 message_invalid`, `403 floor_assist_disabled`, and a session not
 * in the account is the uniform 404.
 */
export function sendSupervisorMessage(
  sessionId: string,
  text: string,
  tenantId: string,
  accountId: string,
): Promise<AgencySupervisorMessageResponse> {
  const body: AgencySupervisorMessageRequest = { text };
  return apiFetch<AgencySupervisorMessageResponse>(
    `${AGENCY_BASE}/sessions/${encodeURIComponent(sessionId)}/messages`,
    { method: 'POST', body: JSON.stringify(body) },
    tenantId,
    accountId,
  );
}

/**
 * `GET /proxy/agency/callbacks` (LF22): one keyset page of the account's open callbacks, overdue
 * (the default) or due later today, optionally one campaign's. Rows name the customer, never the
 * number.
 */
export function listAccountCallbacks(
  query: AgencyCallbacksQuery,
  tenantId: string,
  accountId: string,
): Promise<AgencyCallbacksPage> {
  const params = new URLSearchParams();
  if (query.due) params.set('due', query.due);
  if (query.campaign_id) params.set('campaign_id', query.campaign_id);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const search = params.toString();
  return apiFetch<AgencyCallbacksPage>(`${AGENCY_BASE}/callbacks${search ? `?${search}` : ''}`, {}, tenantId, accountId);
}
