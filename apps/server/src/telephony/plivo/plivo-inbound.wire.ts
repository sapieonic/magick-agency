/**
 * The Plivo REST shapes inbound needs (`docs/inbound.md` §8.1): an Application on the tenant's
 * account (create, read, update, delete, find by name), a number's app (read, set), and the
 * Record API that records a connected inbound call from its bind (at the end of the file). Request
 * bodies are built here and responses read here, as pure functions, so the fixture
 * (`plivo-carrier.fixture.json`, `inbound`) pins both sides; `PlivoAdapter` sends them.
 *
 * UNVERIFIED until the P0 live check (`docs/inbound.md` §12): the parameter and field names are
 * Plivo's documented ones (Application: `app_name`, `answer_url`/`answer_method`,
 * `hangup_url`/`hangup_method`, `fallback_answer_url`/`fallback_method`; create answers
 * `app_id`; a number's app is the `application` resource URI on `GET Number/{number}/` and is set
 * with `app_id` on `POST Number/{number}/`). Two are guesses P0 must settle: how a number is
 * cleared of every app (`app_id: null` here), and whether the list filters by `app_name` (it is
 * filtered again here, so a host that ignores the filter only costs pages).
 */
import type { PlivoInboundUrls } from './inbound-urls.js';
import { withInboundToken } from './inbound-urls.js';

