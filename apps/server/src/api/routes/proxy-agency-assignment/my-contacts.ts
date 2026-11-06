/*
 * The agent's own contacts: `GET /my-contacts/summary` and `GET /my-contacts`.
 * `agency.contacts.own` (floored at `agent`); the subject is ALWAYS `request.user.id`, never a
 * parameter; the `agency_contact_assignment_enabled` flag (`403 assignment_disabled`); the
 * campaign must be one the caller is actively staffed on (`403 not_staffed`, `staffedCampaign`). A contact of
 * another agent never appears: the repository's owner predicate is the caller's id.
 *
 * The agent's ACTIONS on these contacts (retry, call) are registered beside these by their
 * own file (`registerMyContactActionRoutes`), on the same plugin instance.
 *
 * Part of `proxy-agency-assignment.routes.ts`.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  AGENCY_MY_CONTACT_BUCKETS,
  type AgencyMyContactBucket,
  type AgencyMyContactsSummary,
} from '@magick-agency/contracts/api/agency/assignment';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { agencyAgentCallerIdRepository, agencyAssignmentReadRepository } from '../../../db/repositories/agency.repository.js';
import { dedicatedCallerIdOf, usableCallerIds } from '../../../agency/pacing/caller-id-pool.js';
import { clampLimit, multiParam, parsePhoneFilter, PHONE_FILTER_UNUSABLE_MESSAGE } from '../../../agency/spine-filters.js';
import { poolModeQueueState, readAgentQueueState } from '../../../agency/pacing/agent-queue.js';
import { UUID_RE } from '../../../utils/uuid.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import { readKeysetCursor } from '../helpers/read-cursor.js';
import { settledValue } from '../helpers/settled.js';
import { resolveMyAgentId } from '../proxy-agency-staffing/my.js';
import { agentRetryOpen, staffedCampaign } from './shared.js';

const campaignId = z.string().regex(UUID_RE, 'must be a campaign id');

const summaryQuery = z.object({ campaign_id: campaignId }).strict();

const listQuery = z.object({
  campaign_id: campaignId,
  bucket: z.preprocess(
    multiParam,
    z.array(z.enum(AGENCY_MY_CONTACT_BUCKETS as unknown as [AgencyMyContactBucket, ...AgencyMyContactBucket[]])).optional(),
  ),
  phone: z.string().max(40).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.string().regex(/^\d{1,4}$/, 'must be a whole number').optional(),
}).strict();

/** A 400 in the zod-flatten shape `parseOr400` answers, for a field checked by hand. */
function fieldError(reply: FastifyReply, field: string, message: string): FastifyReply {
  return reply.code(400).send({ error: 'Validation Error', details: { formErrors: [], fieldErrors: { [field]: [message] } } });
}

export async function registerMyContactRoutes(app: FastifyInstance): Promise<void> {
  /** GET /my-contacts/summary?campaign_id= — the caller's contacts on a campaign, in counts. */
  app.get('/my-contacts/summary', {
    preHandler: requirePermission('agency.contacts.own'),
  }, async (request, reply) => {
    const userId = resolveMyAgentId(request, reply);
    if (!userId) return reply;
    const query = parseOr400(summaryQuery, request.query ?? {}, reply, 'agency');
    if (!query) return reply;
    const campaign = await staffedCampaign(request, reply, query.data.campaign_id.toLowerCase(), userId);
    if (!campaign) return reply;

    const now = new Date();
    // Independent reads, started together; a throw is rethrown in this order.
    const [tallyRead, queueRead, callerIdRead] = await Promise.allSettled([
      agencyAssignmentReadRepository.myTally(campaign, userId),
      readAgentQueueState(campaign, userId, now),
      agencyAgentCallerIdRepository.findForAgent(campaign.id, userId),
    ]);
    const tally = settledValue(tallyRead);
    // The queue pacing and the station read (strict / preferred); pool mode has none of its own.
    const queue = settledValue(queueRead) ?? poolModeQueueState(campaign, tally.pool.next_open_at, now);
    // The dial path's own rule (DN2): the stored number counts only while it is still one of
    // the campaign's usable caller IDs; otherwise their contacts use the rotation.
    const stored = settledValue(callerIdRead);
    const callerId = stored === null ? null : dedicatedCallerIdOf(usableCallerIds(campaign), new Map([[userId, stored]]), userId);
    const body: AgencyMyContactsSummary = {
      campaign_id: campaign.id,
      assignment_mode: campaign.assignment_mode,
      total: tally.own.total,
      counts: tally.own.counts,
      due_now: tally.own.due_now,
      queue,
      unassigned_open: campaign.assignment_mode === 'strict' ? tally.pool.open ?? 0 : 0,
      caller_id: callerId,
      retry: {
        // Off on a finished campaign too: the retry route would refuse `campaign_not_running`.
        allowed: agentRetryOpen(campaign),
        rounds: campaign.agent_retry_rounds,
        cooldown_minutes: campaign.agent_retry_cooldown_minutes,
        eligible: tally.own.eligible,
      },
    };
    return reply.code(200).send(body);
  });

  /**
   * GET /my-contacts?campaign_id=&bucket=&phone=&q=&cursor=&limit= — the caller's contacts, in
   * due order (`next_attempt_at`, then id), keyset paged.
   */
  app.get('/my-contacts', {
    preHandler: requirePermission('agency.contacts.own'),
  }, async (request, reply) => {
    const userId = resolveMyAgentId(request, reply);
    if (!userId) return reply;
    const query = parseOr400(listQuery, request.query ?? {}, reply, 'agency');
    if (!query) return reply;
    const phone = parsePhoneFilter(query.data.phone);
    if (phone === 'unusable') {
      return fieldError(reply, 'phone', PHONE_FILTER_UNUSABLE_MESSAGE);
    }
    const cursor = readKeysetCursor(request, reply);
    if (cursor === null) return reply;
    const campaign = await staffedCampaign(request, reply, query.data.campaign_id.toLowerCase(), userId);
    if (!campaign) return reply;

    const page = await agencyAssignmentReadRepository.myContacts({
      campaign,
      userId,
      ...(query.data.bucket ? { buckets: [...new Set(query.data.bucket)] } : {}),
      ...(phone ? { phone } : {}),
      ...(query.data.q ? { q: query.data.q } : {}),
      ...(cursor ? { after: cursor } : {}),
      limit: clampLimit(query.data.limit),
    });
    return reply.code(200).send(page);
  });
}
