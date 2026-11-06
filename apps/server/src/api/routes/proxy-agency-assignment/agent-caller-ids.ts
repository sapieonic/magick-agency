/*
 * Dedicated caller IDs (decisions DN1–DN10; wire `packages/contracts/src/api/agency/agent-caller-id.ts`):
 * the supervisor dedicates one of a campaign's caller IDs to a staffed agent, and every dial to
 * a contact that agent owns on the campaign goes out from it (`resolveCallerId`).
 *
 *  - `GET    /campaigns/:id/agent-caller-ids`           the dedications, the rotation
 *  - `PUT    /campaigns/:id/agents/:userId/caller-id`   dedicate (or replace) one agent's number
 *  - `DELETE /campaigns/:id/agents/:userId/caller-id`   release it (204, also when none was set)
 *
 * Guards, as the other supervisor routes: `agency.supervise`, the campaign id's shape (404),
 * `agency_contact_assignment_enabled` (403 `assignment_disabled`, DN9: the runtime honours stored
 * rows whatever the flag), the ownership probe (`supervisedCampaign`). Audited
 * `agency_campaign.agent_caller_id_set` / `_cleared` (`cause: 'supervisor'`), ids and the number
 * only (DN10). Part of `proxy-agency-assignment.routes.ts`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AGENCY_AGENT_CALLER_ID_AUDIT_ACTIONS,
  type AgencyAgentCallerId,
  type AgencyAgentCallerIds,
} from '@magick-agency/contracts/api/agency/agent-caller-id';
import { createChildLogger } from '@magick-agency/observability';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { requestAuditActor } from '../../../audit/platform/audit-actor.js';
import {
  agencyAgentCallerIdRepository,
  type AgentCallerIdRow,
} from '../../../db/repositories/agency.repository.js';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import { resolveAgentNames } from '../../../agency/agency-agent-identity.js';
import { rotationCallerIds, usableCallerIds } from '../../../agency/pacing/caller-id-pool.js';
import { isUuid, refuse, requireAssignmentEnabled, supervisedCampaign } from './shared.js';

const log = createChildLogger({ component: 'proxy-agency-agent-caller-ids' });

/** The longest number the table stores (`caller_id VARCHAR(20)`). */
export const AGENT_CALLER_ID_MAX_LENGTH = 20;

/** The refusals' copy (British English). */
export const AGENT_CALLER_ID_MESSAGES = {
  campaign_not_found: 'Campaign not found.',
  caller_id_invalid: 'Choose one of the campaign\'s caller IDs.',
  agent_not_staffed: 'Only an agent staffed on this campaign can be given a caller ID.',
  caller_id_not_in_campaign: 'That number is not one of this campaign\'s caller IDs.',
  caller_id_taken: 'That number is already dedicated to another agent on this campaign.',
} as const;

const setBodySchema = z.object({
  caller_id: z.string({ invalid_type_error: 'must be a string', required_error: 'is required' })
    .trim()
    .min(1, 'must not be empty')
    .max(AGENT_CALLER_ID_MAX_LENGTH, `must be at most ${AGENT_CALLER_ID_MAX_LENGTH} characters`),
}).strict();

/** The PUT body: the number, trimmed, or the per-field details of a 400 `caller_id_invalid`. */
export function parseSetAgentCallerIdBody(
  body: unknown,
): { ok: true; callerId: string } | { ok: false; details: Record<string, string> } {
  const parsed = setBodySchema.safeParse(body ?? {});
  if (parsed.success) return { ok: true, callerId: parsed.data.caller_id };
  const details: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.code === 'unrecognized_keys'
      ? issue.keys.join(',')
      : issue.path.length ? issue.path.join('.') : 'body';
    details[key] ??= issue.code === 'unrecognized_keys' ? 'is not a field of this request' : issue.message;
  }
  return { ok: false, details };
}