/** A Plivo Application or number id that may go into a URL path. Anything else never does. */
export const PLIVO_APP_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** Page size for the Application list (Plivo's maximum is 20). */
export const PLIVO_APPLICATIONS_PAGE_SIZE = 20;
/**
 * Pages one find-by-name reads at most (100 Applications). The list is filtered by name at Plivo
 * (one page in the normal case); the bound only matters on a host that ignores the filter, and
 * keeps a super-admin request (and Re-point's recreate path, under the credential's lock) to a
 * few requests rather than fifty. Past it an orphan is not found: the next Enable makes a second
 * Application by the same name, which a later find deletes (`placeApplication`); logged.
 */
export const PLIVO_APPLICATIONS_MAX_PAGES = 5;

/** How a Plivo REST call failed, as the inbound service reads it. */
export type PlivoApiFailureKind =
  /** 401/403: the carrier refused the credential. */
  | 'auth_rejected'
  /** Network, timeout, 429 or 5xx: the carrier could not be asked; says nothing about the request. */
  | 'unreachable'
  /** Any other refusal (400, a 404 the operation does not read as "gone", an unreadable 2xx). */
  | 'refused';

export class PlivoApiError extends Error {
  constructor(
    readonly kind: PlivoApiFailureKind,
    readonly operation: string,
    readonly status: number | null,
    detail: string,
  ) {
    super(`${operation}: ${detail}`);
    this.name = 'PlivoApiError';
  }
}

/** The failure an HTTP status means (2xx and the 404 an operation reads itself are the caller's). */
export function plivoStatusFailure(operation: string, status: number, text: string): PlivoApiError {
  if (status === 401 || status === 403) return new PlivoApiError('auth_rejected', operation, status, `Plivo refused the credential (HTTP ${status})`);
  if (status === 429 || status >= 500) return new PlivoApiError('unreachable', operation, status, `Plivo answered HTTP ${status}`);
  return new PlivoApiError('refused', operation, status, `Plivo answered HTTP ${status}: ${text.slice(0, 200)}`);
}

/** The Application as Plivo holds it: what the health check compares with the stored URLs. */
export interface PlivoApplication {
  appId: string;
  appName: string;
  answerUrl: string;
  answerMethod: string;
  hangupUrl: string;
  hangupMethod: string;
  fallbackAnswerUrl: string;
  fallbackMethod: string;
}

/** The URL fields of a create or update: the answer and hangup URLs carry the token. */
function urlFields(urls: PlivoInboundUrls, token: string): Record<string, string> {
  return {
    answer_url: withInboundToken(urls.answerUrl, token),
    answer_method: 'POST',
    hangup_url: withInboundToken(urls.hangupUrl, token),
    hangup_method: 'POST',
    fallback_answer_url: urls.fallbackAnswerUrl,
    fallback_method: urls.fallbackMethod,
  };
}

/** `POST Application/` body. */
export function plivoCreateApplicationBody(appName: string, urls: PlivoInboundUrls, token: string): Record<string, string> {
  return { app_name: appName, ...urlFields(urls, token) };
}

/** `POST Application/{app_id}/` body (a modify; the name is left as it is). */
export function plivoUpdateApplicationBody(urls: PlivoInboundUrls, token: string): Record<string, string> {
  return urlFields(urls, token);
}

/** `POST Number/{number}/` body: the number's app, or none (`null`; unverified until P0). */
export function plivoNumberAppBody(appId: string | null): { app_id: string | null } {
  return { app_id: appId };
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (o: Record<string, unknown>, k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');

/** The id of a created Application (`{"message":"created","app_id":"…"}`), or null when unreadable. */
export function readPlivoCreatedApplication(text: string): string | null {
  const o = parseObject(text);
  const id = o ? (typeof o['app_id'] === 'number' ? String(o['app_id']) : str(o, 'app_id')) : '';
  return PLIVO_APP_ID.test(id) ? id : null;
}

/** `GET Application/{app_id}/`, or null when the body is not an Application. */
export function readPlivoApplication(text: string): PlivoApplication | null {
  const o = parseObject(text);
  if (!o) return null;
  const appId = typeof o['app_id'] === 'number' ? String(o['app_id']) : str(o, 'app_id');
  if (!PLIVO_APP_ID.test(appId)) return null;
  return {
    appId,
    appName: str(o, 'app_name'),
    answerUrl: str(o, 'answer_url'),
    answerMethod: str(o, 'answer_method').toUpperCase(),
    hangupUrl: str(o, 'hangup_url'),
    hangupMethod: str(o, 'hangup_method').toUpperCase(),
    fallbackAnswerUrl: str(o, 'fallback_answer_url'),
    fallbackMethod: str(o, 'fallback_method').toUpperCase(),
  };
}

/** One page of `GET Application/`: the Applications on it and whether another follows. Null when unreadable. */
export function readPlivoApplicationPage(text: string): { apps: Array<{ appId: string; appName: string }>; more: boolean } | null {
  const o = parseObject(text);
  const objects = o?.['objects'];
  if (!o || !Array.isArray(objects)) return null;
  const apps: Array<{ appId: string; appName: string }> = [];
  for (const item of objects as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const app = item as Record<string, unknown>;
    const appId = typeof app['app_id'] === 'number' ? String(app['app_id']) : str(app, 'app_id');
    if (PLIVO_APP_ID.test(appId)) apps.push({ appId, appName: str(app, 'app_name') });
  }
  const next = (o['meta'] as { next?: unknown } | undefined)?.next;
  return { apps, more: objects.length >= PLIVO_APPLICATIONS_PAGE_SIZE && next !== null };
}

/**
 * The app a number is on, from `GET Number/{number}/`: its `application` resource URI
 * (`/v1/Account/{auth_id}/Application/{app_id}/`), read to its last segment; null for none.
 * `undefined` when the body is not a number at all.
 */
export function readPlivoNumberApp(text: string): { appId: string | null } | undefined {
  const o = parseObject(text);
  if (!o || typeof o['number'] !== 'string') return undefined;
  const raw = o['application'];
  if (raw === null || raw === undefined || raw === '') return { appId: null };
  if (typeof raw !== 'string') return undefined;
  const id = raw.split('/').filter(Boolean).at(-1) ?? '';
  return PLIVO_APP_ID.test(id) ? { appId: id } : undefined;
}

// ── Recording a live call: the Record API (docs/inbound.md §5, P2) ────────────────────────
//
// UNVERIFIED until the P0 live check, as everything above: Plivo's documented Record API is
// `POST Call/{call_uuid}/Record/` with `time_limit`, `file_format`, `callback_url` and
// `callback_method`, answered 202 with `recording_id` and `url`; the finished recording is then
// posted to `callback_url` with snake_case params (`record_url`, `recording_id`,
// `recording_duration`, `call_uuid`, …), unlike the `<Record>` element's callback (`RecordUrl`,
// `RecordingID`, …). The recording callback reader accepts both (`normalizePlivoCallback`).

/** `POST Call/{call_uuid}/Record/` body: an mp3 (as the answer XML's `<Record>`), posted to `callbackUrl`. */
export function plivoStartRecordingBody(callbackUrl: string, timeLimitSeconds: number): Record<string, string | number> {
  return {
    time_limit: timeLimitSeconds,
    file_format: 'mp3',
    callback_url: callbackUrl,
    callback_method: 'POST',
  };
}

/**
 * What `POST Call/{call_uuid}/Record/` answered (`{"message":"call recording started",
 * "recording_id":"…","url":"…"}`): the recording's id and where it will be, each null when
 * absent. Null when the body is not an object.
 */
export function readPlivoRecordingStarted(text: string): { recordingId: string | null; url: string | null } | null {
  const o = parseObject(text);
  if (!o) return null;
  return { recordingId: str(o, 'recording_id') || null, url: str(o, 'url') || null };
}
