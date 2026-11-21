/*
 * Archive and restore a campaign (decisions AR1–AR6). Part of `proxy-agency-campaigns.routes.ts`.
 *
 * `agency.campaigns.write`, the PATCH's permission: archiving tidies the account's campaign list,
 * it does not dial or stop anything. The actor is the session's user, sent to the internal handler
 * as the lifecycle controls send theirs (`resolveActorDisplayName`; never a caller-supplied id),
 * so the campaign can say who archived it.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { callCore } from '../../core-dispatch.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../../audit/platform/audit-actor.js';
import { stringField } from '../helpers/core-campaign.js';
import { resolveActorDisplayName } from './lifecycle.js';

/** The internal handler's optional actor body, from the session alone; `undefined` with no user. */
async function archiveActor(request: FastifyRequest): Promise<{ actor_user_id: string; actor_name?: string } | undefined> {
  const userId = request.user?.id;
  if (!userId) return undefined;
  const name = await resolveActorDisplayName(request, userId);
  return { actor_user_id: userId, ...(name ? { actor_name: name } : {}) };
}

/** The platform audit row's shared part; each route states its own actor and action inline. */
function archiveAuditRow(request: FastifyRequest<{ Params: { id: string } }>, result: { body: unknown }) {
  const status = stringField(result.body, 'status');
  return {
    tenant_id: request.tenantId!,
    ...(request.accountId ? { account_id: request.accountId } : {}),
    resource_type: 'agency_campaign' as const,
    resource_id: request.params.id,
    campaign_id: request.params.id,
    details: { campaign_id: request.params.id, ...(status ? { status } : {}) },
  };
}

/** Registered by `proxyAgencyCampaignsRoutes` on its own instance, after its hooks. */
export async function registerCampaignArchiveRoutes(app: FastifyInstance): Promise<void> {
  // Two routes with `path:` literals at their call sites, which `core-dispatch.test.ts` resolves
  // against the internal route table.
  app.post<{ Params: { id: string } }>('/campaigns/:id/archive', {
    preHandler: requirePermission('agency.campaigns.write'),
  }, async (request, reply) => {
    const actor = await archiveActor(request);
    const result = await callCore({
      method: 'POST',
      path: `/agency-campaigns/${request.params.id}/archive`,
      ...(actor ? { body: actor } : {}),
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status < 400) {
      platformAuditLogger.log({
        ...archiveAuditRow(request, result),
        ...requestAuditActor(request),
        action: 'agency_campaign.archived',
      });
    }
    return reply.code(result.status).send(result.body);
  });

  app.post<{ Params: { id: string } }>('/campaigns/:id/unarchive', {
    preHandler: requirePermission('agency.campaigns.write'),
  }, async (request, reply) => {
    const result = await callCore({
      method: 'POST',
      path: `/agency-campaigns/${request.params.id}/unarchive`,
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status < 400) {
      platformAuditLogger.log({
        ...archiveAuditRow(request, result),
        ...requestAuditActor(request),
        action: 'agency_campaign.restored',
      });
    }
    return reply.code(result.status).send(result.body);
  });
}
