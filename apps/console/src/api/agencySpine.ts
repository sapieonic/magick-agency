import { API_BASE } from '../config';
import { apiFetch, ApiError } from './client';
import { buildAuthHeaders } from './authHeaders';
import { captureApiError } from './error-analytics';
import { trackAgencyRecordingOutcome } from '../analytics/events';
import type { RecordingOutcome, WebRtcCallRecord } from '../types/webrtc-call';
import type {
  AgencyAttempt,
  AgencyAttemptFilters,
  AgencyContactDetail,
  AgencyContactFilters,
  AgencyKeysetPage,
  AgencyRosterContact,
} from '../types/agency-spine';

/**
 * The attempt spine, through master's `/proxy/agency` (MAG-159).
 *
 * cusui never reaches core: every route below exists in
 * `magick-master/src/api/routes/proxy-agency-campaigns.routes.ts`, behind
 * `agency.supervise`.
 *
 * Every function takes `accountId` and must be given it — see the note in
 * `agencyCampaigns.ts` for what an omitted one produces (a 400 from core about
 * a header cusui never sent, with nothing pointing back here).
 */

const AGENCY_BASE = `${API_BASE}/proxy/agency`;

/**
 * Filters → query string.
 *
 * Multi-value filters are sent as REPEATED params rather than a comma-joined
 * string, because that is the form both services accept and the one
 * `agencyStats.ts` also sends — one convention across the two spines.
 *
 * **It does not make a comma inside a value survive**, which an earlier version
 * of this comment claimed. Master's `forwardAllowedQuery` joins a repeated
 * param's values with a comma and core's `multiParam` splits on one, so a
 * disposition code containing a comma reaches core as two codes, matches no row,
 * and returns an empty list. That is a platform limitation of the filter
 * encoding; changing it is a core-then-master change, not a change here.
 *
 * A blank value is dropped: `?phone=` is what a cleared search box posts, and
 * sending it would make an empty box look like a filter matching nothing.
 */
function toQuery(
  filters: Record<string, string | string[] | undefined>,
  extra: Record<string, string> = {},
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== '') qs.append(key, item);
    } else if (value !== '') {
      qs.set(key, value);
    }
  }
  for (const [key, value] of Object.entries(extra)) qs.set(key, value);
  const query = qs.toString();
  return query ? `?${query}` : '';
}

export async function getCampaignAttempts(
  campaignId: string,
  filters: AgencyAttemptFilters,
  options: { cursor?: string; limit?: number } = {},
  tenantId?: string,
  accountId?: string,
): Promise<AgencyKeysetPage<AgencyAttempt>> {
  const extra: Record<string, string> = {};
  if (options.cursor) extra['cursor'] = options.cursor;
  if (options.limit !== undefined) extra['limit'] = String(options.limit);
  return apiFetch<AgencyKeysetPage<AgencyAttempt>>(
    `${AGENCY_BASE}/campaigns/${campaignId}/attempts${toQuery({ ...filters }, extra)}`,
    {},
    tenantId,
    accountId,
  );
}

export async function getCampaignContacts(
  campaignId: string,
  filters: AgencyContactFilters,
  options: { cursor?: string; limit?: number } = {},
  tenantId?: string,
  accountId?: string,
): Promise<AgencyKeysetPage<AgencyRosterContact>> {
  const extra: Record<string, string> = {};
  if (options.cursor) extra['cursor'] = options.cursor;
  if (options.limit !== undefined) extra['limit'] = String(options.limit);
  return apiFetch<AgencyKeysetPage<AgencyRosterContact>>(
    `${AGENCY_BASE}/campaigns/${campaignId}/contacts${toQuery({ ...filters }, extra)}`,
    {},
    tenantId,
    accountId,
  );
}

