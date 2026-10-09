import type { FastifyReply, FastifyRequest } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { redactUrl } from '../../utils/redact-url.js';

/*
 * The app-wide error mask, registered in `app.ts`.
 *
 * 5xx bodies are masked; every 4xx passes through, because every 4xx is authored by this
 * codebase — the public API layer's handlers and the internal handler instance behind
 * `callCore`, whose refusals the console reads by `code`. There is no forwarded body from
 * another service that could carry unreviewed provider text.
 *
 * Also: the 429 pass-through, the `preserveReviewedUpstreamError` opt-out (the reviewed way
 * to let a fixed-shape 5xx through; its one setter is `sendRevocationCacheUnavailable`,
 * `cache/revocation-unavailable.ts` — decision Q5 — so a role change's 503 keeps its "retry"
 * instruction), the content-length / x-request-id headers, and `MASK_EXEMPT_PATHS` for the
 * probes `/healthz` and `/readyz`.
 *
 * The masked message says "contact support" without an address (decision B17) and is
 * exported as `MASKED_ERROR_MESSAGE`.
 */

const log = createChildLogger({ component: 'error-mask' });

/** The sentence surfaced to end users in masked error responses. */
export const MASKED_ERROR_MESSAGE =
  'Something went wrong while processing your request. Please contact support ' +
  'and quote the request ID below so we can look into it.';

/** Cap the original error we log so a huge upstream body can't blow up a log line. */
const MAX_LOGGED_ERROR_CHARS = 2000;

/**
 * Ops/probe endpoints exempt from masking — their error bodies carry diagnostic
 * detail (e.g. `/ready` reports which dependency check failed) that is consumed
 * by humans and monitoring, not the SPA, and is not security-sensitive. Mirrors
 * the request-logging skip set in index.ts.
 */
const MASK_EXEMPT_PATHS = new Set(['/healthz', '/readyz']);

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set only by a proxy route after it has received a reviewed, contract-safe
     * upstream response. A URL-based exemption would also expose unrelated
     * local failures (for example an auth repository exception) on that route.
     */
    preserveReviewedUpstreamError?: boolean;
  }
}

/**
 * The generic, internals-free body returned to the client in place of a leaked
 * error. The `requestId` lets support correlate the masked response with the
 * full, unredacted error logged to Grafana.
 */
export function maskedErrorBody(
  requestId: string,
  statusCode: number,
): { error: string; message: string; statusCode: number; requestId: string } {
  return {
    error: statusCode >= 500 ? 'Internal Error' : 'Request Failed',
    message: MASKED_ERROR_MESSAGE,
    statusCode,
    requestId,
  };
}

function payloadForLog(payload: unknown): unknown {
  let str: string | undefined;
  if (typeof payload === 'string') str = payload;
  else if (Buffer.isBuffer(payload)) str = payload.toString('utf8');
  if (str === undefined) return payload;
  return str.length > MAX_LOGGED_ERROR_CHARS ? `${str.slice(0, MAX_LOGGED_ERROR_CHARS)}…[truncated]` : str;
}

/**
 * `onSend` hook that masks internal error details before they reach the client.
 *
 * This is the single choke point for every response, so internal failure detail
 * (database driver text, stack traces, the SQL a failed statement carried) never
 * leaks to the UI.
 *
 * Masking policy:
 *  - **5xx** — masked unless a route explicitly marks a reviewed, fixed-shape
 *    upstream business/configuration response.
 *  - **429** — always passed through. Current client-facing 429s are authored
 *    pacing signals (rate limit, concurrency, escalation cooldown) with
 *    `retryAfter` / `retry_after_seconds` — masking them into a support-ticket
 *    message is misleading. Do not start returning upstream provider 429 text
 *    as HTTP 429 without revisiting this exception.
 *  - **4xx** (Zod validation, RBAC/business errors, the internal handlers' refusals) —
 *    passed through unchanged.
 *
 * The full original error is logged (error for 5xx) with the request id so it
 * stays queryable in Grafana.
 */
export async function errorMaskHook(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown,
): Promise<unknown> {
  const statusCode = reply.statusCode;
  if (statusCode < 400) return payload;
  if (MASK_EXEMPT_PATHS.has(request.url)) return payload;
  if (request.preserveReviewedUpstreamError === true) return payload;
  // Client-facing 429s are authored pacing signals (see policy above).
  if (statusCode === 429) return payload;

  // 4xx we generated ourselves (validation, RBAC, business rules) — see the header.
  const mask = statusCode >= 500;

  if (!mask) return payload;

  const requestId = String((request as { requestId?: string }).requestId ?? request.id);

  const logCtx = {
    requestId,
    statusCode,
    method: request.method,
    // Redacted, not raw: this hook masks errors on every route, including the
    // two public `/invites/*` routes whose path IS a bearer credential.
    url: redactUrl(request.url),
    originalError: payloadForLog(payload),
  };
  log.error(logCtx, 'Masked internal error response returned to client');

  const masked = JSON.stringify(maskedErrorBody(requestId, statusCode));
  reply.header('content-type', 'application/json; charset=utf-8');
  reply.header('content-length', Buffer.byteLength(masked));
  reply.header('x-request-id', requestId);
  return masked;
}
