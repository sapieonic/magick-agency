import { carrierDialReady } from '../telephony/carrier-dial-readiness.js';

/** A start or resume refused because the campaign's carrier cannot dial from this server. */
export interface CampaignCarrierNotReady {
  status: 409;
  code: 'carrier_not_ready';
  message: string;
}

/**
 * Why a campaign pinned to a tenant carrier account may not start or resume now: its
 * carrier cannot place calls from this server (`carrierDialReady`, PL12: its webhook base is
 * not configured), so every dial would be refused before the carrier. Null when it may, or
 * when the campaign dials on the service's own account (whose base is required at load).
 * Vendor-free: it reaches the console.
 */
export function campaignCarrierNotReady(
  campaign: { telephony_provider: string; telephony_credential_id: string | null },
): CampaignCarrierNotReady | null {
  if (!campaign.telephony_credential_id || carrierDialReady(campaign.telephony_provider)) return null;
  return {
    status: 409,
    code: 'carrier_not_ready',
    message: 'This campaign’s carrier account cannot place calls yet: the platform is not set up to receive its call updates. Ask your platform administrator to finish setting it up, or move the campaign to another carrier account.',
  };
}
