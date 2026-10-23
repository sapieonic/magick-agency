import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { closePool, initDbPool } from '@magick-agency/db';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { providerConcurrencyRepository } from '@magick-agency/db/repositories/provider-concurrency.repository';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { uuidFor } from '../../../../../packages/db/test/integration/setup/factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis, TEST_REDIS_URL } from '../../helpers/test-redis.js';
import { createRng, scaled, type Rng } from '../../helpers/load-scale.js';
import { ConcurrencyGuard } from '../../../src/core/concurrency-guard.js';
import { AccountConcurrencyGuard } from '../../../src/core/account-concurrency-guard.js';
import { ProviderConcurrencyGuard } from '../../../src/core/provider-concurrency-guard.js';
import { releaseTelephonyLease } from '../../../src/core/telephony-release.js';

/**
 * ─── THE TELEPHONY CONCURRENCY GUARDS UNDER A STORM ─────────────────────────
 *
 * The three guards (global, account, provider — and the provider guard's
 * all-three-scopes composite) are the only thing between a full floor of agents
 * and the carrier's channel limit. Each is a counter + per-call lock keys + a
 * generation key, mutated only by Lua, and healed by a generation-fenced reconcile.
 * The existing suites prove each refusal and each release one call at a time;
 * this one hammers them from many actors at once, each on its OWN Redis
 * connection and its own guard instance (so the server really interleaves the
 * scripts), and asserts what has to hold at every instant:
 *
 *  - **never over cap.** An actor records a call as held only AFTER its acquire
 *    resolves (Redis counted it before replying) and forgets it BEFORE issuing the
 *    release (Redis still counts it until the release runs). So the set of calls
 *    the test believes held is always a subset of what Redis holds, and its size
 *    exceeding the cap is proof of over-admission — checked after every admission.
 *  - **no leaked slots.** After the storm, with every call released (some of them
 *    two and three times, from different connections at once), every counter is
 *    exactly the number of its live locks, which is zero.
 *  - **reconcile is safe mid-traffic.** A reconciler loop runs throughout. Its
 *    generation fence is what stops a stale lock count from being written over a
 *    concurrent acquire; without it the counter can end below the live locks and
 *    the next storm over-admits.
 *
 * Sizes are seeded and `LOAD_SCALE`-able; nothing asserts on speed.
 */

const PREFIX = 'ma-load:guards:';
const TIMEOUT_S = 60;
const TENANT = uuidFor('load-guards-tenant');

/** Yield a random number of macrotask turns, so holds overlap unpredictably. */
async function jitter(rng: Rng, max = 3): Promise<void> {
  const n = rng.int(0, max);
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

async function countKeys(pattern: string): Promise<number> {
  const redis = getTestRedis();
  let cursor = '0';
  let n = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    n += keys.length;
  } while (cursor !== '0');
  return n;
}

async function readInt(key: string): Promise<number> {
  return Number.parseInt((await getTestRedis().get(key)) ?? '0', 10);
}

const GLOBAL = `${PREFIX}active_calls`;
const accountCounter = (accountId: string) => `${PREFIX}active_calls:account:${TENANT}:${accountId}`;
const providerCounter = (accountId: string, provider: string) =>
  `${PREFIX}active_calls:provider:${TENANT}:${accountId}:${provider}`;

async function seedLegacy(accountId: string, max: number): Promise<void> {
  await getTestPool().query(
    `INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls, concurrency_allocation_mode)
     VALUES ($1, $2, $3, 'legacy_total')
     ON CONFLICT (tenant_id, account_id) DO UPDATE SET max_concurrent_calls = EXCLUDED.max_concurrent_calls`,
    [TENANT, accountId, max],
  );
}

