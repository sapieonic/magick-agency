import type { AgencyActionErrorResponse } from '../types/agency';

/**
 * Reading the agency error envelope off whatever `apiFetch` threw.
 *
 * **`details` and `statusCode`, never `body` and `status`.** `ApiError`
 * (`src/api/client.ts`) carries `statusCode` and `details`; there is no `body`
 * field on it and never was. Reading `body` once made every agency failure look
 * like an empty 400 in production: the 409 disposition-required refusal never
 * surfaced the API's message, and `unknown_disposition_code` /
 * `unknown_break_reason` never delivered their `allowed_codes`, which is the only
 * way the console can resync a stale catalog.
 *
 * Seven call sites each spelled the structured-code read out by hand
 * (`(err as { details?: { code?: unknown } }).details?.code`), which is how one of
 * them came to read the wrong field. They read these instead.
 */

function detailsOf(err: unknown): unknown {
  if (!err || typeof err !== 'object') return null;
  return (err as { details?: unknown }).details ?? null;
}

/** The whole envelope, when `details` carries one with a `code`. */
export function errorBody(err: unknown): AgencyActionErrorResponse | null {
  const body = detailsOf(err);
  if (body && typeof body === 'object' && 'code' in body) return body as AgencyActionErrorResponse;
  return null;
}

/** The HTTP status off an `ApiError`, or null when the error is not one. */
export function errorStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const status = (err as { statusCode?: unknown }).statusCode;
  return typeof status === 'number' ? status : null;
}

/**
 * The structured error code (`details.code`), or null. Never `err.message`: the
 * code is the machine-readable half the API allow-lists through its error mask,
 * and the message is copy that may change.
 */
export function errorCode(err: unknown): string | null {
  const body = detailsOf(err);
  if (!body || typeof body !== 'object') return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * How long apart a join is retried while the server answers `503 station_token_unavailable`
 * (decision D9: Redis could not store the station token, so the server refuses to hand
 * out one that could never open the socket). A join is idempotent, so it is simply sent
 * again; the last refusal falls through to the caller's error screen.
 */
export const STATION_TOKEN_RETRY_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000];

/** Run `call`, retrying it on `503 station_token_unavailable` with the delays above. */
export async function retryOnStationTokenUnavailable<T>(
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const delay = STATION_TOKEN_RETRY_DELAYS_MS[attempt];
      if (errorCode(err) !== 'station_token_unavailable' || delay === undefined) throw err;
      await sleep(delay);
    }
  }
}

/** A refusal's own `details` object (`next_open_at`, `caller_ids`, ...), or `null` when it carries none. */
export function errorDetails(err: unknown): Record<string, unknown> | null {
  const details = (errorBody(err) as { details?: unknown } | null)?.details;
  return details && typeof details === 'object' && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : null;
}
