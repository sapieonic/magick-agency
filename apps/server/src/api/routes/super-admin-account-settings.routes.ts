import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { superAdminMiddleware } from '../../auth/super-admin.middleware.js';
import { tenantRepository } from '@magick-agency/db/repositories/tenant.repository';
import { accountRepository } from '@magick-agency/db/repositories/account.repository';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { getConcurrencyControl } from '../../seams/concurrency-control.js';
import { loadAgencyAccountSettings } from '../../settings/agency-account-settings.js';
import { createChildLogger } from '@magick-agency/observability';
import { updateAgencyAccountSettingsSchema } from '../validators/super-admin.validator.js';
import { recordSuperAdminAudit } from '../../audit/super-admin-audit.js';

const log = createChildLogger({ component: 'super-admin-account-settings-routes' });

/**
 * Per-account settings for super admins (contract
 * `AgencyAccountSettingsResponse` / `UpdateAgencyAccountSettingsBody`). The one
 * writer of the account's behavioural settings:
 *  - `allow_recording` / `analyze_calls`, written through
 *    `setRecordingAnalysisToggles`, which names only the two toggles. Writing them
 *    through `upsert` with a concurrency value just read would, in legacy_total
 *    mode, rewrite the limit and bump its version, silently undoing a concurrency
 *    write that landed between the read and the upsert. `max_concurrent_calls` is
 *    refused outright (a 400 from the `.strict()` body schema): the concurrency
 *    route is its one writer.
 *  - `webrtc_max_duration_seconds` (60..14400), the row's column, written by
 *    `setWebrtcMaxDurationSeconds`.
 * The response is the EFFECTIVE settings (`loadAgencyAccountSettings`).
 */
export async function superAdminAccountSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', superAdminMiddleware);

  async function resolveAccount(tenantId: string, accountId: string) {
    const tenant = await tenantRepository.findById(tenantId);
    if (!tenant) return null;
    return accountRepository.findByIdInTenant(accountId, tenantId);
  }

  /** GET /super-admin/tenants/:tenantId/accounts/:accountId/settings */
  app.get('/tenants/:tenantId/accounts/:accountId/settings', async (
    request: FastifyRequest<{ Params: { tenantId: string; accountId: string } }>,
    reply: FastifyReply,
  ) => {
    const { tenantId, accountId } = request.params;
    const account = await resolveAccount(tenantId, accountId);
    if (!account) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant or account not found' });
    }
    const settings = await loadAgencyAccountSettings(tenantId, account);
    return reply.send({ settings });
  });

  /** PUT /super-admin/tenants/:tenantId/accounts/:accountId/settings — a PATCH. */
  app.put('/tenants/:tenantId/accounts/:accountId/settings', async (
    request: FastifyRequest<{ Params: { tenantId: string; accountId: string } }>,
    reply: FastifyReply,
  ) => {
    const { tenantId, accountId } = request.params;
    const parsed = updateAgencyAccountSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }
    const account = await resolveAccount(tenantId, accountId);
    if (!account) {
      return reply.code(404).send({ error: 'Not Found', message: 'Tenant or account not found' });
    }
    const { allow_recording, analyze_calls, webrtc_max_duration_seconds, reason } = parsed.data;

    const before = await loadAgencyAccountSettings(tenantId, account);

    if (allow_recording !== undefined || analyze_calls !== undefined) {
      await accountSettingsRepository.setRecordingAnalysisToggles(tenantId, accountId, {
        allow_recording,
        analyze_calls,
      });
    }
    if (webrtc_max_duration_seconds !== undefined) {
      await accountSettingsRepository.setWebrtcMaxDurationSeconds(tenantId, accountId, webrtc_max_duration_seconds);
    }

    // Invalidate the account guard's cached limit on every write, although this
    // route never changes the limit: a row this route CREATED is new to the guard
    // too.
    await getConcurrencyControl().invalidateAccountLimit(tenantId, accountId);

    const settings = await loadAgencyAccountSettings(tenantId, account);

    log.info({ tenantId, accountId }, 'Super admin updated account settings');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id, admin_email: request.superAdmin!.email,
      action: 'update_account_settings', resource_type: 'account', resource_id: accountId,
      details: {
        tenant_id: tenantId,
        changes: {
          ...(allow_recording !== undefined ? { allow_recording } : {}),
          ...(analyze_calls !== undefined ? { analyze_calls } : {}),
          ...(webrtc_max_duration_seconds !== undefined ? { webrtc_max_duration_seconds } : {}),
        },
        before: {
          allow_recording: before.allow_recording,
          analyze_calls: before.analyze_calls,
          webrtc_max_duration_seconds: before.webrtc_max_duration_seconds,
        },
        reason: reason ?? null,
      },
    });

    return reply.send({ settings });
  });
}
