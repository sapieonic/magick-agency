/*
 * The agent's actions on their OWN contacts (contact assignment, phase 2, decision CA7),
 * served at the console's paths under `/proxy/agency`:
 *
 *  - `POST /my-contacts/retry`               reopen not-reached contacts into their queue;
 *  - `POST /my-contacts/:contactId/call`     dial one of them now, on the campaign's path.
 *
 * Wire: `packages/contracts/src/api/agency/assignment.ts` (`AgencyAgentRetryRequest/Response`,
 * `AgencyMyContactCallRequest/Response`, refusals `AgencyAgentRetryErrorResponse`).
 *
 * ── The gates, in order, on both routes ──────────────────────────────────────
 *  1. RBAC `agency.contacts.own` (floored at `agent`). The subject is ALWAYS the caller
 *     (`request.user.id`); no route names another agent.
 *  2. The `agency_contact_assignment_enabled` flag (CA9): off → `403 assignment_disabled`.
 *  3. The campaign is in the caller's tenant and account AND the caller has an active staffing
 *     row on it → else `403 not_staffed` (one answer: a campaign elsewhere is not confirmed).
 *  4. Retry only: the campaign allows agent retry (`allow_agent_retry`) → else
 *     `403 agent_retry_disabled`. The call route does NOT require it as a route gate: a due
 *     contact, or one holding a retry-delay override, may be dialled without it (CA7); a dial
 *     that would need a retry round answers `409 contact_not_retryable` (`retry_disabled`).
 *
 * The retry is set-based and served here (repositories, no internal handler). The call runs in
 * the dialer runtime, in the process holding the agent's station (`POST
 * /api/v1/agency/sessions/:id/my-contact-call`, `session_param`), reached through `callCore`.
 * Both write one `platform_audit_log` row (CA12), ids only.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createChildLogger } from '@magick-agency/observability';
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import {
  AGENCY_ASSIGNMENT_RANGE_MAX,
  type AgencyAgentRetryErrorCode,
  type AgencyAgentRetryErrorResponse,
  type AgencyAgentRetryResponse,
  type AgencyMyContactCallResponse,
} from '@magick-agency/contracts/api/agency/assignment';
import { AGENCY_OVERRIDE_NOTE_MAX, AGENCY_OVERRIDE_NOTE_MIN } from '@magick-agency/contracts/agency';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { getFeatureFlagService, FLAGS } from '../../../feature-flags/index.js';
import { agencyAgentRetryRepository, agencyCampaignRepository } from '../../../db/repositories/agency.repository.js';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import { agentRetrySettingsOf, MY_CONTACT_CALL_MESSAGES } from '../../../agency/my-contact-call.js';
import { validateOverrideNoteText } from '../../../agency/contact-overrides.js';
import { publishPacingInvalidation } from '../../../agency/pacing/invalidation-bus.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../../audit/platform/audit-actor.js';
import { callCore } from '../../core-dispatch.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import { stringField } from '../helpers/core-campaign.js';
import { resolveMyAgentId } from '../proxy-agency-staffing/my.js';
import { UUID_RE } from '../../../utils/uuid.js';

const log = createChildLogger({ component: 'proxy-agency-my-contacts' });

const retrySchema = z.object({
  campaign_id: z.string().uuid(),
  contact_ids: z.array(z.string().uuid()).min(1).max(AGENCY_ASSIGNMENT_RANGE_MAX).optional(),
  all: z.boolean().optional(),
}).refine((b) => (b.all === true) !== (b.contact_ids !== undefined), {
  message: 'name contact_ids, or all: true (exactly one)',
});

const callSchema = z.object({
  campaign_id: z.string().uuid(),
  session_id: z.string().uuid(),
  override_note: z.string().optional(),
});

/**
 * The 5xx refusals the call route authors on purpose (nothing was dialled, retry): passed
 * through the error mask as reviewed fixed-shape bodies, like the soft phone's.
 */
const REVIEWED_5XX_CODES: ReadonlySet<unknown> = new Set(['dnc_unavailable', 'no_station', 'dial_failed']);

function sendRefusal(
  reply: FastifyReply,
  status: number,
  code: AgencyAgentRetryErrorCode,
  details?: Record<string, unknown>,
): FastifyReply {
  const body: AgencyAgentRetryErrorResponse = {
    error: status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : status === 400 ? 'Validation failed' : 'Conflict',
    code,
    message: MY_CONTACT_CALL_MESSAGES[code],
    ...(details ? { details } : {}),
  };
  return reply.code(status).send(body);
}

function accountAudit(request: FastifyRequest): { tenant_id: string; account_id?: string } {
  return { tenant_id: request.tenantId!, ...(request.accountId ? { account_id: request.accountId } : {}) };
}

/**
 * Gates 2 and 3: the flag, then the campaign in scope and the caller staffed on it. The
 * campaign, or null once a refusal is sent.
 */
async function ownContactsScope(
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  campaignId: string,
): Promise<AgencyCampaignRecord | null> {
  const tenantId = request.tenantId!;
  const accountId = request.accountId;
  const enabled = await getFeatureFlagService().isEnabled(FLAGS.agency_contact_assignment_enabled, {
    tenantId, ...(accountId ? { accountId } : {}),
  });
  if (!enabled) {
    sendRefusal(reply, 403, 'assignment_disabled');
    return null;
  }
  const campaign = await agencyCampaignRepository.findById(campaignId);
  const staffed = campaign && campaign.tenant_id === tenantId && campaign.account_id === accountId
    ? await agencyCampaignAgentRepository.isActiveOnCampaign(tenantId, campaignId, userId)
    : false;
  if (!campaign || !staffed) {
    sendRefusal(reply, 403, 'not_staffed');
    return null;
  }
  return campaign;
}

