/*
 * Campaign CRUD — a thin pass-through; the dialer runtime owns the schema. Part of
 * `proxy-agency-campaigns.routes.ts`, whose header states the ownership split and the
 * behavioral-capability rules these routes apply.
 */
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { forwardCore } from '../../core-dispatch.js';
import { assertBehavioralCapabilitiesForConfig } from '../../../agency/campaign-behavioral-settings.js';
import { assertAssignmentSettingsAllowed } from '../../../agency/campaign-assignment-gate.js';
import {
  validateAgencyCampaignConfig,
  withCampaignConfigDefaults,
  issuesToDetails,
} from '../../../agency/agency-campaign-config.js';
import { campaignTemplatesEnabled } from '../../../agency/campaign-templates/resolve-effective.js';
import { fillCreateFromTemplate, withoutTemplateKeys } from '../../../agency/campaign-templates/create-fill.js';
import { missingAccountBody, patchCampaignConfig } from '../helpers/campaign-patch.js';
import { sendTemplateRefusal } from '../helpers/campaign-template-refusal.js';

/** Registered by `proxyAgencyCampaignsRoutes` on its own instance, after its hooks. */
export async function registerCampaignCrudRoutes(app: FastifyInstance): Promise<void> {
  // ─── Campaign CRUD — thin pass-through, the dialer runtime owns the schema ──

  app.post('/campaigns', {
    preHandler: requirePermission('agency.campaigns.write'),
  }, async (request, reply) => {
    // ── Campaign templates (CT8, CT9), with `agency_campaign_templates_enabled` on ──
    // The body is filled in from a template before any check, so every check below judges the
    // body the campaign is stored with: the sections it leaves out from the template `template_id`
    // names (else the account's default chain), a section it sends kept as sent (absent fields
    // built-in), and `template_source` recorded (`create-fill.ts`). With the flag off (or no
    // account to judge) none of it happens and the create is what it was: only `template_id` and
    // `template_source` are taken out (the internal handler would ignore the first and the second
    // is the server's to write), and the catalog default below applies.
    const templated = request.accountId ? await campaignTemplatesEnabled(request.tenantId!, request.accountId) : false;
    let sent: unknown = withoutTemplateKeys(request.body);
    if (templated) {
      const filled = await fillCreateFromTemplate({ tenantId: request.tenantId!, accountId: request.accountId! }, request.body);
      if (!filled.ok) {
        if (filled.reason === 'invalid') {
          return sendTemplateRefusal(reply, 'campaign_template_invalid', { details: { template_id: 'must be a template id, or null' } });
        }
        return sendTemplateRefusal(reply, filled.reason === 'archived' ? 'campaign_template_archived' : 'campaign_template_not_found');
      }
      sent = filled.body;
    }

    // Config validation only. The body is still forwarded as-is and the dialer
    // runtime still owns the schema — this layer keeps no campaign copy (see the
    // ownership-split comment at the top of `proxy-agency-campaigns.routes.ts` on why two writable copies
    // drift). What this catches is the set of shapes the dialer runtime stores
    // happily and then behaves wrongly on; see
    // `agency-campaign-config.ts` for why it is a good error message rather than
    // enforcement.
    const configIssues = validateAgencyCampaignConfig(sent);
    if (configIssues.length > 0) {
      return reply
        .code(400)
        .send({ error: 'Validation Error', details: issuesToDetails(configIssues) });
    }

    // Defaults are applied on CREATE only. `disposition_catalog` has a `'[]'`
    // column default that nothing seeds, so disposition would be inert on every
    // campaign created without one. A default here fixes that without deleting
    // the empty-catalog configuration, because an explicit `[]` is an opinion and
    // is left alone — see `withCampaignConfigDefaults`. A templated body already
    // holds its catalog (the template's, or the built-in one), so this changes nothing there.
    const body = templated ? sent : withCampaignConfigDefaults(sent);

    // The behavioral capabilities. After the shape check (a malformed body earns
    // its 400 either way) and before anything is forwarded — the whole point is
    // that the internal handler never sees a body that enables a capability this
    // account does not have.
    //
    // Asserted on `body`, the exact object forwarded below, not on `request.body`.
    // `withCampaignConfigDefaults` is pure and adds only `disposition_catalog`, so
    // asserting after it changes no outcome and makes the asserted object the
    // forwarded one. The target is the request's tenant and account: the internal
    // handler stamps the new row with exactly those (`x-mgkvc-tenant` /
    // `x-mgkvc-account`), so the account judged is the account that will own the
    // campaign.
    // With no account context the settings read has no row to judge
    // (`campaign-behavioral-settings.ts` would answer 403 `capability_disabled`),
    // so a missing account is answered first, as the 400 the internal handler's
    // `authMiddleware` gives for a missing `x-mgkvc-account`.
    if (!request.accountId) return reply.code(400).send(missingAccountBody());
    if (!(await assertBehavioralCapabilitiesForConfig(request, reply, body, {
      tenantId: request.tenantId,
      accountId: request.accountId,
    }))) return;
    // Contact assignment (CA9): a non-default assignment setting or an outcome
    // `override` needs `agency_contact_assignment_enabled`; defaults pass unread.
    if (!(await assertAssignmentSettingsAllowed(reply, body, {
      tenantId: request.tenantId!,
      accountId: request.accountId,
    }))) return;

    return forwardCore(request, reply, {
      method: 'POST',
      path: '/agency-campaigns',
      body,
      // Who created it (IN8). The handler stores the originator in `created_by` and
      // stamps it as the `audit_logs` actor; with no originator both read as the
      // system (`NULL` / `system:api`), which is how every campaign was recorded
      // before this was sent. `request.user` is always the signed-in person here
      // (`sessionMiddleware` has no API-key path); the bare user id, as
      // `agency_ingest_jobs.created_by` and `last_transition_by.user_id` hold it.
      ...(request.user?.id ? { originator: request.user.id } : {}),
    });
  });

  app.get('/campaigns', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    return forwardCore(request, reply, {
      method: 'GET',
      path: '/agency-campaigns',
      query: request.query as Record<string, string>,
    });
  });

  app.get<{ Params: { id: string } }>('/campaigns/:id', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    return forwardCore(request, reply, {
      method: 'GET',
      path: `/agency-campaigns/${request.params.id}`,
    });
  });

  // The settings PATCH: validation, the behavioral and assignment gates, the internal handler's
  // write and the audit rows, one definition (`helpers/campaign-patch.ts`), which a template's
  // apply to draft campaigns runs too (CT16). `request.body` is ONE reference: the object
  // validated is the object gated and the object forwarded (the internal handler parses it again).
  app.patch<{ Params: { id: string } }>('/campaigns/:id', {
    preHandler: requirePermission('agency.campaigns.write'),
  }, async (request, reply) => {
    const answer = await patchCampaignConfig(request, request.params.id, request.body);
    return reply.code(answer.status).send(answer.body);
  });
}
