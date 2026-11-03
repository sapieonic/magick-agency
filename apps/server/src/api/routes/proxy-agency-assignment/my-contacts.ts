/*
 * The agent's own contacts: `GET /my-contacts/summary` and `GET /my-contacts`.
 * `agency.contacts.own` (floored at `agent`); the subject is ALWAYS `request.user.id`, never a
 * parameter; the campaign must be one the caller is actively staffed on (`403 not_staffed`);
 * the `agency_contact_assignment_enabled` flag (`403 assignment_disabled`). A contact of
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
import { agencyAssignmentReadRepository } from '../../../db/repositories/agency.repository.js';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import { clampLimit, multiParam, parsePhoneFilter } from '../../../agency/spine-filters.js';
import { callingWindowState, nextWindowOpen, resolveCallingWindow } from '../../../agency/calling-hours.js';
import { computeQueueState } from '../../../agency/assignment/queue-state.js';
import type { MyContactsTally } from '../../../db/repositories/agency.repository.js';
import { UUID_RE } from '../../../utils/uuid.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import { readKeysetCursor } from '../helpers/read-cursor.js';
import { resolveMyAgentId } from '../proxy-agency-staffing/my.js';
import { requireAssignmentEnabled, staffedCampaign } from './shared.js';

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

/** The open contacts pacing would pair this agent with, by mode (D1), for the queue. */
export function queueInputsFor(
  campaign: Pick<AgencyCampaignRecord, 'assignment_mode' | 'calling_window_start' | 'calling_window_end' | 'calling_days' | 'default_timezone'>,
  tally: MyContactsTally,
  now: Date,
) {
  const window = resolveCallingWindow(campaign, { timezone: null });
  const own = tally.own;
  const ownOpen = own.counts.pending + own.counts.callback + own.counts.not_reached;
  const earliest = (a: Date | null, b: Date | null) => (a && b ? (a < b ? a : b) : a ?? b);
  const base = {
    windowOpen: callingWindowState(window, now) === 'open',
    nextWindowOpenAt: nextWindowOpen(window, now),
  };
  switch (campaign.assignment_mode) {
    case 'strict':
      return { ...base, dueNow: own.due_now, open: ownOpen, openNonCallback: own.open_non_callback, nextAttemptAt: own.next_open_at };
    case 'preferred':
      return {
        ...base,
        dueNow: own.due_now + tally.pool.due_now,
        open: ownOpen + tally.pool.open_non_callback,
        openNonCallback: own.open_non_callback + tally.pool.open_non_callback,
        nextAttemptAt: earliest(own.next_open_at, tally.pool.next_open_at),
      };
    case 'pool':
    default:
      return {
        ...base,
        dueNow: tally.pool.due_now,
        open: tally.pool.open_non_callback,
        openNonCallback: tally.pool.open_non_callback,
        nextAttemptAt: tally.pool.next_open_at,
      };
  }
}

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
    if (!(await requireAssignmentEnabled(request, reply))) return reply;
    const campaign = await staffedCampaign(request, reply, query.data.campaign_id.toLowerCase(), userId);
    if (!campaign) return reply;

    const tally = await agencyAssignmentReadRepository.myTally(campaign, userId);
    const body: AgencyMyContactsSummary = {
      campaign_id: campaign.id,
      assignment_mode: campaign.assignment_mode,
      total: tally.own.total,
      counts: tally.own.counts,
      due_now: tally.own.due_now,
      queue: computeQueueState(queueInputsFor(campaign, tally, new Date())),
      unassigned_open: campaign.assignment_mode === 'strict' ? tally.pool.open ?? 0 : 0,
      retry: {
        allowed: campaign.allow_agent_retry,
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
      return fieldError(reply, 'phone', 'must contain at least one digit — search by the whole number or its last few digits');
    }
    const cursor = readKeysetCursor(request, reply);
    if (cursor === null) return reply;
    if (!(await requireAssignmentEnabled(request, reply))) return reply;
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
