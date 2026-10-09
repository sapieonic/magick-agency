import { API_BASE } from '../config';
import { apiFetch, ApiError } from './client';
import { buildAuthHeaders } from './authHeaders';
import { captureApiError } from './error-analytics';
import { selectorQueryParams } from '../utils/agencyRetrySelector';
import type {
  AgencyCampaign,
  AgencyCampaignLineage,
  AgencyCampaignStats,
  AgencyColumnAnalysis,
  AgencyIngestJob,
  AgencyIngestLimits,
  AgencyIngestRequest,
  AgencyIngestStartResponse,
  AgencyRetryCreateRequest,
  AgencyRetryCreateResponse,
  AgencyRetryPreview,
  AgencyUploadResponse,
} from '../types/agency-campaign';
import type { AgencyRetrySelector } from '../types/agency-spine';

/**
 * Campaign CRUD and roster ingest, all through the server's `/proxy/agency`.
 *
 * **The console never reaches the server.** Every route below is served by
 * the server's `/proxy/agency` routes; a dialer-runtime route
 * with no public-API-layer proxy is unreachable from a browser, so anything missing there
 * is a blocker to report rather than to work around.
 *
 * **Every function here takes `accountId` and must be given it.** `apiFetch`
 * sends `X-Account-Id` only when the fourth argument is present; the server treats
 * that header as OPTIONAL and simply omits `x-mgkvc-account` when it is absent
 * (`core-client.ts`), while the server's `authMiddleware` requires it on every
 * authenticated route. So an omitted argument here does not degrade — it
 * produces `400 Missing required header: x-mgkvc-account` from the server, surfaced
 * through the server's error mask, with nothing in the message pointing at the console.
 * Omitting it is what made every campaign call fail; the multipart helpers
 * below were unaffected only because they build their headers by hand.
 */

const AGENCY_BASE = `${API_BASE}/proxy/agency`;

/**
 * The limits the wizard displays.
 *
 * Fetched rather than hardcoded because requires the number the operator is
 * told to be the real one — a copied constant is a limit that goes stale and
 * tells them the wrong thing.
 */
export async function getIngestLimits(
  tenantId?: string,
  accountId?: string,
): Promise<AgencyIngestLimits> {
  return apiFetch<AgencyIngestLimits>(`${AGENCY_BASE}/ingest/limits`, {}, tenantId, accountId);
}

/**
 * Upload the raw CSV. Multipart, so it uses `fetch` directly with the shared
 * auth headers — `apiFetch` sets `Content-Type: application/json` on any body,
 * which would break the boundary.
 */
export async function uploadRosterCsv(
  file: File,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyUploadResponse> {
  const form = new FormData();
  form.append('file', file);

  const headers = await buildAuthHeaders(tenantId, accountId);
  const res = await fetch(`${AGENCY_BASE}/ingest/upload`, {
    method: 'POST',
    headers,
    body: form,
  });

  if (!res.ok) {
    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = undefined;
    }
    throw new ApiError(res.status, details, res.headers.get('x-request-id') ?? undefined);
  }
  return (await res.json()) as AgencyUploadResponse;
}

/** Headers, three samples per column, and a phone suggestion that may be withheld. */
export async function analyzeRosterColumns(
  input: { s3_key: string; default_country_code?: string },
  tenantId?: string,
  accountId?: string,
): Promise<AgencyColumnAnalysis> {
  return apiFetch<AgencyColumnAnalysis>(
    `${AGENCY_BASE}/ingest/analyze`,
    { method: 'POST', body: JSON.stringify(input) },
    tenantId,
    accountId,
  );
}

/**
 * Start an ingest. The server answers **202** with a job id — a 1M-row file takes
 * minutes, so the wizard polls rather than holding a request open.
 *
 * `dry_run: true` parses the whole file and reports the summary without sending
 * anything to the server, and is the only form that may omit `campaign_id`.
 */
