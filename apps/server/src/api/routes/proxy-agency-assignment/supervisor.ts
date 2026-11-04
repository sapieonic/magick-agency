/*
 * The supervisor's contact assignment: preview and commit an operation, the progress per
 * agent, and one contact's owner history. `agency.supervise`, the campaign proved through the
 * ownership probe, the `agency_contact_assignment_enabled` flag. Part of
 * `proxy-agency-assignment.routes.ts`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AGENCY_ASSIGNMENT_ABSENT_AFTER_MINUTES,
  type AgencyAssignmentProgress,
  type AgencyAssignmentProgressRow,
} from '@magick-agency/contracts/api/agency/assignment';
import { createChildLogger } from '@magick-agency/observability';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../../audit/platform/audit-actor.js';
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import {
  agencyAssignmentReadRepository,
  agencyAssignmentRepository,
  emptyBucketCounts,
  type AssignmentCampaignScope,
} from '../../../db/repositories/agency.repository.js';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import { callbackCodes } from '../../../db/repositories/agency/assignment-sql.js';
import { resolveAgentNames } from '../../../agency/agency-agent-identity.js';
import {
  assignmentCommitSchema,
  parseAssignmentOperation,
  receivingAgents,
  zodDetails,
  type CanonicalAssignment,
} from '../../../agency/assignment/operation.js';
import { isUuid, refuse, requireAssignmentEnabled, supervisedCampaign } from './shared.js';

const log = createChildLogger({ component: 'proxy-agency-assignment' });

/** The longest absence threshold a progress read accepts: a week. */
const ABSENT_AFTER_MAX_MINUTES = 10_080;

type CampaignParams = { Params: { id: string } };

/** Permission → id shape → flag → ownership. Null once it has replied. */
async function guardCampaign(request: FastifyRequest<CampaignParams>, reply: FastifyReply): Promise<AgencyCampaignRecord | null> {
  // A malformed id is the not-found answer an unknown one gets, never a `22P02`.
  if (!isUuid(request.params.id)) {
    refuse(reply, 404, 'campaign_not_found', 'Campaign not found.');
    return null;
  }
  if (!(await requireAssignmentEnabled(request, reply))) return null;
  return supervisedCampaign(request, reply, request.params.id.toLowerCase());
}

function scopeOf(campaign: AgencyCampaignRecord): AssignmentCampaignScope {
  return { campaignId: campaign.id, tenantId: campaign.tenant_id, callbackCodes: callbackCodes(campaign.disposition_catalog) };
}

/** `agent_not_staffed` for any receiving agent without an active staffing row. */
async function refuseUnstaffed(reply: FastifyReply, campaign: AgencyCampaignRecord, op: CanonicalAssignment): Promise<boolean> {
  const missing = await agencyAssignmentRepository.unstaffed(campaign.tenant_id, campaign.id, receivingAgents(op));
  if (missing.length === 0) return false;
  refuse(reply, 400, 'agent_not_staffed', 'Only agents staffed on this campaign can receive contacts.', { agent_user_ids: missing });
  return true;
}

function invalid(reply: FastifyReply, details: Record<string, string>): FastifyReply {
  return refuse(reply, 400, 'assignment_invalid', 'The assignment is not valid.', details);
}

