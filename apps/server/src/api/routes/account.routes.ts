import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { membershipRepository } from '@magick-agency/db/repositories/membership.repository';
import type { CreateAccountErrorCode } from '@magick-agency/contracts/api/platform/auth';
import { createAccountSchema } from '../validators/account.validator.js';
import { parseOr400 } from './helpers/parse-or-400.js';
import { sendRefusal } from './helpers/refusal.js';
import { createTenantAccount } from './helpers/create-account.js';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../audit/platform/audit-actor.js';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'account-routes' });

/*
 * Accounts of the caller's tenant: list, the caller's own, and create. There is no
 * update or delete route: renaming and removing accounts are not console acts (the
 * contract has no `account.update` or `account.delete`).
 */

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);

  /**
   * POST /accounts — add an account to the caller's tenant (tenant_admin+,
   * `account.create`). Body `CreateAccountBody`, 201 `CreateAccountResponse`.
   *
   * ── A tenant-wide seat only ──────────────────────────────────────────────
   * `requirePermission` proves the ROLE. A `tenant_admin` whose membership is
   * scoped to one account (super-admin can add one) holds the role but not the
   * tenant: `GET /accounts` confines them to their own account, so the account
   * they made would vanish from their switcher the moment it existed. Refused
   * 403 `tenant_wide_membership_required` instead. The console sends this
   * request without `X-Account-Id`, so the tenant-context middleware picks the
   * caller's tenant-wide membership when they hold one beside an account seat.
   *
   * 409 `account_name_taken` when a live account already has the name, ignoring
   * case and spacing (`createTenantAccount`). Nothing is cached about a new
   * account id, so nothing is invalidated.
   *
   * The account starts with `max_concurrent_calls = 0`: it can be set up but
   * places no call until a super admin gives it a limit (decision AA4).
   */
  app.post('/', {
    preHandler: [requirePermission('account.create')],
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    if ((request.membership?.account_id ?? null) !== null) {
      return sendRefusal<CreateAccountErrorCode>(
        reply,
        403,
        'tenant_wide_membership_required',
        'Your admin access covers one account, not the whole organisation, so you cannot create accounts. Ask an admin with access to the whole organisation.',
      );
    }

    const parsed = parseOr400(createAccountSchema, request.body, reply, 'platform');
    if (!parsed) return reply;
    const { name } = parsed.data;
    const tenantId = request.tenantId!;

    // Zero calls until a super admin sets the account's limit (decision AA4): call
    // capacity is not the tenant admin's to grant, and there is no tenant-wide cap.
    const result = await createTenantAccount(tenantId, name, { initialMaxConcurrentCalls: 0 });
    if (result.status === 'tenant_not_found') {
      // The tenant-context middleware proved the tenant; it was deleted since.
      return reply.code(404).send({ error: 'Not Found', message: 'Organisation not found' });
    }
    if (result.status === 'name_taken') {
      return sendRefusal<CreateAccountErrorCode>(
        reply,
        409,
        'account_name_taken',
        `There is already an account called "${name}" in this organisation.`,
      );
    }
    const { account } = result;

    log.info({ tenantId, accountId: account.id }, 'Account created');
    platformAuditLogger.log({
      tenant_id: tenantId,
      account_id: account.id,
      ...requestAuditActor(request),
      action: 'account.created',
      resource_type: 'account',
      resource_id: account.id,
      details: { name: account.name, slug: account.slug },
      ip_address: request.ip,
    });

    return reply.code(201).send({ account });
  });

  /**
   * GET /accounts — list accounts in tenant (viewer+)
   *
   * `account.read` proves the caller's ROLE only, and `findByTenantId` has no
   * account predicate — so without the confinement below an account-scoped
   * `viewer` would get every sibling account's full row (`name`, `slug`,
   * `settings`, `status`): an enumeration surface. An account-scoped caller
   * (`membership.account_id !== null`) is therefore confined to their own
   * account; a tenant-wide caller is unaffected. `GET /accounts/mine` already
   * applies this same rule for a caller with no `account.read` at all — this
   * mirrors it for one who does.
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
   * `@magick-agency/contracts/rbac`) — so an agent signing in gets a 403 from
   * `GET /accounts` and has no other way to learn which account to activate: the
   * console's `TenantContext` swallows that error, never sets an active account,
   * and the feature-flag context spins forever with no visible error. Lowering
   * `account.read` to `agent` was rejected on purpose — a test pins that agents
   * lack it (`apps/console/src/__tests__/utils/agentPermissions.test.ts`) — and
   * widening it would grant every other viewer-floored read on the platform
   * along with it.
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
   * locks, not one. `request.user` is always the Firebase-verified caller (there
   * are no platform API keys in v1); the empty-list branch is defensive.
   */
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
   * No `PUT /accounts/:id` (`account.update`) or `DELETE /accounts/:id`
   * (`account.delete`): neither permission is in the contract and no console page
   * calls them.
   */
}
