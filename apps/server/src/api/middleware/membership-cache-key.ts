/**
 * The Redis key `tenantContextMiddleware` caches a user's memberships in a tenant under,
 * and the one every membership write deletes so the next request re-reads the rows.
 *
 * One spelling, in a leaf module with no imports: the middleware reads it, and the user,
 * invite and super-admin routes delete it — a route spelling it differently would delete a
 * key nobody reads and leave a revoked membership cached for its full TTL. User-then-tenant,
 * so `invalidateTenantMembershipCache` can match every user of a tenant by suffix.
 */
export function membershipCacheKey(userId: string, tenantId: string): string {
  return `cache:membership:${userId}:${tenantId}`;
}
