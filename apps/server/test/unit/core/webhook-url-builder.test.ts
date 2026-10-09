/**
 * WebhookUrlBuilder unit tests.
 *
 * Exhaustively covers the three public methods of the pure, stateless
 * `WebhookUrlBuilder` class extracted from CallManager:
 *  - baseUrl(provider)            — known providers + unknown → VOBIZ fallback,
 *                                    case-sensitivity.
 *  - providerWebhookBase(provider)— known provider base; unknown → '' (it does
 *                                    NOT share baseUrl's carrier fallback);
 *                                    configured provider missing
 *                                    webhookBaseUrl → ''.
 *  - outboundUrls(provider, id)   — answer/status shape for every provider;
 *                                    Exotel's flowUrl + path-less status; verbatim
 *                                    callId interpolation (no encoding).
 *
 * PORT NOTE (magick-agency): ported from core test/unit/core/webhook-url-builder.test.ts@4850d1d9.
 * Only `baseUrl` survives (VoiceLink-only builder), and its unknown-provider
 * fallback is the VoiceLink base, not VoBiz. The config mock is verbatim: the
 * other providers' bases stay in it so the fallback assertions can prove the
 * builder never reads them. Deleted and modified cases are listed in PORTING.md (Lane C).
 *
 * Mocking pattern: vi.hoisted + vi.mock with ESM .js imports — matches
 * test/unit/core/runPostCallAnalysis.test.ts. Distinct, recognizable base URLs
 * per provider let us assert the correct one was chosen.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Config (distinct base URLs per provider; telnyx added; exotel has both
//    webhookBaseUrl and flowUrl) ───────────────────────────────────────────
const { PLIVO_BASE, TWILIO_BASE, EXOTEL_BASE, EXOTEL_FLOW, VOBIZ_BASE, TELNYX_BASE, Z99_BASE, VOICELINK_BASE } = vi.hoisted(() => ({
  PLIVO_BASE: 'https://example.com/api/v1/webhooks/plivo',
  TWILIO_BASE: 'https://example.com/api/v1/webhooks/twilio',
  EXOTEL_BASE: 'https://example.com/api/v1/webhooks/exotel',
  EXOTEL_FLOW: 'https://my.exotel.com/v1/Accounts/xyz/Flows/123',
  VOBIZ_BASE: 'https://example.com/api/v1/webhooks/vobiz',
  TELNYX_BASE: 'https://example.com/api/v1/webhooks/telnyx',
  Z99_BASE: 'https://example.com/api/v1/webhooks/z99',
  VOICELINK_BASE: 'https://example.com/api/v1/webhooks/voicelink',
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    telephony: {
      defaultProvider: 'plivo',
      plivo: { webhookBaseUrl: PLIVO_BASE },
      twilio: { webhookBaseUrl: TWILIO_BASE },
      exotel: { webhookBaseUrl: EXOTEL_BASE, flowUrl: EXOTEL_FLOW },
      vobiz: { webhookBaseUrl: VOBIZ_BASE },
      telnyx: { webhookBaseUrl: TELNYX_BASE },
      z99: { webhookBaseUrl: Z99_BASE },
      voicelink: { webhookBaseUrl: VOICELINK_BASE },
      // A provider key present in config but WITHOUT a webhookBaseUrl — used to
      // assert providerWebhookBase returns '' for it.
      sip: {},
      // A base written with trailing slashes — providerWebhookBase strips them.
      slashed: { webhookBaseUrl: 'https://example.com/api/v1/webhooks/slashed//' },
    },
  },
}));

import { WebhookUrlBuilder, normalizeWebhookBase } from '../../../src/core/webhook-url-builder.js';
import { config } from '../../../src/config/index.js';

describe('WebhookUrlBuilder', () => {
  const builder = new WebhookUrlBuilder();

  // ── baseUrl ──────────────────────────────────────────────────────────────
  describe('baseUrl', () => {
    it('strips trailing slashes like providerWebhookBase (review round 2), so outbound callbacks are never `//answer`', () => {
      const tel = (config.telephony as unknown as { voicelink: { webhookBaseUrl: string } }).voicelink;
      const saved = tel.webhookBaseUrl;
      tel.webhookBaseUrl = `${VOICELINK_BASE}//`;
      try {
        expect(builder.baseUrl('voicelink')).toBe(VOICELINK_BASE);
      } finally {
        tel.webhookBaseUrl = saved;
      }
    });

    it('re-exports the one import-free normalizeWebhookBase', () => {
      expect(normalizeWebhookBase('https://h/x///')).toBe('https://h/x');
      expect(normalizeWebhookBase('/')).toBe('');
    });

    it('returns voicelink base for voicelink (guards against the silent default fallback)', () => {
      // baseUrl() defaults unknown providers to VoBiz, which would silently
      // mis-route VoiceLink webhook/WS URLs to the wrong host. Pin the explicit case.
      expect(builder.baseUrl('voicelink')).toBe(VOICELINK_BASE);
      expect(builder.baseUrl('voicelink')).not.toBe(VOBIZ_BASE);
    });

    // The unknown-provider fallback is VOBIZ, not Plivo. Plivo was the fallback
    // only because it was the historical `TELEPHONY_PROVIDER` default; both moved
    // together. This branch decides where a carrier POSTs the answer and status
    // callbacks that drive the whole call state machine, so it must point at the
    // carrier the platform actually runs on rather than at the least-exercised
    // adapter. (Best-effort by construction either way: a provider we cannot name
    // is one whose webhook shape we also do not know, so the fallback buys a
    // well-formed URL, never a working callback.)
    // PORT NOTE (magick-agency): here the carrier the platform runs on is
    // VoiceLink, so the fallback is the VoiceLink base (and never VoBiz's).
    it('falls back to the voicelink base for an unknown provider', () => {
      expect(builder.baseUrl('nexmo')).toBe(VOICELINK_BASE);
      expect(builder.baseUrl('nexmo')).not.toBe(VOBIZ_BASE);
    });

    it('falls back to the voicelink base for garbage input', () => {
      expect(builder.baseUrl('!@#$%^&*')).toBe(VOICELINK_BASE);
    });

    it('falls back to the voicelink base for an empty string', () => {
      expect(builder.baseUrl('')).toBe(VOICELINK_BASE);
    });
  });
});
