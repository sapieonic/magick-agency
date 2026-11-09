import { API_BASE } from '../config';
import { apiFetch } from './client';
import { buildAuthHeaders } from './authHeaders';
import { captureApiError } from './error-analytics';
import { errorCode, errorStatus } from '../utils/agencyErrors';
import {
  AGENCY_INBOUND_ERROR_CODES,
  type AgencyInboundCall,
  type AgencyInboundCallDispositionRequest,
  type AgencyInboundCallDispositionResponse,
  type AgencyInboundCallDncResponse,
  type AgencyInboundCallResponse,
  type AgencyInboundErrorResponse,
  type AgencyInboundQueueResponse,
  type AgencyInboundClipsResponse,
  type AgencyInboundErrorCode,
  type AgencyInboundMarkHandledResponse,
  type AgencyInboundReopenResponse,
  type AgencyInboundMissedCall,
  type AgencyInboundMissedAssignRequest,
  type AgencyInboundMissedAssignResponse,
  type AgencyInboundMissedCountResponse,
  type AgencyInboundMissedListQuery,
  type AgencyInboundSummary,
  type AgencyInboundSummaryQuery,
  type AgencyInboundMissedPage,
  type AgencyInboundNumbersResponse,
  type AgencyInboundRoute,
  type AgencyInboundRouteCreateRequest,
  type AgencyInboundRouteResponse,
  type AgencyInboundRoutesResponse,
  type AgencyInboundRouteUpdateRequest,
} from '../types/inbound';

/**
 * Inbound calls (`docs/inbound.md` §7, §8.1). One function per route of the fixed surface:
 *
 *   GET    /proxy/agency/inbound/routes                → the account's routes
 *   GET    /proxy/agency/inbound/routes/:id            → one route
 *   POST   /proxy/agency/inbound/routes                → 201 route
 *   PATCH  /proxy/agency/inbound/routes/:id            → route
 *   DELETE /proxy/agency/inbound/routes/:id            → 204
 *   GET    /proxy/agency/inbound/numbers               → the editor's number choices
 *   GET    /proxy/agency/inbound/clips                 → the account's audio files
 *   GET    /proxy/agency/inbound/missed                → a page of Missed rows
 *   POST   /proxy/agency/inbound/missed/:id/handled    → the row, handled
 *   POST   /proxy/agency/inbound/missed/:id/reopen     → the row, open again
 *   POST   /proxy/agency/inbound/missed/:id/assign     → the row, reassigned (supervisors)
 *   GET    /proxy/agency/inbound/missed/count          → the nav badge's count
 *   GET    /proxy/agency/inbound/summary               → the inbound summary (supervisors)
 *   GET    <voicemail_url> (the Missed row's)          → the voicemail's audio
 *
 * And the agent's inbound call (P2, §6) and the supervisor's queue, under the same prefix:
 *
 *   GET    /proxy/agency/inbound/calls/:id             → { call }
 *   PATCH  /proxy/agency/inbound/calls/:id             → { call }   (notes autosave)
 *   POST   /proxy/agency/inbound/calls/:id/hangup      → { call }
 *   POST   /proxy/agency/inbound/calls/:id/disposition → AgencyInboundCallDispositionResponse
 *   POST   /proxy/agency/inbound/calls/:id/dnc         → AgencyInboundCallDncResponse
 *   GET    /proxy/agency/inbound/queue                 → AgencyInboundQueueResponse
 *
 * Every path is built by {@link INBOUND_PATHS}, so a renamed route is one edit here.
 *
 * Every route is account-scoped and behind `agency_inbound_enabled` (`403 inbound_disabled`),
 * except the five call routes, which finish a call the flag may have been turned off under (the
 * soft phone's rule), and the Missed list's count, reassign, reopen and the summary: the follow-up of
 * calls that already came in, which turning inbound off does not stop.
 * Reads throw like the rest of the console's clients (their failure is a page state). The
 * writes resolve to an {@link InboundResult}: a refusal is something the admin acts on (a
 * field to fix, a number to drop), so it is a value the form switches on, not an exception.
 */