export async function registerAssignmentSupervisorRoutes(app: FastifyInstance): Promise<void> {
  /** POST /campaigns/:id/assignments/preview — what an operation would do. Writes nothing. */
  app.post<CampaignParams>('/campaigns/:id/assignments/preview', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const campaign = await guardCampaign(request, reply);
    if (!campaign) return reply;
    const parsed = parseAssignmentOperation(request.body, 'preview');
    if (!parsed.ok) return invalid(reply, parsed.details);
    if (await refuseUnstaffed(reply, campaign, parsed.op)) return reply;
    return reply.code(200).send(await agencyAssignmentRepository.preview(parsed.op, scopeOf(campaign)));
  });

  /**
   * POST /campaigns/:id/assignments — commit a previewed operation. Recomputed under row
   * locks; `409 preview_stale` with the fresh preview when it would differ from the token.
   * One audit row (`agency_contacts.assigned`) per committed operation, ids only.
   */
  app.post<CampaignParams>('/campaigns/:id/assignments', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const campaign = await guardCampaign(request, reply);
    if (!campaign) return reply;
    const body = assignmentCommitSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, zodDetails(body.error, 'body'));
    const parsed = parseAssignmentOperation(body.data.operation, 'commit');
    if (!parsed.ok) {
      return invalid(reply, Object.fromEntries(Object.entries(parsed.details).map(([k, v]) => [`operation.${k}`, v])));
    }
    if (await refuseUnstaffed(reply, campaign, parsed.op)) return reply;

    const outcome = await agencyAssignmentRepository.commit({
      op: parsed.op,
      scope: scopeOf(campaign),
      token: body.data.preview_token,
      actorUserId: request.user?.id ?? null,
    });
    if (!outcome.ok) {
      return reply.code(409).send({
        error: 'Conflict',
        code: 'preview_stale',
        message: 'The roster changed since the preview. Review the new preview and confirm again.',
        preview: outcome.preview,
      });
    }
    const r = outcome.result;
    log.info({ tenantId: campaign.tenant_id, campaignId: campaign.id, kind: r.kind, batchId: r.batch_id, moved: r.moved }, 'Contacts assigned');
    platformAuditLogger.log({
      tenant_id: campaign.tenant_id,
      account_id: campaign.account_id,
      ...requestAuditActor(request),
      action: 'agency_contacts.assigned',
      resource_type: 'agency_campaign',
      resource_id: campaign.id,
      campaign_id: campaign.id,
      details: {
        batch_id: r.batch_id,
        kind: r.kind,
        moved: r.moved,
        skipped_live: r.skipped_live,
        to_pool: r.to_pool,
        per_agent: r.per_agent,
      },
    });
    return reply.code(200).send(r);
  });

  /** GET /campaigns/:id/assignments/progress — per agent: counts by bucket, activity, presence. */
  app.get<CampaignParams & { Querystring: { absent_after_minutes?: string } }>('/campaigns/:id/assignments/progress', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const campaign = await guardCampaign(request, reply);
    if (!campaign) return reply;
    const rawAbsent = (request.query as Record<string, unknown> | undefined)?.['absent_after_minutes'];
    let absentAfter = AGENCY_ASSIGNMENT_ABSENT_AFTER_MINUTES;
    if (rawAbsent !== undefined) {
      const n = Number(rawAbsent);
      if (typeof rawAbsent !== 'string' || !/^\d+$/.test(rawAbsent) || n < 1 || n > ABSENT_AFTER_MAX_MINUTES) {
        return invalid(reply, { absent_after_minutes: `must be a whole number of minutes, 1 to ${ABSENT_AFTER_MAX_MINUTES}` });
      }
      absentAfter = n;
    }

    const [raw, staffing] = await Promise.all([
      agencyAssignmentReadRepository.progress(campaign),
      agencyCampaignAgentRepository.listActiveForCampaign(campaign.id, campaign.tenant_id),
    ]);
    const staffed = new Set(staffing.map((s) => s.user_id));
    const ids = [...new Set([...staffing.map((s) => s.user_id), ...[...raw.owners.keys()].sort()])];
    let names = new Map<string, string | null>();
    if (ids.length > 0) {
      try {
        names = await resolveAgentNames(ids, campaign.tenant_id);
      } catch (err) {
        log.warn({ tenantId: campaign.tenant_id, err: err instanceof Error ? err.message : String(err) },
          'assignment progress: agent name resolution failed; emitting agent_name: null');
      }
    }
    const now = Date.now();
    const agents: AgencyAssignmentProgressRow[] = ids.map((id) => {
      const t = raw.owners.get(id);
      const s = raw.sessions.get(id);
      const live = s?.live ?? false;
      const lastSeen = s?.last_seen_at ?? null;
      const absent = !live && (lastSeen === null || now - new Date(lastSeen).getTime() > absentAfter * 60_000);
      const last = raw.lastActivity.get(id) ?? null;
      return {
        agent_user_id: id,
        agent_name: names.get(id) ?? null,
        staffed: staffed.has(id),
        live,
        last_seen_at: lastSeen ? new Date(lastSeen).toISOString() : null,
        assigned: t?.total ?? 0,
        counts: t?.counts ?? emptyBucketCounts(),
        attempted: t?.attempted ?? 0,
        due_now: t?.due_now ?? 0,
        last_activity_at: last ? new Date(last).toISOString() : null,
        due_while_absent: absent ? t?.due_now ?? 0 : 0,
      };
    });
    const poolOpen = raw.pool.counts.pending + raw.pool.counts.callback + raw.pool.counts.not_reached;
    const body: AgencyAssignmentProgress = {
      campaign_id: campaign.id,
      assignment_mode: campaign.assignment_mode,
      agents,
      pool: { total: raw.pool.total, counts: raw.pool.counts, due_now: raw.pool.due_now },
      unassigned_open: campaign.assignment_mode === 'strict' ? poolOpen : 0,
      absent_after_minutes: absentAfter,
      generated_at: new Date(now).toISOString(),
    };
    return reply.code(200).send(body);
  });

  /** GET /campaigns/:id/contacts/:contactId/assignments — who held a contact, newest first. */
  app.get<{ Params: { id: string; contactId: string } }>('/campaigns/:id/contacts/:contactId/assignments', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const campaign = await guardCampaign(request, reply);
    if (!campaign) return reply;
    const contactId = request.params.contactId;
    if (!isUuid(contactId) || !(await agencyAssignmentRepository.contactOnCampaign(campaign.id, contactId))) {
      return refuse(reply, 404, 'contact_not_found', 'Contact not found.');
    }
    return reply.code(200).send({
      contact_id: contactId.toLowerCase(),
      events: await agencyAssignmentRepository.history(campaign.id, contactId),
    });
  });
}
