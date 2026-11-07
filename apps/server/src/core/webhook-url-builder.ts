// Each carrier's webhook namespace comes from env (`config.telephony.<provider>`), never
// from tenant data. A provider with no namespace here throws: a carrier handed another
// carrier's callback base would post its callbacks to routes that cannot read them.
import { config } from '../config/index.js';
import { normalizeWebhookBase } from '../utils/webhook-base.js';

export { normalizeWebhookBase };

/**
 * Builds the provider webhook base URL the WebRTC bridge hands to telephony
 * adapters when placing outbound calls. Pure and stateless — every value
 * derives from `config.telephony`. Kept in its own class so the per-provider
 * URL-shape knowledge lives in one testable place.
 */
export class WebhookUrlBuilder {
  /**
   * Base URL for a provider's webhook namespace, e.g.
   * `https://host/api/v1/webhooks/plivo`.
   *
   * An unknown provider throws rather than falling back to another carrier's base: the
   * base decides where the carrier POSTs the callbacks that drive the whole call state
   * machine, and another carrier's routes would refuse or misread every one of them. The
   * bridge calls this before the carrier is asked anything, so the throw is a dial that
   * was never placed.
   *
   * Trailing slashes are stripped: every caller appends `/<route>/…` (the
   * status callback, the WebRTC status hop), and a base written `…/voicelink/`
   * would otherwise 404 them all.
   */
  baseUrl(providerName: string): string {
    const raw = this.rawBaseUrl(providerName);
    // The schema defaults every base to '', but hand-built config fixtures may
    // leave one undefined — pass that through unchanged.
    return typeof raw === 'string' ? normalizeWebhookBase(raw) : raw;
  }

  private rawBaseUrl(providerName: string): string {
    switch (providerName) {
      case 'voicelink':
        return config.telephony.voicelink.webhookBaseUrl;
      case 'plivo':
        return config.telephony.plivo.webhookBaseUrl;
      default:
        throw new Error(`No webhook base URL for telephony provider: ${providerName}`);
    }
  }
}
