import { createChildLogger } from '@magick-agency/observability';
import { agencyCampaignRepository } from '../db/repositories/agency.repository.js';
import { auditLogger } from '../audit/audit-logger.js';
import type { AgencyCampaignRecord, CarrierAccountPauseReason } from '../db/models/agency.model.js';

const log = createChildLogger({ component: 'agency-carrier-account-pause' });

const PAUSE_LOG_LINE: Record<CarrierAccountPauseReason, string> = {
  carrier_auth: 'Agency campaign auto-paused — the carrier refused its carrier-account credential',
  carrier_account_unavailable: 'Agency campaign auto-paused — its carrier-account credential is no longer active',
  carrier_refusing_calls: 'Agency campaign auto-paused — the carrier refused its dials several times in a row',
};

/**
 * ─── PAUSE A CAMPAIGN WHOSE CARRIER ACCOUNT CANNOT DIAL ─────────────────────
 *
 * Two dial refusals say the campaign's carrier account no longer works, so every further
 * dial on it would be refused the same way:
 *  - `carrier_auth`: the carrier refused the credential with HTTP 401 (the bridge's
 *    `carrier_auth_rejected`);
 *  - `carrier_account_unavailable`: the pinned credential was disabled, marked invalid,
 *    revoked or could not be opened since the campaign started (the bridge's
 *    `telephony_credential_unavailable`, refused before the carrier, B20).
 * Dialling on would cycle the roster through refusals, so the campaign is paused with that
 * reason on the first one, and stays paused until a supervisor resumes it (resume is
 * refused while the credential is not `active`). Nothing here ever resumes.
 *
 * A third, `carrier_refusing_calls`, is the refusal breaker's (`carrier-refusal-breaker.ts`,
 * PL11): the carrier refused several dials in a row with no call placed in between (a
 * destination the account is not enabled for, no credit, a caller ID it rejects), which no
 * single refusal says. A supervisor resumes it once the account is fixed at the carrier.
 *
 * Written like the abandonment guardrail's pause (`abandonment-guardrail.ts`): the row
 * (`pauseForCarrierAccount`, running campaigns only, so a second refusal racing the first
 * writes nothing), an ERROR line, and an `agency_campaign.auto_paused` audit row whose
 * `reason` says why (the Insights transitions read it). The agents are told by the
 * pacing tick, which announces any pause it did not make from `pause_reason`.
 *
 * Never throws: it runs on the dial's failure path, which must go on to release the
 * agent and return the contact whatever happens here.
 *
 * @returns whether this call paused the campaign.
 */
export async function pauseCampaignForCarrierAccount(
  campaign: Pick<AgencyCampaignRecord, 'id' | 'tenant_id' | 'account_id' | 'telephony_provider' | 'telephony_credential_id'>,
  reason: CarrierAccountPauseReason,
): Promise<boolean> {
  try {
    const paused = await agencyCampaignRepository.pauseForCarrierAccount(campaign.id, reason);
    if (!paused) return false;
    log.error(
      {
        campaignId: campaign.id,
        tenantId: campaign.tenant_id,
        provider: campaign.telephony_provider,
        telephonyCredentialId: campaign.telephony_credential_id,
        reason,
      },
      PAUSE_LOG_LINE[reason],
    );
    auditLogger.log({
      tenantId: paused.tenant_id,
      accountId: paused.account_id,
      eventType: 'agency_campaign.auto_paused',
      eventCategory: 'call',
      severity: 'error',
      actor: reason === 'carrier_auth' ? 'system:carrier-auth'
        : reason === 'carrier_refusing_calls' ? 'system:carrier-refusals' : 'system:carrier-account',
      eventData: {
        campaign_id: campaign.id,
        reason,
        telephony_provider: campaign.telephony_provider,
        telephony_credential_id: campaign.telephony_credential_id,
      },
    });
    return true;
  } catch (err) {
    log.error({ err, campaignId: campaign.id, reason }, 'Failed to auto-pause the campaign whose carrier account cannot dial');
    return false;
  }
}
