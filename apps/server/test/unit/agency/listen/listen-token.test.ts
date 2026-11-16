import { describe, expect, it, vi } from 'vitest';
import {
  ListenTokenStore,
  ListenTokenUnavailableError,
  parseListenGrantPayload,
  type ListenGrantPayload,
} from '../../../../src/agency/listen/listen-token.js';

/*
 * The listener socket's single-use token (docs/listening.md §4, LS7), modelled on the station's:
 * one upgrade, a short life, keyed by the listen id, fail closed both ways. The Lua script itself
 * runs against real Redis in `test/integration/agency/live-listen-e2e.test.ts`; here a double with
 * its semantics (match the token prefix, delete, answer the payload).
 */

const L = '22222222-2222-4222-8222-222222222222';
const GRANT: ListenGrantPayload = {
  listenId: L, sessionId: '11111111-1111-4111-8111-111111111111', tenantId: '33333333-3333-4333-8333-333333333333',
  accountId: '44444444-4444-4444-8444-444444444444', callId: '55555555-5555-4555-8555-555555555555', origin: 'manual',
  campaignId: null, correlationId: '77777777-7777-4777-8777-777777777777', agentUserId: '88888888-8888-4888-8888-888888888888',
  listenerUserId: '99999999-9999-4999-8999-999999999999', recording: false, revocationGen: 3,
};

function fakeRedis() {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    set: vi.fn(async (k: string, v: string, _px: string, ttl: number) => { store.set(k, { value: v, ttl }); return 'OK'; }),
    eval: vi.fn(async (_script: string, _n: number, key: string, token: string) => {
      const stored = store.get(key)?.value;
      if (stored === undefined || !stored.startsWith(`${token}|`)) return null;
      store.delete(key);
      return stored.slice(token.length + 1);
    }),
  };
}

describe('ListenTokenStore', () => {
  it('a grant is spent exactly once, by its own listen id, and carries its payload back', async () => {
    const redis = fakeRedis();
    const tokens = new ListenTokenStore(redis as never, 'p:', 60_000);
    const { token, expiresAt } = await tokens.mint(GRANT);
    expect(redis.set).toHaveBeenCalledWith(`p:agency:listen-token:${L}`, expect.any(String), 'PX', 60_000);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    expect(await tokens.consume('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', token)).toBeNull();
    expect(await tokens.consume(L, token)).toEqual(GRANT);
    expect(await tokens.consume(L, token)).toBeNull();
  });

  it('refuses a missing or wrong token, and one carrying the separator', async () => {
    const tokens = new ListenTokenStore(fakeRedis() as never, '', 60_000);
    await tokens.mint(GRANT);
    expect(await tokens.consume(L, undefined)).toBeNull();
    expect(await tokens.consume(L, 'wrong')).toBeNull();
    expect(await tokens.consume(L, '')).toBeNull();
    expect(await tokens.consume(L, 'a|b')).toBeNull();
  });

  it('a stored value that is not a grant is no grant (fail closed)', async () => {
    const redis = fakeRedis();
    const tokens = new ListenTokenStore(redis as never, '', 60_000);
    redis.store.set(`agency:listen-token:${L}`, { value: 'tok|{"listenId":"x"}', ttl: 1 });
    expect(await tokens.consume(L, 'tok')).toBeNull();
    redis.store.set(`agency:listen-token:${L}`, { value: 'tok|not json', ttl: 1 });
    expect(await tokens.consume(L, 'tok')).toBeNull();
    // A well-formed grant for ANOTHER listen stored under this key is still refused.
    redis.store.set(`agency:listen-token:${L}`, { value: `tok|${JSON.stringify({ ...GRANT, listenId: GRANT.sessionId })}`, ttl: 1 });
    expect(await tokens.consume(L, 'tok')).toBeNull();
  });

  it('fails closed both ways when Redis errors: no grant handed out, no upgrade accepted, and the upgrade told it is the store (QA-L3)', async () => {
    const redis = fakeRedis();
    redis.set.mockRejectedValueOnce(new Error('READONLY'));
    const tokens = new ListenTokenStore(redis as never, '', 60_000);
    await expect(tokens.mint(GRANT)).rejects.toBeInstanceOf(ListenTokenUnavailableError);
    // Not null (a token that does not verify: re-mint, 4401) but the store's error: the socket
    // refuses it `listen_unavailable` (1011), as the grant does.
    redis.eval.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(tokens.consume(L, 'anything')).rejects.toBeInstanceOf(ListenTokenUnavailableError);
  });

  it('without Redis the in-process store is single-use and expires', async () => {
    vi.useFakeTimers();
    try {
      const tokens = new ListenTokenStore(null, '', 5_000);
      const first = await tokens.mint(GRANT);
      expect(await tokens.consume(L, 'wrong')).toBeNull();
      // Single-use whatever the outcome: the wrong try spent it.
      expect(await tokens.consume(L, first.token)).toBeNull();
      const second = await tokens.mint(GRANT);
      vi.advanceTimersByTime(5_001);
      expect(await tokens.consume(L, second.token)).toBeNull();
      const third = await tokens.mint(GRANT);
      expect(await tokens.consume(L, third.token)).toEqual(GRANT);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('parseListenGrantPayload', () => {
  it('accepts a grant and refuses each malformed field', () => {
    expect(parseListenGrantPayload(GRANT)).toEqual(GRANT);
    expect(parseListenGrantPayload({ ...GRANT, campaignId: '66666666-6666-4666-8666-666666666666' })).not.toBeNull();
    for (const bad of [
      { ...GRANT, origin: 'pstn' }, { ...GRANT, recording: 'yes' }, { ...GRANT, callId: 'c1' }, { ...GRANT, revocationGen: -1 }, { ...GRANT, revocationGen: 1.5 }, { ...GRANT, revocationGen: undefined },
      { ...GRANT, campaignId: 'x' }, { ...GRANT, listenerUserId: undefined }, null, [], 'grant',
    ]) expect(parseListenGrantPayload(bad)).toBeNull();
  });
});
