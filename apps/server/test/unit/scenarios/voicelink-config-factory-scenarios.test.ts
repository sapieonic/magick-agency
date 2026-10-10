import { describe, it, expect } from 'vitest';
// `telephonySchema` lives in config/blocks/voice.ts (the VoiceLink-only block).
// The raw config carries other providers' keys; the schema strips them, which the
// first case proves harmless.
import { telephonySchema } from '../../../src/config/blocks/voice.js';
import { TelephonyProviderRegistry } from '../../../src/telephony/factory.js';
import { VoicelinkAdapter } from '../../../src/telephony/voicelink/voicelink.adapter.js';
import type { AppConfig } from '../../../src/config/index.js';

// ═══════════════════════════════════════════════════════════════════════════
// End-to-end wiring scenario: a raw config object → real `telephonySchema`
// parse → `TelephonyProviderRegistry` → `get('voicelink')` → a working
// VoicelinkAdapter. Proves the whole config path (defaults, superRefine, factory
// switch, adapter construction) hangs together for the provider. Mirrors the
// z99 config→factory→adapter scenario.
// ═══════════════════════════════════════════════════════════════════════════

function rawTelephonyConfig(overrides: Record<string, unknown> = {}) {
  return {
    defaultProvider: 'voicelink',
    enabledProviders: [],
    plivo: { authId: 'P', authToken: 'P', webhookBaseUrl: 'https://e.com/p', defaultCallerId: '+1' },
    twilio: {},
    exotel: {},
    sip: {},
    vobiz: { authId: 'V', authToken: 'V', webhookBaseUrl: 'https://e.com/v', defaultCallerId: '+91' },
    telnyx: {},
    z99: {},
    voicelink: {
      baseUrl: 'https://app.voicelink.co.in/api',
      username: 'vl-user',
      password: 'vl-pass',
      webhookBaseUrl: 'https://example.com/api/v1/webhooks/voicelink',
    },
    ...overrides,
  };
}

/** Parse the raw config through the real schema, then wrap as an AppConfig the registry can read. */
function parseToAppConfig(overrides: Record<string, unknown> = {}): AppConfig {
  const parsed = telephonySchema.parse(rawTelephonyConfig(overrides));
  return { telephony: parsed } as unknown as AppConfig;
}

describe('VoiceLink config → factory → adapter wiring', () => {
  it('parses a valid voicelink block, then resolves a VoicelinkAdapter from the registry', () => {
    const config = parseToAppConfig();
    const registry = new TelephonyProviderRegistry(config);
    const provider = registry.get('voicelink');
    expect(provider).toBeInstanceOf(VoicelinkAdapter);
    expect(provider.name).toBe('voicelink');
  });

  it('returns the VoicelinkAdapter as the default when defaultProvider is voicelink', () => {
    const registry = new TelephonyProviderRegistry(parseToAppConfig());
    expect(registry.getDefault()).toBeInstanceOf(VoicelinkAdapter);
    expect(registry.getDefault().name).toBe('voicelink');
  });

  it('caches the voicelink instance across repeated lookups', () => {
    const registry = new TelephonyProviderRegistry(parseToAppConfig());
    const a = registry.get('voicelink');
    const b = registry.get('voicelink');
    expect(a).toBe(b);
  });

  it('still throws for an unknown provider after voicelink is wired in', () => {
    const registry = new TelephonyProviderRegistry(parseToAppConfig());
    expect(() => registry.get('not-a-provider')).toThrow(/Unknown telephony provider/);
  });

  it('the wired adapter exposes its stub-final XML/WS behavior', async () => {
    const provider = new TelephonyProviderRegistry(parseToAppConfig()).get('voicelink');
    expect(provider.name).toBe('voicelink');
    // VoiceLink has no answer XML — final empty string from day one.
    expect(provider.generateAnswerResponse('call-1', 'wss://host/api/v1/media-stream/call-1')).toBe('');
    // Audio is A-law (pcma) mono at 8 kHz, bidirectional WS.
    const cfg = await provider.getMediaStreamConfig('call-1');
    expect(cfg).toEqual({ type: 'websocket', codec: 'pcma', sampleRate: 8000, direction: 'both' });
  });
});
