import { API_BASE } from '../config';
import { apiFetch, ApiError } from './client';
import { buildAuthHeaders } from './authHeaders';
import { captureApiError } from './error-analytics';
import type { ActivityFilters, ActivityPage } from '../types/agency-activity';

/**
 * One campaign's merged audit trail, from the server's `/proxy/agency`.
 *
 * The server fans out to its own audit rows and to the dialer runtime's and interleaves
 * them; the console never reaches the dialer runtime. `partial: true` on the response means the dialer runtime's
 * half is missing and the page must be rendered as incomplete rather than as
 * the whole trail.
 */

const AGENCY_BASE = `${API_BASE}/proxy/agency`;

function toQuery(filters: ActivityFilters, extra: Record<string, string> = {}): string {
  const qs = new URLSearchParams();
  // One repeated param per action rather than a comma-joined string. The server
  // accepts both, and repeats cannot be misread if an action name ever contains
  // a comma.
  for (const action of filters.actions ?? []) qs.append('action', action);
  if (filters.from) qs.set('from', filters.from);
  if (filters.to) qs.set('to', filters.to);
  for (const [key, value] of Object.entries(extra)) qs.set(key, value);
  const query = qs.toString();
  return query ? `?${query}` : '';
}

export async function getCampaignActivity(
  campaignId: string,
  filters: ActivityFilters,
  options: { cursor?: string; limit?: number } = {},
  tenantId?: string,
  accountId?: string,
): Promise<ActivityPage> {
  const extra: Record<string, string> = {};
  if (options.cursor) extra['cursor'] = options.cursor;
  if (options.limit !== undefined) extra['limit'] = String(options.limit);

  return apiFetch<ActivityPage>(
    `${AGENCY_BASE}/campaigns/${campaignId}/activity${toQuery(filters, extra)}`,
    {},
    tenantId,
    accountId,
  );
}

export interface ActivityCsvDownload {
  blob: Blob;
  /** True when the export stopped at the server's row ceiling. */
  truncated: boolean;
  rowLimit: number | null;
}

/**
 * The ceiling the export stopped at, or `null` when the header cannot be read
 * as one.
 *
 * `Number('abc')` is `NaN` and `NaN` is a `number`, so a header this client did
 * not expect would satisfy `rowLimit: number | null` and travel all the way to
 * the toast as "Only the most recent NaN entries were exported" — a truncation
 * warning that reads as a bug and so gets dismissed as one. A header is another
 * service's output, not a guarantee, and every non-finite or non-positive parse
 * (including a `0` or a negative, which are not ceilings either) collapses to
 * `null`: "truncated, and the size is not known". That case still says the
 * export is short — see `truncationNotice` — because losing the number must not
 * lose the warning.
 */
function parseRowLimit(header: string | null): number | null {
  if (header === null) return null;
  const parsed = Number(header);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Download the trail as CSV, with the filters currently on screen.
 *
 * Fetched as a blob rather than linked, because the endpoint needs the auth and
 * tenant headers an `<a href>` cannot carry.
 *
 * **A 424 here is an answer, not a transport failure.** The server refuses to write
 * a file that would be missing the server's half of the trail — every status change
 * and any automatic pause — because a screen can carry an "incomplete" banner
 * and a file that leaves the building cannot. The caller must surface that
 * refusal and its remedy rather than retrying blindly.
 */
export async function downloadCampaignActivityCsv(
  campaignId: string,
  filters: ActivityFilters,
  tenantId?: string,
  accountId?: string,
): Promise<ActivityCsvDownload> {
  const headers = await buildAuthHeaders(tenantId, accountId);
  const url = `${AGENCY_BASE}/campaigns/${campaignId}/activity.csv${toQuery(filters)}`;
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
    truncated: res.headers.get('x-activity-truncated') === 'true',
    rowLimit: parseRowLimit(res.headers.get('x-activity-row-limit')),
  };
}
