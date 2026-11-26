import { describe, expect, it } from 'vitest';

/**
 * VoiceLink's tenant credential spec (docs/carriers.md CR2, CR3): the form's fields and their
 * schemas, the login check over a fetch double (this deployment's host only, redirects refused,
 * bounded, every answer mapped), and the service's own username reserved.
 */

import { accountRefReserved, findCredentialSpec, type FetchLike } from '../../../../src/telephony/credentials/credential-specs.js';
import { TELEPHONY_ACCOUNT_REF_MAX_LENGTH } from '../../../../src/telephony/credentials/account-ref.js';
import { VOICELINK_CHECK_TIMEOUT_MS, voicelinkSpec } from '../../../../src/telephony/voicelink/voicelink.credential-spec.js';
import type { TelephonyConfig } from '../../../../src/telephony/carrier-catalog.js';

const BASE = 'https://vl-api.test/api';
const telephony = (over: Record<string, string> = {}) =>
  ({ voicelink: { baseUrl: BASE, username: 'service-user', password: 'service-secret', ...over } }) as unknown as TelephonyConfig;
const pub = { username: 'tenant-user' };
const sec = { password: ' secret with spaces ' };

function recorder(answer: (url: string, init: RequestInit) => Awaited<ReturnType<FetchLike>> | Promise<never>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  return { calls, fetchImpl };
}

const answered = (status: number, body: unknown = {}) => ({ status, json: async () => body });

describe('the VoiceLink credential spec: fields and schemas', () => {
  it('is listed, with the username public and the password secret', () => {
    expect(findCredentialSpec('voicelink')).toBe(voicelinkSpec);
    expect(voicelinkSpec.fields.map((f) => [f.key, f.secret])).toEqual([['username', false], ['password', true]]);
    expect(voicelinkSpec.fields.find((f) => f.key === 'username')!.label).toBe('Username');
    for (const f of voicelinkSpec.fields) expect(f.help?.length ?? 0).toBeGreaterThan(10);
  });

  it('trims the username; it is the account ref, and the password is the hint source', () => {
    const parsed = voicelinkSpec.publicSchema.parse({ username: '  tenant-user\t' });
    expect(parsed).toEqual({ username: 'tenant-user' });
    expect(voicelinkSpec.accountRef(parsed)).toBe('tenant-user');
    expect(voicelinkSpec.hintSource({ password: 'abcd1234' })).toBe('abcd1234');
  });

  it.each([
    ['empty', ''], ['blank', '   '], ['over 100 (the account_ref column)', 'u'.repeat(101)], ['over 100 once lower-cased', 'İ'.repeat(51)], ['a NUL', 'a\u0000b'], ['a newline inside', 'a\nb'],
    ['DEL', 'a\u007fb'], ['a C1 control', 'a\u0085b'],
  ])('refuses a username that is %s', (_l, username) => {
    expect(voicelinkSpec.publicSchema.safeParse({ username }).success).toBe(false);
  });

  it('takes a username of exactly 100 characters, the width of telephony_credentials.account_ref', () => {
    expect(TELEPHONY_ACCOUNT_REF_MAX_LENGTH).toBe(100);
    const parsed = voicelinkSpec.publicSchema.parse({ username: 'U'.repeat(100) });
    expect(voicelinkSpec.accountRef(parsed)).toHaveLength(100);
  });

  it('the account ref is the username lower-cased; public_config keeps the case typed', () => {
    const parsed = voicelinkSpec.publicSchema.parse({ username: ' Acme-Calls ' });
    expect(parsed).toEqual({ username: 'Acme-Calls' });
    expect(voicelinkSpec.accountRef(parsed)).toBe('acme-calls');
    expect(voicelinkSpec.accountRef({ username: 'ACME-CALLS' })).toBe(voicelinkSpec.accountRef(parsed));
  });

  it('keeps a password exactly as typed (spaces included), 1 to 255 characters, never blank', () => {
    expect(voicelinkSpec.secretSchema.parse({ password: ' p a s s ' })).toEqual({ password: ' p a s s ' });
    expect(voicelinkSpec.secretSchema.safeParse({ password: 'p'.repeat(255) }).success).toBe(true);
    for (const password of ['', '    ', 'p'.repeat(256)]) {
      expect(voicelinkSpec.secretSchema.safeParse({ password }).success, JSON.stringify(password)).toBe(false);
    }
  });

  it('refuses unknown fields in either part (no host of the tenant`s can ride in)', () => {
    expect(voicelinkSpec.publicSchema.safeParse({ ...pub, base_url: 'https://evil.test' }).success).toBe(false);
    expect(voicelinkSpec.secretSchema.safeParse({ ...sec, token: 'x' }).success).toBe(false);
  });
});

