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
 *
 * The subscribers run off the request path (LS22 w): the change answers once the cache is dropped,
 * never waiting for them (a re-check reads the database and closes rows, and must not stall an
 * admin's request). Each is still called synchronously, after the drop, before the change answers,
 * so what a subscriber does before its first wait (the listen registry's revocation generation) is
 * done by the time the route answers. A subscriber that fails is logged; it catches up on its own.
 */

/**
 * What changed: a seat `added` (it can narrow access too, see {@link membershipAdded}), or a role
 * changed or a member removed (`revoked`). A subscriber may treat the two differently: listening's
 * re-check fails closed on a revocation and leaves a check it could not make on an addition to
 * its periodic pass (LS22 w).
 */
export type MembershipChange = 'added' | 'revoked';

type MembershipChangeHandler = (tenantId: string, userId: string, change: MembershipChange) => Promise<unknown> | unknown;

const handlers = new Set<MembershipChangeHandler>();

/** Subscribe to membership changes. Returns the unsubscribe. */
export function onMembershipChanged(handler: MembershipChangeHandler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

/** Notifications whose subscribers have not all finished. */
const inFlight = new Set<Promise<void>>();

/**
 * Tell every subscriber, without waiting for them: each is called now; one that fails, at once or
 * later, is logged, never thrown or left an unhandled rejection (each catches up on its own).
 */
function notify(tenantId: string, userId: string, change: MembershipChange): void {
  const told = Promise.all([...handlers].map(async (handler) => {
    try {
      await handler(tenantId, userId, change);
    } catch (err) {
      log.warn({ err, tenantId, userId, change }, 'A membership change subscriber failed — its own periodic check catches what it missed');
    }
  })).then(() => {});
  inFlight.add(told);
  void told.finally(() => inFlight.delete(told));
}

/** Resolves once every notification in flight has finished (tests; a notification never rejects). */
export async function membershipNotificationsSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

/**
 * A seat was added or activated: the cached membership is dropped (`redisCache.del`), then the
 * subscribers told (not waited for). An account-scoped seat is the membership the tenant context picks in that
 * account and can shadow a tenant-wide one, so it can reduce access too.
 */
export async function membershipAdded(tenantId: string, userId: string): Promise<void> {
  await redisCache.del(membershipCacheKey(userId, tenantId));
  notify(tenantId, userId, 'added');
}

/**
 * A role changed or a member was removed: the cached membership is dropped with retries
 * (`redisCache.delForRevocation`, Q5), then the subscribers told (not waited for) whatever the
 * drop's outcome.
 * Returns whether the cache was cleared (the caller decides what a failure answers).
 */
export async function membershipRevoked(tenantId: string, userId: string): Promise<boolean> {
  const cleared = await redisCache.delForRevocation(membershipCacheKey(userId, tenantId));
  notify(tenantId, userId, 'revoked');
  return cleared;
}
