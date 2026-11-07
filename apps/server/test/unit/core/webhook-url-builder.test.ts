/**
 * WebhookUrlBuilder unit tests: `baseUrl(provider)` returns each carrier's own webhook
 * namespace from env (VoiceLink, Plivo), strips trailing slashes, and THROWS for a
 * provider it cannot name. It used to fall back to the VoiceLink base, so a Plivo dial
 * was handed `…/webhooks/voicelink` and Plivo posted its callbacks to routes that cannot
 * read them. The bridge calls it before the carrier is asked anything, so the throw is a
 * dial never placed.
 */

import { describe, it, expect, vi } from 'vitest';

const { PLIVO_BASE, VOICELINK_BASE } = vi.hoisted(() => ({
  PLIVO_BASE: 'https://example.com/api/v1/webhooks/plivo',
  VOICELINK_BASE: 'https://example.com/api/v1/webhooks/voicelink',
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    telephony: {
      plivo: { webhookBaseUrl: PLIVO_BASE },
      voicelink: { webhookBaseUrl: VOICELINK_BASE },
    },
  },
}));

import { WebhookUrlBuilder, normalizeWebhookBase } from '../../../src/core/webhook-url-builder.js';
import { config } from '../../../src/config/index.js';

describe('WebhookUrlBuilder', () => {
  const builder = new WebhookUrlBuilder();

  describe('baseUrl', () => {
    it('strips trailing slashes, so outbound callbacks are never `//webrtc-status`', () => {
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

    it('returns the voicelink base for voicelink', () => {
      expect(builder.baseUrl('voicelink')).toBe(VOICELINK_BASE);
    });

    it('returns the plivo base for plivo, never the voicelink one', () => {
      expect(builder.baseUrl('plivo')).toBe(PLIVO_BASE);
      expect(builder.baseUrl('plivo')).not.toBe(VOICELINK_BASE);
    });

    it.each(['nexmo', '!@#$%^&*', '', 'Plivo'])('throws for a provider it cannot name (%j), rather than falling back', (p) => {
      expect(() => builder.baseUrl(p)).toThrow(/No webhook base URL/);
    });
  });
});
