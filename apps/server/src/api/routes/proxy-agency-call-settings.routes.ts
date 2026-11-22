import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hasPermission, type MembershipRole } from '@magick-agency/contracts/rbac';
import { SOFTPHONE_TAGGABLE_CAMPAIGN_STATUSES } from '@magick-agency/contracts/agency';
import {
  AGENCY_CALL_SETTINGS_AGENTS_MAX,
  AGENCY_CALL_SETTINGS_UNFILED_DAYS,
  type AgencyCallSettings,
  type AgencyCallSettingsReadiness,
  type AgencyCallSettingsResponse,
  type AgencyCallSettingsRouteRef,
  type AgencyCampaignInboundDefaultRoutesResponse,
} from '@magick-agency/contracts/api/agency/call-settings';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { platformAuditLogger } from '../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../audit/platform/audit-actor.js';
import {
  agencyCallSettingsRepository,
  agencyCampaignRepository,
  agencyInboundRouteRepository,
  type AccountMemberRoles,
  type AgencyCallSettingsRecord,
} from '../../db/repositories/agency.repository.js';
import { UUID_RE } from '../../utils/uuid.js';
import { inboundRefusalBody } from './agency/inbound-answer.js';
import { accountOrRefuse } from './helpers/account-scope.js';
import { noStoreHook } from './helpers/no-store.js';
import { parseOr400 } from './helpers/parse-or-400.js';

/*
 * The account's call settings (docs/call-log.md §5; contracts `api/agency/call-settings.ts`),
 * served at the console's path under `/proxy/agency`: the setting "Every call must belong to a
 * campaign" (`require_campaign`), with what stands in the way of switching it on. The public
 * layer of B16, SQL only (this layer's own reads and one write, as the callbacks list's are). The
 * session and the tenant context (the hooks below), then the permission, then the account scope
 * (`400 account_scope_required`). Behind neither the soft phone's flag nor inbound's: the rule is
 * the account's, over both, and an account may have either switched off.
 *
 *  - `GET /call-settings` (`agency.calls.manage`): the setting and its readiness.
 *  - `PUT /call-settings` (`agency.calls.manage`): `{ require_campaign }`. Switching it on is
 *    refused `422 default_campaign_required`, naming the routes, while a live inbound route of the
 *    account has no campaign for unknown callers (CL3); checked under the account's call-settings
 *    lock, which every route write takes too, so a route cannot be saved without one in between.
 *    Switching it off, or saving what it already is, is never refused. Audited
 *    `agency_call_settings.updated` when the switch changed.
 *  - `GET /campaigns/:id/inbound-default-routes` (`agency.supervise`): the live inbound routes
 *    that file unknown callers under the campaign, for the warning before it is stopped or
 *    archived (CL21). A campaign of another tenant or account is a 404.
 *
 * The setting is ENFORCED where calls are made and saved, not here: `SoftphoneService.placeCall`,
 * `InboundCallService.submitDisposition`, the inbound route writes.
 */

const updateSchema = z.object({ require_campaign: z.boolean() }).strip();

function toSettings(row: AgencyCallSettingsRecord | null): AgencyCallSettings {
  return {
    require_campaign: row?.require_campaign ?? false,
    require_campaign_since: row?.require_campaign_since ? new Date(row.require_campaign_since).toISOString() : null,
    updated_at: row ? new Date(row.updated_at).toISOString() : null,
  };
}

const toRouteRefs = (routes: ReadonlyArray<{ id: string; name: string }>): AgencyCallSettingsRouteRef[] =>
  routes.map((r) => ({ route_id: r.id, name: r.name }));

/**
 * The members the rule would stop from dialling: someone who may dial from the soft phone, whose
 * every role in the account is below `agency.supervise` (a supervisor may log a call to any
 * campaign of the account), and who is staffed on no campaign a call can be logged to.
 */
export function agentsWithoutCampaign(members: readonly AccountMemberRoles[]): AccountMemberRoles[] {
  return members.filter((m) => {
    const roles = m.roles as MembershipRole[];
    const dials = roles.some((role) => hasPermission(role, 'agency.softphone.dial'));
    const supervises = roles.some((role) => hasPermission(role, 'agency.supervise'));
    return dials && !supervises && !m.on_taggable_campaign;
  });
}

