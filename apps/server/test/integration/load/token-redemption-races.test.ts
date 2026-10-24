import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { closeTestRedis, flushTestRedis, getTestRedis, TEST_REDIS_URL } from '../../helpers/test-redis.js';
import { createRng, scaled } from '../../helpers/load-scale.js';
import { StationTokenStore } from '../../../src/agency/station-token.js';
import { BridgeWsTokens } from '../../../src/core/bridge/ws-tokens.js';

/**
 * ─── SINGLE-USE AND PURPOSE-BOUND TOKENS UNDER RACING REDEMPTIONS ──────────
 *
 * Two credential stores sit on the agent media path:
 *
 *  - `StationTokenStore` — the token that authenticates a station socket
 *    UPGRADE. Single-use is its whole security model (a URL carrying it may be
 *    replayed), and the header names the race it is built for: "two upgrades
 *    racing the same stolen URL would both pass a read-then-delete check". So the
 *    claim is exactly-one-wins under any number of concurrent redemptions, on
 *    separate connections, across a floor of sessions at once — and that a
 *    re-mint retires the previous token whatever order the mint and a redemption
 *    of the old one land in.
 *  - `BridgeWsTokens` — the carrier's media-socket and webhook credentials. NOT
 *    single-use (every webhook post re-verifies), so the contention claims are
 *    different: concurrent verification of the right token always passes, a
 *    wrong one never does, the two purposes never cross, and teardown racing
 *    verification can only ever cut the media token, never leave a cleared token
 *    verifiable afterwards.
 */

const PREFIX = 'ma-load:tokens:';

