import type { FastifyRequest, FastifyReply } from 'fastify';
import { hasPermission, type Permission } from '@magick-agency/contracts/rbac';

/**
 * Factory that returns a Fastify preHandler checking the caller's authority
 * against the required permission.
 *
 * Must be used AFTER sessionMiddleware + tenantContextMiddleware.
 *
 * ── Two independent gates, both of which must pass ──────────────────────────
 *  1. ROLE — the membership resolved for this (user, tenant, account) clears the
 *     permission's floor in `PERMISSION_MATRIX`.
 *  2. SCOPE — when the caller is a platform API key, the key's `scopes` contain
 *     the permission. Scopes can only ever narrow a key below its creator's role,
 *     never widen it, which is what makes them safe for customers to mint.
 *
 * ── The bypass this used to open ───────────────────────────────────────────
 * The first statement in this function used to be:
 *
 *     if (request.apiKeyTenantId && !request.user) return;
 *
 * i.e. a key whose `created_by` did not resolve to a user skipped EVERY floor in
 * the matrix, on every route in the service. That is not a narrow hole. The
 * reachable set included `POST /credits/allocate` (moving money between
 * accounts), `PUT /users/:id/role` (which can grant `tenant_owner`),
 * `DELETE /users/:id/membership`, `PUT /tenants/:id` (whose settings mirror into
 * core's `account_settings.default_ai_pipeline`, so it changes INBOUND call
 * behaviour that never passes through master), `DELETE /accounts/:id`,
 * `POST /proxy/sip/connections` — and `POST /api-keys` itself, which made it
 * self-propagating: `created_by: request.user?.id` is `undefined` for such a
 * caller, so an unrestricted key minted more unrestricted keys.
 *
 * Two things made it easy to miss. It was *tested* — `platform-api-key-auth.test.ts`
 * asserted "grants full access when the key has no created_by user" — so it read
 * as a decision rather than an oversight. And `platform_api_keys.created_by` is
 * `ON DELETE SET NULL` (migration 003), which meant deleting a user did not
 * disable the keys they created, it PROMOTED them from that person's role to
 * unrestricted tenant access, silently. Migration 065 changes that FK to
 * `RESTRICT`; this function is the half that actually closes the hole, and it is
 * why the two must ship together.
 *
 * ── So: no membership, no access ───────────────────────────────────────────
 * A key with no resolvable membership is now inert on every permissioned route
 * rather than omnipotent on all of them. That is a deliberate, breaking change
 * for any key provisioned with a NULL `created_by`, and the intended remedy is to
 * give such a key a real membership (a service user), not to re-open the branch.
 * `SELECT id, tenant_id, name FROM platform_api_keys WHERE created_by IS NULL AND status = 'active';`
 * finds the keys affected before a deploy.
 */
export function requirePermission(permission: Permission) {
  return async function rbacPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const membership = request.membership;
    if (!membership) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: 'No active membership found for this context',
      });
    }

    if (!hasPermission(membership.role, permission)) {
      return reply.code(403).send({
        error: 'Forbidden',
        message: `Insufficient permissions. Required: ${permission}`,
      });
    }

    /*
     * PORT NOTE (magick-agency): master's second gate — API-key SCOPE narrowing
     * (`resolveScopePermissions` / `scopesPermit`, 403 `api_key_not_permitted`) —
     * is deleted with platform API keys (decision #5). The role floor above is the
     * whole check, against the ONE matrix in `@magick-agency/contracts/rbac`.
     */
  };
}