const enc = encodeURIComponent;

/**
 * Every inbound path the console calls, in one place. The call routes and the queue are the
 * server's P2 build, named against the contract (`AgencyInboundCall*`,
 * `AgencyInboundQueueResponse`): a server-side rename is one edit here.
 */
export const INBOUND_PATHS = {
  base: `${API_BASE}/proxy/agency/inbound`,
  call: (callId: string) => `${API_BASE}/proxy/agency/inbound/calls/${enc(callId)}`,
  callHangup: (callId: string) => `${API_BASE}/proxy/agency/inbound/calls/${enc(callId)}/hangup`,
  callDisposition: (callId: string) => `${API_BASE}/proxy/agency/inbound/calls/${enc(callId)}/disposition`,
  callDnc: (callId: string) => `${API_BASE}/proxy/agency/inbound/calls/${enc(callId)}/dnc`,
  queue: `${API_BASE}/proxy/agency/inbound/queue`,
  missedCount: `${API_BASE}/proxy/agency/inbound/missed/count`,
  missedAssign: (callId: string) => `${API_BASE}/proxy/agency/inbound/missed/${enc(callId)}/assign`,
  missedReopen: (callId: string) => `${API_BASE}/proxy/agency/inbound/missed/${enc(callId)}/reopen`,
  summary: `${API_BASE}/proxy/agency/inbound/summary`,
} as const;

const INBOUND = INBOUND_PATHS.base;

// ─── Refusals ───────────────────────────────────────────────────────────────

export interface InboundRefusal {
  /** A contract code, or `unknown` (a network failure, a masked 5xx, an RBAC 403). */
  code: AgencyInboundErrorCode | 'unknown';
  status: number | null;
  /** The server's sentence: the floor when the console has no better copy. */
  message: string;
  details: Array<{ path: string; message: string }>;
  phoneNumberId: string | null;
  routeId: string | null;
  /** `inbound_call_live` and the call routes' refusals: the call refused for. */
  inboundCallId: string | null;
  /** `inbound_disposition_invalid` (`unknown_code`): the codes the call's catalog accepts. */
  allowedCodes: string[] | null;
  /** `inbound_disposition_invalid`: which rule refused. */
  reason: InboundDispositionRule | null;
}

/** Which rule refused an outcome (`inbound_disposition_invalid`). */
export type InboundDispositionRule = NonNullable<AgencyInboundErrorResponse['reason']>;

export type InboundResult<T> = { ok: true; value: T } | { ok: false; refusal: InboundRefusal };

const KNOWN: ReadonlySet<string> = new Set(AGENCY_INBOUND_ERROR_CODES);
const DISPOSITION_RULES: ReadonlySet<string> = new Set<InboundDispositionRule>([
  'unknown_code',
  'note_required',
  'datetime_required',
  'invalid_callback_at',
]);

/** Read an inbound refusal off whatever `apiFetch` threw (`ApiError.details` / `.statusCode`). */
export function parseInboundRefusal(err: unknown): InboundRefusal {
  const raw = err && typeof err === 'object' ? (err as { details?: unknown }).details : undefined;
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const code = errorCode(err);
  const fallback = err instanceof Error && err.message ? err.message : 'That didn’t go through. Try again in a moment.';
  const details = Array.isArray(body['details'])
    ? (body['details'] as unknown[]).filter(
        (d): d is { path: string; message: string } =>
          !!d && typeof d === 'object' && typeof (d as { path?: unknown }).path === 'string'
          && typeof (d as { message?: unknown }).message === 'string',
      )
    : [];
  return {
    code: code && KNOWN.has(code) ? (code as AgencyInboundErrorCode) : 'unknown',
    status: errorStatus(err),
    message: typeof body['message'] === 'string' && body['message'].trim() ? body['message'] : fallback,
    details,
    phoneNumberId: typeof body['phone_number_id'] === 'string' ? body['phone_number_id'] : null,
    routeId: typeof body['route_id'] === 'string' ? body['route_id'] : null,
    inboundCallId: typeof body['inbound_call_id'] === 'string' ? body['inbound_call_id'] : null,
    allowedCodes: Array.isArray(body['allowed_codes'])
      ? (body['allowed_codes'] as unknown[]).filter((c): c is string => typeof c === 'string')
      : null,
    reason: typeof body['reason'] === 'string' && DISPOSITION_RULES.has(body['reason'])
      ? (body['reason'] as InboundDispositionRule)
      : null,
  };
}

