import { API_BASE } from '../config';
import { apiFetch, ApiError } from './client';
import { buildAuthHeaders } from './authHeaders';
import { captureApiError } from './error-analytics';
import { retryAfterSecondsFromUnknown } from '../utils/poll-backoff';
import type {
  CustomerExportRequest,
  CustomerSearchRequest,
  CustomerSearchResponse,
  CustomerTimelinePage,
  CustomerTimelineRequest,
} from '@magick-agency/contracts/api/agency/customer-history';

/**
 * Customer history (`docs/customer-history.md`): search one phone number and read
 * every interaction with it across the accounts the caller can see.
 *
 * Every call is a `POST` with the number (or the search id that stands for it) in
 * the BODY, never in the URL (CH6): a URL is logged by every proxy on the way and
 * kept in the browser's history, and a phone number is exactly what neither may
 * hold. The search answers a short-lived `search_id`; the timeline pages and the
 * export name the search by that id.
 *
 * Refusals arrive as `ApiError`s; `customerHistoryRefusal` in
 * `utils/customerHistoryCopy.ts` turns one into the words the page shows.
 */

const AGENCY_BASE = `${API_BASE}/proxy/agency`;

/** Search one number. `value` is the raw text as typed; the server cleans it with the box's rule. */
export async function searchCustomers(
  request: CustomerSearchRequest,
  tenantId?: string,
  accountId?: string,
): Promise<CustomerSearchResponse> {
  return apiFetch<CustomerSearchResponse>(
    `${AGENCY_BASE}/customers/search`,
    { method: 'POST', body: JSON.stringify(request) },
    tenantId,
    accountId,
  );
}

/** A later timeline page, or the first page under new filters. */
export async function getCustomerTimeline(
  request: CustomerTimelineRequest,
  tenantId?: string,
  accountId?: string,
): Promise<CustomerTimelinePage> {
  return apiFetch<CustomerTimelinePage>(
    `${AGENCY_BASE}/customers/timeline`,
    { method: 'POST', body: JSON.stringify(request) },
    tenantId,
    accountId,
  );
}

export interface CustomerHistoryCsvDownload {
  blob: Blob;
  /** The server's `Content-Disposition` filename, else a neutral default (never the number). */
  filename: string;
  /** `X-Export-Truncated: true`: the history was longer than the export cap. */
  truncated: boolean;
}

/** The fallback name: no number in it, since the file may be saved somewhere shared. */
export const CUSTOMER_HISTORY_CSV_FALLBACK_NAME = 'customer-history.csv';

/** `attachment; filename="x.csv"` or `filename*=UTF-8''x.csv` → `x.csv`. */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) || null;
    } catch {
      // A malformed escape: fall through to the plain parameter.
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
  const name = (plain?.[2] ?? plain?.[1] ?? '').trim();
  return name.length > 0 ? name : null;
}

/**
 * The history as CSV. Fetched rather than linked, because the endpoint needs the
 * auth and tenant headers an `<a href>` cannot carry, and because the request is a
 * `POST` (the search id travels in the body, like everything else here).
 */
export async function exportCustomerHistory(
  request: CustomerExportRequest,
  tenantId?: string,
  accountId?: string,
): Promise<CustomerHistoryCsvDownload> {
  const headers = await buildAuthHeaders(tenantId, accountId);
  const url = `${AGENCY_BASE}/customers/export`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = undefined;
    }
    captureApiError(url, res);
    const retryAfter = retryAfterSecondsFromUnknown(
      res.status,
      details,
      undefined,
      res.headers.get('Retry-After'),
    ) ?? undefined;
    throw new ApiError(res.status, details, res.headers.get('x-request-id') ?? undefined, retryAfter);
  }

  return {
    blob: await res.blob(),
    filename: filenameFromContentDisposition(res.headers.get('content-disposition')) ?? CUSTOMER_HISTORY_CSV_FALLBACK_NAME,
    truncated: res.headers.get('x-export-truncated') === 'true',
  };
}
