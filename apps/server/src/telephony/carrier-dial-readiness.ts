// Whether a carrier can place calls from this server at all (PL12), decided from the
// carrier module registry and the carrier's env settings, never by a provider name.
//
// A carrier can dial when a carrier module answers to it and its webhook namespace is
// configured: the bridge hands every dial callback URLs under that base, and with none it
// refuses every dial before the carrier is asked (`carrier_dial_not_sent`,
// `webrtc-bridge-manager.ts` step 5b). The service's own carrier has its base required at
// load in production; a tenant-account carrier's base is optional (`PLIVO_WEBHOOK_BASE_URL`),
// so while it is unset its accounts are not offered to campaigns and a campaign pinned to
// one is not started.
import { WebhookUrlBuilder } from '../core/webhook-url-builder.js';
import { findCarrierModule } from './carrier-modules.js';

const webhookUrls = new WebhookUrlBuilder();

/** True when `provider` has a carrier module and a configured webhook base. Never throws. */
export function carrierDialReady(provider: string): boolean {
  if (!findCarrierModule(provider)) return false;
  try {
    const base = webhookUrls.baseUrl(provider);
    return typeof base === 'string' && base !== '';
  } catch {
    return false;
  }
}