export async function registerMyContactActionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /proxy/agency/my-contacts/retry — reopen the caller's not-reached contacts.
   *
   * Ids that are not the caller's contacts on this campaign are dropped from both lists
   * (never `skipped`), so the answer confirms nothing about another agent's contact.
   * `contacts_changed` wakes the campaign's pacing so the reopened contacts are dialled.
   */
  app.post('/my-contacts/retry', {
    preHandler: requirePermission('agency.contacts.own'),
  }, async (request, reply) => {
    const userId = resolveMyAgentId(request, reply);
    if (!userId) return reply;
    const parsed = parseOr400(retrySchema, request.body ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const campaign = await ownContactsScope(request, reply, userId, parsed.data.campaign_id);
    if (!campaign) return reply;
    if (!campaign.allow_agent_retry) return sendRefusal(reply, 403, 'agent_retry_disabled');

    const result = await agencyAgentRetryRepository.reopenForAgent({
      campaignId: campaign.id,
      userId,
      contactIds: parsed.data.all === true ? null : [...new Set(parsed.data.contact_ids!.map((id) => id.toLowerCase()))],
      settings: agentRetrySettingsOf(campaign),
    });
    if (result.reopened.length > 0) {
      publishPacingInvalidation({ type: 'contacts_changed', campaignId: campaign.id });
      platformAuditLogger.log({
        ...accountAudit(request),
        ...requestAuditActor(request),
        action: 'agency_contacts.agent_retry_reopened',
        resource_type: 'agency_campaign',
        resource_id: campaign.id,
        campaign_id: campaign.id,
        details: {
          campaign_id: campaign.id,
          reopened: result.reopened.length,
          skipped_total: result.skippedTotal,
          all: parsed.data.all === true,
        },
      });
    }
    log.info(
      { campaignId: campaign.id, userId, reopened: result.reopened.length, skipped: result.skippedTotal },
      'Agent reopened their not-reached contacts',
    );
    const body: AgencyAgentRetryResponse = {
      reopened: result.reopened.length,
      skipped: result.skipped,
      skipped_total: result.skippedTotal,
    };
    return reply.send(body);
  });

  /**
   * POST /proxy/agency/my-contacts/:contactId/call — dial one of the caller's contacts now,
   * from their live `available` session on the campaign (`agency/my-contact-call.ts`).
   */
  app.post<{ Params: { contactId: string } }>('/my-contacts/:contactId/call', {
    preHandler: requirePermission('agency.contacts.own'),
  }, async (request, reply) => {
    const userId = resolveMyAgentId(request, reply);
    if (!userId) return reply;
    // A malformed id is the not-found answer an unknown one gets (never a 22P02).
    if (!UUID_RE.test(request.params.contactId)) return sendRefusal(reply, 404, 'contact_not_found');
    const parsed = parseOr400(callSchema, request.body ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const campaign = await ownContactsScope(request, reply, userId, parsed.data.campaign_id);
    if (!campaign) return reply;
    // The note's shape, before anything else is asked: a note given is a note that counts.
    if (parsed.data.override_note !== undefined && validateOverrideNoteText(parsed.data.override_note) === null) {
      return sendRefusal(reply, 400, 'override_note_invalid', { min: AGENCY_OVERRIDE_NOTE_MIN, max: AGENCY_OVERRIDE_NOTE_MAX });
    }

    const contactId = request.params.contactId.toLowerCase();
    const result = await callCore({
      method: 'POST',
      path: `/agency/sessions/${parsed.data.session_id}/my-contact-call`,
      body: {
        campaign_id: campaign.id,
        contact_id: contactId,
        ...(parsed.data.override_note !== undefined ? { override_note: parsed.data.override_note } : {}),
        agent_user_id: userId,
      },
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status >= 400) {
      const code = result.body && typeof result.body === 'object' ? (result.body as { code?: unknown }).code : undefined;
      // The session routes' shared guard answers a session that is not the caller's (404,
      // no code) or has ended (`409 session_ended`); in this vocabulary both are "not your
      // live available session on this campaign".
      if (result.status === 404 && code === undefined) return sendRefusal(reply, 409, 'agent_not_available');
      if (result.status === 409 && code === 'session_ended') return sendRefusal(reply, 409, 'agent_not_available');
      if (result.status >= 500 && REVIEWED_5XX_CODES.has(code)) request.preserveReviewedUpstreamError = true;
      return reply.code(result.status).send(result.body);
    }
    const body = result.body as AgencyMyContactCallResponse & { basis?: unknown };
    const attemptId = stringField(result.body, 'attempt_id');
    platformAuditLogger.log({
      ...accountAudit(request),
      ...requestAuditActor(request),
      action: 'agency_contact.agent_dialed',
      resource_type: 'agency_contact',
      resource_id: contactId,
      campaign_id: campaign.id,
      details: {
        campaign_id: campaign.id,
        session_id: parsed.data.session_id,
        ...(attemptId ? { attempt_id: attemptId } : {}),
        basis: typeof body.basis === 'string' ? body.basis : null,
        override_applied: Array.isArray(body.override_applied) ? body.override_applied : [],
        retry_round_spent: body.retry_round_spent === true,
      },
    });
    const response: AgencyMyContactCallResponse = {
      attempt_id: body.attempt_id,
      contact_id: body.contact_id,
      override_applied: body.override_applied,
      retry_round_spent: body.retry_round_spent,
    };
    return reply.send(response);
  });
}
