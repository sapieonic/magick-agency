import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  TENANT_HEADER,
  ACCOUNT_HEADER,
  ORIGINATOR_HEADER,
  TENANT_NAME_HEADER,
  ACCOUNT_NAME_HEADER,
} from './headers.js';

/*
 * PORT NOTE (magick-agency): ported from magic-voice-core/src/api/middleware/auth.middleware.ts
 * @4850d1d9. Core's handler modules (`agency*.routes.ts`) read the tenant and account
 * through the getters below, verbatim. They now run only on the private in-process
 * instance behind `api/core-dispatch.ts` (decision B16), where the headers are set by
 * master's handler from the authenticated session (lane A's session → tenant-context →
 * RBAC chain), never by a browser.
 *
 * `authMiddleware` keeps only its header half: a request without a tenant or an account
 * is still a 400 with core's body (master forwarded `request.accountId`, the optional
 * `X-Account-Id`, so a console request without one met exactly this refusal). Deleted:
 * the API-key and JWT branches (no core API keys, decision #5; the caller is in-process)
 * and PostHog's `identifyTenantAccount` (not carried by lane C).
 */

// Re-exported for backward compatibility — the canonical definitions live in
// ./headers.js so header-only consumers avoid this module's import chain.
export {
  TENANT_HEADER,
  ACCOUNT_HEADER,
  ORIGINATOR_HEADER,
  TENANT_NAME_HEADER,
  ACCOUNT_NAME_HEADER,
};

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // ── Tenant header (required on every authenticated route) ──
  const tenantId = request.headers[TENANT_HEADER] as string | undefined;
  if (!tenantId || tenantId.trim().length === 0) {
    reply.code(400).send({
      error: 'Bad Request',
      message: `Missing required header: ${TENANT_HEADER}`,
    });
    return;
  }

  // ── Account header (required on every authenticated route) ──
  const accountId = request.headers[ACCOUNT_HEADER] as string | undefined;
  if (!accountId || accountId.trim().length === 0) {
    reply.code(400).send({
      error: 'Bad Request',
      message: `Missing required header: ${ACCOUNT_HEADER}`,
    });
    return;
  }
}

/** Extract the tenant ID from request headers. Use after authMiddleware has validated it. */
export function getTenantId(request: FastifyRequest): string {
  return request.headers[TENANT_HEADER] as string;
}

/** Extract the account ID from request headers. Use after authMiddleware has validated it. */
export function getAccountId(request: FastifyRequest): string {
  return request.headers[ACCOUNT_HEADER] as string;
}

/** Extract the originator from request headers, if the optional header is present. */
export function getOriginator(request: FastifyRequest): string | undefined {
  return request.headers[ORIGINATOR_HEADER] as string | undefined;
}

/** Extract the human-readable tenant name from request headers, if the optional header is present. */
export function getTenantName(request: FastifyRequest): string | undefined {
  return request.headers[TENANT_NAME_HEADER] as string | undefined;
}

/** Extract the human-readable account name from request headers, if the optional header is present. */
export function getAccountName(request: FastifyRequest): string | undefined {
  return request.headers[ACCOUNT_NAME_HEADER] as string | undefined;
}