async function result<T>(run: () => Promise<T>): Promise<InboundResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    return { ok: false, refusal: parseInboundRefusal(err) };
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function listInboundRoutes(tenantId?: string, accountId?: string): Promise<AgencyInboundRoute[]> {
  const body = await apiFetch<AgencyInboundRoutesResponse>(`${INBOUND}/routes`, {}, tenantId, accountId);
  return body.routes;
}

export async function getInboundRoute(routeId: string, tenantId?: string, accountId?: string): Promise<AgencyInboundRoute> {
  const body = await apiFetch<AgencyInboundRouteResponse>(`${INBOUND}/routes/${enc(routeId)}`, {}, tenantId, accountId);
  return body.route;
}

export function createInboundRoute(
  request: AgencyInboundRouteCreateRequest,
  tenantId?: string,
  accountId?: string,
): Promise<InboundResult<AgencyInboundRoute>> {
  return result(async () => {
    const body = await apiFetch<AgencyInboundRouteResponse>(
      `${INBOUND}/routes`, { method: 'POST', body: JSON.stringify(request) }, tenantId, accountId,
    );
    return body.route;
  });
}

export function updateInboundRoute(
  routeId: string,
  patch: AgencyInboundRouteUpdateRequest,
  tenantId?: string,
  accountId?: string,
): Promise<InboundResult<AgencyInboundRoute>> {
  return result(async () => {
    const body = await apiFetch<AgencyInboundRouteResponse>(
      `${INBOUND}/routes/${enc(routeId)}`, { method: 'PATCH', body: JSON.stringify(patch) }, tenantId, accountId,
    );
    return body.route;
  });
}

export function deleteInboundRoute(routeId: string, tenantId?: string, accountId?: string): Promise<InboundResult<void>> {
  return result(() => apiFetch<void>(`${INBOUND}/routes/${enc(routeId)}`, { method: 'DELETE' }, tenantId, accountId));
}

export function listInboundNumbers(tenantId?: string, accountId?: string): Promise<AgencyInboundNumbersResponse> {
  return apiFetch<AgencyInboundNumbersResponse>(`${INBOUND}/numbers`, {}, tenantId, accountId);
}

export function listInboundClips(tenantId?: string, accountId?: string): Promise<AgencyInboundClipsResponse> {
  return apiFetch<AgencyInboundClipsResponse>(`${INBOUND}/clips`, {}, tenantId, accountId);
}

// ─── The Missed inbound list ────────────────────────────────────────────────

/** The query string of a Missed page; absent and empty values are left out. */
export function missedQueryString(query: AgencyInboundMissedListQuery): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

