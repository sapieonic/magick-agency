/*
 * The account-scope refusal: a read or write that is one account's work, asked without
 * `X-Account-Id`, is answered `400 account_scope_required` (a reason the console can act on)
 * before any handler work, instead of the internal handler's missing-header complaint.
 */
import type { FastifyReply } from 'fastify';
import { UUID_RE } from '../../../utils/uuid.js';
import { sendRefusal } from './refusal.js';

/** The message of a read scoped to one account. */
export const ACCOUNT_SCOPE_REQUIRED_MESSAGE = 'This read is scoped to one account. Send X-Account-Id.';

/**
 * `accountId` when there is one, else the 400 `account_scope_required` sent with `message`
 * and null (the caller then returns `reply`).
 */
export function accountOrRefuse(
  accountId: string | null | undefined,
  reply: FastifyReply,
  message: string = ACCOUNT_SCOPE_REQUIRED_MESSAGE,
): string | null {
  if (accountId) return accountId;
  void sendRefusal(reply, 400, 'account_scope_required', message);
  return null;
}

/**
 * The campaign `campaignId` names, when it is this tenant's and this account's; null once it
 * has replied `404 campaign_not_found`. An id that is not a UUID never reaches the read (a
 * `uuid` cast would be `22P02`), and another account's or tenant's campaign is as unknown as
 * one that does not exist.
 */
export async function accountCampaignOrRefuse<C extends { tenant_id: string; account_id: string | null }>(
  reply: FastifyReply,
  find: (campaignId: string) => Promise<C | null>,
  campaignId: string,
  tenantId: string,
  accountId: string,
): Promise<C | null> {
  const campaign = UUID_RE.test(campaignId) ? await find(campaignId) : null;
  if (!campaign || campaign.tenant_id !== tenantId || campaign.account_id !== accountId) {
    void sendRefusal(reply, 404, 'campaign_not_found', 'Campaign not found.');
    return null;
  }
  return campaign;
}
