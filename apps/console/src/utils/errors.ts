/**
 * Error helpers shared across the UI.
 *
 * The API masks internal/upstream error detail
 * before it reaches the client.
 * A masked response looks like:
 *
 *   {
 *     "error": "Internal Error",   // "Internal Error" for 5xx, "Request Failed" for masked 4xx
 *     "message": "Something went wrong while processing your request. ...",
 *     "statusCode": 502,
 *     "requestId": "<request id>"
 *   }
 *
 * The same `requestId` is echoed in the `x-request-id` response header on every
 * response. To let support correlate a report to a server-side log, we surface
 * that id wherever an error is shown.
 *
 * Because most data hooks reduce a thrown error to its `message` string before
 * it reaches a display component, the request id is appended to that string at
 * the `ApiError` boundary using {@link REQUEST_ID_SEPARATOR} and split back out
 * by the shared display primitives ({@link splitRequestId}). This gives every
 * existing error surface (toasts, `ErrorAlert`) the copyable id with no
 * call-site churn, while the structured `requestId` field on `ApiError` remains
 * available to code paths that hold the error object.
 *
 * This module intentionally avoids importing `ApiError` (which lives in the API
 * client) so it stays dependency-free and cycle-free; the request-id field is
 * read structurally instead.
 */

/**
 * Marker that joins a user-facing message to its request id inside a single
 * error string. Chosen to be human-readable if it ever renders un-split.
 */
export const REQUEST_ID_SEPARATOR = '\n\nRequest ID: ';

/** The two `error` labels the backend uses for masked responses. */
const MASKED_ERROR_LABELS = ['Internal Error', 'Request Failed'];

/**
 * Decide whether an error response body is a masked/generic one (no actionable
 * field-level or business detail). Validation errors (`details` array /
 * `fieldErrors`) and our own business 4xx (insufficient credits, permissions —
 * which carry a meaningful `message`) are NOT masked.
 */
export function isMaskedErrorBody(statusCode: number, body: unknown): boolean {
  // Server / dialer-runtime / provider failures are always masked.
  if (statusCode >= 500) return true;

  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;

  // Field-level validation is shown unchanged, never treated as masked.
  if (Array.isArray(b['details']) && b['details'].length > 0) return false;
  if (b['details'] && typeof b['details'] === 'object' && !Array.isArray(b['details'])) {
    const det = b['details'] as Record<string, unknown>;
    if (det['fieldErrors'] && typeof det['fieldErrors'] === 'object') return false;
  }

  return typeof b['error'] === 'string' && MASKED_ERROR_LABELS.includes(b['error']);
}

/** Pull a request id out of an error response body, if present. */
export function extractRequestId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const id = (body as Record<string, unknown>)['requestId'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Append a request id to a message so it travels with the (string-only) error
 * through data hooks. No-op when there's no id.
 */
export function appendRequestId(message: string, requestId?: string): string {
  return requestId ? `${message}${REQUEST_ID_SEPARATOR}${requestId}` : message;
}

/**
 * Split a (possibly id-bearing) message back into its display text and request
 * id. Safe on any string — returns the original message and `undefined` id when
 * no marker is present.
 */
export function splitRequestId(message: string): { message: string; requestId?: string } {
  const idx = message.lastIndexOf(REQUEST_ID_SEPARATOR);
  if (idx === -1) return { message };
  const requestId = message.slice(idx + REQUEST_ID_SEPARATOR.length).trim();
  return { message: message.slice(0, idx), requestId: requestId || undefined };
}

/**
 * Canonical "turn an unknown thrown value into a user-facing string" helper.
 * Returns the message unchanged (request-id marker included, if any) so callers
 * and display components stay consistent.
 */
export function getErrorMessage(
  err: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.length > 0) return err;
  return fallback;
}

/**
 * Build an `Error` from a non-ok `fetch` response for the raw-`fetch` API paths
 * (uploads, CSV downloads) that don't go through the shared API clients. Mirrors
 * the masking contract: the support correlation id is embedded in the message
 * for masked errors so the display primitives can surface it as a copyable chip;
 * validation/business messages are left untouched.
 */
export function toFetchError(res: Response, body: unknown, fallback: string): Error {
  const raw =
    typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined;
  const message = typeof raw === 'string' && raw.length > 0 ? raw : fallback;
  if (isMaskedErrorBody(res.status, body)) {
    const requestId = res.headers.get('x-request-id') ?? extractRequestId(body);
    return new Error(appendRequestId(message, requestId));
  }
  return new Error(message);
}

/**
 * Read the request id from a thrown value: the structured `requestId` field
 * (e.g. on `ApiError`) is preferred, falling back to a marker embedded in the
 * message string.
 */
export function getRequestId(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'requestId' in err) {
    const id = (err as { requestId?: unknown }).requestId;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  if (err instanceof Error) return splitRequestId(err.message).requestId;
  return undefined;
}
