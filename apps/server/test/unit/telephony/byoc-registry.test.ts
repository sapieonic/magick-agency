// The registry's BYOC path (decision B20) and Plivo's credential check: a pinned call
// never falls back to the service's own account, a credential of another provider or
// tenant is refused, adapters are cached per purpose and rebuilt when the versions they
// hold change, and the carrier check goes only to Plivo's fixed host with redirects refused.
import { describe, it, expect, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/index.js';
import {
  TelephonyProviderRegistry, ByocCredentialUnavailableError, type ByocAdapterFactory, type CredentialResolver,
} from '../../../src/telephony/factory.js';
import {
  CredentialUnavailableError, type ResolvedCredential, type ResolvePurpose,
} from '../../../src/telephony/credentials/credential-service.js';
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

/**
 * A credential service whose `peek` and `resolve` agree on one state, as the real one
 * does: `peek` lists the versions `resolve` would open. `state` may throw.
 */
function creds(state: (purpose: ResolvePurpose) => ResolvedCredential, opts: { peekVersions?: (r: ResolvedCredential) => number[] } = {}) {
  const versions = opts.peekVersions ?? ((r: ResolvedCredential) => [r.version, ...r.previous.map((p) => p.version)]);
  return {
    peek: vi.fn(async (_id: string, purpose: ResolvePurpose) => {
      const r = state(purpose);
      return { id: r.id, tenantId: r.tenantId, provider: r.provider, version: r.version, versions: versions(r) };
    }),
    resolve: vi.fn(async (_id: string, purpose: ResolvePurpose) => state(purpose)),
  };
}

const unavailable = (reason: string) => new CredentialUnavailableError('cred-1', 'status', reason);

describe('TelephonyProviderRegistry.getForCredentialId', () => {
  it('serves the service’s own account for a null credential id', async () => {
    const r = registry(null);
    expect((await r.getForCredentialId('voicelink', null, 'call_control', 't1')).name).toBe('voicelink');
  });

  it('never falls back to the service’s account when there is no credential store', async () => {
    await expect(registry(null).getForCredentialId('plivo', 'cred-1', 'call_control', 't1')).rejects.toBeInstanceOf(ByocCredentialUnavailableError);
  });

  it('wraps a credential refusal, and passes the purpose through', async () => {
    const c = creds(() => { throw unavailable('status disabled'); });
    const err = await registry(c, new Map([['plivo', () => fakeAdapter('a')]])).getForCredentialId('plivo', 'cred-1', 'dial', 't1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ByocCredentialUnavailableError);
    expect((err as Error).message).toMatch(/status disabled/);
    expect(c.peek).toHaveBeenCalledWith('cred-1', 'dial');
    expect(c.resolve).not.toHaveBeenCalled();
  });

  it('refuses a credential of another tenant without opening its secret', async () => {
    const c = creds(() => resolved({ tenantId: 't2' }));
    const factory = vi.fn(() => fakeAdapter('a'));
    await expect(registry(c, new Map([['plivo', factory]])).getForCredentialId('plivo', 'cred-1', 'dial', 't1'))
      .rejects.toThrow(/another tenant/);
    expect(c.resolve).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('refuses a credential of another provider without opening its secret', async () => {
    const c = creds(() => resolved({ provider: 'twilio' }));
    await expect(registry(c, new Map([['plivo', () => fakeAdapter('a')]])).getForCredentialId('plivo', 'cred-1', 'call_control', 't1'))
      .rejects.toThrow(/credential is for twilio, not plivo/);
    expect(c.resolve).not.toHaveBeenCalled();
  });

  it('refuses a provider with no BYOC adapter without opening its secret', async () => {
    const c = creds(() => resolved());
    await expect(registry(c).getForCredentialId('plivo', 'cred-1', 'call_control', 't1')).rejects.toThrow(/no BYOC adapter/);
    expect(c.resolve).not.toHaveBeenCalled();
  });

  it('refuses a credential whose tenant changed between the peek and the open', async () => {
    let tenantId = 't1';
    const c = creds(() => resolved({ tenantId }));
    c.peek.mockImplementationOnce(async () => {
      const p = { id: 'cred-1', tenantId, provider: 'plivo', version: 1, versions: [1] };
      tenantId = 't2';
      return p;
    });
    const factory = vi.fn(() => fakeAdapter('a'));
    await expect(registry(c, new Map([['plivo', factory]])).getForCredentialId('plivo', 'cred-1', 'dial', 't1'))
      .rejects.toThrow(/changed while it was resolved/);
    expect(factory).not.toHaveBeenCalled();
  });

  it('builds one adapter per credential version, opens secrets only on a miss, and rebuilds after a rotation', async () => {
    let version = 1;
    const c = creds(() => resolved({ version }));
    const factory = vi.fn((cr: ResolvedCredential) => fakeAdapter(`v${cr.version}`));
    const r = registry(c, new Map([['plivo', factory]]));
    const a = await r.getForCredentialId('plivo', 'cred-1', 'call_control', 't1');
    const b = await r.getForCredentialId('plivo', 'cred-1', 'call_control', 't1');
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
    // The hit re-read the row (peek) and opened nothing.
    expect(c.resolve).toHaveBeenCalledTimes(1);
    version = 2;
    const d = await r.getForCredentialId('plivo', 'cred-1', 'call_control', 't1');
    expect(d).not.toBe(a);
    expect((d as unknown as { tag: string }).tag).toBe('v2');
    // The status is re-read on every call even when the adapter is cached.
    expect(c.peek).toHaveBeenCalledTimes(3);
    expect(c.resolve).toHaveBeenCalledTimes(2);
  });

  it('keeps hitting the cache when a grace version is listed but skipped as unopenable', async () => {
    // peek lists v1 (still inside the grace); resolve skipped it because it would not open.
    const c = creds(() => resolved({ version: 2, previous: [] }), { peekVersions: () => [2, 1] });
    const factory = vi.fn(() => fakeAdapter('a'));
    const r = registry(c, new Map([['plivo', factory]]));
    const a = await r.getForCredentialId('plivo', 'cred-1', 'call_control', 't1');
    expect(await r.getForCredentialId('plivo', 'cred-1', 'call_control', 't1')).toBe(a);
    expect(c.resolve).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('caches per purpose: a dial adapter never stands in for call control', async () => {
    // resolve() fills `previous` (the rotation-grace secrets) only for call_control.
    const c = creds((purpose) => resolved({
      version: 2, previous: purpose === 'call_control' ? [{ version: 1, secret: new Secret({ auth_token: 'old' }) }] : [],
    }));
    const factory = vi.fn((cr: ResolvedCredential) => fakeAdapter(`prev:${cr.previous.length}`));
    const r = registry(c, new Map([['plivo', factory]]));
    await r.getForCredentialId('plivo', 'cred-1', 'dial', 't1');
    const control = await r.getForCredentialId('plivo', 'cred-1', 'call_control', 't1');
    expect((control as unknown as { tag: string }).tag).toBe('prev:1');
  });

  it('rebuilds when a grace version is pruned, so a pruned secret stops verifying', async () => {
    let previous = [{ version: 1, secret: new Secret({ auth_token: 'old' }) }];
    const c = creds(() => resolved({ version: 2, previous }));
    const factory = vi.fn((cr: ResolvedCredential) => fakeAdapter(`prev:${cr.previous.length}`));
    const r = registry(c, new Map([['plivo', factory]]));
    expect((await r.getForCredentialId('plivo', 'cred-1', 'call_control', 't1') as unknown as { tag: string }).tag).toBe('prev:1');
    previous = [];
    expect((await r.getForCredentialId('plivo', 'cred-1', 'call_control', 't1') as unknown as { tag: string }).tag).toBe('prev:0');
  });

  it.each(['peek', 'resolve'] as const)('drops every cached adapter of a credential that stops resolving (refused by %s)', async (which) => {
    let version = 1;
    const c = creds(() => resolved({ version }));
    const factory = vi.fn(() => fakeAdapter('a'));
    const r = registry(c, new Map([['plivo', factory]]));
    await r.getForCredentialId('plivo', 'cred-1', 'call_control', 't1');
    // A refusal from resolve is reached only on a miss, so move the version first.
    if (which === 'resolve') version = 2;
    c[which].mockRejectedValueOnce(unavailable('revoked'));
    await expect(r.getForCredentialId('plivo', 'cred-1', 'call_control', 't1')).rejects.toThrow(ByocCredentialUnavailableError);
    version = 1;
    await r.getForCredentialId('plivo', 'cred-1', 'call_control', 't1');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it.each(['peek', 'resolve'] as const)('rethrows a transient %s failure unchanged and keeps the cache', async (which) => {
    let version = 1;
    const c = creds(() => resolved({ version }));
    const factory = vi.fn(() => fakeAdapter('a'));
    const r = registry(c, new Map([['plivo', factory]]));
    const a = await r.getForCredentialId('plivo', 'cred-1', 'call_control', 't1');
    const pgDown = Object.assign(new Error('Connection terminated due to connection timeout'), { code: 'ETIMEDOUT' });
    if (which === 'resolve') version = 2;
    c[which].mockRejectedValueOnce(pgDown);
    const err = await r.getForCredentialId('plivo', 'cred-1', 'call_control', 't1').catch((e: unknown) => e);
    expect(err).toBe(pgDown);
    expect(err).not.toBeInstanceOf(ByocCredentialUnavailableError);
    version = 1;
    expect(await r.getForCredentialId('plivo', 'cred-1', 'call_control', 't1')).toBe(a);
    expect(factory).toHaveBeenCalledTimes(1);
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
