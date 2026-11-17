import { API_BASE } from '../config';
import { apiFetch, ApiError } from './client';
import { buildAuthHeaders } from './authHeaders';
import { captureApiError } from './error-analytics';
import { filenameFromContentDisposition } from './customerHistory';
import type { AgencyListenHistoryQuery, AgencyListenHistoryResponse } from '../types/listen-history';

/**
 * The account's listening history (`docs/listening.md` §12, LS19; contracts
 * `api/agency/listen-history.ts`), under `/proxy/agency` with the tenant and account headers.
 * Gated by `agency.supervise` alone: neither route reads the listening flag (LS19, amended
 * 2026-11-17), so turning listening off does not hide past listens.
 */

const LISTEN_HISTORY_BASE = `${API_BASE}/proxy/agency/listen-history`;

/** The download's name when the server's `Content-Disposition` cannot be read. */
export const LISTEN_HISTORY_CSV_FALLBACK_NAME = 'listening-history.csv';

/** The filters (and, for the page, the cursor and limit) as the query; blank keys left out, as the route refuses them. */
function toQuery(query: AgencyListenHistoryQuery): string {
  const qs = new URLSearchParams();
  if (query.listener_user_id) qs.set('listener_user_id', query.listener_user_id);
  if (query.agent_user_id) qs.set('agent_user_id', query.agent_user_id);
  if (query.from) qs.set('from', query.from);
  if (query.to) qs.set('to', query.to);
  if (query.cursor) qs.set('cursor', query.cursor);
  if (query.limit !== undefined) qs.set('limit', String(query.limit));
  const search = qs.toString();
  return search ? `?${search}` : '';
}

/** `GET /listen-history`: one page of visits, newest first (`next_cursor` for the next). */
export function listListenHistory(
  query: AgencyListenHistoryQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyListenHistoryResponse> {
  return apiFetch<AgencyListenHistoryResponse>(`${LISTEN_HISTORY_BASE}${toQuery(query)}`, {}, tenantId, accountId);
}

export interface ListenHistoryCsvDownload {
  blob: Blob;
  /** The server's `Content-Disposition` name, else {@link LISTEN_HISTORY_CSV_FALLBACK_NAME}. */
  filename: string;
  /** `X-Export-Truncated: true`: past the row ceiling or the time budget. */
  truncated: boolean;
  /** `X-Export-Truncated-Reason`: `row_limit` or `deadline`. */
  reason: string | null;
  /** `X-Export-Row-Limit`, or null when it does not read as a count. */
  rowLimit: number | null;
  /** `X-Export-Rows`: entries written. */
  rows: number | null;
}

/** A header as a positive count, or null: a header is another service's output, not a guarantee. */
function parseCount(header: string | null): number | null {
  if (header === null) return null;
  const parsed = Number(header);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * `GET /listen-history.csv` with the page's filters (no cursor, no limit). Fetched rather than
 * linked, because the route needs the auth and tenant headers an `<a href>` cannot carry. A
 * refusal throws an {@link ApiError} with its status and code; it is never saved as a file.
 */
export async function downloadListenHistoryCsv(
  filters: Omit<AgencyListenHistoryQuery, 'cursor' | 'limit'>,
  tenantId?: string,
  accountId?: string,
): Promise<ListenHistoryCsvDownload> {
  const headers = await buildAuthHeaders(tenantId, accountId);
  const url = `${LISTEN_HISTORY_BASE}.csv${toQuery({ ...filters, cursor: undefined, limit: undefined })}`;
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
    filename: filenameFromContentDisposition(res.headers.get('content-disposition')) ?? LISTEN_HISTORY_CSV_FALLBACK_NAME,
    truncated: res.headers.get('x-export-truncated') === 'true',
    reason: res.headers.get('x-export-truncated-reason'),
    rowLimit: parseCount(res.headers.get('x-export-row-limit')),
    rows: parseCount(res.headers.get('x-export-rows')),
  };
}
