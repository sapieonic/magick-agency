import type { FastifyRequest, FastifyReply } from 'fastify';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import { redisCache } from '../../cache/redis-cache.js';
import {
  resolveTenantAccountNames,
  getCachedAccountRecord,
} from '../../services/tenant-name-resolver.js';
import type { MembershipRecord } from '@magick-agency/db/models/membership.model';

declare module 'fastify' {
  interface FastifyRequest {
    tenantId?: string;
    accountId?: string;
    /** Display name of the resolved tenant — forwarded to core as a header. */
    tenantName?: string;
    /** Display name of the resolved account — forwarded to core as a header. */
    accountName?: string;
    membership?: MembershipRecord;
  }
}

const MEMBERSHIP_CACHE_TTL = 30 * 60; // 30 minutes

/**
 * Invalidate every cached membership for a tenant (`cache:membership:*:{tenantId}`
 * — the key is user-then-tenant, so the tenant is the suffix). Call when a
 * tenant-wide membership change lands that isn't scoped to a single user, e.g.
 * deleting/suspending a tenant deactivates all its memberships at once.
 */
export async function invalidateTenantMembershipCache(tenantId: string): Promise<void> {
  await redisCache.delByPattern(`cache:membership:*:${tenantId}`);
}

/**
 * Postgres `22P02 invalid_text_representation` — what a non-UUID `X-Account-Id`
 * produces against a `UUID` column. A client-supplied header must not be able to
 * turn into a 500, and it must not be able to skip the ownership check either,
 * so this is mapped to the same refusal as an unknown account.
 */
function isInvalidUuidError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '22P02';
}

/**
 * Which of a user's memberships in this tenant a request acts under.
 *
 * With `X-Account-Id`: that account's own row, else the tenant-wide row (which
 * reaches every account). Without it: the tenant-wide row, else the OLDEST
 * account-scoped row (`created_at`, then `id`).
 *
 * ── Why "oldest" and not `memberships[0]` ───────────────────────────────────
 * The fallback used to be `memberships[0]`, and `findByUserAndTenant` had no
 * `ORDER BY`, so for a user holding two account-scoped memberships and no
 * tenant-wide one, Postgres heap order picked the account — and therefore the
 * role, and every account-scoped filter downstream. It could change between
 * requests and across a membership-cache refresh: an ingest job created under
 * account A was stamped A, and the same person polling it a little later could
 * resolve to B and get a 404 for their own import. The rule is applied here in
 * code as well as in the SQL because an array already in the membership cache
 * was written before the SQL gained its ORDER BY, and because a cached copy
 * comes back through JSON with `created_at` as a string.
 *
 * "Oldest" is a deterministic choice, not a semantic one — nothing ranks one
 * account over another. A client that means a specific account sends
 * `X-Account-Id`; this only guarantees the answer does not flip underneath one
 * that does not.
 */
