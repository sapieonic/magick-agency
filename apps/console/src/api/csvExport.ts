import { ApiError } from './client';
import { buildAuthHeaders } from './authHeaders';
import { captureApiError } from './error-analytics';
import { filenameFromContentDisposition } from './customerHistory';

/**
 * A `GET` CSV export under `/proxy/agency` (a campaign's attempts and contacts, the listening
 * history): the file, and what its headers say about it.
 */
export interface CsvExport {
  blob: Blob;
  /** The server's `Content-Disposition` name, or null when it cannot be read. */
  filename: string | null;
  /** `X-Export-Truncated: true`: the export stopped early, at the row ceiling or on a deadline. */
  truncated: boolean;
  /** `X-Export-Truncated-Reason`: `row_limit` or `deadline`. */
  reason: string | null;
  /** `X-Export-Row-Limit`, or null when it does not read as a count. */
  rowLimit: number | null;
  /** `X-Export-Rows`: rows written, or null when it does not read as a count. */
  rows: number | null;
}

/**
 * A header produced by the server is not a guarantee.
 *
 * `Number('abc')` is `NaN` and `NaN` is a `number`, so an unexpected header
 * would satisfy `rowLimit: number | null` and travel all the way to the toast as
 * "only the first NaN rows" — a truncation warning that reads as a bug and so
 * gets dismissed as one. Every non-finite or non-positive parse collapses to
 * `null`: "truncated, and the size is not known". The warning survives losing
 * the number, which is the property that matters.
 */
export function parseCount(header: string | null): number | null {
  if (header === null) return null;
  const parsed = Number(header);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Fetch `url` as a CSV export. Fetched as a blob rather than linked, because the routes need the
 * auth and tenant headers an `<a href>` cannot carry. A refusal throws an {@link ApiError} with
 * its status and body; it is never handed back as a file.
 */
export async function fetchCsvExport(url: string, tenantId?: string, accountId?: string): Promise<CsvExport> {
  const headers = await buildAuthHeaders(tenantId, accountId);
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
    filename: filenameFromContentDisposition(res.headers.get('content-disposition')),
    truncated: res.headers.get('x-export-truncated') === 'true',
    reason: res.headers.get('x-export-truncated-reason'),
    rowLimit: parseCount(res.headers.get('x-export-row-limit')),
    rows: parseCount(res.headers.get('x-export-rows')),
  };
}