describe('telephony concurrency guards under a storm (integration, real Redis + Postgres)', () => {
  const ACTORS = 32;
  let clients: Redis[] = [];

  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 8 });
    clients = Array.from({ length: ACTORS }, () => new Redis(TEST_REDIS_URL));
  });
  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit()));
    await closePool();
    await closeTestPool();
    await closeTestRedis();
  });

  it('global guard: never over cap, double releases free one slot, reconcile mid-storm leaks nothing', async () => {
    const CAP = 12;
    const ITERATIONS = scaled(120);
    const guards = clients.map((c) => new ConcurrencyGuard(c, PREFIX, CAP, TIMEOUT_S));
    const held = new Set<string>();
    let admitted = 0;
    let refused = 0;
    let maxHeld = 0;
    let stop = false;

    // A reconciler on its own connection, the self-heal sweep's shape, throughout.
    const reconciler = (async () => {
      const g = new ConcurrencyGuard(getTestRedis(), PREFIX, CAP, TIMEOUT_S);
      let passes = 0;
      while (!stop) {
        await g.reconcile();
        passes++;
        await new Promise((r) => setImmediate(r));
      }
      return passes;
    })();
    // A sampler: the counter itself is never observed over the cap either.
    const sampler = (async () => {
      let worst = 0;
      while (!stop) {
        worst = Math.max(worst, await readInt(GLOBAL));
        await new Promise((r) => setImmediate(r));
      }
      return worst;
    })();

    // The background loops stop whatever happens: a red actor must not leave them
    // running into the next test's keyspace.
    const actors = Promise.all(guards.map(async (guard, a) => {
      const rng = createRng(createRng().seed + a);
      for (let i = 0; i < ITERATIONS; i++) {
        const callId = `g-${a}-${i}`;
        if (!(await guard.tryAcquire(callId))) {
          refused++;
          await jitter(rng);
          continue;
        }
        admitted++;
        held.add(callId);
        maxHeld = Math.max(maxHeld, held.size);
        expect(held.size, `over-admission: ${held.size} held against a cap of ${CAP}`).toBeLessThanOrEqual(CAP);
        // A retried acquire of a held call is idempotent, not a second slot.
        if (rng.chance(0.1)) expect(await guard.tryAcquire(callId)).toBe(true);
        await jitter(rng);
        held.delete(callId);
        // Duplicate teardowns (a late webhook, a reaper) from other connections at once.
        const releasers = rng.chance(0.3) ? 3 : 1;
        await Promise.all(Array.from({ length: releasers }, (_, k) =>
          guards[(a + k) % ACTORS]!.release(callId)));
      }
    }));
    try { await actors; } finally { stop = true; }
    const [passes, worstObserved] = await Promise.all([reconciler, sampler]);

    expect(worstObserved).toBeLessThanOrEqual(CAP);
    expect(await readInt(GLOBAL)).toBe(0);
    expect(await countKeys(`${GLOBAL}:lock:*`)).toBe(0);
    // The storm was a storm: calls were turned away, which the script does only
    // with the counter AT the cap. (Not `maxHeld === CAP`: how full the test's own
    // view gets depends on scheduling, and nothing here asserts on speed.)
    expect(maxHeld).toBeGreaterThan(1);
    expect(refused).toBeGreaterThan(0);
    expect(admitted).toBeGreaterThan(ITERATIONS);
    expect(passes).toBeGreaterThan(5);
  });

  it('global guard: a release storm against a full house frees exactly the released calls', async () => {
    const CAP = 40;
    const guards = clients.map((c) => new ConcurrencyGuard(c, PREFIX, CAP, TIMEOUT_S));
    const calls = Array.from({ length: CAP }, (_, i) => `full-${i}`);
    const acquired = await Promise.all(calls.map((id, i) => guards[i % ACTORS]!.tryAcquire(id)));
    expect(acquired.every(Boolean)).toBe(true);

    // Half the calls are released FOUR times each, from four connections at once,
    // interleaved with releases of call ids that never held anything.
    const leaving = calls.filter((_, i) => i % 2 === 0);
    await Promise.all([
      ...leaving.flatMap((id, i) => Array.from({ length: 4 }, (_, k) => guards[(i + k) % ACTORS]!.release(id))),
      ...Array.from({ length: 60 }, (_, i) => guards[i % ACTORS]!.release(`never-held-${i}`)),
    ]);

    expect(await readInt(GLOBAL)).toBe(CAP - leaving.length);
    expect(await countKeys(`${GLOBAL}:lock:*`)).toBe(CAP - leaving.length);

    // Exactly the freed capacity is re-admitted, by a fresh storm of 3x as many.
    const rush = await Promise.all(Array.from({ length: leaving.length * 3 }, (_, i) =>
      guards[i % ACTORS]!.tryAcquire(`rush-${i}`)));
    expect(rush.filter(Boolean)).toHaveLength(leaving.length);
    expect(await readInt(GLOBAL)).toBe(CAP);
  });

  it('global guard: expired slots are recovered by reconcile, even with an acquire storm on the drifted counter', async () => {
    // A crash shape: calls take slots with a 1s lock and nobody releases them. The
    // locks expire, the counter stays at the cap, and every new call is refused
    // until the sweep reconciles — while the floor keeps trying.
    const CAP = 10;
    const guards = clients.map((c) => new ConcurrencyGuard(c, PREFIX, CAP, TIMEOUT_S));
    const dead = await Promise.all(Array.from({ length: CAP }, (_, i) => guards[i]!.tryAcquire(`dead-${i}`, 1)));
    expect(dead.every(Boolean)).toBe(true);
    await new Promise((r) => setTimeout(r, 1_300));
    expect(await countKeys(`${GLOBAL}:lock:*`)).toBe(0);
    expect(await readInt(GLOBAL)).toBe(CAP);
    expect(await guards[0]!.tryAcquire('blocked')).toBe(false);

    const healer = new ConcurrencyGuard(getTestRedis(), PREFIX, CAP, TIMEOUT_S);
    const admittedIds: string[] = [];
    let stop = false;
    const storm = Promise.all(guards.map(async (g, a) => {
      for (let i = 0; !stop && i < 400; i++) {
        if (await g.tryAcquire(`fresh-${a}-${i}`)) admittedIds.push(`fresh-${a}-${i}`);
        await new Promise((r) => setImmediate(r));
      }
    }));
    // Keep reconciling until the storm has filled the recovered capacity: a
    // reconcile whose snapshot a concurrent acquire invalidated is a deliberate
    // no-op, so one pass is not guaranteed to land.
    for (let pass = 0; pass < 200 && admittedIds.length < CAP; pass++) await healer.reconcile();
    stop = true;
    await storm;

    expect(admittedIds.length).toBe(CAP);
    expect(await readInt(GLOBAL)).toBe(CAP);
    expect(await countKeys(`${GLOBAL}:lock:*`)).toBe(CAP);
    // The quiescent counter equals its locks, so one more reconcile changes nothing.
    expect(await healer.reconcile()).toEqual({ before: CAP, after: CAP });
  });

  it('global guard: extendLock racing release never re-creates a released slot', async () => {
    const CAP = 200;
    const guards = clients.map((c) => new ConcurrencyGuard(c, PREFIX, CAP, TIMEOUT_S));
    const calls = Array.from({ length: CAP }, (_, i) => `ext-${i}`);
    await Promise.all(calls.map((id, i) => guards[i % ACTORS]!.tryAcquire(id)));
    const results = await Promise.all(calls.map((id, i) => Promise.all([
      guards[i % ACTORS]!.release(id),
      guards[(i + 1) % ACTORS]!.extendLock(id, 3_600),
      guards[(i + 2) % ACTORS]!.extendLock(id, 3_600),
    ])));
    expect(results).toHaveLength(CAP);
    expect(await countKeys(`${GLOBAL}:lock:*`)).toBe(0);
    expect(await readInt(GLOBAL)).toBe(0);
  });

  it('account guard: several accounts at once, each held under its own DB limit, with reconcileAll mid-storm', async () => {
    const ACCOUNTS = [
      { id: uuidFor('load-acct-a'), max: 4 },
      { id: uuidFor('load-acct-b'), max: 7 },
      { id: uuidFor('load-acct-c'), max: 1 },
    ];
    for (const a of ACCOUNTS) await seedLegacy(a.id, a.max);
    const guards = clients.map((c) => new AccountConcurrencyGuard(c, PREFIX, TIMEOUT_S));
    const held = new Map(ACCOUNTS.map((a) => [a.id, new Set<string>()]));
    const refusals = new Map(ACCOUNTS.map((a) => [a.id, 0]));
    let stop = false;
    const sweeper = (async () => {
      const g = new AccountConcurrencyGuard(getTestRedis(), PREFIX, TIMEOUT_S);
      while (!stop) {
        await g.reconcileAll();
        await new Promise((r) => setImmediate(r));
      }
    })();

    const ITERATIONS = scaled(80);
    const actors = Promise.all(guards.map(async (guard, a) => {
      const rng = createRng(createRng().seed + 100 + a);
      for (let i = 0; i < ITERATIONS; i++) {
        const account = rng.pick(ACCOUNTS);
        const callId = `acct-${a}-${i}`;
        if (!(await guard.tryAcquire(callId, TENANT, account.id))) {
          refusals.set(account.id, refusals.get(account.id)! + 1);
          continue;
        }
        const set = held.get(account.id)!;
        set.add(callId);
        expect(set.size, `account limit ${account.max} exceeded`).toBeLessThanOrEqual(account.max);
        await jitter(rng);
        set.delete(callId);
        await Promise.all(Array.from({ length: rng.chance(0.25) ? 2 : 1 }, (_, k) =>
          guards[(a + k) % ACTORS]!.release(callId, TENANT, account.id)));
      }
    }));
    try { await actors; } finally { stop = true; await sweeper; }

    for (const a of ACCOUNTS) {
      // Refused at least once: the account's counter really reached its limit.
      expect(refusals.get(a.id), `account limit ${a.max} never contended`).toBeGreaterThan(0);
      expect(await readInt(accountCounter(a.id))).toBe(0);
      expect(await countKeys(`${accountCounter(a.id)}:lock:*`)).toBe(0);
    }
  });

  it('account guard: a limit raised and lowered live is honoured by every acquire issued after the invalidation', async () => {
    const account = uuidFor('load-acct-live');
    await seedLegacy(account, 5);
    const guards = clients.map((c) => new AccountConcurrencyGuard(c, PREFIX, TIMEOUT_S));
    let seq = 0;
    const rush = async (n: number): Promise<string[]> => {
      const ids = Array.from({ length: n }, () => `live-${seq++}`);
      const won = await Promise.all(ids.map((id, i) => guards[i % ACTORS]!.tryAcquire(id, TENANT, account)));
      return ids.filter((_, i) => won[i]);
    };
    const invalidateEverywhere = () =>
      Promise.all(guards.map((g) => g.invalidateLimit(TENANT, account)));

    const first = await rush(40);
    expect(first).toHaveLength(5);

    await seedLegacy(account, 12);
    await invalidateEverywhere();
    const second = await rush(40);
    expect(second).toHaveLength(7);

    // Lowered below what is already held: nothing new until the floor drains under it.
    await seedLegacy(account, 3);
    await invalidateEverywhere();
    const held = [...first, ...second];
    expect(await rush(40)).toHaveLength(0);
    await Promise.all(held.splice(0, 10).map((id, i) => guards[i % ACTORS]!.release(id, TENANT, account)));
    expect(await readInt(accountCounter(account))).toBe(2);
    expect(await rush(40)).toHaveLength(1);
  });

  it('composite admission: global, account and per-provider caps all hold under a mixed storm with sweeps', async () => {
    // Two provider-mode accounts sharing the GLOBAL counter, three providers, and
    // the global cap set below the sum of the accounts so every scope binds at some
    // point. Each actor admits through `tryAcquireAll` and tears down through
    // `releaseTelephonyLease` (the bridge's teardown), sometimes twice at once.
    const GLOBAL_CAP = 14;
    const accounts = [
      { id: uuidFor('load-comp-a'), providers: [{ provider: 'voicelink', max_concurrent_calls: 6 }, { provider: 'vobiz', max_concurrent_calls: 4 }] },
      { id: uuidFor('load-comp-b'), providers: [{ provider: 'voicelink', max_concurrent_calls: 5 }, { provider: 'plivo', max_concurrent_calls: 3 }] },
    ];
    for (const a of accounts) {
      await providerConcurrencyRepository.replaceProviderBreakdown({
        tenant_id: TENANT, account_id: a.id, expected_version: 1, providers: a.providers,
      });
    }
    const totals = new Map(accounts.map((a) => [a.id, a.providers.reduce((s, p) => s + p.max_concurrent_calls, 0)]));
    const caps = new Map<string, number>(accounts.flatMap((a) => a.providers.map((p) => [`${a.id}:${p.provider}`, p.max_concurrent_calls] as const)));

    const actors = clients.map((c) => ({
      provider: new ProviderConcurrencyGuard(c, PREFIX, TIMEOUT_S, GLOBAL_CAP),
      global: new ConcurrencyGuard(c, PREFIX, GLOBAL_CAP, TIMEOUT_S),
      account: new AccountConcurrencyGuard(c, PREFIX, TIMEOUT_S),
    }));
    const heldGlobal = new Set<string>();
    const heldAccount = new Map(accounts.map((a) => [a.id, new Set<string>()]));
    const heldProvider = new Map([...caps.keys()].map((k) => [k, new Set<string>()]));
    const results = new Map<string, number>();
    let stop = false;

    const sweeps = (async () => {
      const r = getTestRedis();
      const p = new ProviderConcurrencyGuard(r, PREFIX, TIMEOUT_S, GLOBAL_CAP);
      const g = new ConcurrencyGuard(r, PREFIX, GLOBAL_CAP, TIMEOUT_S);
      const a = new AccountConcurrencyGuard(r, PREFIX, TIMEOUT_S);
      while (!stop) {
        await Promise.all([p.reconcileAll(), g.reconcile(), a.reconcileAll()]);
        await new Promise((res) => setImmediate(res));
      }
    })();

    const ITERATIONS = scaled(70);
    const storm = Promise.all(actors.map(async (guards, a) => {
      const rng = createRng(createRng().seed + 200 + a);
      for (let i = 0; i < ITERATIONS; i++) {
        const account = rng.pick(accounts);
        const provider = rng.pick(account.providers).provider;
        const key = `comp-${a}-${i}`;
        const admission = await guards.provider.tryAcquireAll(key, TENANT, account.id, provider);
        results.set(admission.result, (results.get(admission.result) ?? 0) + 1);
        if (admission.result !== 'acquired') {
          await jitter(rng);
          continue;
        }
        const pk = `${account.id}:${provider}`;
        heldGlobal.add(key);
        heldAccount.get(account.id)!.add(key);
        heldProvider.get(pk)!.add(key);
        expect(heldGlobal.size, 'global cap exceeded').toBeLessThanOrEqual(GLOBAL_CAP);
        expect(heldAccount.get(account.id)!.size, 'account total exceeded').toBeLessThanOrEqual(totals.get(account.id)!);
        expect(heldProvider.get(pk)!.size, `provider cap exceeded for ${provider}`).toBeLessThanOrEqual(caps.get(pk)!);
        await jitter(rng);
        heldGlobal.delete(key);
        heldAccount.get(account.id)!.delete(key);
        heldProvider.get(pk)!.delete(key);
        const teardowns = rng.chance(0.3) ? 2 : 1;
        const outcomes = await Promise.all(Array.from({ length: teardowns }, (_, k) => {
          const other = actors[(a + k) % ACTORS]!;
          return releaseTelephonyLease({
            concurrencyGuard: other.global,
            accountConcurrencyGuard: other.account,
            providerConcurrencyGuard: other.provider,
          }, { concurrencyKey: key, tenantId: TENANT, accountId: account.id, provider, source: 'webrtc' });
        }));
        // Exactly one teardown found the three leases; a duplicate found none.
        expect(outcomes.filter((o) => o === 'composite')).toHaveLength(1);
        expect(outcomes.filter((o) => o !== 'composite').every((o) => o === 'noop')).toBe(true);
      }
    }));
    try { await storm; } finally { stop = true; await sweeps; }

    expect(results.get('acquired') ?? 0).toBeGreaterThan(ITERATIONS);
    // Every scope actually refused somebody, so every cap was really contended.
    expect(results.get('global_full') ?? 0).toBeGreaterThan(0);
    expect(results.get('provider_full') ?? 0).toBeGreaterThan(0);
    expect(await readInt(GLOBAL)).toBe(0);
    for (const a of accounts) {
      expect(await readInt(accountCounter(a.id))).toBe(0);
      for (const p of a.providers) expect(await readInt(providerCounter(a.id, p.provider))).toBe(0);
    }
    expect(await countKeys(`${PREFIX}active_calls*:lock:*`)).toBe(0);
  });

  it('legacy and provider-mode accounts admitting together never overrun the shared global counter', async () => {
    // A legacy account goes through the per-scope path (global guard, then
    // account guard, rolling the global back on an account refusal) while a
    // provider-mode account goes through the composite — two different scripts on
    // ONE global counter, as `TelephonyGuardHost` runs them side by side.
    const GLOBAL_CAP = 9;
    const legacy = uuidFor('load-mixed-legacy');
    const modern = uuidFor('load-mixed-provider');
    await seedLegacy(legacy, 6);
    await providerConcurrencyRepository.replaceProviderBreakdown({
      tenant_id: TENANT, account_id: modern, expected_version: 1,
      providers: [{ provider: 'voicelink', max_concurrent_calls: 6 }],
    });
    const actors = clients.map((c) => ({
      provider: new ProviderConcurrencyGuard(c, PREFIX, TIMEOUT_S, GLOBAL_CAP),
      global: new ConcurrencyGuard(c, PREFIX, GLOBAL_CAP, TIMEOUT_S),
      account: new AccountConcurrencyGuard(c, PREFIX, TIMEOUT_S),
    }));
    const held = new Set<string>();
    let globalRefusals = 0;

    const ITERATIONS = scaled(60);
    await Promise.all(actors.map(async (g, a) => {
      const rng = createRng(createRng().seed + 300 + a);
      for (let i = 0; i < ITERATIONS; i++) {
        const key = `mixed-${a}-${i}`;
        const useLegacy = rng.chance(0.5);
        const accountId = useLegacy ? legacy : modern;
        let ok: boolean;
        if (useLegacy) {
          ok = await g.global.tryAcquire(key);
          if (!ok) globalRefusals++;
          if (ok && !(await g.account.tryAcquire(key, TENANT, legacy))) {
            await g.global.release(key);
            ok = false;
          }
        } else {
          const res = (await g.provider.tryAcquireAll(key, TENANT, modern, 'voicelink')).result;
          if (res === 'global_full') globalRefusals++;
          ok = res === 'acquired';
        }
        if (!ok) continue;
        held.add(key);
        expect(held.size, 'shared global counter overrun').toBeLessThanOrEqual(GLOBAL_CAP);
        await jitter(rng, 6);
        held.delete(key);
        await releaseTelephonyLease(
          { concurrencyGuard: g.global, accountConcurrencyGuard: g.account, providerConcurrencyGuard: g.provider },
          { concurrencyKey: key, tenantId: TENANT, accountId, provider: 'voicelink', source: 'webrtc' },
        );
      }
    }));

    // The shared counter was genuinely contended: both scripts were refused at it.
    expect(globalRefusals).toBeGreaterThan(0);
    expect(await readInt(GLOBAL)).toBe(0);
    expect(await readInt(accountCounter(legacy))).toBe(0);
    expect(await readInt(accountCounter(modern))).toBe(0);
    expect(await countKeys(`${PREFIX}active_calls*:lock:*`)).toBe(0);
  });

  /**
   * ── DEFECT: an invalidation can be undone by a limit read already in flight ──
   *
   * Both guards cache the limit they read from Postgres (the account guard in
   * Redis for 60s, the provider guard in-process for 5s), and the super-admin
   * routes lower a limit by writing the row and then calling `invalidateLimit` /
   * `invalidateLimits`, which delete the cached value. But `resolveLimit` is
   * read-DB-then-write-cache with nothing fencing the write: an acquire whose DB
   * read returned the OLD limit before the update committed, and whose cache write
   * lands AFTER the invalidation, re-caches the old limit — and every acquire for
   * the rest of the TTL admits against it. A limit lowered because the carrier
   * contract shrank is then not honoured for up to a minute.
   *
   * Driven deterministically rather than hoped for: the in-flight read is the real
   * repository call against the real row, held at its return by a gate while the
   * limit is lowered and invalidated (the network latency of a DB reply on a busy
   * floor is exactly that gap). The fix is a generation fence on the cache write —
   * `invalidateLimit` bumps a per-account generation, `resolveLimit` snapshots it
   * before the read and writes the cache only if it is unchanged (one Lua script,
   * as the counters' reconcile already does) — and it changes the guard's Redis
   * call shape that its unit suite pins, so it is left for a deliberate change.
   * These assert the correct behaviour and are expected to fail until then.
   */
  describe('limit invalidation racing an in-flight limit read', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    /** Park the next call to `obj[method]` at its return, after the real read ran. */
    function parkNextRead<T extends object, K extends keyof T>(obj: T, method: K) {
      const original = (obj[method] as (...args: unknown[]) => Promise<unknown>).bind(obj);
      let open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      let readDone!: () => void;
      const read = new Promise<void>((r) => { readDone = r; });
      vi.spyOn(obj, method as never).mockImplementationOnce((async (...args: unknown[]) => {
        const value = await original(...args);
        readDone();
        await gate;
        return value;
      }) as never);
      return { readReturned: read, release: () => open() };
    }

    it.fails('DEFECT account guard: a lowered limit is re-cached as the old one by a read in flight', async () => {
      const account = uuidFor('load-acct-inflight');
      await seedLegacy(account, 8);
      const slow = new AccountConcurrencyGuard(clients[0]!, PREFIX, TIMEOUT_S);
      const parked = parkNextRead(accountSettingsRepository, 'getMaxConcurrentCalls');

      const inFlight = slow.tryAcquire('inflight-0', TENANT, account);
      await parked.readReturned; // it has read 8 from the committed row
      await seedLegacy(account, 2);
      await new AccountConcurrencyGuard(clients[1]!, PREFIX, TIMEOUT_S).invalidateLimit(TENANT, account);
      parked.release();
      expect(await inFlight).toBe(true);

      // Every acquire issued after the invalidation must see the new limit of 2:
      // one more call fits beside the one in flight, and no others.
      const guards = clients.map((c) => new AccountConcurrencyGuard(c, PREFIX, TIMEOUT_S));
      const won = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        guards[i % ACTORS]!.tryAcquire(`after-${i}`, TENANT, account)));
      expect(1 + won.filter(Boolean).length).toBeLessThanOrEqual(2);
    });

    it.fails('DEFECT provider guard: a lowered provider allocation is re-cached by a read in flight', async () => {
      const account = uuidFor('load-prov-inflight');
      await providerConcurrencyRepository.replaceProviderBreakdown({
        tenant_id: TENANT, account_id: account, expected_version: 1,
        providers: [{ provider: 'voicelink', max_concurrent_calls: 8 }],
      });
      // One guard, as one replica has: its in-process cache is what the race poisons.
      const guard = new ProviderConcurrencyGuard(getTestRedis(), PREFIX, TIMEOUT_S, 100);
      const parked = parkNextRead(providerConcurrencyRepository, 'getProviderLimit');

      const inFlight = guard.tryAcquireAll('inflight-0', TENANT, account, 'voicelink');
      await parked.readReturned;
      const { rows } = await getTestPool().query<{ v: number }>(
        'SELECT concurrency_allocation_version AS v FROM account_settings WHERE tenant_id = $1 AND account_id = $2',
        [TENANT, account],
      );
      await providerConcurrencyRepository.replaceProviderBreakdown({
        tenant_id: TENANT, account_id: account, expected_version: rows[0]!.v,
        providers: [{ provider: 'voicelink', max_concurrent_calls: 2 }],
      });
      await guard.invalidateLimits(TENANT, account);
      parked.release();
      expect((await inFlight).result).toBe('acquired');

      const after = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        guard.tryAcquireAll(`after-${i}`, TENANT, account, 'voicelink')));
      expect(1 + after.filter((r) => r.result === 'acquired').length).toBeLessThanOrEqual(2);
    });
  });
});
