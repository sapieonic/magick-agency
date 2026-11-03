/*
 * What the contact-assignment routes share: the flag gate, the refusal bodies, and the two
 * ways a campaign is resolved (the supervisor's ownership probe, the agent's staffed read).
 * Part of `proxy-agency-assignment.routes.ts`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  AgencyAgentRetryErrorCode,
  AgencyAssignmentErrorCode,
} from '@magick-agency/contracts/api/agency/assignment';
import { getFeatureFlagService, FLAGS } from '../../../feature-flags/index.js';
import { fetchOwnedCoreCampaign } from '../helpers/core-campaign.js';
import { agencyCampaignRepository } from '../../../db/repositories/agency.repository.js';
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import type { AgencyCampaignRecord } from '../../../db/models/agency.model.js';
import { UUID_RE } from '../../../utils/uuid.js';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
};

/** The repo-wide refusal shape: `{ error: <title>, code, message, details? }`. */
export function refuse(
  reply: FastifyReply,
  status: number,
  code: AgencyAssignmentErrorCode | AgencyAgentRetryErrorCode | 'campaign_not_found',
  message: string,
  details?: Record<string, unknown>,
): FastifyReply {
  return reply.code(status).send({ error: TITLES[status] ?? 'Error', code, message, ...(details ? { details } : {}) });
}

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value);

/**
 * `agency_contact_assignment_enabled` for the request's tenant and account, else
 * `403 assignment_disabled` (CA9). Runs after `requirePermission`, so a caller without the
 * permission is told that first. A flag read that throws is a 500: fail closed.
 */
export async function requireAssignmentEnabled(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const enabled = await getFeatureFlagService().isEnabled(FLAGS.agency_contact_assignment_enabled, {
    tenantId: request.tenantId!,
    ...(request.accountId ? { accountId: request.accountId } : {}),
  });
  if (enabled) return true;
  refuse(reply, 403, 'assignment_disabled', 'Contact assignment is not enabled for this workspace.');
  return false;
}

/**
 * The supervisor's campaign: proved through the internal handler's ownership probe (tenant
 * AND account, the `agency_dialer_enabled` gate; its refusal is forwarded as-is, so a
 * campaign in another account and a missing one stay the same 404), then read for the
 * settings the assignment reads. Null once it has replied.
 */
export async function supervisedCampaign(
  request: FastifyRequest,
  reply: FastifyReply,
  campaignId: string,
): Promise<AgencyCampaignRecord | null> {
  const probe = await fetchOwnedCoreCampaign(request, campaignId);
  if (!probe.ok) {
    reply.code(probe.status).send(probe.body);
    return null;
  }
  const campaign = await agencyCampaignRepository.findById(campaignId);
  if (!campaign || campaign.tenant_id !== request.tenantId) {
    refuse(reply, 404, 'campaign_not_found', 'Campaign not found.');
    return null;
  }
  return campaign;
}

/**
 * The agent's campaign: in the caller's tenant (and account, when the request or the
 * membership names one), else 404; the caller actively staffed on it, else
 * `403 not_staffed`. A supervisor-role caller is not special: these are the caller's OWN
 * contacts, and they hold none on a campaign they are not staffed on.
 */
export async function staffedCampaign(
  request: FastifyRequest,
  reply: FastifyReply,
  campaignId: string,
  userId: string,
): Promise<AgencyCampaignRecord | null> {
  const campaign = await agencyCampaignRepository.findById(campaignId);
  const account = request.accountId ?? request.membership?.account_id ?? null;
  if (!campaign || campaign.tenant_id !== request.tenantId || (account !== null && campaign.account_id !== account)) {
    refuse(reply, 404, 'campaign_not_found', 'Campaign not found.');
    return null;
  }
  const staffed = await agencyCampaignAgentRepository.isActiveOnCampaign(request.tenantId!, campaignId, userId);
  if (!staffed) {
    refuse(reply, 403, 'not_staffed', "You're not assigned to this campaign. Ask your supervisor to add you.");
    return null;
  }
  return campaign;
}
