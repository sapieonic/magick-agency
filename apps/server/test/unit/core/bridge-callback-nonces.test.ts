import { describe, it, expect, vi } from 'vitest';

// The bridge's record of signed carrier-callback nonces (`BridgeWsTokens.claimCallbackNonce`):
// one Redis set per call, re-armed on every callback, so a replayed (call, nonce) is refused
// whichever process it reaches; failing OPEN when Redis is absent or errors.

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { BridgeWsTokens, CALLBACK_NONCE_TTL_SECONDS } from '../../../src/core/bridge/ws-tokens.js';
import { WEBHOOK_TOKEN_POST_END_GRACE_SECONDS } from '../../../src/telephony/webhook-grace.js';

function fakeRedis() {
  const sets = new Map<string, Set<string>>();
  const ttls = new Map<string, number>();
  let failing = false;
  return {
    sets, ttls,
    fail(on: boolean) { failing = on; },
    multi() {
      const ops: Array<() => [Error | null, unknown]> = [];
      const chain = {
        sadd(key: string, member: string) {
          ops.push(() => {
            const set = sets.get(key) ?? new Set<string>();
            sets.set(key, set);
            if (set.has(member)) return [null, 0];
            set.add(member);
            return [null, 1];
          });
          return chain;
        },
        expire(key: string, s: number) { ops.push(() => { ttls.set(key, s); return [null, 1]; }); return chain; },
        async exec() { if (failing) throw new Error('redis down'); return ops.map((op) => op()); },
      };
      return chain;
    },
    async srem(key: string, member: string) { if (failing) throw new Error('redis down'); return sets.get(key)?.delete(member) ? 1 : 0; },
  };
}

describe('BridgeWsTokens callback nonces', () => {
  it('true the first time, false for a repeat on the same call; another call or nonce is new', async () => {
    const redis = fakeRedis();
    const tokens = new BridgeWsTokens(redis as any, 'p:');
    expect(await tokens.claimCallbackNonce('call-1', 'n1')).toBe(true);
    expect(await tokens.claimCallbackNonce('call-1', 'n1')).toBe(false);
    expect(await tokens.claimCallbackNonce('call-1', 'n2')).toBe(true);
    expect(await tokens.claimCallbackNonce('call-2', 'n1')).toBe(true);
    expect(redis.sets.get('p:webrtc:callback-nonces:call-1')).toEqual(new Set(['n1', 'n2']));
    // Remembered past the webhook token's own post-end life.
    expect(redis.ttls.get('p:webrtc:callback-nonces:call-1')).toBe(CALLBACK_NONCE_TTL_SECONDS);
    expect(CALLBACK_NONCE_TTL_SECONDS).toBeGreaterThan(WEBHOOK_TOKEN_POST_END_GRACE_SECONDS);
  });

  it('a released nonce may be claimed again (the carrier`s retry of a callback that failed)', async () => {
    const tokens = new BridgeWsTokens(fakeRedis() as any, '');
    expect(await tokens.claimCallbackNonce('call-1', 'n1')).toBe(true);
    await tokens.releaseCallbackNonce('call-1', 'n1');
    expect(await tokens.claimCallbackNonce('call-1', 'n1')).toBe(true);
  });

  it('fails open: no Redis, or Redis erroring, accepts (and a release never throws)', async () => {
    expect(await new BridgeWsTokens(null, '').claimCallbackNonce('call-1', 'n1')).toBe(true);
    const redis = fakeRedis();
    redis.fail(true);
    const tokens = new BridgeWsTokens(redis as any, '');
    expect(await tokens.claimCallbackNonce('call-1', 'n1')).toBe(true);
    expect(await tokens.claimCallbackNonce('call-1', 'n1')).toBe(true);
    await expect(tokens.releaseCallbackNonce('call-1', 'n1')).resolves.toBeUndefined();
  });
});