export async function startRosterIngest(
  request: AgencyIngestRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyIngestStartResponse> {
  return apiFetch<AgencyIngestStartResponse>(
    `${AGENCY_BASE}/ingest/jobs`,
    { method: 'POST', body: JSON.stringify(request) },
    tenantId,
    accountId,
  );
}

export async function getIngestJob(
  jobId: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyIngestJob> {
  return apiFetch<AgencyIngestJob>(`${AGENCY_BASE}/ingest/jobs/${jobId}`, {}, tenantId, accountId);
}

/**
 * Ask for cancellation.
 *
 * The server answers **409** when the job already finished, and that is not an error
 * to swallow: pretending to cancel something already loaded would leave the
 * operator believing a roster is not there when it is.
 */
export async function cancelIngestJob(
  jobId: string,
  tenantId?: string,
  accountId?: string,
): Promise<void> {
  await apiFetch(
    `${AGENCY_BASE}/ingest/jobs/${jobId}/cancel`,
    { method: 'POST' },
    tenantId,
    accountId,
  );
}

/**
 * Download the rejected rows: the operator's original columns plus `_reason`,
 * identified by their original row number.
 *
 * Fetched as a blob rather than linked, because the endpoint needs the auth and
 * tenant headers that an `<a href>` cannot carry.
 */
export async function downloadRejectedRows(
  jobId: string,
  tenantId?: string,
  accountId?: string,
): Promise<Blob> {
  const headers = await buildAuthHeaders(tenantId, accountId);
  const url = `${AGENCY_BASE}/ingest/jobs/${jobId}/rejected.csv`;
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
  return await res.blob();
}

// ─── Campaign CRUD ───────────────────────────────────────────────────────────

export async function listAgencyCampaigns(
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaign[]> {
  const body = await apiFetch<AgencyCampaign[] | { campaigns: AgencyCampaign[] }>(
    `${AGENCY_BASE}/campaigns`,
    {},
    tenantId,
    accountId,
  );
  return Array.isArray(body) ? body : body.campaigns;
}

export async function getAgencyCampaign(
  id: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaign> {
  return apiFetch<AgencyCampaign>(`${AGENCY_BASE}/campaigns/${id}`, {}, tenantId, accountId);
}

export async function createAgencyCampaign(
  body: Partial<AgencyCampaign>,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaign> {
  return apiFetch<AgencyCampaign>(
    `${AGENCY_BASE}/campaigns`,
    { method: 'POST', body: JSON.stringify(body) },
    tenantId,
    accountId,
  );
}

/**
 * Patch a campaign's config.
 *
 * Editing a **running** campaign is allowed and deliberately not gated — the
 * calling window is most often wrong *while* the campaign is dialing outside it.
 * The server re-reads the campaign every pacing tick, so the edit applies to future
 * attempts; an already-dispatched attempt keeps the snapshot it was dialed with.
 */
export async function updateAgencyCampaign(
  id: string,
  body: Partial<AgencyCampaign>,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaign> {
  return apiFetch<AgencyCampaign>(
    `${AGENCY_BASE}/campaigns/${id}`,
    { method: 'PATCH', body: JSON.stringify(body) },
    tenantId,
    accountId,
  );
}

// ─── Stats and lifecycle ─────────────────────────────────────────────────────

/**
 * Campaign counters.
 *
 * What comes back today is eleven counters from `agencyCampaignRepository.stats`.
 * `AgencyCampaignStats` in the shared contract additionally declares
 * `abandoned_24h`, `answered_24h` and `abandonment_rate_24h_pct` as REQUIRED,
 * and the server produces none of them — they exist only as Prometheus metrics
 * (see the contract). They are typed optional here on purpose: a required field with no
 * producer reads as guaranteed and silences the one check that would catch it.
 * Render them as unavailable rather than as zero.
 */
export async function getAgencyCampaignStats(
  id: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaignStats> {
  return apiFetch<AgencyCampaignStats>(
    `${AGENCY_BASE}/campaigns/${id}/stats`,
    {},
    tenantId,
    accountId,
  );
}

/**
 * The four lifecycle controls.
 *
 * `stop` is not the inverse of `start`: the server sets `stopping` and the pacing
 * leader finalizes to `stopped` once in-flight attempts drain, so the status the
 * caller reads back is usually `stopping`, not `stopped`. Callers must render
 * what came back rather than assuming the transition completed.
 *
 * A **409** here is a real answer, not a failure to retry: either the campaign
 * moved underneath us, or the one-running-campaign-per-account rule refused the
 * start. Both carry a `code` the caller should show.
 */
export async function transitionAgencyCampaign(
  id: string,
  action: 'start' | 'pause' | 'resume' | 'stop',
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaign> {
  return apiFetch<AgencyCampaign>(
    `${AGENCY_BASE}/campaigns/${id}/${action}`,
    { method: 'POST' },
    tenantId,
    accountId,
  );
}

// ─── Retry campaigns ─────────────────────────────────────────────────────────
//
// Three routes, all browser → the server → the dialer runtime (`/proxy/*`).
// **No new S2S seam**, so none of this touches `agency-s2s-contract.fixture.json`.
//
// The server's permissions, mirrored here only as a comment because the server's 403 is
// the real enforcement and this client's job is to not offer what it cannot do:
//   preview → `agency.supervise`
//   create  → `agency.supervise` AND `agency.campaigns.write`
//   lineage → `agency.campaigns.read`
// The create names two because the act is BOTH creating a campaign and acting
// on another campaign's call results; they share a floor today, and naming both
// is what keeps the route correct if either moves.

/**
 * How many contacts a selector would seed, and what they are made of. Writes
 * nothing.
 *
 * The preview is a separate read on purpose (DR-8): the create is one
 * transaction that makes a campaign AND a roster, and a supervisor has to see
 * the count before that happens. Preview and commit share one parser and one
 * predicate builder inside the server, or the preview eventually promises a number the
 * commit does not deliver.
 */
export async function retryPreview(
  campaignId: string,
  selector: AgencyRetrySelector,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyRetryPreview> {
  const query = selectorQueryParams(selector).toString();
  return apiFetch<AgencyRetryPreview>(
    `${AGENCY_BASE}/campaigns/${campaignId}/retry/preview${query ? `?${query}` : ''}`,
    {},
    tenantId,
    accountId,
  );
}

/**
 * Create the child campaign and seed its roster, in one server transaction.
 *
 * **A 409 here is an answer, not a failure to retry** — the same shape the
 * lifecycle controls already deal with. `retry_selection_empty`,
 * `retry_selection_too_large` and `retry_generation_exceeded` each carry a
 * `code` the server allow-lists through its error mask, and each has a remedy the
 * caller must show (`retryRefusalCopy`). On all three, **nothing was created**;
 * re-sending the same body would refuse identically.
 *
 * The actor is **not** in the body. The server fills `agent_user_id` from the
 * authenticated session and `actor_name` from its own user directory, exactly as
 * it does for every other agency write — an actor the browser supplies is an
 * actor the browser can forge.
 */
export async function createRetry(
  campaignId: string,
  body: AgencyRetryCreateRequest,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyRetryCreateResponse> {
  return apiFetch<AgencyRetryCreateResponse>(
    `${AGENCY_BASE}/campaigns/${campaignId}/retry`,
    { method: 'POST', body: JSON.stringify(body) },
    tenantId,
    accountId,
  );
}

/**
 * Every pass of this campaign — root first, ordered by generation then creation.
 *
 * **A campaign in no chain answers with itself as the only entry, not a 404**,
 * so callers branch on `campaigns.length > 1` rather than on an error. That is
 * also why this can be called for any campaign without knowing first whether it
 * is part of a chain: a parent that has been retried carries
 * `retry_generation: 0` and `parent_campaign_id: null` exactly like a campaign
 * that never was, so its own row cannot tell them apart.
 */
export async function campaignLineage(
  campaignId: string,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyCampaignLineage> {
  return apiFetch<AgencyCampaignLineage>(
    `${AGENCY_BASE}/campaigns/${campaignId}/lineage`,
    {},
    tenantId,
    accountId,
  );
}