/** One row on the wire. `usable` is the campaign's usable caller IDs. */
export function agentCallerIdOf(
  row: AgentCallerIdRow,
  usable: readonly string[],
  agentName: string | null,
): AgencyAgentCallerId {
  return {
    campaign_id: row.campaign_id,
    user_id: row.user_id,
    agent_name: agentName,
    caller_id: row.caller_id,
    in_campaign: usable.includes(row.caller_id),
    set_at: new Date(row.set_at).toISOString(),
    set_by_user_id: row.set_by_user_id,
  };
}

/**
 * The GET body: the campaign's usable caller IDs, every dedication (by agent name, unnamed
 * last, then user id), and the rotation the other contacts use (DN3, from the dedications
 * still in the campaign).
 */
export function agentCallerIdsBody(
  campaign: Pick<AgencyCampaignRecord, 'id' | 'caller_ids'>,
  rows: readonly AgentCallerIdRow[],
  names: ReadonlyMap<string, string | null>,
): AgencyAgentCallerIds {
  const usable = usableCallerIds(campaign as AgencyCampaignRecord);
  const dedicated = rows
    .map((r) => agentCallerIdOf(r, usable, names.get(r.user_id) ?? null))
    .sort((a, b) => {
      if (a.agent_name !== b.agent_name) {
        if (a.agent_name === null) return 1;
        if (b.agent_name === null) return -1;
        const byName = a.agent_name.localeCompare(b.agent_name);
        if (byName !== 0) return byName;
      }
      return a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0;
    });
  const map = new Map(rows.map((r) => [r.user_id, r.caller_id]));
  const rotation = rotationCallerIds(usable, map);
  const live = new Set(dedicated.filter((d) => d.in_campaign).map((d) => d.caller_id));
  return {
    campaign_id: campaign.id,
    caller_ids: usable,
    dedicated,
    rotation,
    all_dedicated: usable.length > 0 && usable.every((n) => live.has(n)),
  };
}

type CampaignParams = { Params: { id: string } };
type AgentParams = { Params: { id: string; userId: string } };

/** Id shape → flag → ownership, as the other supervisor routes. Null once it has replied. */
async function guardCampaign(request: FastifyRequest<CampaignParams>, reply: FastifyReply): Promise<AgencyCampaignRecord | null> {
  if (!isUuid(request.params.id)) {
    refuse(reply, 404, 'campaign_not_found', AGENT_CALLER_ID_MESSAGES.campaign_not_found);
    return null;
  }
  if (!(await requireAssignmentEnabled(request, reply))) return null;
  return supervisedCampaign(request, reply, request.params.id.toLowerCase());
}

/** Names for `ids`; a failed lookup degrades to nulls (the read still answers). */
async function namesFor(ids: readonly string[], tenantId: string): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  try {
    return await resolveAgentNames(ids, tenantId);
  } catch (err) {
    log.warn({ tenantId, err: err instanceof Error ? err.message : String(err) },
      'agent caller IDs: agent name resolution failed; emitting agent_name: null');
    return new Map();
  }
}

