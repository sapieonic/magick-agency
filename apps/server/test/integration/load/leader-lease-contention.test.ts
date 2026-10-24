import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { closeTestRedis, flushTestRedis, getTestRedis, TEST_REDIS_URL } from '../../helpers/test-redis.js';
import { createRng, scaled } from '../../helpers/load-scale.js';
import { LEADER_LEASE_MS, LeaderLease } from '../../../src/agency/pacing/leader-lease.js';

/**
 * ─── THE PACING LEADER LEASE UNDER MANY CONTENDERS ─────────────────────────
 *
 * `LeaderLease` is the efficiency mechanism (the contact claim is the
 * correctness one), but its own contract is still exact and still matters: two
 * replicas both believing they lead a campaign means two ticks dialing it, and the
 * header says how that happens — "losing leadership and then re-taking it by blind
 * SET". So the three scripts must hold under contention:
 *
 *   tryAcquire  SET NX PX: of any number of racers on a free key, exactly one wins
 *   renew       extends ONLY the caller's own lease, never re-creates a lapsed one,
 *               and never extends a lease another replica has since taken
 *   release     deletes ONLY the caller's own lease
 *
 * Expiry is simulated, not waited for: the lease is 15s, and the property under
 * test is what the scripts do when the key has gone (or changed hands) between a
 * replica's calls, not how Redis measures 15 seconds. A `PEXPIRE 1` + short sleep
 * (or a DEL) is exactly that event.
 *
 * The "exactly one leader over time" property is checked as the scripts can
 * actually promise it: a replica that is TOLD it leads (`tryAcquire` true,
 * `renew` 'held') must be the value in the key at that moment. A schedule driven
 * one call at a time across real separate connections, by a seeded scheduler with
 * a chaos actor expiring and stealing the key, makes "at that moment" observable:
 * after each call the key is read and compared.
 */

const PREFIX = 'ma-load:leader:';
const keyFor = (campaignId: string) => `${PREFIX}agency:leader:${campaignId}`;

async function expireNow(redis: Redis, key: string): Promise<void> {
  await redis.pexpire(key, 1);
  // A key past its PTTL is gone to every reader (lazy expiry on access), so one
  // millisecond's margin is enough; 3 is generous.
  await new Promise((r) => setTimeout(r, 3));
}

