/**
 * The campaigns a caller may log a call to (docs/softphone.md §2, SP4): in their account,
 * `running` or `paused` (`SOFTPHONE_TAGGABLE_CAMPAIGN_STATUSES`), and one they are actively
 * staffed on unless they hold `agency.supervise`. One rule for the soft phone's "Log to"
 * (`SoftphoneService.placeCall`, bootstrap's `taggable_campaigns`) and for filing an unknown
 * inbound caller's call under a campaign at wrap-up (`InboundCallService`, docs/call-log.md §5).
 */
import { SOFTPHONE_TAGGABLE_CAMPAIGN_STATUSES } from '@magick-agency/contracts/agency';
import { agencyCampaignAgentRepository } from '@magick-agency/db/repositories/agency-campaign-agent.repository';
import { agencyCampaignRepository } from '../../db/repositories/agency.repository.js';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import { isUuid } from '../../utils/uuid.js';
import type { SoftphoneActor } from './types.js';

/** At most this many campaigns are offered, newest first, after the status and staffing filters. */
export const TAGGABLE_CAMPAIGNS_MAX = 500;

/** Campaign `campaignId`, when `actor` may log a call to it; else null (a malformed id included). */
export async function findTaggableCampaign(campaignId: string, actor: SoftphoneActor): Promise<AgencyCampaignRecord | null> {
  if (!isUuid(campaignId)) return null;
  const campaign = await agencyCampaignRepository.findById(campaignId);
  if (!campaign || campaign.tenant_id !== actor.tenantId || campaign.account_id !== actor.accountId) return null;
  if (!(SOFTPHONE_TAGGABLE_CAMPAIGN_STATUSES as readonly string[]).includes(campaign.status)) return null;
  if (actor.supervise) return campaign;
  const staffed = await agencyCampaignAgentRepository.listActiveForUser(actor.tenantId, actor.userId);
  return staffed.some((s) => s.campaign_id === campaign.id) ? campaign : null;
}

/** Every campaign `actor` may log a call to, newest first (filtered in the query, before the cap). */
export function listTaggableCampaigns(actor: SoftphoneActor): Promise<AgencyCampaignRecord[]> {
  return agencyCampaignRepository.listSoftphoneTaggable(actor.tenantId, actor.accountId, {
    statuses: SOFTPHONE_TAGGABLE_CAMPAIGN_STATUSES,
    staffedUserId: actor.supervise ? null : actor.userId,
    limit: TAGGABLE_CAMPAIGNS_MAX,
  });
}
