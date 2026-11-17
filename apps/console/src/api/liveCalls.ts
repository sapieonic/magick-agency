import { API_BASE } from '../config';
import { apiFetch } from './client';
import { errorCode, errorStatus } from '../utils/agencyErrors';
import type {
  AgencyListenGrant,
  AgencyLiveCallNumberResponse,
  AgencyLiveCallsQuery,
  AgencyLiveCallsResponse,
} from '../types/live-calls';

/**
 * Live calls and listening (`docs/listening.md`; `packages/contracts/src/api/agency/live-calls.ts`),
 * every route under `/proxy/agency` with the tenant and account headers. Each answers
 * `403 feature_disabled` while `agency_live_listen_enabled` is off for the account.
 *
 * Reads throw like the rest of the console's clients (their failure is a page state). The grant
 * resolves to a {@link ListenGrantResult}: a refusal is an answer the bar or a toast says, and
 * `useListenSession`'s reducer decides from its status and code what happens next.
 */

const LIVE_CALLS_BASE = `${API_BASE}/proxy/agency/live-calls`;

/** `GET /live-calls`: the account's calls in progress, or one campaign's (numbers masked). */
export function listLiveCalls(
  query: AgencyLiveCallsQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyLiveCallsResponse> {
  const qs = new URLSearchParams();
  // A blank campaign id is "no filter", not a filter matching nothing.
  if (query.campaign_id) qs.set('campaign_id', query.campaign_id);
  const search = qs.toString();
  return apiFetch<AgencyLiveCallsResponse>(`${LIVE_CALLS_BASE}${search ? `?${search}` : ''}`, {}, tenantId, accountId);
}

/** `GET /live-calls/:callId/number`: one row's full number, on demand (LS9). Never kept in the polled list. */
export function revealLiveCallNumber(
  callId: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyLiveCallNumberResponse> {
  return apiFetch<AgencyLiveCallNumberResponse>(
    `${LIVE_CALLS_BASE}/${encodeURIComponent(callId)}/number`,
    {},
    tenantId,
    accountId,
  );
}

export type ListenGrantResult =
  | { ok: true; grant: AgencyListenGrant }
  /** `status` null: no answer at all (offline, the request failed). `code` the body's, when it had one. */
  | { ok: false; status: number | null; code: string | null };

/** `POST /live-calls/:callId/listen`, no body: a grant to open the listener socket with. */
export async function grantListen(callId: string, tenantId?: string, accountId?: string): Promise<ListenGrantResult> {
  try {
    const grant = await apiFetch<AgencyListenGrant>(
      `${LIVE_CALLS_BASE}/${encodeURIComponent(callId)}/listen`,
      { method: 'POST' },
      tenantId,
      accountId,
    );
    return { ok: true, grant };
  } catch (err) {
    return { ok: false, status: errorStatus(err), code: errorCode(err) };
  }
}
