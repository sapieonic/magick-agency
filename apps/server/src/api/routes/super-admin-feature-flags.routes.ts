import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { superAdminMiddleware } from '../../auth/super-admin.middleware.js';
import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import { recordSuperAdminAudit } from '../../audit/super-admin-audit.js';
import { featureFlagRepository } from '@magick-agency/db/repositories/feature-flag.repository';
import { getFeatureFlagService } from '../../feature-flags/index.js';
import { allFlags, getFlag, resolveEnvDefault } from '../../feature-flags/registry.js';
import { auditLogger } from '../../audit/audit-logger.js';
import { createChildLogger } from '@magick-agency/observability';
import {
  resolveFlagsQuerySchema,
  upsertFlagOverrideSchema,
  deleteFlagOverrideSchema,
  bulkFlagOverrideSchema,
  validateFlagValue,
} from '../validators/super-admin-feature-flags.validator.js';

const log = createChildLogger({ component: 'super-admin-feature-flags-routes' });

/*
 * Super-admin feature-flag management: validation, the tenant check, the write on
 * the shared `featureFlagRepository`, cache invalidation through the flag service
 * singleton, and the audit rows. Deliberately absent:
 *  - flag policies (reason-required, bulk-refused) — no flag has a policy, so
 *    those branches would be unreachable;
 *  - a broadcast-cap cache refresh after an override write — no broadcast
 *    campaigns;
 *  - flag-change analytics — no analytics module.
 * The 4xx responses are first-party (the routes' own labels and messages), and the
 * app-wide error mask passes every 4xx through as it is.
 *
 * The `audit_logs` row (`feature_flag.override.upsert|delete`) is written only
 * where its UUID columns can hold the scope: only an account-scoped change has a
 * real tenant AND account id, and the placeholder ids the other scopes would need
 * are refused by the UUID `audit_logs.tenant_id` / `account_id` — and a refused
 * row fails the whole buffered batch, dropping other events with it. So that row
 * is written for ACCOUNT scope only, and the facts it carries (`old_value`, and
 * bulk's applied/failed split) are also put on the super-admin audit row, which
 * every scope writes.
 */

/**
 * Best-effort prior-override read for the old→new audit trail. A failed read
 * returns null so it never blocks the write that follows.
 */
const readPriorOverride = async (
  tuple: { flag_key: string; scope_type: 'global' | 'tenant' | 'account'; tenant_id?: string; account_id?: string },
) => {
  try {
    return await featureFlagRepository.findOne(tuple);
  } catch (err) {
    log.warn({ err, flagKey: tuple.flag_key }, 'Failed to read prior feature-flag override for audit');
    return null;
  }
};

/**
 * Audit a flag override change in `audit_logs`. Called for account scope only —
 * see the module note.
 */
const auditFlagChange = (
  tenantId: string,
  accountId: string,
  action: 'upsert' | 'delete',
  eventData: Record<string, unknown>,
  actor: string | undefined,
): void => {
  auditLogger.log({
    tenantId,
    accountId,
    eventType: `feature_flag.override.${action}`,
    eventCategory: 'system',
    severity: 'info',
    eventData,
    actor,
  });
};

/**
 * Super-admin feature-flag management. There is no flag allow-list: every key
 * the registry declares is manageable. Writes record the authenticated
 * super-admin's id as `updated_by` and are audited in `super_admin_audit_log`.
 */