/** One contact, with its uploaded CSV columns. The only call that returns `context`. */
export async function getCampaignContact(
  campaignId: string,
  contactId: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyContactDetail> {
  return apiFetch<AgencyContactDetail>(
    `${AGENCY_BASE}/campaigns/${campaignId}/contacts/${contactId}`,
    {},
    tenantId,
    accountId,
  );
}

/**
 * Why the call is or is not here. Core's own vocabulary, forwarded through
 * master untouched (`docs/reference/magickvoice-platform/docs/agency-dialer-design.md` §7b).
 *
 * The distinction between the last two is not cosmetic. The attempt→call link is
 * deliberately un-FK'd and both sides purge on independent retention windows, so
 * an attempt routinely outlives its call — and "we never dialled this number" is a
 * different answer to a compliance question than "we dialled it and the recording
 * has aged out". Collapsing them into one empty state would make the spine unable
 * to give either.
 */
export type AgencyCallAvailability = 'available' | 'purged' | 'never_placed';

/** One attempt, plus its call when the call still exists. */
export interface AgencyAttemptCallDetail {
  attempt: AgencyAttempt;
  /** Null whenever `call_availability` is not `available`. */
  call: WebRtcCallRecord | null;
  call_availability: AgencyCallAvailability;
}

/**
 * One attempt and its call — the agency's own call detail.
 *
 * **This is the endpoint that did not exist**, and whose absence is why the
 * agency workspace linked attempt rows into the primary application's shell. It
 * is keyed on campaign + attempt rather than on a call id because the attempt is
 * what the reader clicked, it is campaign-scoped so core can prove ownership from
 * the path, and it outlives the call.
 *
 * A purged call is a **200 with a marker, never a 404** — master forwards core's
 * `call_availability` verbatim. Callers must render the shell, not an error.
 */
export async function getAgencyAttemptCall(
  campaignId: string,
  attemptId: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyAttemptCallDetail> {
  return apiFetch<AgencyAttemptCallDetail>(
    `${AGENCY_BASE}/campaigns/${campaignId}/attempts/${attemptId}`,
    {},
    tenantId,
    accountId,
  );
}

/**
 * Why a recording is not playable, from the refusal the platform actually sent.
 *
 * This function used to be `if (!res.ok) return null`, and that single `null` was
 * the consumer of a lot of deliberate work on the tiers below it. Core emits
 * `call_purged`, `call_never_placed` and `no_recording` as distinct codes; master
 * carries four allow-list entries in `error-mask.middleware.ts` to stop its error
 * mask rewriting them into "contact support and quote this request id", and the
 * comment on those entries says why in as many words: *"A supervisor asking why
 * they cannot hear a call from eight months ago would be told the platform is
 * broken."* Collapsing all of it into "Recording not available." threw that away.
 *
 * The mapping, by status:
 *  - **403** — the tenant does not hold `agency.recording`. Master refuses the
 *    route before it calls core, so there is no code to read.
 *  - **404 `call_purged` / `call_never_placed`** — the call row aged out of
 *    retention (the attempt is un-FK'd on purpose and outlives it, core
 *    migration 076), or there was never a call to record.
 *  - **404, anything else** — the call is there and carries no recording. Core's
 *    `no_recording` code comes from its recording-URL route, which master does
 *    not proxy; the streaming route answers a bare `{ error, message }` with no
 *    code, so the mask rewrites the message and the STATUS is all that survives.
 *    Both mean the same thing to a reader, so both land here.
 *  - **anything else (5xx, 502)** — we could not reach the carrier that stores
 *    it. Core answers 502 for an unresolvable credential or a provider fetch
 *    failure; that is not "the recording is gone" and must not read as it.
 */
async function recordingRefusal(res: Response): Promise<RecordingOutcome> {
  if (res.status === 403) return { status: 'forbidden' };
  if (res.status === 404) {
    let code: unknown;
    try {
      code = ((await res.json()) as { code?: unknown } | null)?.code;
    } catch {
      // A masked or empty body — the status is still the answer below.
    }
    return code === 'call_purged' || code === 'call_never_placed'
      ? { status: 'purged' }
      : { status: 'not_recorded' };
  }
  return { status: 'unreachable' };
}

/**
 * The attempt's recording as a blob URL, for playback in an `<audio>`.
 *
 * The softphone's `fetchWebRtcRecordingBlobUrl` cannot serve this: it is keyed on
 * a call id and hits `/proxy/webrtc-call/:id/recording`, whose reads core pins to
 * the dialer scope and which 404s an agency leg by design. Same mechanism, its own
 * route.
 *
 * NOTE: the CALLER owns the object URL on a `ready` outcome and must revoke it.
 */
export async function fetchAgencyAttemptRecordingBlobUrl(
  campaignId: string,
  attemptId: string,
  tenantId: string,
  accountId?: string,
): Promise<RecordingOutcome> {
  const url = `${AGENCY_BASE}/campaigns/${campaignId}/attempts/${attemptId}/recording`;
  const headers = await buildAuthHeaders(tenantId, accountId);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    captureApiError(url, res);
    const outcome = await recordingRefusal(res);
    // `recordingRefusal` never actually returns `ready` (that only happens on
    // the `res.ok` branch below), but its declared type is the full
    // `RecordingOutcome` union — narrow at runtime so this satisfies
    // `trackAgencyRecordingOutcome`'s failure-only status union.
    if (outcome.status !== 'ready') {
      trackAgencyRecordingOutcome({ status: outcome.status });
    }
    return outcome;
  }

  const blob = await res.blob();
  const mimeType = res.headers.get('content-type') ?? blob.type ?? null;
  trackAgencyRecordingOutcome({ status: 'ok' });
  return { status: 'ready', url: URL.createObjectURL(blob), mimeType };
}

export interface SpineCsvDownload {
  blob: Blob;
  /** True when the export stopped early — at the row ceiling or on a deadline. */
  truncated: boolean;
  reason: string | null;
  rowLimit: number | null;
  rows: number | null;
}

/**
 * A header another service produced is not a guarantee.
 *
 * `Number('abc')` is `NaN` and `NaN` is a `number`, so an unexpected header
 * would satisfy `rowLimit: number | null` and travel all the way to the toast as
 * "only the first NaN rows" — a truncation warning that reads as a bug and so
 * gets dismissed as one. Every non-finite or non-positive parse collapses to
 * `null`: "truncated, and the size is not known". The warning survives losing
 * the number, which is the property that matters.
 */
function parseCount(header: string | null): number | null {
  if (header === null) return null;
  const parsed = Number(header);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Download the filtered set as CSV.
 *
 * Fetched as a blob rather than linked, because the endpoint needs the auth and
 * tenant headers an `<a href>` cannot carry.
 *
 * **The truncation is the normal case, not an edge case.** A campaign can hold a
 * million contacts and the export ceiling is 50,000, so an unfiltered export of
 * a large campaign stops early by design — the caller must surface that rather
 * than hand over a file the operator will read as complete.
 */
export async function downloadSpineCsv(
  campaignId: string,
  kind: 'attempts' | 'contacts',
  filters: Record<string, string | string[] | undefined>,
  tenantId?: string,
  accountId?: string,
): Promise<SpineCsvDownload> {
  const headers = await buildAuthHeaders(tenantId, accountId);
  const url = `${AGENCY_BASE}/campaigns/${campaignId}/${kind}.csv${toQuery(filters)}`;
  const res = await fetch(url, { headers });

  if (!res.ok) {
    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = undefined;
    }
    captureApiError(url, res);
    throw new ApiError(res.status, details, res.headers.get('x-request-id') ?? undefined);
  }

  return {
    blob: await res.blob(),
    truncated: res.headers.get('x-export-truncated') === 'true',
    reason: res.headers.get('x-export-truncated-reason'),
    rowLimit: parseCount(res.headers.get('x-export-row-limit')),
    rows: parseCount(res.headers.get('x-export-rows')),
  };
}
