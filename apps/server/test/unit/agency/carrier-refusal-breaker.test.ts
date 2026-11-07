import { describe, it, expect, vi } from 'vitest';

// The refusal breaker's count (PL11): in Redis per campaign with a TTL, cleared by a placed
// call and by tripping, and counted in this process while Redis errors, so a Redis fault never
// fails a dial and a refusal streak still trips.

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/config/index.js', () => ({ config: { redis: { keyPrefix: '' }, telephony: {} } }));

import { CarrierRefusalBreaker, countsTowardBreaker } from '../../../src/agency/carrier-refusal-breaker.js';
import { WebRtcCallError } from '../../../src/core/webrtc-bridge-manager.js';
import { CarrierDialNotSentError, CarrierRequestTimeoutError } from '../../../src/telephony/carrier-errors.js';

/** Enough of ioredis for the breaker: MULTI INCR/EXPIRE/EXEC and DEL, with TTLs recorded. */
function fakeRedis() {
  const values = new Map<string, number>();
  const ttls = new Map<string, number>();
  let failing = false;
  const redis = {
    values, ttls,
    fail(on: boolean) { failing = on; },
    multi() {
      const ops: Array<() => [Error | null, unknown]> = [];
      const chain = {
        incr(key: string) { ops.push(() => { const v = (values.get(key) ?? 0) + 1; values.set(key, v); return [null, v]; }); return chain; },
        expire(key: string, s: number) { ops.push(() => { ttls.set(key, s); return [null, 1]; }); return chain; },
        async exec() { if (failing) throw new Error('redis down'); return ops.map((op) => op()); },
      };
      return chain;
    },
    async del(key: string) { if (failing) throw new Error('redis down'); values.delete(key); ttls.delete(key); return 1; },
  };
  return redis;
}

describe('CarrierRefusalBreaker', () => {
  it('trips on the threshold-th refusal in a row, under a TTL’d per-campaign key, and clears it', async () => {
    const redis = fakeRedis();
    const b = new CarrierRefusalBreaker(redis as any, 'p:', { threshold: 3, ttlSeconds: 900 });
    expect(await b.noteRefusal('c1')).toBe(false);
    expect(await b.noteRefusal('c1')).toBe(false);
    expect(redis.values.get('p:agency:carrier-refusals:c1')).toBe(2);
    expect(redis.ttls.get('p:agency:carrier-refusals:c1')).toBe(900);
    expect(await b.noteRefusal('c2')).toBe(false);
    expect(await b.noteRefusal('c1')).toBe(true);
    expect(redis.values.has('p:agency:carrier-refusals:c1')).toBe(false);
    expect(redis.values.get('p:agency:carrier-refusals:c2')).toBe(1);
  });

  it('a placed call clears the streak', async () => {
    const redis = fakeRedis();
    const b = new CarrierRefusalBreaker(redis as any, '', { threshold: 2 });
    expect(await b.noteRefusal('c1')).toBe(false);
    await b.notePlaced('c1');
    expect(await b.noteRefusal('c1')).toBe(false);
  });

  it('counts in this process while Redis errors, and never throws', async () => {
    const redis = fakeRedis();
    redis.fail(true);
    const b = new CarrierRefusalBreaker(redis as any, '', { threshold: 2 });
    expect(await b.noteRefusal('c1')).toBe(false);
    expect(await b.noteRefusal('c1')).toBe(true);
    await expect(b.notePlaced('c1')).resolves.toBeUndefined();
  });

  it('the in-process count lapses with the TTL', async () => {
    let now = 0;
    const b = new CarrierRefusalBreaker(null, '', { threshold: 2, ttlSeconds: 60, now: () => now });
    expect(await b.noteRefusal('c1')).toBe(false);
    now = 61_000;
    expect(await b.noteRefusal('c1')).toBe(false);
    now = 62_000;
    expect(await b.noteRefusal('c1')).toBe(true);
  });
});

describe('countsTowardBreaker', () => {
  const wrap = (code: any, cause: unknown) => Object.assign(new WebRtcCallError('x', code, 502), { cause });
  it.each([
    ['a carrier refusal', wrap('telephony_init_failed', new Error('Plivo create call error 403')), true],
    ['a dial not sent for configuration', wrap('carrier_dial_not_sent', new CarrierDialNotSentError('plivo', 'configuration', 'x')), true],
    ['an unknown outcome', wrap('telephony_init_failed', new CarrierRequestTimeoutError('op', 1, true)), false],
    ['a dial not sent for its number', wrap('carrier_dial_not_sent', new CarrierDialNotSentError('plivo', 'destination', 'x')), false],
    ['a dial not sent for the network', wrap('carrier_dial_not_sent', new CarrierDialNotSentError('plivo', 'network', 'x')), false],
    ['a 401', wrap('carrier_auth_rejected', new Error('401')), false],
    ['a rate limit', wrap('carrier_rate_limited', new Error('429')), false],
    ['a plain error', new Error('boom'), false],
  ])('%s → %s', (_what, err, want) => {
    expect(countsTowardBreaker(err)).toBe(want);
  });
});
