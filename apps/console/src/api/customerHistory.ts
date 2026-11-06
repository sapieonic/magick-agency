import { API_BASE } from '../config';
import { apiFetch, ApiError } from './client';
import { buildAuthHeaders } from './authHeaders';
import { captureApiError } from './error-analytics';
import { retryAfterSecondsFromUnknown } from '../utils/poll-backoff';
import type {
  CustomerExportRequest,
  CustomerSearchOptionsResponse,
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

/**
 * Search one number. `value` is the raw text as typed; the server cleans it with the box's rule.
 * `signal` lets the box abandon a search nobody is waiting for any more (the panel closed, the
 * page left), so a slow answer cannot navigate the person away from where they went.
 */
export async function searchCustomers(
  request: CustomerSearchRequest,
  tenantId?: string,
  accountId?: string,
  signal?: AbortSignal,
): Promise<CustomerSearchResponse> {
  return apiFetch<CustomerSearchResponse>(
    `${AGENCY_BASE}/customers/search`,
    { method: 'POST', body: JSON.stringify(request), ...(signal ? { signal } : {}) },
    tenantId,
    accountId,
  );
}

/** `GET /proxy/agency/customers/options`: the platform's default calling code, for the country picker. */
export async function getCustomerSearchOptions(
  tenantId?: string,
  accountId?: string,
): Promise<CustomerSearchOptionsResponse> {
  return apiFetch<CustomerSearchOptionsResponse>(`${AGENCY_BASE}/customers/options`, {}, tenantId, accountId);
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

/** An RFC 5987 `charset'language'value` (`filename*`), decoded; null when it cannot be read. */
function decodeExtValue(raw: string): string | null {
  const ext = /^([^']*)'[^']*'(.*)$/.exec(raw.trim().replace(/^"|"$/g, ''));
  const charset = (ext?.[1] ?? 'utf-8').toLowerCase();
  const value = ext ? ext[2]! : raw.trim();
  try {
    if (charset === 'utf-8' || charset === '') return decodeURIComponent(value) || null;
    if (charset === 'iso-8859-1') {
      // One byte per `%XX`, each byte its own code point.
      return value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))) || null;
    }
  } catch {
    // A malformed escape.
  }
  return null;
}

/**
 * The download's name from `Content-Disposition`, in every form RFC 6266 allows:
 * `filename="x.csv"`, `filename=x.csv`, and the RFC 5987 `filename*=UTF-8''x.csv` (or another
 * charset), preferred when present. The server sends both (`csvAttachmentHeader`):
 * `attachment; filename="customer-history-2026-11-06.csv"; filename*=UTF-8''customer-history-2026-11-06.csv`.
 */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*([^;]+)/i.exec(header);
  if (star?.[1]) {
    const decoded = decodeExtValue(star[1]);
    if (decoded) return decoded;
  }
  // `(?:^|;)` so the plain parameter is never read out of `filename*=`.
  const plain = /(?:^|;)\s*filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(header);
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