async function readiness(tenantId: string, accountId: string): Promise<AgencyCallSettingsReadiness> {
  const [missing, members, unfiled] = await Promise.all([
    agencyInboundRouteRepository.listMissingDefaultCampaign(tenantId, accountId),
    agencyCallSettingsRepository.listMembersWithStaffing(tenantId, accountId, SOFTPHONE_TAGGABLE_CAMPAIGN_STATUSES),
    agencyCallSettingsRepository.countUnfiledCalls(tenantId, accountId, AGENCY_CALL_SETTINGS_UNFILED_DAYS),
  ]);
  const idle = agentsWithoutCampaign(members);
  return {
    routes_missing_default: toRouteRefs(missing),
    agents_without_campaign: idle.slice(0, AGENCY_CALL_SETTINGS_AGENTS_MAX).map((m) => ({ user_id: m.user_id, name: m.name })),
    agents_without_campaign_total: idle.length,
    unfiled_calls: unfiled,
  };
}

export async function proxyAgencyCallSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  app.addHook('onRequest', noStoreHook);

  // ── GET /call-settings ────────────────────────────────────────────────────
  app.get('/call-settings', { preHandler: [requirePermission('agency.calls.manage')] }, async (request, reply) => {
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return reply;
    const tenantId = request.tenantId!;
    const [row, ready] = await Promise.all([
      agencyCallSettingsRepository.find(tenantId, accountId),
      readiness(tenantId, accountId),
    ]);
    const body: AgencyCallSettingsResponse = { settings: toSettings(row), readiness: ready };
    return reply.send(body);
  });

  // ── PUT /call-settings ────────────────────────────────────────────────────
  app.put('/call-settings', { preHandler: [requirePermission('agency.calls.manage')] }, async (request, reply) => {
    const accountId = accountOrRefuse(request.accountId, reply, 'Call settings belong to one account. Send X-Account-Id.');
    if (!accountId) return reply;
    const parsed = parseOr400(updateSchema, request.body, reply, 'agency');
    if (!parsed) return reply;
    const tenantId = request.tenantId!;
    const userId = request.user?.id;
    if (!userId) return reply.code(400).send({ error: 'Bad Request', code: 'missing_actor', message: 'This action must be attributed to a user.' });

    const written = await agencyCallSettingsRepository.setRequireCampaign(
      { tenantId, accountId, on: parsed.data.require_campaign, userId },
      // Under the account's lock: no live route without a campaign for unknown callers (CL3).
      async (client) => {
        const missing = await agencyInboundRouteRepository.listMissingDefaultCampaign(tenantId, accountId, client);
        return missing.length > 0 ? missing : null;
      },
    );
    if (!written.ok) {
      const refusal = inboundRefusalBody({ code: 'default_campaign_required', routes: toRouteRefs(written.refusal) });
      return reply.code(refusal.status).send({
        ...refusal.body,
        message: 'Every inbound number needs a campaign for unknown callers before this can be switched on.',
      });
    }
    if (written.changed) {
      platformAuditLogger.log({
        tenant_id: tenantId,
        account_id: accountId,
        ...requestAuditActor(request),
        action: 'agency_call_settings.updated',
        resource_type: 'agency_call_settings',
        details: { require_campaign: written.row.require_campaign },
      });
    }
    const body: AgencyCallSettingsResponse = { settings: toSettings(written.row), readiness: await readiness(tenantId, accountId) };
    return reply.send(body);
  });

  // ── GET /campaigns/:id/inbound-default-routes ─────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/campaigns/:id/inbound-default-routes',
    { preHandler: [requirePermission('agency.supervise')] },
    async (request, reply) => {
      const accountId = accountOrRefuse(request.accountId, reply);
      if (!accountId) return reply;
      const tenantId = request.tenantId!;
      const notFound = () => reply.code(404).send({ error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found.' });
      // The tenant context middleware lower-cased the header ids; a path id is checked here (`22P02`).
      if (!UUID_RE.test(request.params.id)) return notFound();
      const campaignId = request.params.id.toLowerCase();
      const campaign = await agencyCampaignRepository.findById(campaignId);
      if (!campaign || campaign.tenant_id !== tenantId || campaign.account_id !== accountId) return notFound();
      const routes = (await agencyInboundRouteRepository.listDefaultingTo(tenantId, campaignId))
        .filter((r) => r.account_id === accountId);
      const body: AgencyCampaignInboundDefaultRoutesResponse = { routes: toRouteRefs(routes) };
      return reply.send(body);
    },
  );
}