export async function registerAgentCallerIdRoutes(app: FastifyInstance): Promise<void> {
  /** GET /campaigns/:id/agent-caller-ids — every dedicated number and the rotation. */
  app.get<CampaignParams>('/campaigns/:id/agent-caller-ids', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const campaign = await guardCampaign(request, reply);
    if (!campaign) return reply;
    const rows = await agencyAgentCallerIdRepository.listForCampaign(campaign.tenant_id, campaign.id);
    const names = await namesFor(rows.map((r) => r.user_id), campaign.tenant_id);
    return reply.code(200).send(agentCallerIdsBody(campaign, rows, names));
  });

  /**
   * PUT /campaigns/:id/agents/:userId/caller-id — dedicate one of the campaign's caller IDs to
   * a staffed agent, replacing the number they held. 404 `agent_not_staffed`, 409
   * `caller_id_not_in_campaign` (`details.caller_ids`), 409 `caller_id_taken` (`details.user_id`,
   * `details.agent_name`; also when a concurrent PUT took it first).
   */
  app.put<AgentParams>('/campaigns/:id/agents/:userId/caller-id', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const campaign = await guardCampaign(request, reply);
    if (!campaign) return reply;
    const body = parseSetAgentCallerIdBody(request.body);
    if (!body.ok) return refuse(reply, 400, 'caller_id_invalid', AGENT_CALLER_ID_MESSAGES.caller_id_invalid, body.details);
    const userId = request.params.userId;
    // A malformed user id is the answer an unknown one gets, never a `22P02`.
    if (!isUuid(userId)) return refuse(reply, 404, 'agent_not_staffed', AGENT_CALLER_ID_MESSAGES.agent_not_staffed);
    const agentId = userId.toLowerCase();

    // The staffing and the campaign's caller IDs are checked inside the write's transaction,
    // under locks (the repository's header): an unstaff or a campaign PATCH racing this PUT
    // either waits for it or is seen by it.
    const outcome = await agencyAgentCallerIdRepository.set({
      tenantId: campaign.tenant_id,
      accountId: campaign.account_id,
      campaignId: campaign.id,
      userId: agentId,
      callerId: body.callerId,
      setByUserId: request.user?.id ?? null,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'not_staffed') {
        return refuse(reply, 404, 'agent_not_staffed', AGENT_CALLER_ID_MESSAGES.agent_not_staffed);
      }
      if (outcome.reason === 'not_in_campaign') {
        return refuse(reply, 409, 'caller_id_not_in_campaign', AGENT_CALLER_ID_MESSAGES.caller_id_not_in_campaign,
          { caller_ids: outcome.caller_ids });
      }
      const holder = outcome.holder_user_id;
      const holderName = holder ? (await namesFor([holder], campaign.tenant_id)).get(holder) ?? null : null;
      return refuse(reply, 409, 'caller_id_taken', AGENT_CALLER_ID_MESSAGES.caller_id_taken, {
        caller_id: body.callerId, user_id: holder, agent_name: holderName,
      });
    }
    if (outcome.changed) {
      log.info({ tenantId: campaign.tenant_id, campaignId: campaign.id, userId: agentId }, 'Caller ID dedicated to an agent');
      platformAuditLogger.log({
        tenant_id: campaign.tenant_id,
        account_id: campaign.account_id,
        ...requestAuditActor(request),
        action: AGENCY_AGENT_CALLER_ID_AUDIT_ACTIONS.set,
        resource_type: 'agency_campaign',
        resource_id: campaign.id,
        campaign_id: campaign.id,
        details: {
          campaign_id: campaign.id,
          user_id: agentId,
          caller_id: outcome.row.caller_id,
          previous_caller_id: outcome.previous_caller_id,
        },
      });
    }
    const name = (await namesFor([agentId], campaign.tenant_id)).get(agentId) ?? null;
    return reply.code(200).send(agentCallerIdOf(outcome.row, outcome.caller_ids, name));
  });

  /** DELETE /campaigns/:id/agents/:userId/caller-id — release the agent's number. 204, idempotent. */
  app.delete<AgentParams>('/campaigns/:id/agents/:userId/caller-id', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const campaign = await guardCampaign(request, reply);
    if (!campaign) return reply;
    const userId = request.params.userId;
    // Nothing can be dedicated to a malformed id: nothing to release.
    if (!isUuid(userId)) return reply.code(204).send();
    const agentId = userId.toLowerCase();
    const released = await agencyAgentCallerIdRepository.clear(campaign.id, agentId);
    if (released !== null) {
      log.info({ tenantId: campaign.tenant_id, campaignId: campaign.id, userId: agentId }, 'Agent\'s dedicated caller ID released');
      platformAuditLogger.log({
        tenant_id: campaign.tenant_id,
        account_id: campaign.account_id,
        ...requestAuditActor(request),
        action: AGENCY_AGENT_CALLER_ID_AUDIT_ACTIONS.cleared,
        resource_type: 'agency_campaign',
        resource_id: campaign.id,
        campaign_id: campaign.id,
        details: { campaign_id: campaign.id, user_id: agentId, caller_id: released, cause: 'supervisor' },
      });
    }
    return reply.code(204).send();
  });
}
