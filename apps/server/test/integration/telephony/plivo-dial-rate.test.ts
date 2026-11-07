import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { RedisPlivoDialRateLimiter, acquirePlivoDialSlot } from '../../../src/telephony/plivo/plivo-dial-rate.js';

/**
 * The Plivo calls-per-second gate's Lua script against REAL Redis (6383, a non-zero db):
 * a sliding 1000 ms window per account, one ZSET of admission times shared by every
 * process, that expires once the account is idle. The clocks are injected, so nothing
 * here waits on wall time except the TTL check.
 */

const PREFIX = 'ma-test:dial-rate:';

describe('RedisPlivoDialRateLimiter on real Redis', () => {
  beforeEach(async () => {
    await flushTestRedis();
  });

  afterAll(async () => {
    await closeTestRedis();
  });

  it('admits no more than perSecond dials in any 1000 ms span', async () => {
    let t = 999; const rate = new RedisPlivoDialRateLimiter(getTestRedis(), PREFIX, () => t); const admittedAt: number[] = [];
    for (const at of [999, 999, 1000, 1000]) { t = at; if ((await rate.tryAcquire('MA1', 2)).admitted) admittedAt.push(at); }
    expect(admittedAt.length).toBeLessThanOrEqual(2);
  });

  it('two processes on one account share the window; another account has its own', async () => {
    let t = 50_000;
    const a = new RedisPlivoDialRateLimiter(getTestRedis(), PREFIX, () => t);
    const b = new RedisPlivoDialRateLimiter(getTestRedis(), PREFIX, () => t);
    expect(await a.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await b.tryAcquire('MA1', 2)).toEqual({ admitted: true }); // same millisecond: its own member
    expect(await a.tryAcquire('MA1', 2)).toEqual({ admitted: false, retryAfterMs: 1000 });
    expect(await b.tryAcquire('MA2', 2)).toEqual({ admitted: true });
    t += 600;
    expect(await b.tryAcquire('MA1', 2)).toEqual({ admitted: false, retryAfterMs: 400 });
    t += 400;
    expect(await b.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await a.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await a.tryAcquire('MA1', 2)).toEqual({ admitted: false, retryAfterMs: 1000 });
  });

  it('frees slots one at a time, as each admission ages out, and a refusal records nothing', async () => {
    let t = 100;
    const rate = new RedisPlivoDialRateLimiter(getTestRedis(), PREFIX, () => t);
    await rate.tryAcquire('MA1', 2);
    t = 400; await rate.tryAcquire('MA1', 2);
    t = 600;
    for (let i = 0; i < 5; i++) expect(await rate.tryAcquire('MA1', 2)).toEqual({ admitted: false, retryAfterMs: 500 });
    t = 1100;
    expect(await rate.tryAcquire('MA1', 2)).toEqual({ admitted: true });
    expect(await rate.tryAcquire('MA1', 2)).toEqual({ admitted: false, retryAfterMs: 300 });
    expect(await getTestRedis().zcard(`${PREFIX}plivo:dial_rate:MA1`)).toBe(2);
  });

  it('a wait returns as soon as the oldest admission ages out', async () => {
    let t = 0;
    const rate = new RedisPlivoDialRateLimiter(getTestRedis(), PREFIX, () => t);
    const sleeps: number[] = [];
    const opts = { perSecond: 2, maxWaitMs: 5000, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } };
    await rate.tryAcquire('MA1', 2);
    t = 300; await rate.tryAcquire('MA1', 2);
    t = 500;
    expect(await acquirePlivoDialSlot(rate, 'MA1', opts)).toEqual({ admitted: true, waitedMs: 500 });
    expect(sleeps).toEqual([500]);
  });

  it('an idle account leaves nothing behind: the key expires a window after its newest admission', async () => {
    const redis = getTestRedis();
    const rate = new RedisPlivoDialRateLimiter(redis, PREFIX);
    expect((await rate.tryAcquire('MA-idle', 2)).admitted).toBe(true);
    const ttl = await redis.pttl(`${PREFIX}plivo:dial_rate:MA-idle`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1000);
    await new Promise((r) => setTimeout(r, 1100));
    expect(await redis.exists(`${PREFIX}plivo:dial_rate:MA-idle`)).toBe(0);
  });
});