describe('leader lease under contention (integration, real Lua)', () => {
  const REPLICAS = 24;
  let clients: Redis[] = [];
  let leases: LeaderLease[] = [];

  beforeAll(() => {
    clients = Array.from({ length: REPLICAS }, () => new Redis(TEST_REDIS_URL));
    leases = clients.map((c, i) => new LeaderLease(c, PREFIX, `replica-${i}`));
  });
  beforeEach(flushTestRedis);
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit()));
    await closeTestRedis();
  });

  it('a free lease is won by exactly one of many racers, every round, across many campaigns', async () => {
    const CAMPAIGNS = scaled(40);
    const ROUNDS = scaled(25);
    const redis = getTestRedis();

    for (let round = 0; round < ROUNDS; round++) {
      const results = await Promise.all(Array.from({ length: CAMPAIGNS }, (_, c) =>
        Promise.all(leases.map((l) => l.tryAcquire(`camp-${c}`)))));

      for (let c = 0; c < CAMPAIGNS; c++) {
        const winners = results[c]!.flatMap((won, i) => (won ? [i] : []));
        expect(winners, `round ${round} campaign ${c}`).toHaveLength(1);
        expect(await redis.get(keyFor(`camp-${c}`))).toBe(`replica-${winners[0]}`);
        const pttl = await redis.pttl(keyFor(`camp-${c}`));
        expect(pttl).toBeGreaterThan(LEADER_LEASE_MS - 2_000);
        expect(pttl).toBeLessThanOrEqual(LEADER_LEASE_MS);
      }
      // The lease "lapses" for every campaign at once and the floor races again.
      await Promise.all(Array.from({ length: CAMPAIGNS }, (_, c) => redis.del(keyFor(`camp-${c}`))));
    }
  });

  it('renew racing a steal: the stale holder is never told it still leads, and never extends the thief', async () => {
    // The exact sequence the RENEW script exists for: A holds, A's lease lapses
    // (GC pause, partition), B takes it — and A's renew, already in flight,
    // arrives. A blind PEXPIRE would answer 'held' and extend B's lease under A's
    // belief; a blind SET would hand it back to A. Many campaigns at once, each
    // with the stale renew and the new holder's renews racing on separate sockets.
    const CAMPAIGNS = scaled(150);
    const redis = getTestRedis();
    const ids = Array.from({ length: CAMPAIGNS }, (_, c) => `steal-${c}`);

    // replica-0 leads everything, then every lease lapses.
    expect(await Promise.all(ids.map((id) => leases[0]!.tryAcquire(id)))).toEqual(ids.map(() => true));
    await Promise.all(ids.map((id) => expireNow(redis, keyFor(id))));

    // The thieves (one per campaign) and the stale renews are issued together.
    const [stolen, staleRenews] = await Promise.all([
      Promise.all(ids.map((id, c) => leases[1 + (c % (REPLICAS - 1))]!.tryAcquire(id))),
      Promise.all(ids.map((id) => leases[0]!.renew(id))),
    ]);

    for (let c = 0; c < CAMPAIGNS; c++) {
      const holder = await redis.get(keyFor(ids[c]!));
      const thief = `replica-${1 + (c % (REPLICAS - 1))}`;
      // The stale renew never sees 'held' (the key was gone or the thief's), and
      // never resurrected it in its own name.
      expect(staleRenews[c], `campaign ${c}`).toBe('lost');
      expect(stolen[c]).toBe(true);
      expect(holder).toBe(thief);
    }

    // Now the stale holder's renews against a LIVE foreign lease: refused, and the
    // thief's TTL is not touched. Shorten the thief's TTL first so an extension
    // would be visible.
    await Promise.all(ids.map((id) => redis.pexpire(keyFor(id), 4_000)));
    const again = await Promise.all(ids.map((id) => leases[0]!.renew(id)));
    expect(again.every((r) => r === 'lost')).toBe(true);
    const pttls = await Promise.all(ids.map((id) => redis.pttl(keyFor(id))));
    expect(Math.max(...pttls)).toBeLessThanOrEqual(4_000);

    // And its release of a lease it no longer holds deletes nothing.
    await Promise.all(ids.map((id) => leases[0]!.release(id)));
    const holders = await Promise.all(ids.map((id) => redis.get(keyFor(id))));
    holders.forEach((h, c) => expect(h).toBe(`replica-${1 + (c % (REPLICAS - 1))}`));
  });

  it('a seeded schedule with expiry and steals never tells a replica it leads when it does not', async () => {
    // One campaign, every replica running its own pacing-supervisor loop
    // (`tryAcquire` when not leading, `renew` while leading, now and then
    // `release`), interleaved one call at a time by a seeded scheduler, with a
    // chaos actor expiring the key. Each call goes out on that replica's own
    // connection; after it returns, the key is read: any 'held'/true answer must
    // name the caller, and the number of replicas that BELIEVE they lead and are
    // right is never more than one.
    const rng = createRng();
    const STEPS = scaled(3_000);
    const redis = getTestRedis();
    const campaign = 'sched';
    const believes = new Set<number>();
    let leaderships = 0;
    let steals = 0;

    for (let s = 0; s < STEPS; s++) {
      const roll = rng.next();
      if (roll < 0.05) {
        await expireNow(redis, keyFor(campaign));
        continue;
      }
      const r = rng.int(0, REPLICAS - 1);
      const lease = leases[r]!;
      const ctx = `seed=${rng.seed} step=${s} replica-${r}`;

      if (!believes.has(r)) {
        const won = await lease.tryAcquire(campaign);
        const holder = await redis.get(keyFor(campaign));
        if (won) {
          expect(holder, ctx).toBe(`replica-${r}`);
          leaderships++;
          // Anyone else who still believes is now provably stale.
          if ([...believes].some((b) => b !== r)) steals++;
          believes.add(r);
        } else {
          expect(holder, ctx).not.toBe(`replica-${r}`);
        }
      } else if (rng.chance(0.08)) {
        await lease.release(campaign);
        believes.delete(r);
        expect(await redis.get(keyFor(campaign)), ctx).not.toBe(`replica-${r}`);
      } else {
        const res = await lease.renew(campaign);
        const holder = await redis.get(keyFor(campaign));
        if (res === 'held') expect(holder, ctx).toBe(`replica-${r}`);
        else {
          expect(res, ctx).toBe('lost');
          expect(holder, ctx).not.toBe(`replica-${r}`);
          believes.delete(r);
        }
      }

      // Of the replicas that believe they lead, at most one is right.
      const holder = await redis.get(keyFor(campaign));
      const right = [...believes].filter((b) => holder === `replica-${b}`);
      expect(right.length, ctx).toBeLessThanOrEqual(1);
    }

    // The schedule exercised hand-overs, including leaders displaced while still
    // believing (the stale-renew shape), not just one replica renewing forever.
    expect(leaderships).toBeGreaterThan(20);
    expect(steals).toBeGreaterThan(5);
  });

  it('a renew storm from every replica at once extends only the holder, and only while it holds', async () => {
    const CAMPAIGNS = scaled(60);
    const redis = getTestRedis();
    const ids = Array.from({ length: CAMPAIGNS }, (_, c) => `storm-${c}`);
    const holderOf = (c: number) => c % REPLICAS;
    await Promise.all(ids.map((id, c) => leases[holderOf(c)]!.tryAcquire(id)));

    // Every replica renews every campaign concurrently, while a quarter of the
    // campaigns lose their lease mid-storm.
    const doomed = new Set(ids.filter((_, c) => c % 4 === 0));
    const [renewals] = await Promise.all([
      Promise.all(ids.map((id) => Promise.all(leases.map((l) => l.renew(id))))),
      Promise.all([...doomed].map((id) => redis.del(keyFor(id)))),
    ]);

    for (let c = 0; c < CAMPAIGNS; c++) {
      const id = ids[c]!;
      const res = renewals[c]!;
      // Nobody but the holder is ever told 'held'.
      res.forEach((r, i) => { if (i !== holderOf(c)) expect(r, `${id} replica-${i}`).toBe('lost'); });
      const holder = await redis.get(keyFor(id));
      if (doomed.has(id)) {
        // Deleted mid-storm: no renew may have brought it back.
        expect(holder, id).toBeNull();
      } else {
        expect(res[holderOf(c)]).toBe('held');
        expect(holder).toBe(`replica-${holderOf(c)}`);
      }
    }
  });
});
