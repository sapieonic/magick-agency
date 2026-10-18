/**
 * One reading of a non-ok API response body, shared by the console's `ApiError`
 * and the super-admin's `saError` / `superAdminLogin`.
 *
 * The two clients used to carry their own copies, and they drifted: the
 * super-admin's let a top-level `message` win, so Fastify's generic
 * `message: 'Bad Request'` hid the `details` / `issues` array that said what was
 * actually wrong, and it never read `issues` at all. Parsing lives here once so
 * the order below cannot drift again.
 */
import { appendRequestId, extractRequestId, isMaskedErrorBody } from './errors';

/** How many field-level problems are spelled out before the rest are counted. */
const MAX_LISTED_ISSUES = 3;

/**
 * Render an array of Zod-shaped validation problems as one readable sentence.
 *
 * The server emits the same `{ path, message }` objects under two keys
 * (`details` or `issues`), so the formatting lives here once. A plain non-empty
 * string entry is taken as it is. Anything else that is not a
 * `{ message: string }` object is dropped rather than stringified — an
 * `[object Object]` in a toast is worse than a shorter list.
 */
export function formatValidationIssues(raw: readonly unknown[]): string {
  const lines: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry !== '') lines.push(entry);
      continue;
    }
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

/**
 * The user-facing message in an error body, or `undefined` when the body says
 * nothing usable (the caller picks the fallback).
 */
function messageFromBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const d = body as Record<string, unknown>;

  /*
    Field-level problems are read BEFORE `message`, and the order is the whole
    point of these two branches.

    Fastify's default error body is `{ statusCode, error: 'Bad Request',
    message: 'Bad Request' }`, and a handler that adds its own `issues` array
    leaves that generic `message` in place. Read top-down, `message` matched
    first and won, so the decoder never ran and a rejected save still reached
    the author as the bare words "Bad Request". A non-empty array is always the
    more specific answer, so it goes first; a body carrying only `message` is
    untouched by this and still falls through to it.

    Both keys, same array: `details` is what the server's validation sends and
    `issues` is what its automation writes send.
  */
  if (Array.isArray(d['details']) && d['details'].length > 0) {
    const messages = formatValidationIssues(d['details']);
    if (messages) return messages;
  }
  if (Array.isArray(d['issues']) && d['issues'].length > 0) {
    const messages = formatValidationIssues(d['issues']);
    if (messages) return messages;
  }

  // Standard error shape: { message: "..." }. An empty string says nothing.
  if (typeof d['message'] === 'string' && d['message'] !== '') return d['message'];

  // Zod flatten shape: { error: "Validation failed", details: { fieldErrors: { field: ["msg"] } } }
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

  // The "all recipients failed" shape: { error: "...", calls: [{ error_message }] }
  if (typeof d['error'] === 'string' && Array.isArray(d['calls'])) {
    const calls = d['calls'] as Array<{ error_message?: string; phone?: string }>;
    const firstFailed = calls.find(c => c.error_message);
    if (firstFailed) {
      return `${d['error']}: ${firstFailed.error_message} (${calls.length} recipient(s) affected)`;
    }
  }

  // Fallback: { error: "..." }
  if (typeof d['error'] === 'string' && d['error'] !== '') return d['error'];

  return undefined;
}

export interface ParsedApiErrorBody {
  /** What to show: `baseMessage`, plus the request id when the body is masked. */
  message: string;
  /** The message without any request id appended. */
  baseMessage: string;
  /** Header `x-request-id`, falling back to the body's `requestId`. */
  requestId?: string;
  /** Whether the body is a masked/generic one (no actionable detail). */
  isMasked: boolean;
}

/** Anything with a `Headers`-style `get`; `null` / omitted when there are none. */
export type HeaderSource = { get(name: string): string | null } | null | undefined;

/**
 * Read a non-ok response's parsed body into the message to show.
 *
 * Never throws: `body` is whatever the server sent, and this runs inside an
 * error path that must not raise one of its own. `fallback` defaults to
 * `API error <status>`.
 */
export function parseApiErrorBody(
  status: number,
  body: unknown,
  headers?: HeaderSource,
  fallback: string = `API error ${status}`,
): ParsedApiErrorBody {
  const isMasked = isMaskedErrorBody(status, body);
  // Prefer the header-provided id: it survives a body that failed to parse.
  const requestId = headers?.get('x-request-id') ?? extractRequestId(body);
  const baseMessage = messageFromBody(body) ?? fallback;
  return {
    // Embed the id only for masked errors — validation/business errors carry
    // their own actionable message and need no support correlation id.
    message: isMasked ? appendRequestId(baseMessage, requestId) : baseMessage,
    baseMessage,
    requestId,
    isMasked,
  };
}
