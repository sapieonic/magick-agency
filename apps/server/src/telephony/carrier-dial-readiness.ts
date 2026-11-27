// Whether a carrier can place calls from this server at all (PL12), decided from the
// carrier module registry and the carrier's env settings, never by a provider name.
//
// A carrier can dial when a carrier module answers to it and its webhook namespace is
// configured: the bridge hands every dial callback URLs under that base, and with none it
// refuses every dial before the carrier is asked (`carrier_dial_not_sent`,
// `webrtc-bridge-manager.ts` step 5b). The service's own carrier has its base required at
// load in production; a tenant-account carrier's base is optional (`PLIVO_WEBHOOK_BASE_URL`),
// so while it is unset its accounts are not offered to campaigns and a campaign pinned to
// one is not started. A tenant account may need more of this server's env than the webhook
// base (VoiceLink: its API host, CR2); the carrier says so in its catalogue entry
// (`tenantAccountsReady`).
import { config } from '../config/index.js';
import { WebhookUrlBuilder } from '../core/webhook-url-builder.js';
import { findCarrier } from './carrier-catalog.js';
import { findCarrierModule } from './carrier-modules.js';

const webhookUrls = new WebhookUrlBuilder();

/**
 * True when `provider` can place calls from this server on the given account mode: a carrier
 * module answers to it, its webhook base is configured, and, for a tenant account, whatever
 * else the carrier declares it needs (`CarrierDescriptor.tenantAccountsReady`). Never throws.
 */
export function carrierDialReady(provider: string, account: 'service' | 'tenant'): boolean {
  if (!findCarrierModule(provider)) return false;
  try {
    const base = webhookUrls.baseUrl(provider);
    if (typeof base !== 'string' || base === '') return false;
    if (account === 'tenant') {
      const ready = findCarrier(provider)?.tenantAccountsReady;
      if (ready && !ready(config.telephony)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
