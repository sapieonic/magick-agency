import { createChildLogger } from '@magick-agency/observability';
import { agencyCampaignRepository } from '../db/repositories/agency.repository.js';
import { auditLogger } from '../audit/audit-logger.js';
import type { AgencyCampaignRecord } from '../db/models/agency.model.js';

const log = createChildLogger({ component: 'agency-carrier-auth-pause' });

/**
 * ─── PAUSE A CAMPAIGN WHOSE CARRIER REFUSED ITS CREDENTIAL ──────────────────
 *
 * A dial the carrier refused with HTTP 401 (the bridge's `carrier_auth_rejected`) says
 * the campaign's carrier-account credential no longer works: every further dial on it
 * will be refused the same way. Dialling on would cycle the roster through refusals, so
 * the campaign is paused (`pause_reason = 'carrier_auth'`) on the first one, and stays
 * paused until a supervisor resumes it (resume is refused while the credential is not
 * `active`). Nothing here ever resumes.
 *
 * Written like the abandonment guardrail's pause (`abandonment-guardrail.ts`): the row
 * (`pauseForCarrierAuth`, running campaigns only, so a second refusal racing the first
 * writes nothing), an ERROR line, and an `agency_campaign.auto_paused` audit row whose
 * `reason` says why (the Insights transitions read it). The agents are told by the
 * pacing tick, which announces any pause it did not make from `pause_reason`.
 *
 * Never throws: it runs on the dial's failure path, which must go on to release the
 * agent and return the contact whatever happens here.
 *
 * @returns whether this call paused the campaign.
 */
export async function pauseCampaignForCarrierAuth(
  campaign: Pick<AgencyCampaignRecord, 'id' | 'tenant_id' | 'account_id' | 'telephony_provider' | 'telephony_credential_id'>,
): Promise<boolean> {
  try {
    const paused = await agencyCampaignRepository.pauseForCarrierAuth(campaign.id);
    if (!paused) return false;
    log.error(
      {
        campaignId: campaign.id,
        tenantId: campaign.tenant_id,
        provider: campaign.telephony_provider,
        telephonyCredentialId: campaign.telephony_credential_id,
      },
      'Agency campaign auto-paused — the carrier refused its carrier-account credential',
    );
    auditLogger.log({
      tenantId: paused.tenant_id,
      accountId: paused.account_id,
      eventType: 'agency_campaign.auto_paused',
      eventCategory: 'call',
      severity: 'error',
      actor: 'system:carrier-auth',
      eventData: {
        campaign_id: campaign.id,
        reason: 'carrier_auth',
        telephony_provider: campaign.telephony_provider,
        telephony_credential_id: campaign.telephony_credential_id,
      },
    });
    return true;
  } catch (err) {
    log.error({ err, campaignId: campaign.id }, 'Failed to auto-pause the campaign whose carrier refused its credential');
    return false;
  }
}
