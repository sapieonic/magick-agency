import { API_BASE } from '../config';
import { apiFetch } from './client';
import { buildAuthHeaders } from './authHeaders';
import { captureApiError } from './error-analytics';
import { recordingRefusal } from './agencySpine';
import { trackAgencyRecordingOutcome } from '../analytics/events';
import { errorStatus } from '../utils/agencyErrors';
import {
  AGENCY_SOFTPHONE_ERROR_CODES,
  type AgencyCallFieldValues,
  type AgencyManualCall,
  type AgencyManualCallCreateRequest,
  type AgencyManualCallDetail,
  type AgencyManualCallDispositionRequest,
  type AgencyManualCallDispositionResponse,
  type AgencyManualCallDncResponse,
  type AgencyManualCallListQuery,
  type AgencyManualCallsPage,
  type AgencySoftphoneBootstrap,
  type AgencySoftphoneCallPendingRefusal,
  type AgencySoftphoneContactInFlightRefusal,
  type AgencySoftphoneDncListedRefusal,
  type AgencySoftphoneErrorCode,
  type AgencySoftphoneOutsideHoursRefusal,
  type AgencySoftphoneSessionOnCampaignRefusal,
  type AgencySoftphoneSessionResponse,
  type AgencySoftphoneSettings,
  type AgencySoftphoneSettingsResponse,
  type AgencySoftphoneSettingsUpdateRequest,
} from '../types/softphone';
import type { AgencySessionStateResponse } from '../types/agency';
import type { RecordingOutcome } from '../types/webrtc-call';

/**
 * The soft phone's routes (`docs/softphone.md` §6), every one under
 * `/proxy/agency/softphone` except the two switch routes on a campaign session.
 *
 * ── Refusals are results, not exceptions ─────────────────────────────────────
 * Most soft-phone refusals are an answer the agent acts on — a DNC hit that can
 * be overridden with a note, a closed calling window, a campaign that is calling
 * the same customer right now — so every mutation here resolves to a
 * {@link SoftphoneResult} rather than throwing. The refusal is narrowed by code
 * where the contract gives it structured fields (`entry` on `dnc_listed`, the
 * window on `outside_calling_hours`, the pending call on `outcome_pending` /
 * `manual_call_live`), so a caller switches on `refusal.code` and the compiler
 * hands it the right shape. Reads (`bootstrap`, the lists, the detail, the
 * settings) throw like the rest of the console's clients: their failure is a
 * page state, not a decision.
 */

const SOFTPHONE_BASE = `${API_BASE}/proxy/agency/softphone`;
const SESSIONS_BASE = `${API_BASE}/proxy/agency/sessions`;

// ─── Refusals ───────────────────────────────────────────────────────────────

/** Codes whose body the contract narrows; everything else is {@link SoftphoneGenericRefusal}. */
type NarrowedCode =
  | 'dnc_listed'
  | 'outside_calling_hours'
  | 'contact_in_flight'
  | 'session_on_campaign'
  | 'outcome_pending'
  | 'manual_call_live';

interface RefusalBase {
  /** HTTP status, or null when the request never got an answer. */
  status: number | null;
  /** The server's sentence — the floor when the console has no better copy. */
  message: string;
}

export type SoftphoneDncListedRefusal = RefusalBase & Omit<AgencySoftphoneDncListedRefusal, 'error' | 'message'>;
export type SoftphoneOutsideHoursRefusal = RefusalBase & Omit<AgencySoftphoneOutsideHoursRefusal, 'error' | 'message'>;
export type SoftphoneContactInFlightRefusal = RefusalBase & Omit<AgencySoftphoneContactInFlightRefusal, 'error' | 'message'>;
export type SoftphoneSessionOnCampaignRefusal = RefusalBase & Omit<AgencySoftphoneSessionOnCampaignRefusal, 'error' | 'message'>;
export type SoftphoneCallPendingRefusal = RefusalBase & Omit<AgencySoftphoneCallPendingRefusal, 'error' | 'message'>;

export interface SoftphoneGenericRefusal extends RefusalBase {
  code: Exclude<AgencySoftphoneErrorCode, NarrowedCode>;
  allowed_codes?: string[];
  details?: Array<{ path: string; message: string }>;
}

/**
 * Not a soft-phone code at all: a network failure, a masked 5xx, an agency action
 * code from a shared route. Carried as a refusal so a caller has one branch to
 * write, with the server's (or the client's) sentence.
 */
export interface SoftphoneUnknownRefusal extends RefusalBase {
  code: 'unknown';
  /** The raw code when the body carried one we do not know. */
  raw_code: string | null;
}

