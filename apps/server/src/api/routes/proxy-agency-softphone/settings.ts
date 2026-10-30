/*
 * The account's soft-phone settings (docs/softphone.md §3, §6): read at the agent floor
 * (the soft phone cannot render without its call fields), replaced at
 * `agency.softphone.manage` (account admin). Part of `proxy-agency-softphone.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { resolvedUserAuditActor } from '../../../audit/platform/audit-actor.js';
import { callCore } from '../../core-dispatch.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import type { SoftphoneSettingsAudit } from '../agency/softphone-answer.js';
import {
  requireSoftphoneEnabled,
  sendCoreRefusal,
  softphoneActorOrRefuse,
  softphoneAuditTenancy,
  unwrapCoreAnswer,
} from './shared.js';

/**
 * The five settings, values unchecked here: `PUT` replaces the whole row, and the
 * internal handler answers every problem as `settings_invalid` with a `details` path the
 * console maps onto its form (`call_fields[i].key|label|options`,
 * `disposition_catalog[i].code|label`, `default_caller_id`, `analysis_profile_id`).
 * A zod refusal here would answer a different shape with different paths. Anything else
 * (`updated_at`, which the console echoes back from its GET) is stripped.
 */
const settingsBody = z.object({
  disposition_catalog: z.unknown(),
  call_fields: z.unknown(),
  analysis_profile_id: z.unknown(),
  record_calls: z.unknown(),
  default_caller_id: z.unknown(),
}).strip();

export async function registerSoftphoneSettingsRoutes(app: FastifyInstance): Promise<void> {
  /** GET /proxy/agency/softphone/settings — `{ settings }`, the defaults when the account has no row. */
  app.get('/softphone/settings', {
    preHandler: [requirePermission('agency.softphone.dial'), requireSoftphoneEnabled],
  }, async (request, reply) => {
    const result = await callCore({
      method: 'GET',
      path: '/agency/softphone/settings',
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    return reply.code(result.status).send(result.body);
  });

  /** PUT /proxy/agency/softphone/settings — replace the row; audited with which settings changed. */
  app.put('/softphone/settings', {
    preHandler: [requirePermission('agency.softphone.manage'), requireSoftphoneEnabled],
  }, async (request, reply) => {
    const parsed = parseOr400(settingsBody, request.body, reply, 'agency');
    if (!parsed) return reply;
    const actor = softphoneActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'PUT',
      path: '/agency/softphone/settings',
      body: {
        disposition_catalog: parsed.data.disposition_catalog,
        call_fields: parsed.data.call_fields,
        analysis_profile_id: parsed.data.analysis_profile_id,
        record_calls: parsed.data.record_calls,
        default_caller_id: parsed.data.default_caller_id,
      },
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status >= 400) return sendCoreRefusal(request, reply, result);
    const unwrapped = unwrapCoreAnswer<SoftphoneSettingsAudit>(reply, result, 'PUT /softphone/settings');
    if (!unwrapped) return reply;
    platformAuditLogger.log({
      ...softphoneAuditTenancy(request),
      ...resolvedUserAuditActor(request, actor.agent_user_id),
      action: 'agency_softphone_settings.updated',
      resource_type: 'agency_softphone_settings',
      details: { changed: unwrapped.audit.changed },
    });
    return reply.send(unwrapped.answer);
  });
}
