import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
// PORT NOTE (magick-agency): master's `invalidateAccountRecordCache`,
// `invalidateMetadataCache`, `account.validator`, the core account-settings sync
// service and `denyPlatformApiKey` imports are removed. The first four served
// only the deleted `POST /`, `PUT /:id` and `DELETE /:id`; the last is decision #5
// (no platform API keys).

/*
 * PORT NOTE (magick-agency): master's `accountScopeMismatch` /
 * `ACCOUNT_SCOPE_MISMATCH_REPLY` guarded only `PUT /:id` and `DELETE /:id`,
 * which are deleted below, so they go with them.
 */

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);

  /*
   * PORT NOTE (magick-agency): master's `POST /accounts` (`account.create`) is
   * DELETED. The contract (`@magick-agency/contracts/rbac`) has no
   * `account.create`, and no console page in agency's scope calls it (cusui's
   * AccountsPage is out of scope; decision Q3e). Super-admins create accounts.
   */

  /**
   * GET /accounts — list accounts in tenant (viewer+)
   *
   * `account.read` proves the caller's ROLE only, and `findByTenantId` has no
   * account predicate — so an account-scoped `viewer` got every sibling
   * account's full row (`name`, `slug`, `settings` — including
   * `default_pipeline` — `status`), which is exactly the enumeration surface
   * the original `PUT /accounts/:id` finding used, just via a read instead of
   * a write. An account-scoped caller (`membership.account_id !== null`) is
   * therefore confined to their own account; a tenant-wide caller is
   * unaffected. `GET /accounts/mine` already applies this same rule for a
   * caller with no `account.read` at all — this mirrors it for one who does.
   */
  app.get('/', {
    preHandler: [requirePermission('account.read')],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const callerAccountId = request.membership?.account_id ?? null;
    const accounts = callerAccountId !== null
      ? await accountRepository.findByIdInTenant(callerAccountId, request.tenantId!).then((a) => (a ? [a] : []))
      : await accountRepository.findByTenantId(request.tenantId!);
    return reply.send({ accounts });
  });

  /**
   * GET /accounts/mine — the accounts the CALLER is a member of.
   * Authentication only — no RBAC permission check.
   *
   * ── Why this route exists ───────────────────────────────────────────────
   * `GET /accounts` above floors at `account.read` = `viewer` (10). The
   * Agency Dialer's `agent` role is deliberately `5` — BELOW `viewer` (see
   * `src/rbac/roles.ts`) — so an agent signing in gets a 403 from `GET
   * /accounts` and has no other way to learn which account to activate:
   * cusui's `TenantContext` swallows that error, never sets an active
   * account, and the feature-flag context spins forever with no visible
   * error. Lowering `account.read` to `agent` was rejected on purpose — a
   * test pins that agents lack it (`cusui/src/__tests__/utils/
   * agentPermissions.test.ts`) — and widening it would grant every other
   * viewer-floored read on the platform along with it.
   *
   * ── Why this is safe without a permission check ─────────────────────────
   * The response is never the tenant's account list — it is the SET OF
   * ACCOUNTS THE CALLER'S OWN MEMBERSHIPS ALREADY POINT AT, which every
   * authenticated member of a tenant is entitled to know about themselves
   * (it is exactly the information `POST /auth/session` already returns as
   * `memberships[].account_id` — this route just resolves those ids to
   * `{id, name, tenant_id}` for a caller who wasn't given `account.read` to
   * do it themselves). A membership with `account_id = NULL` is tenant-wide
   * by the same rule `tenant-context.middleware.ts` and the RBAC layer
   * already apply ("Tenant-level members … can access all accounts"), so it
   * resolves to every account in the tenant rather than zero.
   *
   * `request.tenantId` is already proven to belong to the caller by
   * `tenantContextMiddleware` (403s upstream otherwise), so the MEMBERSHIP
   * lookup below is scoped by construction. That alone is not enough to
   * guarantee the ACCOUNTS it resolves to are also this tenant's: nothing in
   * the schema stops a membership's `account_id` from pointing at another
   * tenant's account (see `accountRepository.findByIds`'s docstring), so
   * `findByIds` is called with `request.tenantId` as an independent second
   * filter — the membership scoping and the account scoping are two separate
   * locks, not one. `request.user` can be absent under pure API-key auth (no
   * `created_by` user) — there is no "mine" for a non-human caller, so that
   * degrades to an empty list rather than throwing.
   */
  // PORT NOTE (magick-agency): master refused a platform API key here
  // (`denyPlatformApiKey`); there are no platform API keys (decision #5), so the
  // route has no per-route preHandler. `request.user` is always the
  // Firebase-verified caller.
  app.get('/mine', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return reply.send({ accounts: [] });
    }

    const memberships = await membershipRepository.findByUserAndTenant(request.user.id, request.tenantId!);

    const isTenantWide = memberships.some((m) => m.account_id === null);
    const accounts = isTenantWide
      ? await accountRepository.findByTenantId(request.tenantId!)
      : await accountRepository.findByIds(
          [
            ...new Set(
              memberships
                .map((m) => m.account_id)
                .filter((id): id is string => id !== null),
            ),
          ],
          request.tenantId!,
        );

    return reply.send({
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, tenant_id: a.tenant_id })),
    });
  });

  /*
   * PORT NOTE (magick-agency): master's `PUT /accounts/:id` (`account.update`)
   * and `DELETE /accounts/:id` (`account.delete`) are DELETED, for the same reason
   * as `POST /` above: neither permission is in the contract and no console page
   * in scope calls them.
   */
}