export type SoftphoneRefusal =
  | SoftphoneDncListedRefusal
  | SoftphoneOutsideHoursRefusal
  | SoftphoneContactInFlightRefusal
  | SoftphoneSessionOnCampaignRefusal
  | SoftphoneCallPendingRefusal
  | SoftphoneGenericRefusal
  | SoftphoneUnknownRefusal;

export type SoftphoneResult<T> = { ok: true; value: T } | { ok: false; refusal: SoftphoneRefusal };

const KNOWN_CODES: ReadonlySet<string> = new Set(AGENCY_SOFTPHONE_ERROR_CODES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCall(value: unknown): value is AgencyManualCall {
  return isRecord(value) && typeof value['id'] === 'string' && typeof value['state'] === 'string';
}

/**
 * Read a soft-phone refusal off whatever `apiFetch` threw (`ApiError.details` /
 * `.statusCode`, never `body`/`status` — see `utils/agencyErrors`).
 *
 * A narrowed code whose structured field is missing degrades to `unknown` with
 * the server's sentence rather than to a half-typed object: a DNC refusal without
 * its `entry` cannot honestly open the override dialog, which promises to say
 * exactly what matched.
 */
export function parseSoftphoneRefusal(err: unknown): SoftphoneRefusal {
  const status = errorStatus(err);
  const details = isRecord(err) ? (err as { details?: unknown }).details : undefined;
  const fallbackMessage =
    err instanceof Error && err.message ? err.message : 'That didn’t go through. Try again in a moment.';
  if (!isRecord(details)) {
    return { code: 'unknown', raw_code: null, status, message: fallbackMessage };
  }
  const code = typeof details['code'] === 'string' ? details['code'] : null;
  const message =
    typeof details['message'] === 'string' && details['message'].trim() ? details['message'] : fallbackMessage;
  if (code === null || !KNOWN_CODES.has(code)) {
    return { code: 'unknown', raw_code: code, status, message };
  }
  const known = code as AgencySoftphoneErrorCode;
  const unknown = (): SoftphoneUnknownRefusal => ({ code: 'unknown', raw_code: code, status, message });

  switch (known) {
    case 'dnc_listed': {
      const entry = details['entry'];
      if (!isRecord(entry) || typeof entry['id'] !== 'string') return unknown();
      return {
        code: 'dnc_listed',
        status,
        message,
        entry: {
          id: entry['id'],
          scope: entry['scope'] === 'campaign' || entry['scope'] === 'account' ? entry['scope'] : 'tenant',
          reason: typeof entry['reason'] === 'string' ? entry['reason'] : null,
          created_at: typeof entry['created_at'] === 'string' ? entry['created_at'] : '',
        },
      };
    }
    case 'outside_calling_hours': {
      const window = details['window'];
      if (!isRecord(window) || typeof window['start'] !== 'string' || typeof window['end'] !== 'string') {
        return unknown();
      }
      return {
        code: 'outside_calling_hours',
        status,
        message,
        window: {
          start: window['start'],
          end: window['end'],
          days: Array.isArray(window['days']) ? (window['days'] as unknown[]).filter((d): d is number => typeof d === 'number') : [],
          timezone: typeof window['timezone'] === 'string' ? window['timezone'] : 'UTC',
        },
        timezone_source: details['timezone_source'] === 'contact' ? 'contact' : 'campaign_default',
        next_open_at: typeof details['next_open_at'] === 'string' ? details['next_open_at'] : null,
      };
    }
    case 'contact_in_flight':
      return {
        code: 'contact_in_flight',
        status,
        message,
        campaign_id: typeof details['campaign_id'] === 'string' ? details['campaign_id'] : '',
        contact_id: typeof details['contact_id'] === 'string' ? details['contact_id'] : '',
      };
    case 'session_on_campaign': {
      if (typeof details['session_id'] !== 'string' || typeof details['campaign_id'] !== 'string') return unknown();
      return {
        code: 'session_on_campaign',
        status,
        message,
        session_id: details['session_id'],
        campaign_id: details['campaign_id'],
        campaign_name: typeof details['campaign_name'] === 'string' ? details['campaign_name'] : 'your campaign',
        state: (typeof details['state'] === 'string' ? details['state'] : 'offline') as SoftphoneSessionOnCampaignRefusal['state'],
      };
    }
    case 'outcome_pending':
    case 'manual_call_live': {
      const call = details['call'];
      if (!isCall(call)) {
        // The pending call is what lets the console show it instead of an error;
        // without it the refusal is still true, so it stays a generic one.
        return { code: 'unknown', raw_code: code, status, message };
      }
      return { code: known, status, message, call };
    }
    default: {
      const generic: SoftphoneGenericRefusal = { code: known, status, message };
      if (Array.isArray(details['allowed_codes'])) {
        generic.allowed_codes = (details['allowed_codes'] as unknown[]).filter((c): c is string => typeof c === 'string');
      }
      if (Array.isArray(details['details'])) {
        generic.details = (details['details'] as unknown[])
          .filter(isRecord)
          .filter((d) => typeof d['path'] === 'string' && typeof d['message'] === 'string')
          .map((d) => ({ path: d['path'] as string, message: d['message'] as string }));
      }
      return generic;
    }
  }
}

async function attempt<T>(request: () => Promise<T>): Promise<SoftphoneResult<T>> {
  try {
    return { ok: true, value: await request() };
  } catch (err) {
    return { ok: false, refusal: parseSoftphoneRefusal(err) };
  }
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** `GET /bootstrap`: everything the soft phone renders with, in one response. */
export function getSoftphoneBootstrap(tenantId?: string, accountId?: string): Promise<AgencySoftphoneBootstrap> {
  return apiFetch<AgencySoftphoneBootstrap>(`${SOFTPHONE_BASE}/bootstrap`, {}, tenantId, accountId);
}

/** Query → string. Only set keys are sent, so an empty filter is the server's default. */
export function manualCallQuery(query: AgencyManualCallListQuery): string {
  const qs = new URLSearchParams();
  const keys: (keyof AgencyManualCallListQuery)[] = [
    'cursor',
    'limit',
    'agent_user_id',
    'campaign_id',
    'status',
    'outcome',
    'disposition_code',
    'phone',
    'from',
    'to',
  ];
  for (const key of keys) {
    const value = query[key];
    if (value === undefined || value === null || value === '') continue;
    qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

/** `GET /calls`: the caller's own calls, or the account's with `agency.supervise`. */
export function listManualCalls(
  query: AgencyManualCallListQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyManualCallsPage> {
  return apiFetch<AgencyManualCallsPage>(`${SOFTPHONE_BASE}/calls${manualCallQuery(query)}`, {}, tenantId, accountId);
}

/** `GET /calls/:id`: the call, its overrides, and its media leg. */
export function getManualCall(callId: string, tenantId?: string, accountId?: string): Promise<AgencyManualCallDetail> {
  return apiFetch<AgencyManualCallDetail>(
    `${SOFTPHONE_BASE}/calls/${encodeURIComponent(callId)}`,
    {},
    tenantId,
    accountId,
  );
}

/** `GET /settings`, at the agent floor. */
export async function getSoftphoneSettings(tenantId?: string, accountId?: string): Promise<AgencySoftphoneSettings> {
  const res = await apiFetch<AgencySoftphoneSettingsResponse>(`${SOFTPHONE_BASE}/settings`, {}, tenantId, accountId);
  return res.settings;
}

/**
 * The manual call's recording as a blob URL, for `CallDetailView`'s player.
 *
 * **Not in `docs/softphone.md` §6.** The campaign attempt's recording is served
 * by `GET /proxy/agency/campaigns/:id/attempts/:attemptId/recording`, keyed on the
 * attempt so the reader stays in the agency shell; this is the same shape keyed
 * on the manual call. Refusals read exactly as the attempt's do.
 */
export async function fetchManualCallRecordingBlobUrl(
  callId: string,
  tenantId: string,
  accountId?: string,
): Promise<RecordingOutcome> {
  const url = `${SOFTPHONE_BASE}/calls/${encodeURIComponent(callId)}/recording`;
  const headers = await buildAuthHeaders(tenantId, accountId);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    captureApiError(url, res);
    const outcome = await recordingRefusal(res);
    if (outcome.status !== 'ready') trackAgencyRecordingOutcome({ status: outcome.status });
    return outcome;
  }
  const blob = await res.blob();
  trackAgencyRecordingOutcome({ status: 'ok' });
  return { status: 'ready', url: URL.createObjectURL(blob), mimeType: res.headers.get('content-type') ?? blob.type ?? null };
}

// ─── Sessions ───────────────────────────────────────────────────────────────

/**
 * `POST /sessions`: open (or rehydrate) a soft-phone session. 409
 * `session_on_campaign` when the agent is live on a campaign — the remedy is the
 * switch on that session, which the refusal names.
 */
export function openSoftphoneSession(
  tenantId?: string,
  accountId?: string,
): Promise<SoftphoneResult<AgencySoftphoneSessionResponse>> {
  return attempt(() =>
    apiFetch<AgencySoftphoneSessionResponse>(
      `${SOFTPHONE_BASE}/sessions`,
      { method: 'POST', body: JSON.stringify({}) },
      tenantId,
      accountId,
    ),
  );
}

/**
 * `POST /proxy/agency/sessions/:id/softphone` (SP7): break from the campaign onto
 * the soft phone. Queued like any break while the agent is on a call or in
 * wrap-up — the answer then carries `pending_state: 'break'`.
 */
export function switchToSoftphone(
  sessionId: string,
  tenantId?: string,
  accountId?: string,
): Promise<SoftphoneResult<AgencySessionStateResponse>> {
  return attempt(() =>
    apiFetch<AgencySessionStateResponse>(
      `${SESSIONS_BASE}/${encodeURIComponent(sessionId)}/softphone`,
      { method: 'POST', body: JSON.stringify({}) },
      tenantId,
      accountId,
    ),
  );
}

/** `POST /proxy/agency/sessions/:id/softphone/return`: back to the campaign. 409 `manual_call_live` while a call is unsettled. */
export function returnFromSoftphone(
  sessionId: string,
  tenantId?: string,
  accountId?: string,
): Promise<SoftphoneResult<AgencySessionStateResponse>> {
  return attempt(() =>
    apiFetch<AgencySessionStateResponse>(
      `${SESSIONS_BASE}/${encodeURIComponent(sessionId)}/softphone/return`,
      { method: 'POST', body: JSON.stringify({}) },
      tenantId,
      accountId,
    ),
  );
}

// ─── Calls ──────────────────────────────────────────────────────────────────

/** `POST /calls` → 201 the call. Refusals: §4.1 step 2's pre-dial gates, in order. */
export function placeManualCall(
  body: AgencyManualCallCreateRequest,
  tenantId?: string,
  accountId?: string,
): Promise<SoftphoneResult<AgencyManualCall>> {
  return attempt(() =>
    apiFetch<AgencyManualCall>(
      `${SOFTPHONE_BASE}/calls`,
      { method: 'POST', body: JSON.stringify(body) },
      tenantId,
      accountId,
    ),
  );
}

/** `PATCH /calls/:id`: replace the call details and/or the notes. Last write wins. */
export function updateManualCall(
  callId: string,
  body: { fields?: AgencyCallFieldValues; notes?: string },
  tenantId?: string,
  accountId?: string,
): Promise<SoftphoneResult<AgencyManualCall>> {
  return attempt(() =>
    apiFetch<AgencyManualCall>(
      `${SOFTPHONE_BASE}/calls/${encodeURIComponent(callId)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
      tenantId,
      accountId,
    ),
  );
}

/**
 * `POST /calls/:id/hangup`. The answer may still be live: the `manual_call`
 * frame is the authority for "the call is over". A ringing call keeps ringing on
 * the customer's side (SP3).
 */
export function hangupManualCall(
  callId: string,
  tenantId?: string,
  accountId?: string,
): Promise<SoftphoneResult<AgencyManualCall>> {
  return attempt(() =>
    apiFetch<AgencyManualCall>(
      `${SOFTPHONE_BASE}/calls/${encodeURIComponent(callId)}/hangup`,
      { method: 'POST', body: JSON.stringify({}) },
      tenantId,
      accountId,
    ),
  );
}

/** `POST /calls/:id/disposition`: save the outcome. */
export function dispositionManualCall(
  callId: string,
  body: AgencyManualCallDispositionRequest,
  tenantId?: string,
  accountId?: string,
): Promise<SoftphoneResult<AgencyManualCallDispositionResponse>> {
  return attempt(() =>
    apiFetch<AgencyManualCallDispositionResponse>(
      `${SOFTPHONE_BASE}/calls/${encodeURIComponent(callId)}/disposition`,
      { method: 'POST', body: JSON.stringify(body) },
      tenantId,
      accountId,
    ),
  );
}

/** `POST /calls/:id/dnc`: campaign scope when tagged, else tenant — the server decides. */
export function markManualCallDnc(
  callId: string,
  reason: string | undefined,
  tenantId?: string,
  accountId?: string,
): Promise<SoftphoneResult<AgencyManualCallDncResponse>> {
  const trimmed = reason?.trim();
  return attempt(() =>
    apiFetch<AgencyManualCallDncResponse>(
      `${SOFTPHONE_BASE}/calls/${encodeURIComponent(callId)}/dnc`,
      { method: 'POST', body: JSON.stringify(trimmed ? { reason: trimmed } : {}) },
      tenantId,
      accountId,
    ),
  );
}

// ─── Settings ───────────────────────────────────────────────────────────────

/** `PUT /settings`: replaces the whole row. `agency.softphone.manage`. */
export function putSoftphoneSettings(
  body: AgencySoftphoneSettingsUpdateRequest,
  tenantId?: string,
  accountId?: string,
): Promise<SoftphoneResult<AgencySoftphoneSettings>> {
  return attempt(async () => {
    const res = await apiFetch<AgencySoftphoneSettingsResponse>(
      `${SOFTPHONE_BASE}/settings`,
      { method: 'PUT', body: JSON.stringify(body) },
      tenantId,
      accountId,
    );
    return res.settings;
  });
}
