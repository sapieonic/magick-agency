// PORT NOTE (magick-agency): ported from core src/core/webhook-url-builder.ts@4850d1d9.
// Modified: only `config.telephony.voicelink` exists here, so `rawBaseUrl` keeps the
// `voicelink` case and an unknown provider falls back to the VoiceLink base (core
// fell back to VoBiz, which agency does not carry). Deleted `providerWebhookBase`
// and `outboundUrls`, whose only callers are the AI/static/IVR/escalation paths.
// The trailing-slash normalisation and the `normalizeWebhookBase` re-export are
// unchanged.
import { config } from '../config/index.js';
import { normalizeWebhookBase } from '../utils/webhook-base.js';

export { normalizeWebhookBase };

/**
 * Builds the provider-specific webhook URLs CallManager hands to telephony
 * adapters when placing outbound calls. Pure and stateless — every value
 * derives from `config.telephony`. Extracted from CallManager so the
 * per-provider URL-shape knowledge (answer/status callbacks, Exotel's external
 * flow URL, the `webhookBaseUrl` fallback) lives in one testable place.
 */
export class WebhookUrlBuilder {
  /**
   * Base URL for a provider's webhook namespace.
   *
   * An unknown provider falls back to VoiceLink's base — the only carrier this
   * service runs on. (Core falls back to VoBiz for the same reason: the fallback
   * decides where the carrier POSTs the status callbacks that drive the whole
   * call state machine, so it should point at the carrier the platform actually
   * runs on.)
   *
   * Note this is best-effort by construction: a provider we cannot name is a
   * provider whose webhook shape we also do not know, so the fallback only ever
   * buys a well-formed URL, never a working callback.
   *
   * Trailing slashes are stripped: every caller appends `/<route>/…` (the
   * status callback, the WebRTC status hop), and a base written `…/voicelink/`
   * would otherwise 404 them all.
   */
  baseUrl(providerName: string): string {
    const raw = this.rawBaseUrl(providerName);
    // The schema defaults every base to '', but hand-built config fixtures may
    // leave one undefined — pass that through exactly as before.
    return typeof raw === 'string' ? normalizeWebhookBase(raw) : raw;
  }

  private rawBaseUrl(providerName: string): string {
    switch (providerName) {
      case 'voicelink':
        return config.telephony.voicelink.webhookBaseUrl;
      default:
        return config.telephony.voicelink.webhookBaseUrl;
    }
  }
}
