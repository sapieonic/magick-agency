/*
 * A tenant's accounts with their concurrency settings, and one account's concurrency read
 * and write. The only writer of the per-account limit. Part of `super-admin.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { superAdminAuditRepository } from '@magick-agency/db/repositories/super-admin-audit.repository';
import { tenantPhoneAssignmentRepository } from '@magick-agency/db/repositories/tenant-phone-assignment.repository';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import {
  ConcurrencyAllocationVersionConflictError,
  providerConcurrencyRepository,
} from '@magick-agency/db/repositories/provider-concurrency.repository';
import type { AccountConcurrencyAllocation } from '@magick-agency/db/models/account-settings.model';
import { getConcurrencyControl } from '../../../seams/concurrency-control.js';
import { settledValue } from '../helpers/settled.js';
import { auditLogger } from '../../../audit/audit-logger.js';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'super-admin-routes' });

/**
 * The utilization read: live counts come from the voice engine's guards through
 * `seams/concurrency-control.ts` (`getAccountProviderCounts` per provider,
 * `getAccountCount` for the account total).
 */
async function readAccountConcurrencyUtilization(
  tenantId: string,
  accountId: string,
  allocation: AccountConcurrencyAllocation,
) {
  const control = getConcurrencyControl();
  // Independent reads, together; either failing fails the utilization read, which the
  // caller turns into `null` whichever one it was.
  const [live, accountInUse] = await Promise.all([
    control.getAccountProviderCounts(tenantId, accountId),
    control.getAccountCount(tenantId, accountId),
  ]);
  const allocations = new Map(allocation.providers.map((row) => [row.provider, row.max_concurrent_calls]));
  const providerNames = new Set([...allocations.keys(), ...live.counts.keys()]);
  const providers = [...providerNames].sort().map((provider) => {
    const allocated = allocations.get(provider) ?? 0;
    const inUse = live.status === 'available' ? (live.counts.get(provider) ?? 0) : null;
    return {
      provider,
      allocated,
      in_use: inUse,
      available: inUse === null ? null : Math.max(0, allocated - inUse),
      over_limit: inUse === null ? null : Math.max(0, inUse - allocated),
      saturated: inUse === null ? null : inUse >= allocated,
      draining: allocated === 0 && inUse !== null && inUse > 0,
    };
  });
  return {
    mode: allocation.mode,
    version: allocation.version,
    status: live.status,
    observed_at: new Date().toISOString(),
    total: {
      allocated: allocation.total_concurrency,
      in_use: live.status === 'available' ? accountInUse : null,
      available: live.status === 'available'
        ? Math.max(0, allocation.total_concurrency - accountInUse)
        : null,
    },
    providers,
  };
}

/**
 * Registered by `superAdminRoutes` inside its authenticated scope (`authApp`, the one
 * carrying `superAdminMiddleware`), so every route here runs behind it.
 */
