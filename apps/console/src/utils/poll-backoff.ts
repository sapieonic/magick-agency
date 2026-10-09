/**
 * Shared 429 backoff for live polls that share a tenant+API-key budget with
 * core (200 req/min). Dedicated 2026-09-07 (sreenidhi): a 143-batch static
 * campaign 429'd GET /static-calls/batches/:id while the UI kept polling at the
 * foreground cadence, including on hidden tabs.
 *
 * Core's limiter returns `{ retryAfter, message: "Rate limit exceeded. Try again
 * in N seconds." }`. Master's proxy historically dropped the `Retry-After`
 * header, so callers must also parse the body / message.
 */

const TRY_AGAIN_IN = /try again in (\d+) seconds/i;
const DEFAULT_429_SECONDS = 60;

function nonNegativeSeconds(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.ceil(n);
}

/** `Retry-After` is either delta-seconds or an HTTP-date. */
export function parseRetryAfterHeader(value: string | null | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const asDelta = nonNegativeSeconds(value.trim());
  if (asDelta != null) return asDelta;
  const asDate = Date.parse(value);
  if (Number.isNaN(asDate)) return null;
  return nonNegativeSeconds((asDate - Date.now()) / 1000);
}

export function retryAfterSecondsFromUnknown(
  statusCode: number | undefined,
  details: unknown,
  message?: string,
  headerValue?: string | null,
): number | null {
  const fromHeader = parseRetryAfterHeader(headerValue);
  if (fromHeader != null) return fromHeader;

  if (details && typeof details === 'object') {
    const d = details as Record<string, unknown>;
    for (const key of ['retryAfter', 'retry_after', 'retry_after_seconds'] as const) {
      const n = nonNegativeSeconds(d[key]);
      if (n != null) return n;
    }
    if (typeof d['message'] === 'string') {
      const m = d['message'].match(TRY_AGAIN_IN);
      if (m) return Number(m[1]);
    }
  }

  if (typeof message === 'string') {
    const m = message.match(TRY_AGAIN_IN);
    if (m) return Number(m[1]);
  }

  if (statusCode === 429) return DEFAULT_429_SECONDS;
  return null;
}

/** Prefer a structured `ApiError.retryAfterSeconds`, then body / message / 429 default. */
export function retryAfterSecondsFromError(error: unknown): number | null {
  if (error == null || typeof error !== 'object') return null;
  const err = error as {
    statusCode?: number;
    retryAfterSeconds?: number;
    details?: unknown;
    message?: string;
  };
  const explicit = nonNegativeSeconds(err.retryAfterSeconds);
  if (explicit != null) return explicit;
  return retryAfterSecondsFromUnknown(err.statusCode, err.details, err.message);
}

export interface PollBackoff {
  isCoolingDown(now?: number): boolean;
  note(error: unknown, now?: number): void;
  reset(): void;
}

export function createPollBackoff(): PollBackoff {
  let untilMs = 0;
  return {
    isCoolingDown(now = Date.now()) {
      return now < untilMs;
    },
    note(error: unknown, now = Date.now()) {
      const seconds = retryAfterSecondsFromError(error);
      if (seconds == null) return;
      untilMs = Math.max(untilMs, now + seconds * 1000);
    },
    reset() {
      untilMs = 0;
    },
  };
}
