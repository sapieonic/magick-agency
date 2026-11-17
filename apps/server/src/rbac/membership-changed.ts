import { createChildLogger } from '@magick-agency/observability';
import { redisCache } from '../cache/redis-cache.js';
import { membershipCacheKey } from '../api/middleware/membership-cache-key.js';

const log = createChildLogger({ component: 'membership-changed' });

/*
 * A user's membership in a tenant changed: a seat added (an invite, its claim, the super-admin's
 * add), a role changed, a member removed. The routes that write one call {@link membershipAdded}
 * or {@link membershipRevoked}: the membership the tenant context caches is dropped, then every
 * subscriber is told. The platform knows no subscriber by name; the bootstraps subscribe
 * ({@link onMembershipChanged}): live call listening re-checks the user's listens against the
 * database (LS10, LS22 l: `runtime.listen.revokeUser`, and with media workers the primary's
 * `listen.revoke` to each). With none subscribed (a process without the agency runtime) only the
 * cache is dropped.
 */

type MembershipChangeHandler = (tenantId: string, userId: string) => Promise<unknown> | unknown;

const handlers = new Set<MembershipChangeHandler>();

/** Subscribe to membership changes. Returns the unsubscribe. */
export function onMembershipChanged(handler: MembershipChangeHandler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

/** Tell every subscriber; one that fails is logged, never thrown (each catches up on its own). */
async function notify(tenantId: string, userId: string): Promise<void> {
  await Promise.all([...handlers].map(async (handler) => {
    try {
      await handler(tenantId, userId);
    } catch (err) {
      log.warn({ err, tenantId, userId }, 'A membership change subscriber failed — its own periodic check catches what it missed');
    }
  }));
}

/**
 * A seat was added or activated: the cached membership is dropped (`redisCache.del`), then the
 * subscribers told. An account-scoped seat is the membership the tenant context picks in that
 * account and can shadow a tenant-wide one, so it can reduce access too.
 */
export async function membershipAdded(tenantId: string, userId: string): Promise<void> {
  await redisCache.del(membershipCacheKey(userId, tenantId));
  await notify(tenantId, userId);
}

/**
 * A role changed or a member was removed: the cached membership is dropped with retries
 * (`redisCache.delForRevocation`, Q5), then the subscribers told whatever the drop's outcome.
 * Returns whether the cache was cleared (the caller decides what a failure answers).
 */
export async function membershipRevoked(tenantId: string, userId: string): Promise<boolean> {
  const cleared = await redisCache.delForRevocation(membershipCacheKey(userId, tenantId));
  await notify(tenantId, userId);
  return cleared;
}