export function listMissedInboundCalls(
  query: AgencyInboundMissedListQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyInboundMissedPage> {
  return apiFetch<AgencyInboundMissedPage>(`${INBOUND}/missed${missedQueryString(query)}`, {}, tenantId, accountId);
}

/** Idempotent: a row already handled comes back as it is, with its first handler. */
export function markMissedInboundCallHandled(
  callId: string,
  tenantId?: string,
  accountId?: string,
): Promise<InboundResult<AgencyInboundMissedCall>> {
  return result(async () => {
    const body = await apiFetch<AgencyInboundMarkHandledResponse>(
      `${INBOUND}/missed/${enc(callId)}/handled`, { method: 'POST' }, tenantId, accountId,
    );
    return body.call;
  });
}

/**
 * `POST /inbound/missed/:id/reopen`: put a handled row back on the list (Mark handled's rules: an
 * agent's own rows, a supervisor's the account's). Idempotent: an open row comes back as it is.
 * Refusal: `inbound_missed_call_not_found`.
 */
export function reopenMissedInboundCall(
  callId: string,
  tenantId?: string,
  accountId?: string,
): Promise<InboundResult<AgencyInboundMissedCall>> {
  return result(async () => {
    const body = await apiFetch<AgencyInboundReopenResponse>(INBOUND_PATHS.missedReopen(callId), { method: 'POST' }, tenantId, accountId);
    return body.call;
  });
}

/**
 * `POST /inbound/missed/:id/assign` (`agency.supervise`): give an open row to a member of the
 * account, or to the account (`null`). Refusals: `inbound_assignee_invalid` (not an active member),
 * `inbound_missed_call_handled`, `inbound_missed_call_not_found`.
 */
export function assignMissedInboundCall(
  callId: string,
  assigneeUserId: string | null,
  tenantId?: string,
  accountId?: string,
): Promise<InboundResult<AgencyInboundMissedCall>> {
  const request: AgencyInboundMissedAssignRequest = { assignee_user_id: assigneeUserId };
  return result(async () => {
    const body = await apiFetch<AgencyInboundMissedAssignResponse>(
      INBOUND_PATHS.missedAssign(callId), { method: 'POST', body: JSON.stringify(request) }, tenantId, accountId,
    );
    return body.call;
  });
}

/** `GET /inbound/missed/count`: the nav badge (the caller's scope). A read; throws. */
export function getMissedInboundCount(tenantId?: string, accountId?: string): Promise<AgencyInboundMissedCountResponse> {
  return apiFetch<AgencyInboundMissedCountResponse>(INBOUND_PATHS.missedCount, {}, tenantId, accountId);
}

// ─── The inbound summary (supervisors) ──────────────────────────────────────

/** `GET /inbound/summary?from&to` (`agency.supervise`). A read; throws. */
export function getInboundSummary(query: AgencyInboundSummaryQuery, tenantId?: string, accountId?: string): Promise<AgencyInboundSummary> {
  const qs = new URLSearchParams({ from: query.from, to: query.to });
  return apiFetch<AgencyInboundSummary>(`${INBOUND_PATHS.summary}?${qs.toString()}`, {}, tenantId, accountId);
}

// ─── The voicemail on a Missed row (P2) ─────────────────────────────────────

/** The only shape a voicemail's path may have: the Missed row's own route, under the proxy or relative to it. */
const VOICEMAIL_PATH_RE = /^\/(?:proxy\/agency\/)?inbound\/missed\/[A-Za-z0-9-]+\/voicemail$/;

/**
 * Where a Missed row's `voicemail_url` is fetched from, or null when it is not one we will send the
 * console's token to. The contract states it relative to the proxy (`/inbound/missed/:id/voicemail`,
 * under `/proxy/agency`); a path that already starts `/proxy/agency/` is taken as it is. Anything
 * else (an absolute or protocol-relative URL, another path, a query, a `..`) is refused: the fetch
 * carries the bearer token, which must only ever go to our own API (`API_BASE`), whatever a
 * server mistake or contract drift puts in the field.
 */
export function voicemailFetchUrl(voicemailUrl: string): string | null {
  const path = voicemailUrl.startsWith('/') ? voicemailUrl : `/${voicemailUrl}`;
  if (!VOICEMAIL_PATH_RE.test(path)) return null;
  return path.startsWith('/proxy/') ? `${API_BASE}${path}` : `${API_BASE}/proxy/agency${path}`;
}

export type VoicemailAudio = { status: 'ready'; url: string } | { status: 'unavailable'; message: string };

export const VOICEMAIL_GONE_COPY = 'This voicemail is no longer available.';
export const VOICEMAIL_FAILED_COPY = 'We couldn’t load the voicemail. Try again in a moment.';

/**
 * The voicemail as a blob URL for an `<audio>` element: the route needs the console's bearer
 * token, which an `<audio src>` cannot send (the manual call's recording is fetched the same way).
 * The caller revokes the URL when it is done with it.
 */
export async function fetchVoicemailBlobUrl(
  voicemailUrl: string,
  tenantId: string,
  accountId?: string,
): Promise<VoicemailAudio> {
  const url = voicemailFetchUrl(voicemailUrl);
  // Not our route: never sent anywhere with the token.
  if (url === null) return { status: 'unavailable', message: VOICEMAIL_FAILED_COPY };
  try {
    const headers = await buildAuthHeaders(tenantId, accountId);
    const res = await fetch(url, { headers });
    if (!res.ok) {
      captureApiError(url, res);
      return { status: 'unavailable', message: res.status === 404 ? VOICEMAIL_GONE_COPY : VOICEMAIL_FAILED_COPY };
    }
    const blob = await res.blob();
    return { status: 'ready', url: URL.createObjectURL(blob) };
  } catch {
    return { status: 'unavailable', message: VOICEMAIL_FAILED_COPY };
  }
}

// ─── The agent's inbound call (P2, §6) ──────────────────────────────────────

/**
 * `GET /inbound/calls/:id`: the call as the server holds it. A read, so it throws: the
 * reconnect's reconciliation decides what a refusal means.
 */
export async function getInboundCall(callId: string, tenantId?: string, accountId?: string): Promise<AgencyInboundCall> {
  const body = await apiFetch<AgencyInboundCallResponse>(INBOUND_PATHS.call(callId), {}, tenantId, accountId);
  return body.call;
}

/** `PATCH /inbound/calls/:id`: the notes (`''` clears them). Last write wins, while unsettled. */
export function updateInboundCallNotes(
  callId: string,
  notes: string,
  tenantId?: string,
  accountId?: string,
): Promise<InboundResult<AgencyInboundCall>> {
  return result(async () => {
    const body = await apiFetch<AgencyInboundCallResponse>(
      INBOUND_PATHS.call(callId), { method: 'PATCH', body: JSON.stringify({ notes }) }, tenantId, accountId,
    );
    return body.call;
  });
}

/**
 * `POST /inbound/calls/:id/hangup`. The answer is the call as read when the hang-up was issued
 * and may still say `connected`: the `inbound_call` frame is the authority for "the call is over".
 */
export function hangupInboundCall(callId: string, tenantId?: string, accountId?: string): Promise<InboundResult<AgencyInboundCall>> {
  return result(async () => {
    const body = await apiFetch<AgencyInboundCallResponse>(
      INBOUND_PATHS.callHangup(callId), { method: 'POST', body: JSON.stringify({}) }, tenantId, accountId,
    );
    return body.call;
  });
}

/** `POST /inbound/calls/:id/disposition`: the outcome, once the call has ended after it was answered. */
export function dispositionInboundCall(
  callId: string,
  request: AgencyInboundCallDispositionRequest,
  tenantId?: string,
  accountId?: string,
): Promise<InboundResult<AgencyInboundCallDispositionResponse>> {
  return result(() =>
    apiFetch<AgencyInboundCallDispositionResponse>(
      INBOUND_PATHS.callDisposition(callId), { method: 'POST', body: JSON.stringify(request) }, tenantId, accountId,
    ),
  );
}

/** `POST /inbound/calls/:id/dnc`: campaign scope when the call matched a campaign, else the account (the server decides). */
export function markInboundCallDnc(
  callId: string,
  reason: string | undefined,
  tenantId?: string,
  accountId?: string,
): Promise<InboundResult<AgencyInboundCallDncResponse>> {
  const trimmed = reason?.trim();
  return result(() =>
    apiFetch<AgencyInboundCallDncResponse>(
      INBOUND_PATHS.callDnc(callId),
      { method: 'POST', body: JSON.stringify(trimmed ? { reason: trimmed } : {}) },
      tenantId,
      accountId,
    ),
  );
}

// ─── The supervisor's queue (P2, §6) ────────────────────────────────────────

/** `GET /inbound/queue` (`agency.supervise`): one tile per live route. Polled every 5 s; throws. */
export function getInboundQueue(tenantId?: string, accountId?: string): Promise<AgencyInboundQueueResponse> {
  return apiFetch<AgencyInboundQueueResponse>(INBOUND_PATHS.queue, {}, tenantId, accountId);
}
