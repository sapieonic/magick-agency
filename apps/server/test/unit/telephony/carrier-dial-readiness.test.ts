// Whether a carrier can place calls from this server (PL12): a carrier module answers to it
// and its webhook base is configured; never decided by a provider name. And the campaign
// start/resume refusal built on it, for a campaign pinned to a tenant credential only.
import { describe, it, expect, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {
      voicelink: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/voicelink' },
      plivo: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/plivo' },
    },
  },
}));
vi.mock('../../../src/config/index.js', () => cfg);

import { carrierDialReady } from '../../../src/telephony/carrier-dial-readiness.js';
import { carrierNotReadyBlocker } from '../../../src/agency/campaign-dialability.js';

describe('carrierDialReady', () => {
  it('a carrier with a module and a configured webhook base can dial', () => {
    expect(carrierDialReady('plivo')).toBe(true);
    expect(carrierDialReady('voicelink')).toBe(true);
  });

  it('an unset (empty) webhook base cannot; a name no carrier module answers to cannot', () => {
    cfg.config.telephony.plivo.webhookBaseUrl = '';
    try {
      expect(carrierDialReady('plivo')).toBe(false);
      expect(carrierDialReady('voicelink')).toBe(true);
    } finally {
      cfg.config.telephony.plivo.webhookBaseUrl = 'https://server.test/api/v1/webhooks/plivo';
    }
    expect(carrierDialReady('nope')).toBe(false);
  });
});

describe('carrierNotReadyBlocker', () => {
  const pinned = { telephony_provider: 'plivo', telephony_credential_id: 'cred-1' };

  it('refuses a pinned campaign whose carrier cannot dial, with a vendor-free message', () => {
    cfg.config.telephony.plivo.webhookBaseUrl = '';
    try {
      const refusal = carrierNotReadyBlocker(pinned);
      expect(refusal).toMatchObject({ status: 409, code: 'carrier_not_ready' });
      expect(refusal!.message).not.toMatch(/plivo|voicelink|PLIVO_/i);
      // The service's own account is not judged here (its base is required at load).
      expect(carrierNotReadyBlocker({ telephony_provider: 'voicelink', telephony_credential_id: null })).toBeNull();
    } finally {
      cfg.config.telephony.plivo.webhookBaseUrl = 'https://server.test/api/v1/webhooks/plivo';
    }
  });

  it('lets a pinned campaign start when its carrier can dial', () => {
    expect(carrierNotReadyBlocker(pinned)).toBeNull();
  });
});
