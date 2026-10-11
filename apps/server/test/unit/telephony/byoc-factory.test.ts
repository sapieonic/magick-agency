// The registry's platform path and its fail-closed pinned-credential branch, on a
// registry built without a credential store. The cases run on `voicelink`, and the
// `config` fixture is VoiceLink-only. The credential-store path (tenant credentials,
// decision B20) is covered in `byoc-registry.test.ts`.
import { describe, it, expect, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/index.js';

vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  TelephonyProviderRegistry,
  buildProviderConfig,
  ByocCredentialUnavailableError,
} from '../../../src/telephony/factory.js';

const config = {
  telephony: {
    voicelink: { baseUrl: '', username: '', password: '', webhookBaseUrl: '', defaultCountryCode: '91' },
  },
} as unknown as AppConfig;

describe('buildProviderConfig — platform sources are byte-for-byte today behaviour', () => {
  it('returns the env block unchanged for every provider', () => {
    expect(buildProviderConfig('voicelink', config)).toBe(config.telephony.voicelink);
  });

  it('throws on an unknown provider name', () => {
    expect(() => buildProviderConfig('carrier_pigeon', config))
      .toThrow(/Unknown telephony provider/);
  });
});

describe('TelephonyProviderRegistry — get(name) is unchanged', () => {
  it('stays synchronous and memoises per provider name', () => {
    const registry = new TelephonyProviderRegistry(config);
    const a = registry.get('voicelink');
    const b = registry.get('voicelink');
    expect(a).toBe(b);
    expect(a.name).toBe('voicelink');
  });

  it('getDefault resolves the configured default provider', () => {
    const registry = new TelephonyProviderRegistry(config);
    expect(registry.getDefault()).toBe(registry.get('voicelink'));
  });

  it('still throws on an unknown provider', () => {
    const registry = new TelephonyProviderRegistry(config);
    expect(() => registry.get('carrier_pigeon')).toThrow(/Unknown telephony provider/);
  });
});

describe('TelephonyProviderRegistry — pinned-credential resolution', () => {
  it('a null pinned id resolves to the platform adapter (every pre-feature call)', async () => {
    const registry = new TelephonyProviderRegistry(config);

    expect(await registry.getForCredentialId('voicelink', null, 'call_control', 't1')).toBe(registry.get('voicelink'));
  });

  it('THROWS for a pinned id when the module is unconfigured on this replica', async () => {
    const registry = new TelephonyProviderRegistry(config);
    await expect(registry.getForCredentialId('voicelink', 'cred-1', 'call_control', 't1'))
      .rejects.toThrow(ByocCredentialUnavailableError);
  });
});
