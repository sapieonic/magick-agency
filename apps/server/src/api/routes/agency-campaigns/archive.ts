/*
 * Archive and restore a campaign (decisions AR1–AR6). Part of `agency-campaigns.routes.ts`.
 *
 * Archiving takes a draft or stopped campaign off the Campaigns page; it is listed on its own
 * screen (`GET /?archived=true`) and restored from there or from its own page. It is not a
 * status: the campaign keeps `draft` or `stopped`, so nothing that reads `status` changes, and
 * the one statement that moves a status refuses an archived campaign (`transitionStatus`).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { agencyCampaignRepository } from '../../../db/repositories/agency.repository.js';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import type { AgencyCampaignActor } from '@magick-agency/contracts/agency';
import {
  AGENCY_CAMPAIGN_ARCHIVABLE_STATUSES,
  type AgencyCampaignArchiveErrorCode,
} from '@magick-agency/contracts/api/agency/agency-campaign';
import { formatAgencyCampaignResponse } from '../../responses/agency-campaign.response.js';
import { campaignOf, ownedCampaign } from './guards.js';
import { ACTOR_NAME_MAX } from './lifecycle.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a campaign in `status` may be archived (AR2). */
export function isArchivableStatus(status: string): boolean {
  return (AGENCY_CAMPAIGN_ARCHIVABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * Who archived it, from the optional body the public route builds from the session
 * (`{ actor_user_id, actor_name }`, as on the lifecycle routes). Attribution, never a
 * precondition: an absent or non-UUID id (the column is a UUID, and a value that is not one would
 * fail the archive with `22P02`) records the archive unattributed. The name is trimmed and cut to
 * the column's width.
 */
export function readArchiveActor(body: unknown): AgencyCampaignActor | null {
  const raw = (body ?? {}) as { actor_user_id?: unknown; actor_name?: unknown };
  const userId = typeof raw.actor_user_id === 'string' ? raw.actor_user_id.trim() : '';
  if (!UUID_RE.test(userId)) return null;
  const name = typeof raw.actor_name === 'string' ? raw.actor_name.trim() : '';
  return { user_id: userId, name: name ? name.slice(0, ACTOR_NAME_MAX) : null };
}

/** A 409 with one of the archive codes, carrying the row as it stands. */
export function replyArchiveConflict(
  reply: FastifyReply,
  code: AgencyCampaignArchiveErrorCode,
  message: string,
  campaign: Pick<AgencyCampaignRecord, 'status' | 'archived_at'> | null,
): FastifyReply {
  return reply.code(409).send({
    error: 'Conflict',
    code,
    message,
    current_status: campaign?.status ?? null,
    archived_at: campaign?.archived_at ?? null,
  });
}

/** Why `campaign` cannot be archived, or `null` when it can. */
function archiveRefusal(
  campaign: Pick<AgencyCampaignRecord, 'status' | 'archived_at'>,
): { code: AgencyCampaignArchiveErrorCode; message: string } | null {
  if (campaign.archived_at) {
    return { code: 'campaign_archived', message: 'This campaign is already archived.' };
  }
  if (!isArchivableStatus(campaign.status)) {
    return {
      code: 'campaign_not_archivable',
      message: `Only a draft or a stopped campaign can be archived; this one is ${campaign.status}.`,
    };
  }
  return null;
}

/** Registered by `agencyCampaignRoutes` on its own instance, after its `authMiddleware`. */
export async function registerCampaignArchiveRoutes(app: FastifyInstance): Promise<void> {
  // ── POST /api/v1/agency-campaigns/:id/archive ────────────────────────────
  //
  // Gated like the PATCH: archiving is housekeeping, not the off button.
  app.post<{ Params: { id: string } }>('/:id/archive', {
    preHandler: ownedCampaign({ gated: true }),
  }, async (request, reply) => {
    const campaign = campaignOf(request);
    const refusal = archiveRefusal(campaign);
    if (refusal) return replyArchiveConflict(reply, refusal.code, refusal.message, campaign);

    const updated = await agencyCampaignRepository.archive(campaign.id, readArchiveActor(request.body));
    if (!updated) {
      // Read as archivable, written as not: it moved underneath us (Start won, or another
      // archive did). Re-read and say which.
      const fresh = await agencyCampaignRepository.findById(campaign.id);
      const why = fresh ? archiveRefusal(fresh) : null;
      return replyArchiveConflict(
        reply,
        why?.code ?? 'campaign_not_archivable',
        why?.message ?? 'The campaign changed before it could be archived.',
        fresh,
      );
    }
    return reply.send(formatAgencyCampaignResponse(updated));
  });

  // ── POST /api/v1/agency-campaigns/:id/unarchive ──────────────────────────
  app.post<{ Params: { id: string } }>('/:id/unarchive', {
    preHandler: ownedCampaign({ gated: true }),
  }, async (request, reply) => {
    const campaign = campaignOf(request);
    const notArchived = () => replyArchiveConflict(
      reply, 'campaign_not_archived', 'This campaign is not archived.', campaign,
    );
    if (!campaign.archived_at) return notArchived();
    const updated = await agencyCampaignRepository.unarchive(campaign.id);
    if (!updated) return notArchived();
    return reply.send(formatAgencyCampaignResponse(updated));
  });
}
