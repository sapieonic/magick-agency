/*
 * What the insights routes share: the guard chain after the permission and the refusal bodies.
 * Part of `proxy-agency-insights.routes.ts`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getFeatureFlagService, FLAGS } from '../../../feature-flags/index.js';
import { agencyCampaignRepository } from '../../../db/repositories/agency.repository.js';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import { UUID_RE } from '../../../utils/uuid.js';
import { fetchOwnedCoreCampaign } from '../helpers/core-campaign.js';
import { settledValue } from '../helpers/settled.js';

export type CampaignParams = { Params: { id: string } };

/**
 * The internal campaign handlers' `requireOwned` 404, byte for byte, so a malformed id, an unknown
 * one and another tenant's or account's are one answer (never a campaign-id oracle).
 */
export const CAMPAIGN_NOT_FOUND_BODY = { error: 'Not Found', code: 'campaign_not_found', message: 'Campaign not found' } as const;

/** The internal handlers' `gate` refusal (`agency-campaigns/guards.ts`), byte for byte. */
export const DIALER_DISABLED_BODY = {
  error: 'Feature Not Enabled', code: 'feature_disabled', message: 'Agency dialer is not enabled for this account.',
} as const;

/**
 * The campaign an insights read is about, after `requirePermission('agency.supervise')`:
 *
 *  1. the dialer flag (`agency_dialer_enabled`) for the request's tenant and account, else the
 *     internal handlers' `403 feature_disabled`: the flag every other campaign read checks, and
 *     before the id so a tenant without the dialer learns nothing about ids;
 *  2. the id is a UUID, else `404 campaign_not_found` (a malformed id never reaches a `uuid` cast);
 *  3. the ownership probe (`fetchOwnedCoreCampaign`: the internal handler's gate and
 *     `requireOwned`, tenant AND account), its refusal forwarded as-is, and the campaign row the
 *     reads take their settings from (read in parallel with the probe, discarded when it refuses).
 *
 * Null once it has replied. A read that throws propagates (a 500): the flag fails closed.
 */
export async function insightsCampaign(
  request: FastifyRequest<CampaignParams>,
  reply: FastifyReply,
): Promise<AgencyCampaignRecord | null> {
  const enabled = await getFeatureFlagService().isEnabled(FLAGS.agency_dialer_enabled, {
    tenantId: request.tenantId!,
    ...(request.accountId ? { accountId: request.accountId } : {}),
  });
  if (!enabled) {
    await reply.code(403).send(DIALER_DISABLED_BODY);
    return null;
  }
  const id = request.params.id;
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    await reply.code(404).send(CAMPAIGN_NOT_FOUND_BODY);
    return null;
  }
  const campaignId = id.toLowerCase();
  const [probeRead, rowRead] = await Promise.allSettled([
    fetchOwnedCoreCampaign(request, campaignId),
    agencyCampaignRepository.findById(campaignId),
  ]);
  const probe = settledValue(probeRead);
  if (!probe.ok) {
    await reply.code(probe.status).send(probe.body);
    return null;
  }
  const campaign = settledValue(rowRead);
  if (!campaign || campaign.tenant_id !== request.tenantId) {
    await reply.code(404).send(CAMPAIGN_NOT_FOUND_BODY);
    return null;
  }
  return campaign;
}
