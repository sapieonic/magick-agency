import type { FastifyRequest, FastifyReply } from 'fastify';
import { hasPermission, type Permission } from '@magick-agency/contracts/rbac';

/**
 * Factory that returns a Fastify preHandler checking the caller's authority
 * against the required permission.
 *
 * Must be used AFTER sessionMiddleware + tenantContextMiddleware.
 *
 * ── One gate: the role floor ──────────────────────────────────────────────
 * The membership resolved for this (user, tenant, account) must clear the
 * permission's floor in `PERMISSION_MATRIX`, the ONE matrix in
 * `@magick-agency/contracts/rbac`. There are no platform API keys, so there is
 * no key-scope gate.
 *
 * ── No membership, no access ───────────────────────────────────────────────
 * A caller with no resolvable membership is refused on every permissioned
 * route. There is deliberately no branch that skips the floor for any kind of
 * caller: such a branch would skip EVERY floor in the matrix, on every route in
 * the service.
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
  };
}
