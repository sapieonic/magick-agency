import { API_BASE } from '../config';
import { apiFetch } from './client';
import { errorCode, errorStatus } from '../utils/agencyErrors';
import {
  AGENCY_INBOUND_ERROR_CODES,
  type AgencyInboundClipsResponse,
  type AgencyInboundErrorCode,
  type AgencyInboundMarkHandledResponse,
  type AgencyInboundMissedCall,
  type AgencyInboundMissedListQuery,
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
 *
 * Every route is account-scoped and behind `agency_inbound_enabled` (`403 inbound_disabled`).
 * Reads throw like the rest of the console's clients (their failure is a page state). The
 * writes resolve to an {@link InboundResult}: a refusal is something the admin acts on (a
 * field to fix, a number to drop), so it is a value the form switches on, not an exception.
 */

const INBOUND = `${API_BASE}/proxy/agency/inbound`;
const enc = encodeURIComponent;

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
}

export type InboundResult<T> = { ok: true; value: T } | { ok: false; refusal: InboundRefusal };

const KNOWN: ReadonlySet<string> = new Set(AGENCY_INBOUND_ERROR_CODES);

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
