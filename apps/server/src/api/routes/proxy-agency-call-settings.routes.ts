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
import { getFeatureFlagService, FLAGS } from '../../feature-flags/index.js';
import { inboundRefusalBody } from './agency/inbound-answer.js';
import { accountCampaignOrRefuse, accountOrRefuse } from './helpers/account-scope.js';
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
 *    account has no usable campaign for unknown callers (CL3; none, or an archived one); checked
 *    under the account's call-settings lock, which every route write takes too, so a route
 *    cannot be saved without one in between. Routes are not counted while inbound is off for the
 *    account (`agency_inbound_enabled`, CL18): the route editor is closed then, so a leftover
 *    route could not be fixed, and a call filed under no campaign is still refused its outcome.
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
 * "Agents on no running campaign" (CL24): a member who holds the `agent` role in the account,
 * none of whose roles there holds `agency.supervise` (a supervisor may log a call to any campaign
 * of the account), and who is staffed on no campaign a call can be logged to. A viewer or an
 * operator is not counted: they are not the floor's agents, and are not staffed on campaigns
 * as a rule, so listing them would bury the agents a supervisor has to act on.
 */
export function agentsWithoutCampaign(members: readonly AccountMemberRoles[]): AccountMemberRoles[] {
  return members.filter((m) => {
    const roles = m.roles as MembershipRole[];
    const supervises = roles.some((role) => hasPermission(role, 'agency.supervise'));
    return roles.includes('agent') && !supervises && !m.on_taggable_campaign;
  });
}

/** `agency_inbound_enabled` for the account: its routes count only while it is on (CL18). */
const inboundOn = (tenantId: string, accountId: string): Promise<boolean> =>
  getFeatureFlagService().isEnabled(FLAGS.agency_inbound_enabled, { tenantId, accountId });

async function readiness(tenantId: string, accountId: string): Promise<AgencyCallSettingsReadiness> {
  const [missing, members, unfiled] = await Promise.all([
    inboundOn(tenantId, accountId).then((on) => (on ? agencyInboundRouteRepository.listMissingDefaultCampaign(tenantId, accountId) : [])),
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

    // Read before the lock is taken (a flag read, cached): with inbound off its routes do not count.
    const countRoutes = parsed.data.require_campaign && await inboundOn(tenantId, accountId);
    const written = await agencyCallSettingsRepository.setRequireCampaign(
      { tenantId, accountId, on: parsed.data.require_campaign, userId },
      // Under the account's lock: no live route without a campaign for unknown callers (CL3).
      async (client) => {
        if (!countRoutes) return null;
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
      // The tenant context middleware lower-cased the header ids; a path id is checked (`22P02`)
      // and lower-cased here.
      const campaignId = request.params.id.toLowerCase();
      const campaign = await accountCampaignOrRefuse(
        reply, (id) => agencyCampaignRepository.findById(id), campaignId, tenantId, accountId,
      );
      if (!campaign) return reply;
      // The campaign is the account's (above), and a route names only a campaign of its own
      // account (checked on every route save), so every route found is the account's.
      const routes = await agencyInboundRouteRepository.listDefaultingTo(tenantId, campaignId);
      const body: AgencyCampaignInboundDefaultRoutesResponse = { routes: toRouteRefs(routes) };
      return reply.send(body);
    },
  );
}