export async function superAdminFeatureFlagsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', superAdminMiddleware);

  // The same singleton the call hot path reads, so a cache invalidation here
  // propagates everywhere.
  const featureFlags = getFeatureFlagService();

  // GET /super-admin/feature-flags — registry catalog + current global overrides.
  app.get('/feature-flags', async (_request: FastifyRequest, reply: FastifyReply) => {
    const globalRows = await featureFlagRepository.findGlobal();
    const globalByKey = new Map(globalRows.map((r) => [r.flag_key, r]));
    return reply.send({
      flags: allFlags().map((f) => ({
        key: f.key,
        type: f.type,
        default: f.default,
        env_default: resolveEnvDefault(f),
        scopes: f.scopes,
        client_exposed: f.clientExposed === true,
        owner: f.owner,
        description: f.description,
        global_override: globalByKey.get(f.key)?.value ?? null,
      })),
    });
  });

  // GET /super-admin/feature-flags/resolve — effective values for a tenant/account.
  // (Registered before /:flagKey so the static segment wins over the param route.)
  app.get('/feature-flags/resolve', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = resolveFlagsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }
    const tenant = await tenantRepository.findById(parsed.data.tenant_id);
    if (!tenant) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant not found' });
    }
    const { tenant_id, account_id } = parsed.data;
    // resolveAllWithSource reports which layer won per flag so the UI can render
    // "inherited (default: … — set globally/from env)" precisely.
    const resolved = await featureFlags.resolveAllWithSource({ tenantId: tenant_id, accountId: account_id });
    const effective: Record<string, unknown> = {};
    const source: Record<string, string> = {};
    for (const [key, r] of Object.entries(resolved)) {
      effective[key] = r.value;
      source[key] = r.source;
    }
    const defaults: Record<string, unknown> = {};
    for (const f of allFlags()) defaults[f.key] = resolveEnvDefault(f);
    const overrides = await featureFlagRepository.findByTenant(tenant_id);
    return reply.send({ tenant_id, account_id: account_id ?? null, effective, source, defaults, overrides });
  });

  // GET /super-admin/feature-flags/:flagKey — one flag's definition + override rows.
  app.get('/feature-flags/:flagKey', async (
    request: FastifyRequest<{ Params: { flagKey: string } }>,
    reply: FastifyReply,
  ) => {
    const flag = getFlag(request.params.flagKey);
    if (!flag) {
      return reply.code(404).send({ error: 'Not Found', message: `Unknown flag '${request.params.flagKey}'` });
    }
    const overrides = await featureFlagRepository.findByFlag(flag.key);
    return reply.send({
      flag: {
        key: flag.key, type: flag.type, default: flag.default, env_default: resolveEnvDefault(flag),
        scopes: flag.scopes, client_exposed: flag.clientExposed === true, owner: flag.owner,
        description: flag.description,
      },
      overrides,
    });
  });

  // PUT /super-admin/feature-flags/:flagKey/overrides — upsert an override.
  app.put('/feature-flags/:flagKey/overrides', async (
    request: FastifyRequest<{ Params: { flagKey: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = upsertFlagOverrideSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }
    const flag = getFlag(request.params.flagKey);
    if (!flag) {
      return reply.code(404).send({ error: 'Not Found', message: `Unknown flag '${request.params.flagKey}'` });
    }
    const body = parsed.data;
    const updatedBy = request.superAdmin!.id;

    if (!flag.scopes.includes(body.scope_type)) {
      return reply.code(422).send({ error: 'Invalid Scope', message: `Flag '${flag.key}' does not permit scope '${body.scope_type}'` });
    }
    const valueError = validateFlagValue(flag, body.value);
    if (valueError) {
      return reply.code(422).send({ error: 'Invalid Value', message: valueError });
    }

    // Capture the prior value for the old→new audit trail. Best-effort:
    // a failed prior-read must never block the write, so it falls back to undefined.
    const prior = await readPriorOverride({
      flag_key: flag.key, scope_type: body.scope_type, tenant_id: body.tenant_id, account_id: body.account_id,
    });

    const record = await featureFlagRepository.upsert({
      flag_key: flag.key,
      scope_type: body.scope_type,
      tenant_id: body.tenant_id,
      account_id: body.account_id,
      value: body.value,
      reason: body.reason,
      expires_at: body.expires_at ? new Date(body.expires_at) : null,
      updated_by: updatedBy,
    });

    // Invalidate the affected cache snapshot so the change takes effect next call.
    if (body.scope_type === 'global') await featureFlags.invalidate({});
    else await featureFlags.invalidate({ tenantId: body.tenant_id! });

    if (body.scope_type === 'account') {
      auditFlagChange(body.tenant_id!, body.account_id!, 'upsert', {
        flag_key: flag.key, scope_type: body.scope_type,
        old_value: prior?.value ?? null, new_value: body.value,
        reason: body.reason ?? null,
      }, updatedBy);
    }
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id,
      admin_email: request.superAdmin!.email,
      action: 'feature_flag.override.upserted',
      resource_type: 'feature_flag',
      resource_id: flag.key,
      details: {
        scope_type: body.scope_type,
        tenant_id: body.tenant_id ?? null,
        account_id: body.account_id ?? null,
        // `old_value` too, because the `audit_logs` row is not written for every
        // scope (module note).
        old_value: prior?.value ?? null,
        value: body.value,
        reason: body.reason ?? null,
      },
    });

    log.info({ flagKey: flag.key, scope: body.scope_type, tenantId: body.tenant_id }, 'Feature flag override upserted');
    return reply.send({ override: record });
  });

  // DELETE /super-admin/feature-flags/:flagKey/overrides — remove an override.
  app.delete('/feature-flags/:flagKey/overrides', async (
    request: FastifyRequest<{ Params: { flagKey: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = deleteFlagOverrideSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }
    const flag = getFlag(request.params.flagKey);
    if (!flag) {
      return reply.code(404).send({ error: 'Not Found', message: `Unknown flag '${request.params.flagKey}'` });
    }
    const body = parsed.data;
    const updatedBy = request.superAdmin!.id;

    // Capture the removed value before deleting, for the audit trail (best-effort).
    const prior = await readPriorOverride({
      flag_key: flag.key, scope_type: body.scope_type, tenant_id: body.tenant_id, account_id: body.account_id,
    });

    const deleted = await featureFlagRepository.delete({
      flag_key: flag.key, scope_type: body.scope_type, tenant_id: body.tenant_id, account_id: body.account_id,
    });
    if (!deleted) {
      return reply.code(404).send({ error: 'Not Found', message: 'No matching override to delete' });
    }

    if (body.scope_type === 'global') await featureFlags.invalidate({});
    else await featureFlags.invalidate({ tenantId: body.tenant_id! });

    if (body.scope_type === 'account') {
      auditFlagChange(body.tenant_id!, body.account_id!, 'delete', {
        flag_key: flag.key, scope_type: body.scope_type, old_value: prior?.value ?? null,
      }, updatedBy);
    }
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id,
      admin_email: request.superAdmin!.email,
      action: 'feature_flag.override.deleted',
      resource_type: 'feature_flag',
      resource_id: flag.key,
      details: {
        scope_type: body.scope_type,
        tenant_id: body.tenant_id ?? null,
        account_id: body.account_id ?? null,
        // `old_value` too (module note).
        old_value: prior?.value ?? null,
      },
    });

    log.info({ flagKey: flag.key, scope: body.scope_type, tenantId: body.tenant_id }, 'Feature flag override deleted');
    return reply.send({ status: 'deleted' });
  });

  // POST /super-admin/feature-flags/:flagKey/overrides/bulk — enable/disable for a list of tenants.
  // Validates flag + value once, then applies per tenant; returns a per-item result map.
  app.post('/feature-flags/:flagKey/overrides/bulk', async (
    request: FastifyRequest<{ Params: { flagKey: string } }>,
    reply: FastifyReply,
  ) => {
    const parsed = bulkFlagOverrideSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }
    const flag = getFlag(request.params.flagKey);
    if (!flag) {
      return reply.code(404).send({ error: 'Not Found', message: `Unknown flag '${request.params.flagKey}'` });
    }
    const body = parsed.data;
    const updatedBy = request.superAdmin!.id;

    if (!flag.scopes.includes('tenant')) {
      return reply.code(422).send({ error: 'Invalid Scope', message: `Flag '${flag.key}' does not permit tenant scope` });
    }
    const valueError = validateFlagValue(flag, body.value);
    if (valueError) {
      return reply.code(422).send({ error: 'Invalid Value', message: valueError });
    }

    const applied: string[] = [];
    const failed: Array<{ tenant_id: string; error: string }> = [];
    for (const tenantId of body.tenant_ids) {
      try {
        await featureFlagRepository.upsert({
          flag_key: flag.key, scope_type: 'tenant', tenant_id: tenantId, value: body.value,
          reason: body.reason, updated_by: updatedBy,
        });
        await featureFlags.invalidate({ tenantId });
        applied.push(tenantId);
      } catch (err) {
        failed.push({ tenant_id: tenantId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // One summary audit row carrying the full tenant list.
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id,
      admin_email: request.superAdmin!.email,
      action: 'feature_flag.override.bulk',
      resource_type: 'feature_flag',
      resource_id: flag.key,
      details: {
        tenant_ids: body.tenant_ids,
        value: body.value,
        reason: body.reason ?? null,
        // The applied/failed split (module note).
        applied_tenant_ids: applied,
        failed_tenant_ids: failed.map((f) => f.tenant_id),
      },
    });

    log.info({ flagKey: flag.key, applied: applied.length, failed: failed.length }, 'Feature flag bulk override applied');
    return reply.send({ applied, failed });
  });
}