describe('token redemption under contention (integration, real Redis)', () => {
  const CLIENTS = 16;
  let clients: Redis[] = [];
  let stores: StationTokenStore[] = [];

  beforeAll(() => {
    clients = Array.from({ length: CLIENTS }, () => new Redis(TEST_REDIS_URL));
    stores = clients.map((c) => new StationTokenStore(c, PREFIX));
  });
  beforeEach(flushTestRedis);
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit()));
    await closeTestRedis();
  });

  it('a station token redeemed by many racing upgrades is accepted exactly once, for every session on the floor', async () => {
    const SESSIONS = scaled(200);
    const RACERS = 8;
    const minted = await Promise.all(Array.from({ length: SESSIONS }, (_, s) => stores[s % CLIENTS]!.mint(`sess-${s}`)));

    const results = await Promise.all(minted.map(({ token }, s) => Promise.all(
      Array.from({ length: RACERS }, (_, r) => stores[(s + r) % CLIENTS]!.verifyAndConsume(`sess-${s}`, token)),
    )));

    results.forEach((res, s) => {
      expect(res.filter(Boolean), `session ${s}: ${JSON.stringify(res)}`).toHaveLength(1);
    });
    // Consumed means gone: nothing is left to replay.
    expect(await getTestRedis().keys(`${PREFIX}agency:station-token:*`)).toHaveLength(0);
  });

  it('a wrong or cross-session token never wins, and never burns the real one', async () => {
    const SESSIONS = scaled(150);
    const minted = await Promise.all(Array.from({ length: SESSIONS }, (_, s) => stores[0]!.mint(`x-${s}`)));

    // Forged guesses and other sessions' REAL tokens, all racing at once.
    const forged = await Promise.all(minted.flatMap(({ token }, s) => [
      stores[s % CLIENTS]!.verifyAndConsume(`x-${s}`, `${token}-forged`),
      stores[(s + 1) % CLIENTS]!.verifyAndConsume(`x-${s}`, minted[(s + 1) % SESSIONS]!.token),
      stores[(s + 2) % CLIENTS]!.verifyAndConsume(`x-${s}`, ''),
      stores[(s + 3) % CLIENTS]!.verifyAndConsume(`x-${s}`, undefined),
    ]));
    expect(forged.some(Boolean)).toBe(false);

    // The genuine token survived every failed attempt and is still single-use.
    const genuine = await Promise.all(minted.map(({ token }, s) => Promise.all([
      stores[s % CLIENTS]!.verifyAndConsume(`x-${s}`, token),
      stores[(s + 5) % CLIENTS]!.verifyAndConsume(`x-${s}`, token),
    ])));
    genuine.forEach((pair) => expect(pair.filter(Boolean)).toHaveLength(1));
  });

  it('re-mint racing a redemption of the old token: the old one wins at most once, and the new one exactly once', async () => {
    // A console reconnecting (re-mint over HTTP) while a replayed URL carrying the
    // previous token races its upgrade. Whatever the order, the old token may be
    // spent at most once (only if it landed before the re-mint), and the new one —
    // the one the console actually holds — is good for exactly one upgrade.
    const rng = createRng();
    const SESSIONS = scaled(200);
    const first = await Promise.all(Array.from({ length: SESSIONS }, (_, s) => stores[0]!.mint(`re-${s}`)));

    let oldWins = 0;
    const rounds = await Promise.all(first.map(async ({ token: oldToken }, s) => {
      const order = rng.chance(0.5);
      const racers = Array.from({ length: 4 }, (_, r) => stores[(s + r) % CLIENTS]!.verifyAndConsume(`re-${s}`, oldToken));
      const remint = stores[(s + 7) % CLIENTS]!.mint(`re-${s}`);
      const [oldResults, fresh] = order
        ? [await Promise.all(racers), await remint]
        : await Promise.all([Promise.all(racers), remint]);
      return { oldResults, fresh };
    }));

    for (let s = 0; s < SESSIONS; s++) {
      const { oldResults, fresh } = rounds[s]!;
      const wins = oldResults.filter(Boolean).length;
      expect(wins, `session ${s}`).toBeLessThanOrEqual(1);
      oldWins += wins;
      // The new token can only have been consumed by someone holding it — nobody
      // has yet — unless an old-token racer landed AFTER the re-mint, which would
      // mean the old token verified against the new value: impossible by value.
      const newResults = await Promise.all(Array.from({ length: 4 }, (_, r) =>
        stores[(s + r + 3) % CLIENTS]!.verifyAndConsume(`re-${s}`, fresh.token)));
      expect(newResults.filter(Boolean), `session ${s} new token`).toHaveLength(1);
    }
    // Both orders occurred: some old tokens were spent before their re-mint.
    expect(oldWins).toBeGreaterThan(0);
  });

  it('carrier ws tokens: concurrent verification is stable, purposes never cross, wrong tokens never pass', async () => {
    const CALLS = scaled(150);
    const bridges = clients.map((c) => new BridgeWsTokens(c, PREFIX));
    const tokens = Array.from({ length: CALLS }, (_, i) => ({
      provider: `prov-${i}-${'a'.repeat(20)}`,
      webhook: `hook-${i}-${'b'.repeat(20)}`,
    }));
    await Promise.all(tokens.flatMap((t, i) => [
      bridges[i % CLIENTS]!.storeWsToken(`call-${i}`, t.provider, 600, 'provider'),
      bridges[(i + 1) % CLIENTS]!.storeWsToken(`call-${i}`, t.webhook, 600, 'webhook'),
    ]));

    const checks = await Promise.all(tokens.map((t, i) => Promise.all([
      // The carrier's legitimate posts, many at once: all accepted, none consumed.
      ...Array.from({ length: 5 }, (_, r) => bridges[(i + r) % CLIENTS]!.verifyWsToken(`call-${i}`, t.webhook, 'webhook')),
      ...Array.from({ length: 3 }, (_, r) => bridges[(i + r) % CLIENTS]!.verifyWsToken(`call-${i}`, t.provider, 'provider')),
      // Cross-purpose, cross-call and forged: never.
      bridges[i % CLIENTS]!.verifyWsToken(`call-${i}`, t.provider, 'webhook'),
      bridges[i % CLIENTS]!.verifyWsToken(`call-${i}`, t.webhook, 'provider'),
      bridges[i % CLIENTS]!.verifyWsToken(`call-${(i + 1) % CALLS}`, t.webhook, 'webhook'),
      bridges[i % CLIENTS]!.verifyWsToken(`call-${i}`, `${t.webhook.slice(0, -1)}x`, 'webhook'),
      bridges[i % CLIENTS]!.verifyWsToken(`call-${i}`, undefined, 'webhook'),
    ])));
    checks.forEach((res, i) => {
      expect(res.slice(0, 8), `call ${i} legitimate`).toEqual(Array(8).fill(true));
      expect(res.slice(8), `call ${i} illegitimate`).toEqual(Array(5).fill(false));
    });
  });

  it('carrier ws tokens: teardown racing verification never leaves the media token verifiable afterwards', async () => {
    const CALLS = scaled(150);
    const bridges = clients.map((c) => new BridgeWsTokens(c, PREFIX));
    await Promise.all(Array.from({ length: CALLS }, (_, i) => Promise.all([
      bridges[0]!.storeWsToken(`end-${i}`, `p-${i}`, 600, 'provider'),
      bridges[0]!.storeWsToken(`end-${i}`, `w-${i}`, 600, 'webhook'),
    ])));

    // Teardown and a burst of verifications of both purposes, all at once.
    await Promise.all(Array.from({ length: CALLS }, (_, i) => Promise.all([
      bridges[i % CLIENTS]!.clearWsToken(`end-${i}`),
      ...Array.from({ length: 4 }, (_, r) => bridges[(i + r + 1) % CLIENTS]!.verifyWsToken(`end-${i}`, `p-${i}`, 'provider')),
      ...Array.from({ length: 4 }, (_, r) => bridges[(i + r + 1) % CLIENTS]!.verifyWsToken(`end-${i}`, `w-${i}`, 'webhook')),
    ])));

    // Once teardown has landed: the media leg's token is dead, the webhook token
    // survives for the carrier's late terminal post (with its grace TTL, not the
    // call's), on every connection.
    const after = await Promise.all(Array.from({ length: CALLS }, (_, i) => Promise.all([
      bridges[(i + 3) % CLIENTS]!.verifyWsToken(`end-${i}`, `p-${i}`, 'provider'),
      bridges[(i + 4) % CLIENTS]!.verifyWsToken(`end-${i}`, `w-${i}`, 'webhook'),
    ])));
    after.forEach(([provider, webhook], i) => {
      expect(provider, `call ${i} provider token outlived teardown`).toBe(false);
      expect(webhook, `call ${i} webhook token lost at teardown`).toBe(true);
    });
  });
});
