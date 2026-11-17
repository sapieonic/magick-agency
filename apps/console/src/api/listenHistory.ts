import { API_BASE } from '../config';
import { apiFetch, type ApiError } from './client';
import { toQuery as encodeQuery } from './agencySpine';
import { fetchCsvExport, type CsvExport } from './csvExport';
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
  return encodeQuery({
    listener_user_id: query.listener_user_id,
    agent_user_id: query.agent_user_id,
    from: query.from,
    to: query.to,
    cursor: query.cursor,
    limit: query.limit === undefined ? undefined : String(query.limit),
  });
}

/** `GET /listen-history`: one page of visits, newest first (`next_cursor` for the next). */
export function listListenHistory(
  query: AgencyListenHistoryQuery,
  tenantId?: string,
  accountId?: string,
): Promise<AgencyListenHistoryResponse> {
  return apiFetch<AgencyListenHistoryResponse>(`${LISTEN_HISTORY_BASE}${toQuery(query)}`, {}, tenantId, accountId);
}

export interface ListenHistoryCsvDownload extends CsvExport {
  /** The server's `Content-Disposition` name, else {@link LISTEN_HISTORY_CSV_FALLBACK_NAME}. */
  filename: string;
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
  const file = await fetchCsvExport(
    `${LISTEN_HISTORY_BASE}.csv${toQuery({ ...filters, cursor: undefined, limit: undefined })}`,
    tenantId,
    accountId,
  );
  return { ...file, filename: file.filename ?? LISTEN_HISTORY_CSV_FALLBACK_NAME };
}
