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
  code: AgencyAssignmentErrorCode | AgencyAgentRetryErrorCode,
  message: string,
  details?: Record<string, unknown>,
): FastifyReply {
  return reply.code(status).send({ error: TITLES[status] ?? 'Error', code, message, ...(details ? { details } : {}) });
}

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_RE.test(value);

/**
 * The statuses an agent's reopen is useful in: something will dial the contact (now, or on
 * resume). A reopen on a finished campaign would be dialled by nothing, its round spent for
 * nothing; the retry route answers `409 campaign_not_running` outside these.
 */
export const AGENT_RETRY_STATUSES: ReadonlySet<string> = new Set(['running', 'paused']);

/** Whether the agent may reopen contacts on `campaign` now: the summary's `retry.allowed`. */
export function agentRetryOpen(campaign: Pick<AgencyCampaignRecord, 'allow_agent_retry' | 'status'>): boolean {
  return campaign.allow_agent_retry === true && AGENT_RETRY_STATUSES.has(campaign.status);
}

/** The copy of the two scope refusals the agent's routes share. */
export const AGENT_SCOPE_MESSAGES = {
  assignment_disabled: 'Contact assignment is not enabled for this account.',
  not_staffed: "You're not assigned to this campaign. Ask your supervisor to add you.",
} as const;

/** The flag for a tenant and, when known, an account (account overrides are read only with one). */
async function assignmentEnabledFor(tenantId: string, accountId: string | null | undefined): Promise<boolean> {
  return getFeatureFlagService().isEnabled(FLAGS.agency_contact_assignment_enabled, {
    tenantId,
    ...(accountId ? { accountId } : {}),
  });
}

/**
 * `agency_contact_assignment_enabled` for the request's tenant and account, else
 * `403 assignment_disabled` (CA9). Runs after `requirePermission`, so a caller without the
 * permission is told that first. A flag read that throws is a 500: fail closed.
 */
export async function requireAssignmentEnabled(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (await assignmentEnabledFor(request.tenantId!, request.accountId)) return true;
  refuse(reply, 403, 'assignment_disabled', AGENT_SCOPE_MESSAGES.assignment_disabled);
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
 * The agent's campaign, for all four own-contact routes (reads and actions alike, CA14):
 *
 *  1. the flag for the request (`403 assignment_disabled`);
 *  2. the campaign in the caller's tenant (and account, when the request or the membership
 *     names one) AND the caller actively staffed on it, else `403 not_staffed`. One answer for
 *     a missing campaign, another tenant's or account's, and one the caller is not on: nothing
 *     about a campaign elsewhere is confirmed;
 *  3. when the request named no account, the flag again for the CAMPAIGN's account, so an
 *     account-level override is not side-stepped by leaving the header off.
 *
 * A supervisor-role caller is not special: these are the caller's OWN contacts, and they hold
 * none on a campaign they are not staffed on. Null once it has replied.
 */
export async function staffedCampaign(
  request: FastifyRequest,
  reply: FastifyReply,
  campaignId: string,
  userId: string,
): Promise<AgencyCampaignRecord | null> {
  if (!(await requireAssignmentEnabled(request, reply))) return null;
  const tenantId = request.tenantId!;
  const campaign = await agencyCampaignRepository.findById(campaignId);
  const account = request.accountId ?? request.membership?.account_id ?? null;
  const inScope = campaign !== null && campaign.tenant_id === tenantId
    && (account === null || campaign.account_id === account);
  const staffed = inScope && await agencyCampaignAgentRepository.isActiveOnCampaign(tenantId, campaignId, userId);
  if (!campaign || !staffed) {
    refuse(reply, 403, 'not_staffed', AGENT_SCOPE_MESSAGES.not_staffed);
    return null;
  }
  if (!request.accountId && campaign.account_id && !(await assignmentEnabledFor(tenantId, campaign.account_id))) {
    refuse(reply, 403, 'assignment_disabled', AGENT_SCOPE_MESSAGES.assignment_disabled);
    return null;
  }
  return campaign;
}
