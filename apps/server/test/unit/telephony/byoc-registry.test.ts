// The registry's BYOC path (decision B20) and Plivo's credential check: a pinned call
// never falls back to the service's own account, a credential of another provider is
// refused, adapters are rebuilt on rotation, and the carrier check goes only to Plivo's
// fixed host with redirects refused.
import { describe, it, expect, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/index.js';
import {
  TelephonyProviderRegistry, ByocCredentialUnavailableError, type ByocAdapterFactory, type CredentialResolver,
} from '../../../src/telephony/factory.js';
import type { ResolvedCredential } from '../../../src/telephony/credentials/credential-service.js';
import { Secret } from '../../../src/telephony/credentials/secret.js';
import { findCredentialSpec, PLIVO_API_BASE, type FetchLike } from '../../../src/telephony/credentials/credential-specs.js';
import type { TelephonyProvider } from '../../../src/telephony/types.js';

const CONFIG = {
  telephony: {
    requireVoicelink: false,
    voicelink: { baseUrl: 'https://vl.test', username: 'u', password: 'p', webhookBaseUrl: 'https://srv.test/api/v1/webhooks/voicelink', defaultCountryCode: '91' },
  },
} as unknown as AppConfig;

function resolved(over: Partial<ResolvedCredential> = {}): ResolvedCredential {
  return {
    id: 'cred-1', tenantId: 't1', provider: 'plivo', accountRef: 'MA1', publicConfig: {},
    version: 1, secret: new Secret({ auth_token: 'tok' }), previous: [], ...over,
  };
}

function registry(resolver: CredentialResolver | null, factories = new Map<string, ByocAdapterFactory>()) {
  return new TelephonyProviderRegistry(CONFIG, {
    ...(resolver ? { credentials: () => resolver } : {}),
    byocAdapters: factories,
  });
}

const fakeAdapter = (tag: string) => ({ name: 'plivo', tag } as unknown as TelephonyProvider);

describe('TelephonyProviderRegistry.getForCredentialId', () => {
  it('serves the service’s own account for a null credential id', async () => {
    const r = registry(null);
    expect((await r.getForCredentialId('voicelink', null)).name).toBe('voicelink');
  });

  it('never falls back to the service’s account when there is no credential store', async () => {
    await expect(registry(null).getForCredentialId('plivo', 'cred-1')).rejects.toBeInstanceOf(ByocCredentialUnavailableError);
  });

  it('wraps a resolver refusal, and passes the purpose through', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('status disabled'));
    const err = await registry({ resolve }).getForCredentialId('plivo', 'cred-1', 'dial').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ByocCredentialUnavailableError);
    expect((err as Error).message).toMatch(/status disabled/);
    expect(resolve).toHaveBeenCalledWith('cred-1', 'dial');
  });

  it('defaults to call_control, so a disabled credential can still hang up its calls', async () => {
    const resolve = vi.fn().mockResolvedValue(resolved());
    await registry({ resolve }, new Map([['plivo', () => fakeAdapter('a')]])).getForCredentialId('plivo', 'cred-1');
    expect(resolve).toHaveBeenCalledWith('cred-1', 'call_control');
  });

  it('refuses a credential of another provider', async () => {
    const resolve = vi.fn().mockResolvedValue(resolved({ provider: 'twilio' }));
    await expect(registry({ resolve }, new Map([['plivo', () => fakeAdapter('a')]])).getForCredentialId('plivo', 'cred-1'))
      .rejects.toThrow(/credential is for twilio, not plivo/);
  });

  it('refuses a provider with no BYOC adapter', async () => {
    const resolve = vi.fn().mockResolvedValue(resolved());
    await expect(registry({ resolve }).getForCredentialId('plivo', 'cred-1')).rejects.toThrow(/no BYOC adapter/);
  });

  it('builds one adapter per credential version, and a new one after a rotation', async () => {
    let version = 1;
    const resolve = vi.fn(async () => resolved({ version }));
    const factory = vi.fn((c: ResolvedCredential) => fakeAdapter(`v${c.version}`));
    const r = registry({ resolve }, new Map([['plivo', factory]]));
    const a = await r.getForCredentialId('plivo', 'cred-1');
    const b = await r.getForCredentialId('plivo', 'cred-1');
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
    version = 2;
    const c = await r.getForCredentialId('plivo', 'cred-1');
    expect(c).not.toBe(a);
    expect((c as unknown as { tag: string }).tag).toBe('v2');
    // The status is re-read on every call even when the adapter is cached.
    expect(resolve).toHaveBeenCalledTimes(3);
  });
});

describe('Plivo credential check', () => {
  const spec = findCredentialSpec('plivo')!;
  const pub = { auth_id: 'MAABCDEFGHIJKLMNOPQR' };
  const sec = { auth_token: 'tokentokentokentoken' };

  it('asks only Plivo’s fixed host, with Basic auth and redirects refused', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => { calls.push({ url, init }); return { status: 200 }; };
    expect(await spec.check(pub, sec, fetchImpl)).toEqual({ result: 'ok' });
    expect(PLIVO_API_BASE).toBe('https://api.plivo.com');
    expect(calls[0]!.url).toBe('https://api.plivo.com/v1/Account/MAABCDEFGHIJKLMNOPQR/');
    expect(calls[0]!.init.redirect).toBe('error');
    expect(calls[0]!.init.method).toBe('GET');
    const auth = (calls[0]!.init.headers as Record<string, string>)['Authorization']!;
    expect(Buffer.from(auth.replace('Basic ', ''), 'base64').toString()).toBe('MAABCDEFGHIJKLMNOPQR:tokentokentokentoken');
  });

  it.each([
    [401, 'rejected'], [403, 'rejected'], [404, 'rejected'], [429, 'unreachable'], [500, 'unreachable'],
  ])('maps HTTP %i to %s', async (status, result) => {
    expect((await spec.check(pub, sec, async () => ({ status }))).result).toBe(result);
  });

  it('maps a network failure or timeout to unreachable, without the error text', async () => {
    const boom: FetchLike = async () => { throw Object.assign(new Error(`failed ${sec.auth_token}`), { name: 'TypeError' }); };
    const r = await spec.check(pub, sec, boom);
    expect(r.result).toBe('unreachable');
    expect(JSON.stringify(r)).not.toContain(sec.auth_token);
    const timeout: FetchLike = async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
    expect(await spec.check(pub, sec, timeout)).toEqual({ result: 'unreachable', reason: 'Plivo did not answer in time' });
  });

  it('refuses unknown fields in either part', () => {
    expect(spec.publicSchema.safeParse({ ...pub, host: 'evil.test' }).success).toBe(false);
    expect(spec.secretSchema.safeParse({ ...sec, extra: 'x' }).success).toBe(false);
  });
});