describe('the VoiceLink credential check (CR3)', () => {
  it('logs in on this deployment`s host only, JSON body, redirects refused, bounded', async () => {
    const { calls, fetchImpl } = recorder(() => answered(200, { data: { access_token: '9|tok' } }));
    expect(await voicelinkSpec.check(pub, sec, { fetch: fetchImpl, telephony: telephony() })).toEqual({ result: 'ok' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/v1/auth/login`);
    expect(calls[0]!.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ username: 'tenant-user', password: ' secret with spaces ' });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(VOICELINK_CHECK_TIMEOUT_MS).toBe(10_000);
  });

  it('logs in with the username as typed, never the lower-cased account ref', async () => {
    const { calls, fetchImpl } = recorder(() => answered(200, { data: { access_token: '9|tok' } }));
    await voicelinkSpec.check({ username: 'Acme-Calls' }, sec, { fetch: fetchImpl, telephony: telephony() });
    expect(JSON.parse(calls[0]!.init.body as string).username).toBe('Acme-Calls');
  });

  it.each<[string, number, unknown, string]>([
    ['401', 401, {}, 'rejected'],
    ['403', 403, {}, 'rejected'],
    ['422', 422, { errors: {} }, 'rejected'],
    ['404', 404, {}, 'unreachable'],
    ['429', 429, {}, 'unreachable'],
    ['500', 500, {}, 'unreachable'],
    ['a redirect answered as such', 302, {}, 'unreachable'],
    ['2xx with no token', 200, { data: {} }, 'unreachable'],
    ['2xx with an empty token', 200, { data: { access_token: '' } }, 'unreachable'],
    ['2xx with a token that is not a string', 200, { data: { access_token: 42 } }, 'unreachable'],
    ['2xx with a null body', 200, null, 'unreachable'],
    ['201 with a token', 201, { data: { access_token: 't' } }, 'ok'],
  ])('maps %s to %s', async (_l, status, body, result) => {
    const { fetchImpl } = recorder(() => answered(status, body));
    const r = await voicelinkSpec.check(pub, sec, { fetch: fetchImpl, telephony: telephony() });
    expect(r.result).toBe(result);
    if (r.result === 'rejected') expect(r.reason).toBe(`VoiceLink refused the login (HTTP ${status})`);
  });

  it('a 2xx with no readable body is unreachable', async () => {
    const { fetchImpl } = recorder(() => ({ status: 200 }));
    expect(await voicelinkSpec.check(pub, sec, { fetch: fetchImpl, telephony: telephony() }))
      .toEqual({ result: 'unreachable', reason: 'VoiceLink sent an unreadable answer' });
    const bad = recorder(() => ({ status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
    expect(await voicelinkSpec.check(pub, sec, { fetch: bad.fetchImpl, telephony: telephony() }))
      .toEqual({ result: 'unreachable', reason: 'VoiceLink sent an unreadable answer' });
  });

  it('a refused redirect, a network error or a timeout is unreachable, never echoing the error`s text', async () => {
    const redirect = recorder(() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: new Error(`redirect ${sec.password}`) })));
    const r = await voicelinkSpec.check(pub, sec, { fetch: redirect.fetchImpl, telephony: telephony() });
    expect(r).toEqual({ result: 'unreachable', reason: 'VoiceLink could not be reached' });
    expect(JSON.stringify(r)).not.toContain('secret with spaces');
    const timeout = recorder(() => Promise.reject(Object.assign(new Error('t'), { name: 'TimeoutError' })));
    expect(await voicelinkSpec.check(pub, sec, { fetch: timeout.fetchImpl, telephony: telephony() }))
      .toEqual({ result: 'unreachable', reason: 'VoiceLink did not answer in time' });
  });

  it('with no VOICELINK_BASE_URL (or no carrier env at all), sends nothing and is unreachable', async () => {
    for (const ctx of [{ telephony: telephony({ baseUrl: '' }) }, { telephony: telephony({ baseUrl: '   ' }) }, {}]) {
      const { calls, fetchImpl } = recorder(() => answered(200, { data: { access_token: 't' } }));
      const r = await voicelinkSpec.check(pub, sec, { ...ctx, fetch: fetchImpl });
      expect(r.result).toBe('unreachable');
      expect(calls).toEqual([]);
    }
  });
});

describe('the service`s own VoiceLink login is reserved (CR3)', () => {
  it('reserves VOICELINK_USERNAME when set, case-insensitively and trimmed; nothing when unset', () => {
    expect(voicelinkSpec.reservedAccountRefs!(telephony())).toEqual(['service-user']);
    expect(voicelinkSpec.reservedAccountRefs!(telephony({ username: '' }))).toEqual([]);
    expect(voicelinkSpec.reservedAccountRefs!(telephony({ username: '  ' }))).toEqual([]);
    expect(accountRefReserved(voicelinkSpec, ' SERVICE-user ', telephony())).toBe(true);
    expect(accountRefReserved(voicelinkSpec, 'tenant-user', telephony())).toBe(false);
    expect(accountRefReserved(voicelinkSpec, 'service-user', undefined)).toBe(false);
  });
});