export async function registerSuperAdminConcurrencyRoutes(authApp: FastifyInstance): Promise<void> {
  /**
   * GET /super-admin/tenants/:id/accounts
   * List all accounts for a tenant with their concurrency settings.
   *
   * The allocations are `providerConcurrencyRepository.getAllocationsForAccounts`:
   * one statement for every account of the tenant, each entry what `getAllocation`
   * answers for that account. A read failure reports `unavailable` rather than
   * fabricating a limit.
   */
  authApp.get('/tenants/:id/accounts', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id: tenantId } = request.params;
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }

    const dbAccounts = await accountRepository.findByTenantId(tenantId);

    let allocations: Map<string, AccountConcurrencyAllocation> | null = null;
    try {
      allocations = await providerConcurrencyRepository.getAllocationsForAccounts(
        tenantId,
        dbAccounts.map((acc) => acc.id),
      );
    } catch (err) {
      log.warn({ err, tenantId, accounts: dbAccounts.length }, 'Account concurrency unavailable');
    }

    const accounts = dbAccounts.map((acc) => {
      const concurrency = allocations?.get(acc.id);
      return {
        id: acc.id,
        name: acc.name,
        slug: acc.slug,
        status: acc.status,
        max_concurrent_calls: concurrency ? concurrency.total_concurrency : null,
        concurrency_status: concurrency ? 'available' : 'unavailable',
        ...(concurrency ? { concurrency } : {}),
      };
    });

    return reply.send({ accounts });
  });

  /**
   * PUT /super-admin/tenants/:id/accounts/:accountId/concurrency
   * Update the concurrency allocation for a specific account.
   */
  const updateConcurrencySchema = z.object({
    max_concurrent_calls: z.number().int().min(1).max(1000),
  });

  const providerConcurrencySchema = z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('legacy_total'),
      version: z.number().int().min(1),
      max_concurrent_calls: z.number().int().min(1).max(1000),
      change_reason: z.string().min(3).max(1000),
    }),
    z.object({
      mode: z.literal('provider_breakdown'),
      version: z.number().int().min(1),
      providers: z.array(z.object({
        provider: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/),
        max_concurrent_calls: z.number().int().min(0).max(1000),
      })).min(1).max(50),
      force_migration: z.boolean().optional().default(false),
      change_reason: z.string().min(3).max(1000),
    }),
  ]);

  /**
   * GET /super-admin/tenants/:id/accounts/:accountId/concurrency
   *
   * `allocation` is `getAllocation` and `utilization` is computed in-process by
   * `readAccountConcurrencyUtilization`. When the utilization read itself fails
   * (the guard is unreachable or not wired) it is `null` — the contract's
   * `AccountConcurrencyDetail.utilization: … | null`. No telephony catalog,
   * entitlements or synchronization state (the module note in `super-admin.routes.ts`).
   */
  authApp.get('/tenants/:id/accounts/:accountId/concurrency', async (
    request: FastifyRequest<{ Params: { id: string; accountId: string } }>,
    reply: FastifyReply,
  ) => {
    const { id: tenantId, accountId } = request.params;
    const [tenant, account] = await Promise.all([
      tenantRepository.findById(tenantId),
      accountRepository.findById(accountId),
    ]);
    if (!tenant || !account || account.tenant_id !== tenantId) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant or account not found' });
    }

    try {
      const allocation = await providerConcurrencyRepository.getAllocation(tenantId, accountId);
      const utilization = await readAccountConcurrencyUtilization(tenantId, accountId, allocation).catch((err: unknown) => {
        log.warn({ err, tenantId, accountId }, 'Account concurrency utilization unavailable');
        return null;
      });
      return reply.send({ allocation, utilization });
    } catch (err) {
      log.error({ err, tenantId, accountId }, 'Failed to read account concurrency');
      return reply.code(500).send({ error: 'Internal Server Error', message: 'Failed to read account concurrency' });
    }
  });

  /**
   * PUT /super-admin/tenants/:id/accounts/:accountId/concurrency
   *
   * In order: the two accepted bodies and their checks (duplicate provider, total
   * 1..1000, a routed number per allocated provider); the legacy-body translation
   * (`version` from the current allocation, refused once the account is in
   * provider mode); the provider-mode migration drain check through the ACCOUNT
   * guard's distributed count (503 when unavailable, 409 with active calls, both
   * bypassed by `force_migration`); the versioned write; three invalidations, in
   * this order (settings row cache → account guard → provider guard), the guard
   * calls through `seams/concurrency-control.ts`; the `concurrency.allocation.updated`
   * audit row (actor = the super admin's email); the super-admin audit row. A drain
   * or version refusal, or an unexpected throw (answered 500), writes the
   * `update_account_concurrency_failed` super-admin audit row through `refuse`.
   */
  authApp.put('/tenants/:id/accounts/:accountId/concurrency', async (request: FastifyRequest<{ Params: { id: string; accountId: string } }>, reply: FastifyReply) => {
    const { id: tenantId, accountId } = request.params;

    const providerParsed = providerConcurrencySchema.safeParse(request.body);
    const legacyParsed = updateConcurrencySchema.safeParse(request.body);
    if (!providerParsed.success && !legacyParsed.success) {
      const providerShaped = typeof request.body === 'object' && request.body !== null && 'mode' in request.body;
      return reply.code(400).send({
        error: 'Bad Request',
        details: providerShaped ? providerParsed.error.issues : legacyParsed.error.issues,
      });
    }

    // Together, answered in order (`settledValue`), as the GET twin reads them.
    const [tenantRead, accountRead] = await Promise.allSettled([
      tenantRepository.findById(tenantId),
      accountRepository.findById(accountId),
    ]);
    const tenant = settledValue(tenantRead);
    if (!tenant) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }

    const account = settledValue(accountRead);
    if (!account || account.tenant_id !== tenantId) {
      return reply.code(404).send({ error: 'Not Found', message: 'Account not found' });
    }

    const superAdmin = request.superAdmin!;
    let before: AccountConcurrencyAllocation | null = null;
    /** The `update_account_concurrency_failed` super-admin audit row, then the reply. */
    const refuse = async (status: number, body: Record<string, unknown>) => {
      // Awaited, with an error log that names the row it lost (Manas, 2026-10-09:
      // a failed super-admin audit write must say what it was).
      await superAdminAuditRepository.log({
        admin_id: superAdmin.id, admin_email: superAdmin.email,
        action: 'update_account_concurrency_failed', resource_type: 'account', resource_id: accountId,
        details: { tenant_id: tenantId, status, before },
      }).catch((auditErr) => log.error({
        err: auditErr, action: 'update_account_concurrency_failed',
        actor: { admin_id: superAdmin.id, admin_email: superAdmin.email },
        target: { resource_type: 'account', resource_id: accountId }, tenantId,
      }, 'Failed to audit rejected concurrency update'));
      return reply.code(status).send(body);
    };

    try {
      if (providerParsed.success && providerParsed.data.mode === 'provider_breakdown') {
        const names = providerParsed.data.providers.map((row) => row.provider);
        const total = providerParsed.data.providers.reduce(
          (sum, row) => sum + row.max_concurrent_calls, 0,
        );
        if (total < 1 || total > 1000) {
          return reply.code(400).send({
            error: 'Bad Request', message: 'Total concurrency must be between 1 and 1000',
          });
        }
        const allocatedNames = providerParsed.data.providers
          .filter((row) => row.max_concurrent_calls > 0)
          .map((row) => row.provider);
        if (new Set(names).size !== names.length) {
          return reply.code(400).send({ error: 'Bad Request', message: 'Each provider may appear only once' });
        }
        // No telephony-catalog checks (`super-admin.routes.ts` module note). The routed-number check
        // stays: capacity on a carrier the account has no number on cannot place
        // a call.
        const routes = await tenantPhoneAssignmentRepository.findAvailableForAccount(tenantId, accountId);
        const unrouted = allocatedNames.filter((name) => !routes.some((route) => route.provider_name === name));
        if (unrouted.length > 0) {
          return reply.code(422).send({ error: 'Unusable Provider', message: `No active account-accessible phone number for: ${unrouted.join(', ')}` });
        }
      }

      before = await providerConcurrencyRepository.getAllocation(tenantId, accountId).catch(() => null);
      let data:
        | { mode: 'legacy_total'; version: number; max_concurrent_calls: number; change_reason: string }
        | { mode: 'provider_breakdown'; version: number; providers: Array<{ provider: string; max_concurrent_calls: number }>; force_migration: boolean; change_reason: string };
      if (providerParsed.success) {
        data = providerParsed.data;
      } else {
        if (!before) {
          return reply.code(503).send({ error: 'Service Unavailable', message: 'Current concurrency allocation is unavailable' });
        }
        if (before.mode === 'provider_breakdown') {
          return reply.code(409).send({ error: 'Conflict', message: 'Use the versioned provider allocation editor for this account' });
        }
        data = {
          mode: 'legacy_total',
          version: before.version,
          max_concurrent_calls: legacyParsed.data!.max_concurrent_calls,
          change_reason: 'Legacy total updated from Super Admin',
        };
      }
      if (!before) {
        // A provider-shaped body with no readable current allocation fails the
        // request (500, audited) rather than writing blind.
        throw new Error('Current concurrency allocation is unavailable');
      }

      // ── The versioned write, its invalidations and the allocation audit row ──
      let allocation: AccountConcurrencyAllocation;
      try {
        if (data.mode === 'provider_breakdown') {
          if (before.mode === 'legacy_total') {
            const active = await getConcurrencyControl().getDistributedAccountCount(tenantId, accountId);
            if (active.status === 'unavailable' && !data.force_migration) {
              return await refuse(503, {
                error: 'Concurrency State Unavailable',
                message: 'Cannot safely migrate while the distributed active-call count is unavailable',
                current_version: before.version,
              });
            }
            if (active.status === 'available' && active.count > 0 && !data.force_migration) {
              return await refuse(409, {
                error: 'Active Calls',
                message: 'Provider-mode migration requires the account to drain active calls or an explicit force_migration confirmation',
                active_calls: active.count,
                current_version: before.version,
              });
            }
          }
          allocation = await providerConcurrencyRepository.replaceProviderBreakdown({
            tenant_id: tenantId,
            account_id: accountId,
            expected_version: data.version,
            providers: data.providers,
          });
        } else {
          allocation = await providerConcurrencyRepository.switchToLegacy({
            tenant_id: tenantId,
            account_id: accountId,
            expected_version: data.version,
            max_concurrent_calls: data.max_concurrent_calls,
          });
        }
      } catch (err) {
        if (err instanceof ConcurrencyAllocationVersionConflictError) {
          return await refuse(409, {
            error: 'Conflict', message: err.message, current_version: err.currentVersion,
          });
        }
        throw err;
      }

      accountSettingsRepository.invalidate(tenantId, accountId);
      await getConcurrencyControl().invalidateAccountLimit(tenantId, accountId);
      await getConcurrencyControl().invalidateProviderLimits(tenantId, accountId);
      auditLogger.log({
        tenantId,
        accountId,
        eventType: 'concurrency.allocation.updated',
        eventCategory: 'system',
        severity: 'info',
        actor: superAdmin.email,
        eventData: {
          before,
          after: allocation,
          change_reason: data.change_reason,
          ...(data.mode === 'provider_breakdown' && data.force_migration
            ? { force_migration: true }
            : {}),
        },
      });
      // ── end of the allocation write ───────────────────────────────────────

      // Awaited; the error log names the lost row (Manas, 2026-10-09).
      await superAdminAuditRepository.log({
        admin_id: superAdmin.id, admin_email: superAdmin.email,
        action: 'update_account_concurrency', resource_type: 'account', resource_id: accountId,
        details: {
          tenant_id: tenantId,
          ...(!providerParsed.success && legacyParsed.success
            ? { max_concurrent_calls: legacyParsed.data.max_concurrent_calls }
            : {}),
          before,
          after: allocation,
        },
      }).catch((auditErr) => log.error({
        err: auditErr, action: 'update_account_concurrency',
        actor: { admin_id: superAdmin.id, admin_email: superAdmin.email },
        target: { resource_type: 'account', resource_id: accountId }, tenantId,
      }, 'Failed to audit concurrency update'));
      log.info({ tenantId, accountId, mode: data.mode }, 'Super admin updated account concurrency');

      return reply.send(allocation);
    } catch (err) {
      log.error({ err, tenantId, accountId }, 'Failed to update account concurrency');
      // An unexpected throw writes the failed row too, answered as a 500.
      return await refuse(500, { error: 'Internal Server Error', message: 'Failed to update account concurrency' });
    }
  });

  // No concurrency retry-sync route: there is nothing to re-synchronize (the
  // module note in `super-admin.routes.ts`).
}
