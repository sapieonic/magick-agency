import { getAuth } from 'firebase/auth';
import { ORIGINATOR_HEADER, ORIGINATOR } from '../config';
import { captureApiError } from './error-analytics';
import { clearSessionStart } from '../utils/session';
import { isLoginPath, sessionExpiredLoginUrl } from '../utils/returnPath';
import { parseApiErrorBody } from '@magick-agency/web-ui/apiErrorBody';
import { retryAfterSecondsFromUnknown } from '../utils/poll-backoff';

export class ApiError extends Error {
  /**
   * Server-side correlation id (from the `x-request-id` header, falling back to
   * the body `requestId`). Set for masked errors so users can quote it to
   * support. Also embedded in `message` for masked errors so it survives the
   * hook layer (which reduces errors to `.message`) — see `@magick-agency/web-ui/errors`.
   */
  public readonly requestId?: string;

  /** Whether the backend returned a masked/generic body (no actionable detail). */
  public readonly isMasked: boolean;

  /**
   * Seconds until a 429 may be retried. Taken from `Retry-After`, the server's
   * `retryAfter` body field, or `"Try again in N seconds"`. Poll loops must
   * honour this rather than charging the tenant+API-key budget at cadence.
   */
  public readonly retryAfterSeconds?: number;

  constructor(
    public statusCode: number,
    public details?: unknown,
    requestId?: string,
    retryAfterSeconds?: number,
  ) {
    // Prefer the header-provided id, then the body field. Message order
    // (field-level problems before a generic `message`) lives in
    // `parseApiErrorBody`, shared with the super-admin client.
    const parsedBody = parseApiErrorBody(
      statusCode,
      details,
      requestId ? new Headers({ 'x-request-id': requestId }) : null,
    );
    super(parsedBody.message);
    this.name = 'ApiError';
    this.requestId = parsedBody.requestId;
    this.isMasked = parsedBody.isMasked;
    const parsed = retryAfterSeconds
      ?? retryAfterSecondsFromUnknown(statusCode, details, parsedBody.baseMessage)
      ?? undefined;
    this.retryAfterSeconds = parsed;
  }
}

export async function apiFetch<T>(
  url: string,
  options: RequestInit = {},
  tenantId?: string,
  accountId?: string,
): Promise<T> {
  const auth = getAuth();
  const user = auth.currentUser;
  const token = user ? await user.getIdToken() : null;

  const headers: Record<string, string> = {
    [ORIGINATOR_HEADER]: ORIGINATOR,
    ...((options.headers as Record<string, string>) || {}),
  };

  // Only set Content-Type for requests that have a body
  if (options.body) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (tenantId) {
    headers['X-Tenant-Id'] = tenantId;
  }
  if (accountId) {
    headers['X-Account-Id'] = accountId;
  }

  const res = await fetch(url, { ...options, headers });

  if (!res.ok) {
    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = { message: res.statusText };
    }
    // The backend echoes the correlation id on every response header; prefer it
    // over the body field so we still have it even if the body fails to parse.
    const requestId = res.headers.get('x-request-id') ?? undefined;
    const retryAfterSeconds = retryAfterSecondsFromUnknown(
      res.status,
      details,
      undefined,
      res.headers.get('Retry-After') ?? res.headers.get('retry-after'),
    ) ?? undefined;
    captureApiError(url, res);
    // A 401 means the session is no longer valid (e.g. backend-enforced 6-hour
    // expiry). Clear the session, sign out of Firebase, and bounce to login so
    // the user must re-authenticate. Guard against redirect loops on either
    // sign-in page — `isLoginPath`, not `startsWith('/login')`, because the agency
    // door does not share that prefix and a reload there would wipe the form and
    // hide the real error. See `utils/returnPath`.
    if (res.status === 401) {
      clearSessionStart();
      try { await auth.signOut(); } catch { /* */ }
      if (!isLoginPath(window.location.pathname)) {
        // Carries where they were, so re-authentication returns them there
        // instead of dumping everyone on `/app`.
        window.location.href = sessionExpiredLoginUrl();
      }
    }
    throw new ApiError(res.status, details, requestId, retryAfterSeconds);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}