export function selectMembership(
  memberships: MembershipRecord[],
  accountId: string | undefined,
): MembershipRecord | undefined {
  if (accountId) {
    return memberships.find((m) => m.account_id === accountId)
      ?? memberships.find((m) => m.account_id === null);
  }
  const tenantWide = memberships.find((m) => m.account_id === null);
  if (tenantWide) return tenantWide;
  const createdAt = (m: MembershipRecord): number => {
    const t = m.created_at ? new Date(m.created_at).getTime() : Number.NaN;
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  return [...memberships].sort(
    (a, b) => createdAt(a) - createdAt(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
}

/**
 * Does `accountId` actually belong to `tenantId`?
 *
 * ── The hole this closes ────────────────────────────────────────────────────
 * `X-Account-Id` was read from the header and assigned to `request.accountId`
 * **verbatim**, with the only membership check being the tenant-wide fallback
 * below — which succeeds for any tenant-wide member of the tenant they named. So
 * a legitimate tenant-wide member of A could send `X-Tenant-Id: A` with
 * `X-Account-Id: <an account of B>` and every downstream consumer would take the
 * foreign id as fact:
 *
 *  - **writes** store it — `agencyIngestJobRepository.create` stamps it on the
 *    ingest job, and from there onto core's roster rows;
 *  - **reads** leak with it — `resolveTenantAccountNames` resolved B's display
 *    name and `proxyToCore` forwarded it to core as `x-mgkvc-account-name`;
 *  - **analytics** mis-attribute — the same resolver registers PostHog group
 *    properties, filing A's events under B's account group.
 *
 * The invite fix closed the other door (a membership row written cross-tenant);
 * this is the door that needed no membership row at all.
 *
 * ── Why here ────────────────────────────────────────────────────────────────
 * Every `/proxy/*`, contact-list, agency and automation route inherits this
 * middleware, and none of them re-derives the account. Checking per-route means
 * checking in ~100 places and missing the next one; the header is parsed exactly
 * once, so it should be constrained exactly once.
 *
 * **Fails closed on a malformed id, propagates a genuine fault.** A 22P02 is the
 * client's doing and is refused; a connection error is ours and must not be
 * disguised as an authorization decision.
 */
async function accountBelongsToTenant(accountId: string, tenantId: string): Promise<boolean> {
  try {
    const account = await getCachedAccountRecord(accountId);
    return account !== null && account.tenant_id === tenantId;
  } catch (err) {
    if (isInvalidUuidError(err)) return false;
    throw err;
  }
}

/**
 * Extracts X-Tenant-Id and optional X-Account-Id from headers,
 * validates that the authenticated user has a membership in the given tenant/account,
 * validates that the named account belongs to the named tenant,
 * and attaches tenantId, accountId, and membership to the request.
 */
export async function tenantContextMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tenantId = request.headers['x-tenant-id'] as string | undefined;
  const accountId = request.headers['x-account-id'] as string | undefined;

  if (!tenantId) {
    return reply.code(400).send({ error: 'Bad Request', message: 'X-Tenant-Id header is required' });
  }

  /*
   * PORT NOTE (magick-agency): master's platform-API-key branch (key tenant must
   * equal `X-Tenant-Id`, account ownership check, creator's membership loaded for
   * RBAC) is deleted with platform API keys (decision #5). Every request reaching
   * here is a Firebase-authenticated user, and the checks below are master's.
   */

  // Firebase-authenticated user: validate membership
  if (!request.user) {
    return reply.code(401).send({ error: 'Unauthorized', message: 'User context not found' });
  }

  // Look for a membership in this tenant — try Redis cache first
  const membershipCacheKey = `cache:membership:${request.user.id}:${tenantId}`;
  let memberships = await redisCache.get<MembershipRecord[]>(membershipCacheKey);
  if (!memberships) {
    memberships = await membershipRepository.findByUserAndTenant(request.user.id, tenantId);
    if (memberships.length > 0) {
      await redisCache.set(membershipCacheKey, memberships, MEMBERSHIP_CACHE_TTL);
    }
  }
  if (memberships.length === 0) {
    return reply.code(403).send({ error: 'Forbidden', message: 'You are not a member of this tenant' });
  }

  const membership = selectMembership(memberships, accountId);

  if (!membership || membership.status !== 'active') {
    return reply.code(403).send({ error: 'Forbidden', message: 'No active membership for this context' });
  }

  /**
   * Ownership, checked AFTER membership and as a separate question.
   *
   * The membership resolution above answers "may this user act in this tenant",
   * and its tenant-wide fallback (`m.account_id === null`) deliberately grants
   * access to every account **in that tenant**. It cannot answer "is this account
   * in that tenant", because a tenant-wide membership row has no account to
   * compare against — which is exactly why naming a foreign account satisfied it.
   */
  if (accountId && !(await accountBelongsToTenant(accountId, tenantId))) {
    return reply.code(403).send({
      error: 'Forbidden',
      message: 'X-Account-Id does not belong to this tenant',
    });
  }

  request.tenantId = tenantId;
  request.accountId = accountId;
  request.membership = membership;
  await attachTenantAccountNames(request, tenantId, accountId);
}

/**
 * Resolve and attach tenant/account display names to the request. Because the
 * request is the live log-context source, these names are then forwarded to
 * core on every proxied call. Best-effort: failures leave the names unset.
 */
async function attachTenantAccountNames(
  request: FastifyRequest,
  tenantId: string,
  accountId?: string,
): Promise<void> {
  const names = await resolveTenantAccountNames(tenantId, accountId);
  request.tenantName = names.tenantName;
  request.accountName = names.accountName;
}
