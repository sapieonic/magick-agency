import { getAuth } from 'firebase/auth';
import { ORIGINATOR_HEADER, ORIGINATOR } from '../config';
import { captureApiError } from './error-analytics';
import { clearSessionStart } from '../utils/session';
import { isLoginPath, sessionExpiredLoginUrl } from '../utils/returnPath';
import { appendRequestId, extractRequestId, isMaskedErrorBody } from '../utils/errors';
import { retryAfterSecondsFromUnknown } from '../utils/poll-backoff';

/** How many field-level problems are spelled out before the rest are counted. */
const MAX_LISTED_ISSUES = 3;

/**
 * Render an array of Zod-shaped validation problems as one readable sentence.
 *
 * Both backends emit the same `{ path, message }` objects; they differ only in
 * the key they hang the array off (`details` or `issues`), so the formatting
 * lives here once. Anything that is not a `{ message: string }` object is
 * dropped rather than stringified — an `[object Object]` in a toast is worse
 * than a shorter list.
 */
function formatValidationIssues(raw: readonly unknown[]): string {
  const lines: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const issue = entry as { path?: unknown; message?: unknown };
    if (typeof issue.message !== 'string' || issue.message === '') continue;
    const path =
      Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    lines.push(`${path}${issue.message}`);
  }
  if (lines.length === 0) return '';
  if (lines.length <= MAX_LISTED_ISSUES) return lines.join('; ');
  const rest = lines.length - MAX_LISTED_ISSUES;
  return `${lines.slice(0, MAX_LISTED_ISSUES).join('; ')} (and ${rest} more problem${rest === 1 ? '' : 's'})`;
}

export class ApiError extends Error {
  /**
   * Server-side correlation id (from the `x-request-id` header, falling back to
   * the body `requestId`). Set for masked errors so users can quote it to
   * support. Also embedded in `message` for masked errors so it survives the
   * hook layer (which reduces errors to `.message`) — see `utils/errors.ts`.
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
    const masked = isMaskedErrorBody(statusCode, details);
    // Prefer the header-provided id, then the body field.
    const id = requestId ?? extractRequestId(details);
    const base = ApiError.extractMessage(statusCode, details);
    // Embed the id only for masked errors — validation/business errors carry
    // their own actionable message and don't need a support correlation id.
    super(masked ? appendRequestId(base, id) : base);
    this.name = 'ApiError';
    this.requestId = id;
    this.isMasked = masked;
    const parsed = retryAfterSeconds
      ?? retryAfterSecondsFromUnknown(statusCode, details, base)
      ?? undefined;
    this.retryAfterSeconds = parsed;
  }

  private static extractMessage(statusCode: number, details: unknown): string {
    if (typeof details !== 'object' || details === null) return `API error ${statusCode}`;

    const d = details as Record<string, unknown>;

    /*
      Field-level problems are read BEFORE `message`, and the order is the whole
      point of these two branches.

      Fastify's default error body is `{ statusCode, error: 'Bad Request',
      message: 'Bad Request' }`, and a handler that adds its own `issues` array
      leaves that generic `message` in place. Read top-down, `message` matched
      first and won, so the decoder below never ran and a rejected automation
      save still reached the author as the bare words "Bad Request" — the exact
      failure the `issues` branch was added to fix, restored by nothing more
      than statement order. A non-empty array is always the more specific
      answer, so it goes first; a body carrying only `message` is untouched by
      this and still falls through to it.

      Both keys, same array: `details` is what the server sends and `issues` is what
      the server's automation writes send.
    */
    // Validation error shape: { error: "Validation Error", details: [{ message, path }] }
    if (Array.isArray(d['details']) && d['details'].length > 0) {
      const messages = formatValidationIssues(d['details']);
      if (messages) return messages;
    }

    // The SAME array of validation problems under a different key:
    // `{ error: 'Bad Request', issues: [...] }`. That is what the server replies to
    // every automation write.
    if (Array.isArray(d['issues']) && d['issues'].length > 0) {
      const messages = formatValidationIssues(d['issues']);
      if (messages) return messages;
    }

    // Standard error shape: { message: "..." }
    if (typeof d['message'] === 'string') return d['message'];

    // Zod validation shape from the server: { error: "Validation failed", details: { fieldErrors: { field: ["msg"] } } }
    if (typeof d['error'] === 'string' && d['details'] && typeof d['details'] === 'object' && !Array.isArray(d['details'])) {
      const det = d['details'] as Record<string, unknown>;
      const fieldErrors = det['fieldErrors'] as Record<string, string[]> | undefined;
      if (fieldErrors && typeof fieldErrors === 'object') {
        const parts = Object.entries(fieldErrors)
          .filter(([, msgs]) => Array.isArray(msgs) && msgs.length > 0)
          .map(([field, msgs]) => `${field}: ${msgs.join(', ')}`)
          .join('; ');
        if (parts) return `${d['error']}: ${parts}`;
      }
    }

    // The server "all recipients failed" shape: { error: "...", calls: [{ error_message }] }
    if (typeof d['error'] === 'string' && Array.isArray(d['calls'])) {
      const calls = d['calls'] as Array<{ error_message?: string; phone?: string }>;
      const firstFailed = calls.find(c => c.error_message);
      if (firstFailed) {
        return `${d['error']}: ${firstFailed.error_message} (${calls.length} recipient(s) affected)`;
      }
    }

    // Fallback: { error: "..." }
    if (typeof d['error'] === 'string') return d['error'];

    return `API error ${statusCode}`;
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
