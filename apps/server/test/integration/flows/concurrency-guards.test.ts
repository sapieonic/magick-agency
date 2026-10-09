// PORT NOTE (magick-agency): ported from core test/integration/flows/concurrency-guards.test.ts@4850d1d9.
// Changed: harness imports (agency test-db / test-redis helpers); mock specifiers
// (`@magick-agency/db/connection`, `@magick-agency/db/repositories/...`); the tenant/
// account ids that reach Postgres (`account_settings` and the allocation rows are UUID
// columns here) are `uuidFor(<core label>)`, and the raw-key assertions interpolate
// them. 'vobiz' stays as a second provider LABEL in the cross-provider cases: the
// guard is provider-agnostic and the no-borrowing proof needs two providers.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool, closeTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
import { uuidFor } from '../../../../../packages/db/test/integration/setup/factories.js';
import { getTestRedis, flushTestRedis, closeTestRedis } from '../../helpers/test-redis.js';
// Type-only, so it is erased at runtime and cannot defeat the vi.mock ordering below.
import type { CompositeReleaseResult } from '../../../src/core/provider-concurrency-guard.js';

// Mock the DB connection so that AccountConcurrencyGuard's resolveLimit uses the test DB
vi.mock('@magick-agency/db/connection', () => ({
  getPool: () => getTestPool(),
}));

// Mock accountSettingsRepository to return a fixed limit — avoids needing account_settings rows
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: {
    getMaxConcurrentCalls: vi.fn().mockResolvedValue(3),
    clearCache: vi.fn(),
  },
}));

// Must import AFTER vi.mock
const { ConcurrencyGuard } = await import('../../../src/core/concurrency-guard.js');
const { AccountConcurrencyGuard } = await import('../../../src/core/account-concurrency-guard.js');
const { ProviderConcurrencyGuard } = await import('../../../src/core/provider-concurrency-guard.js');
const { providerConcurrencyRepository } = await import('@magick-agency/db/repositories/provider-concurrency.repository');
const { releaseTelephonyLease } = await import('../../../src/core/telephony-release.js');

describe('ConcurrencyGuard (integration)', () => {
  beforeEach(async () => {
    await flushTestRedis();
  });

  afterAll(async () => {
    await closeTestRedis();
    await closeTestPool();
  });

  it('allows up to maxConcurrent acquisitions and rejects the next one', async () => {
    const redis = getTestRedis();
    const guard = new ConcurrencyGuard(redis, 'test:cg-limit:', 2, 60);

    const r1 = await guard.tryAcquire('call-1');
    const r2 = await guard.tryAcquire('call-2');
    const r3 = await guard.tryAcquire('call-3');

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(false);
  });

  it('allows a new acquisition after releasing one slot', async () => {
    const redis = getTestRedis();
    const guard = new ConcurrencyGuard(redis, 'test:cg-release:', 2, 60);

    await guard.tryAcquire('call-1');
    await guard.tryAcquire('call-2');

    // At capacity — third should fail
    const beforeRelease = await guard.tryAcquire('call-3');
    expect(beforeRelease).toBe(false);

    // Release one slot
    await guard.release('call-1');

    // Now should succeed
    const afterRelease = await guard.tryAcquire('call-3');
    expect(afterRelease).toBe(true);
  });

  it('getCurrentCount reflects the number of active locks', async () => {
    const redis = getTestRedis();
    const guard = new ConcurrencyGuard(redis, 'test:cg-count:', 5, 60);

    expect(await guard.getCurrentCount()).toBe(0);

    await guard.tryAcquire('call-a');
    expect(await guard.getCurrentCount()).toBe(1);

    await guard.tryAcquire('call-b');
    expect(await guard.getCurrentCount()).toBe(2);

    await guard.release('call-a');
    expect(await guard.getCurrentCount()).toBe(1);
  });

  it('treats a retry for the same call as idempotent', async () => {
    const guard = new ConcurrencyGuard(getTestRedis(), 'test:cg-idempotent:', 2, 60);
    expect(await guard.tryAcquire('same-call')).toBe(true);
    expect(await guard.tryAcquire('same-call')).toBe(true);
    expect(await guard.getCurrentCount()).toBe(1);
  });

  it('release decrements counter correctly even at zero', async () => {
    const redis = getTestRedis();
    const guard = new ConcurrencyGuard(redis, 'test:cg-release-zero:', 5, 60);

    await guard.tryAcquire('call-z');
    await guard.release('call-z');

    expect(await guard.getCurrentCount()).toBe(0);

    // Releasing a non-existent lock should be a no-op (not go negative)
    await guard.release('call-z');
    const count = await guard.getCurrentCount();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('each guard instance with a different prefix operates independently', async () => {
    const redis = getTestRedis();
    const guardA = new ConcurrencyGuard(redis, 'test:cg-independent-A:', 1, 60);
    const guardB = new ConcurrencyGuard(redis, 'test:cg-independent-B:', 1, 60);

    // Fill guard A to capacity
    const resultA1 = await guardA.tryAcquire('call-A1');
    const resultA2 = await guardA.tryAcquire('call-A2');

    // Guard B should be unaffected
    const resultB1 = await guardB.tryAcquire('call-B1');

    expect(resultA1).toBe(true);
    expect(resultA2).toBe(false);  // Guard A is full
    expect(resultB1).toBe(true);   // Guard B is independent
  });
});

describe('AccountConcurrencyGuard (integration)', () => {
  beforeEach(async () => {
    await flushTestRedis();
  });

  afterAll(async () => {
    await closeTestRedis();
    await closeTestPool();
  });

  it('allows acquisition up to the mocked limit (3) and rejects the fourth', async () => {
    const redis = getTestRedis();
    const guard = new AccountConcurrencyGuard(redis, 'test:acg-limit:', 60);

    const tenant = 'tenant-1';
    const account = 'account-1';

    const r1 = await guard.tryAcquire('call-1', tenant, account);
    const r2 = await guard.tryAcquire('call-2', tenant, account);
    const r3 = await guard.tryAcquire('call-3', tenant, account);
    const r4 = await guard.tryAcquire('call-4', tenant, account);

    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
    expect(r4).toBe(false);
  });

  it('release decrements the account counter', async () => {
    const redis = getTestRedis();
    const guard = new AccountConcurrencyGuard(redis, 'test:acg-release:', 60);

    const tenant = 'tenant-2';
    const account = 'account-2';

    await guard.tryAcquire('call-1', tenant, account);
    await guard.tryAcquire('call-2', tenant, account);
    await guard.tryAcquire('call-3', tenant, account);

    // At limit (3) — next should fail
    const atLimit = await guard.tryAcquire('call-4', tenant, account);
    expect(atLimit).toBe(false);

    // Release one
    await guard.release('call-1', tenant, account);

    // Now should succeed
    const afterRelease = await guard.tryAcquire('call-4', tenant, account);
    expect(afterRelease).toBe(true);
  });

  it('getAccountCount reflects the current active count for an account', async () => {
    const redis = getTestRedis();
    const guard = new AccountConcurrencyGuard(redis, 'test:acg-count:', 60);

    const tenant = 'tenant-3';
    const account = 'account-3';

    expect(await guard.getAccountCount(tenant, account)).toBe(0);

    await guard.tryAcquire('call-a', tenant, account);
    expect(await guard.getAccountCount(tenant, account)).toBe(1);

    await guard.tryAcquire('call-b', tenant, account);
    expect(await guard.getAccountCount(tenant, account)).toBe(2);

    await guard.release('call-a', tenant, account);
    expect(await guard.getAccountCount(tenant, account)).toBe(1);
  });

  it('treats an account-scope retry for the same call as idempotent', async () => {
    const guard = new AccountConcurrencyGuard(getTestRedis(), 'test:acg-idempotent:', 60);
    expect(await guard.tryAcquire('same-call', 'tenant-idem', 'account-idem')).toBe(true);
    expect(await guard.tryAcquire('same-call', 'tenant-idem', 'account-idem')).toBe(true);
    expect(await guard.getAccountCount('tenant-idem', 'account-idem')).toBe(1);
  });

  it('different accounts under the same tenant are independent', async () => {
    const redis = getTestRedis();
    const guard = new AccountConcurrencyGuard(redis, 'test:acg-isolation:', 60);

    const tenant = 'shared-tenant';

    // Acquire 3 for account-A (fills it up per the mock limit)
    await guard.tryAcquire('call-A1', tenant, 'account-A');
    await guard.tryAcquire('call-A2', tenant, 'account-A');
    await guard.tryAcquire('call-A3', tenant, 'account-A');

    // Account-A is now full
    const accountAFull = await guard.tryAcquire('call-A4', tenant, 'account-A');
    expect(accountAFull).toBe(false);

    // Account-B should still be able to acquire (independent counter)
    const accountBFirst = await guard.tryAcquire('call-B1', tenant, 'account-B');
    expect(accountBFirst).toBe(true);

    const countA = await guard.getAccountCount(tenant, 'account-A');
    const countB = await guard.getAccountCount(tenant, 'account-B');

    expect(countA).toBe(3);
    expect(countB).toBe(1);
  });

  it('different tenants are independent from each other', async () => {
    const redis = getTestRedis();
    const guard = new AccountConcurrencyGuard(redis, 'test:acg-tenant-isolation:', 60);

    const account = 'shared-account';

    // Fill tenant-1's account
    await guard.tryAcquire('call-T1-1', 'tenant-1', account);
    await guard.tryAcquire('call-T1-2', 'tenant-1', account);
    await guard.tryAcquire('call-T1-3', 'tenant-1', account);
    const tenant1Full = await guard.tryAcquire('call-T1-4', 'tenant-1', account);
    expect(tenant1Full).toBe(false);

    // Tenant-2 should still be clear
    const tenant2First = await guard.tryAcquire('call-T2-1', 'tenant-2', account);
    expect(tenant2First).toBe(true);
  });
});

describe('ProviderConcurrencyGuard composite admission (integration)', () => {
  // PORT: account_settings / allocation ids are UUID columns here.
  const TENANT_PROVIDER = uuidFor('tenant-provider');
  const ACCOUNT_PROVIDER = uuidFor('account-provider');

  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
    await providerConcurrencyRepository.replaceProviderBreakdown({
      tenant_id: TENANT_PROVIDER,
      account_id: ACCOUNT_PROVIDER,
      expected_version: 1,
      providers: [
        { provider: 'vobiz', max_concurrent_calls: 30 },
        { provider: 'voicelink', max_concurrent_calls: 20 },
      ],
    });
  });

  afterAll(async () => {
    await closeTestRedis();
    await closeTestPool();
  });

  it('uses all 30 + 20 purchased slots without cross-provider borrowing', async () => {
    const guard = new ProviderConcurrencyGuard(getTestRedis(), 'test:pcg:', 60, 100);

    for (let i = 1; i <= 30; i++) {
      await expect(guard.tryAcquireAll(
        `vobiz-${i}`, TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz',
      )).resolves.toMatchObject({ result: 'acquired', providerScoped: true });
    }
    await expect(guard.tryAcquireAll(
      'vobiz-31', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz',
    )).resolves.toEqual({ result: 'provider_full', providerScoped: true });

    for (let i = 1; i <= 20; i++) {
      await expect(guard.tryAcquireAll(
        `voicelink-${i}`, TENANT_PROVIDER, ACCOUNT_PROVIDER, 'voicelink',
      )).resolves.toMatchObject({ result: 'acquired', providerScoped: true });
    }

    expect(await guard.getProviderCount(TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz')).toBe(30);
    expect(await guard.getProviderCount(TENANT_PROVIDER, ACCOUNT_PROVIDER, 'voicelink')).toBe(20);
    await expect(guard.tryAcquireAll(
      'voicelink-21', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'voicelink',
    )).resolves.toEqual({ result: 'account_full', providerScoped: true });
  });

  it('is idempotent for retries and reuses only the released provider slot', async () => {
    const guard = new ProviderConcurrencyGuard(getTestRedis(), 'test:pcg-retry:', 60, 100);
    await expect(guard.tryAcquireAll(
      'same-call', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz',
    )).resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: true });
    await expect(guard.tryAcquireAll(
      'same-call', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz',
    )).resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: false });
    expect(await guard.getProviderCount(TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz')).toBe(1);

    await guard.releaseAll('same-call', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz');
    expect(await guard.getProviderCount(TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz')).toBe(0);
  });

  it('composite release returns every counter to zero in one transaction', async () => {
    const redis = getTestRedis();
    const prefix = 'test:pcg-rel:';
    const guard = new ProviderConcurrencyGuard(redis, prefix, 60, 100);

    await guard.tryAcquireAll('rel-1', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz');
    await expect(redis.get(`${prefix}active_calls`)).resolves.toBe('1');

    await expect(guard.releaseAll('rel-1', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz'))
      .resolves.toEqual({ status: 'released', scopes: 3 });

    await expect(redis.get(`${prefix}active_calls`)).resolves.toBe('0');
    await expect(redis.get(`${prefix}active_calls:account:${TENANT_PROVIDER}:${ACCOUNT_PROVIDER}`))
      .resolves.toBe('0');
    await expect(redis.get(`${prefix}active_calls:provider:${TENANT_PROVIDER}:${ACCOUNT_PROVIDER}:vobiz`))
      .resolves.toBe('0');
  });

  it('a duplicate composite release is a zero-scope noop, never a negative counter', async () => {
    const redis = getTestRedis();
    const prefix = 'test:pcg-dup:';
    const guard = new ProviderConcurrencyGuard(redis, prefix, 60, 100);

    await guard.tryAcquireAll('dup-1', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz');
    await guard.tryAcquireAll('dup-2', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz');

    await expect(guard.releaseAll('dup-1', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz'))
      .resolves.toEqual({ status: 'released', scopes: 3 });
    // The duplicate teardown (hangup racing a WS close) must not decrement dup-2's lease.
    await expect(guard.releaseAll('dup-1', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz'))
      .resolves.toEqual({ status: 'released', scopes: 0 });

    await expect(redis.get(`${prefix}active_calls`)).resolves.toBe('1');
    expect(await guard.getProviderCount(TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz')).toBe(1);
  });

  it('concurrent endings free exactly their own leases and readmit exactly that many', async () => {
    const redis = getTestRedis();
    const prefix = 'test:pcg-conc:';
    const guard = new ProviderConcurrencyGuard(redis, prefix, 60, 100);

    for (let i = 1; i <= 30; i++) {
      await guard.tryAcquireAll(`c-${i}`, TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz');
    }
    await expect(guard.tryAcquireAll('c-31', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz'))
      .resolves.toEqual({ result: 'provider_full', providerScoped: true });

    // Ten calls end at once, each also getting a duplicate teardown.
    const ending = Array.from({ length: 10 }, (_unused, i) => `c-${i + 1}`);
    await Promise.all(ending.flatMap((key) => [
      guard.releaseAll(key, TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz'),
      guard.releaseAll(key, TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz'),
    ]));

    expect(await guard.getProviderCount(TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz')).toBe(20);
    await expect(redis.get(`${prefix}active_calls`)).resolves.toBe('20');

    // Queue progression: exactly ten slots became available, and no more.
    for (let i = 1; i <= 10; i++) {
      await expect(guard.tryAcquireAll(
        `next-${i}`, TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz',
      )).resolves.toMatchObject({ result: 'acquired' });
    }
    await expect(guard.tryAcquireAll('next-11', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz'))
      .resolves.toEqual({ result: 'provider_full', providerScoped: true });
  });

  it('reports failure rather than a false success when Redis rejects the release', async () => {
    const prefix = 'test:pcg-fail:';
    const guard = new ProviderConcurrencyGuard(getTestRedis(), prefix, 60, 100);
    await guard.tryAcquireAll('fail-1', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz');

    // Inject a Redis failure on the release only.
    const broken = { ...getTestRedis(), eval: async () => { throw new Error('redis down'); } };
    const brokenGuard = new ProviderConcurrencyGuard(broken as never, prefix, 60, 100);
    const result = await brokenGuard.releaseAll('fail-1', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz');
    expect(result.status).toBe('failed');

    // The lease is untouched, so the caller's fallback (and failing that, the
    // self-heal sweep) still has something to reconcile — capacity is parked, not lost.
    expect(await guard.getProviderCount(TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz')).toBe(1);

    // A real release afterwards still settles it exactly once.
    await expect(guard.releaseAll('fail-1', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz'))
      .resolves.toEqual({ status: 'released', scopes: 3 });
    expect(await guard.getProviderCount(TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz')).toBe(0);
  });

  it('repairs a partial lease and rebuilds every counter before reacquiring', async () => {
    const redis = getTestRedis();
    const prefix = 'test:pcg-partial:';
    const guard = new ProviderConcurrencyGuard(redis, prefix, 60, 100);
    await guard.tryAcquireAll(
      'partial-call', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz',
    );
    await redis.del(
      `${prefix}active_calls:provider:${TENANT_PROVIDER}:${ACCOUNT_PROVIDER}:vobiz:lock:partial-call`,
    );

    await expect(guard.tryAcquireAll(
      'partial-call', TENANT_PROVIDER, ACCOUNT_PROVIDER, 'vobiz',
    )).resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: true });

    await expect(redis.get(`${prefix}active_calls`)).resolves.toBe('1');
    await expect(redis.get(`${prefix}active_calls:account:${TENANT_PROVIDER}:${ACCOUNT_PROVIDER}`))
      .resolves.toBe('1');
    await expect(redis.get(`${prefix}active_calls:provider:${TENANT_PROVIDER}:${ACCOUNT_PROVIDER}:vobiz`))
      .resolves.toBe('1');
  });
});

describe('releaseTelephonyLease against REAL guards (integration)', () => {
  // Provider-mode account (A, C, D) and a legacy account (B) that owns no
  // allocation row, so `tryAcquireAll` hands it back as `legacy_mode`.
  // PORT: UUIDs (the baseline types tenant/account ids UUID; core used labels).
  const TENANT = uuidFor('tenant-release');
  const ACCOUNT = uuidFor('account-release');
  const LEGACY_TENANT = uuidFor('tenant-release-legacy');
  const LEGACY_ACCOUNT = uuidFor('account-release-legacy');

  /**
   * The three production guard classes, all sharing ONE key prefix and one Redis
   * client — exactly how `CallManager` constructs them.
   *
   * That shared prefix is the whole point of this block. `releaseAll` in
   * `provider-concurrency-guard.ts` hand-builds the global counter/lock/generation
   * keys as `${prefix}active_calls[:lock:<key>|:generation]` and the account ones as
   * `${prefix}active_calls:account:<tenant>:<account>[...]`, duplicating formats
   * that `ConcurrencyGuard` and `AccountConcurrencyGuard` own privately. Nothing in
   * the type system couples them: if either owner ever renames a key, the composite
   * silently DELs three keys nobody wrote, returns `scopes: 0`, and
   * `releaseTelephonyLease` classifies that as the TERMINAL `noop` — no fallback —
   * so every lease leaks for a full lock TTL. Every existing double for these guards
   * omits `releaseAll` entirely, so the composite branch has never been run against
   * real guard instances until here.
   */
  function realGuards(prefix: string) {
    const redis = getTestRedis();
    return {
      concurrencyGuard: new ConcurrencyGuard(redis, prefix, 100, 60),
      accountConcurrencyGuard: new AccountConcurrencyGuard(redis, prefix, 60),
      providerConcurrencyGuard: new ProviderConcurrencyGuard(redis, prefix, 60, 100),
    };
  }

  /** Read the server's own EVAL call counter. See the comment in test C. */
  async function evalCalls(): Promise<number> {
    const info = await getTestRedis().info('commandstats');
    const raw = /^cmdstat_eval:calls=(\d+)/m.exec(info)?.[1];
    return raw ? Number.parseInt(raw, 10) : 0;
  }

  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
    await providerConcurrencyRepository.replaceProviderBreakdown({
      tenant_id: TENANT,
      account_id: ACCOUNT,
      expected_version: 1,
      providers: [{ provider: 'vobiz', max_concurrent_calls: 5 }],
    });
  });

  afterAll(async () => {
    await closeTestRedis();
    await closeTestPool();
  });

  it('releases a provider-mode lease through the composite, zeroing all three real counters', async () => {
    const redis = getTestRedis();
    const prefix = 'test:pcg-rel-helper-a:';
    const guards = realGuards(prefix);

    await expect(guards.providerConcurrencyGuard.tryAcquireAll(
      'rel-a-1', TENANT, ACCOUNT, 'vobiz',
    )).resolves.toMatchObject({ result: 'acquired', providerScoped: true });

    // Precondition: every scope really is held, read back through the owning class.
    expect(await guards.concurrencyGuard.getCurrentCount()).toBe(1);
    expect(await guards.accountConcurrencyGuard.getAccountCount(TENANT, ACCOUNT)).toBe(1);
    expect(await guards.providerConcurrencyGuard.getProviderCount(TENANT, ACCOUNT, 'vobiz')).toBe(1);

    await expect(releaseTelephonyLease(guards, {
      concurrencyKey: 'rel-a-1',
      tenantId: TENANT,
      accountId: ACCOUNT,
      provider: 'vobiz',
      source: 'session_end',
      callId: 'call-rel-a-1',
    })).resolves.toBe('composite');

    // Asserted on the raw keys as well as through the accessors: a drifted key
    // format would make the accessors agree with each other and with nothing else.
    await expect(redis.get(`${prefix}active_calls`)).resolves.toBe('0');
    await expect(redis.get(`${prefix}active_calls:account:${TENANT}:${ACCOUNT}`)).resolves.toBe('0');
    await expect(redis.get(`${prefix}active_calls:provider:${TENANT}:${ACCOUNT}:vobiz`)).resolves.toBe('0');
    expect(await guards.concurrencyGuard.getCurrentCount()).toBe(0);
    expect(await guards.accountConcurrencyGuard.getAccountCount(TENANT, ACCOUNT)).toBe(0);
    expect(await guards.providerConcurrencyGuard.getProviderCount(TENANT, ACCOUNT, 'vobiz')).toBe(0);

    // The freed capacity is real: a fresh call is admitted after the release.
    await expect(guards.providerConcurrencyGuard.tryAcquireAll(
      'rel-a-2', TENANT, ACCOUNT, 'vobiz',
    )).resolves.toMatchObject({ result: 'acquired', newlyAcquired: true });
  });

  it('releases a LEGACY lease written by the individual guards — the cross-class key parity pin', async () => {
    const redis = getTestRedis();
    const prefix = 'test:pcg-rel-helper-b:';
    const guards = realGuards(prefix);

    // This account owns no allocation row, so composite admission declines it and
    // the legacy path runs — which is what makes this the load-bearing case: the
    // keys are written by `ConcurrencyGuard` and `AccountConcurrencyGuard`
    // themselves, and torn down by the composite's hand-built copies of those
    // formats. If the two ever drift, only this direction catches it.
    await expect(guards.providerConcurrencyGuard.tryAcquireAll(
      'rel-b-1', LEGACY_TENANT, LEGACY_ACCOUNT, 'vobiz',
    )).resolves.toEqual({ result: 'legacy_mode', providerScoped: false });

    expect(await guards.concurrencyGuard.tryAcquire('rel-b-1')).toBe(true);
    expect(await guards.accountConcurrencyGuard.tryAcquire(
      'rel-b-1', LEGACY_TENANT, LEGACY_ACCOUNT,
    )).toBe(true);
    await expect(redis.get(`${prefix}active_calls`)).resolves.toBe('1');
    await expect(redis.get(`${prefix}active_calls:account:${LEGACY_TENANT}:${LEGACY_ACCOUNT}`))
      .resolves.toBe('1');

    // Delegating wrapper so the scope count the composite reports is observable —
    // `releaseTelephonyLease` returns only the outcome label. The work is still
    // done by the real guard against real Redis.
    const composite: CompositeReleaseResult[] = [];
    const real = guards.providerConcurrencyGuard;
    const observedGuards = {
      concurrencyGuard: guards.concurrencyGuard,
      accountConcurrencyGuard: guards.accountConcurrencyGuard,
      providerConcurrencyGuard: {
        release: (c: string, t: string, a: string, p: string) => real.release(c, t, a, p),
        releaseAll: async (c: string, t: string, a: string, p: string) => {
          const result = await real.releaseAll(c, t, a, p);
          composite.push(result);
          return result;
        },
      },
    };

    await expect(releaseTelephonyLease(observedGuards, {
      concurrencyKey: 'rel-b-1',
      tenantId: LEGACY_TENANT,
      accountId: LEGACY_ACCOUNT,
      provider: 'vobiz',
      source: 'session_end',
    })).resolves.toBe('composite');

    // Exactly two scopes: a legacy account never held a provider lease, so the
    // third DEL is a no-op. Three would mean it deleted something it did not own;
    // zero or one would be the key-format drift this test exists to catch.
    expect(composite).toEqual([{ status: 'released', scopes: 2 }]);

    await expect(redis.get(`${prefix}active_calls`)).resolves.toBe('0');
    await expect(redis.get(`${prefix}active_calls:account:${LEGACY_TENANT}:${LEGACY_ACCOUNT}`))
      .resolves.toBe('0');
    expect(await guards.concurrencyGuard.getCurrentCount()).toBe(0);
    expect(await guards.accountConcurrencyGuard.getAccountCount(LEGACY_TENANT, LEGACY_ACCOUNT)).toBe(0);
  });

  it('costs exactly ONE Redis eval on the healthy path and THREE on the fallback', async () => {
    // The ticket's headline claim ("three release evaluations reduced to one") has
    // only ever been asserted by counting mock calls. This counts what Redis itself
    // recorded: the delta on the server's `cmdstat_eval:calls` between two
    // `INFO commandstats` reads. Chosen over a spy on the ioredis client because a
    // spy can only see the calls the code makes through THAT client object, whereas
    // the server counter is ground truth for the whole connection — it would also
    // catch a release that reached Redis by some other route. `INFO` increments
    // `cmdstat_info`, not `cmdstat_eval`, so measuring does not perturb the
    // measurement; ioredis sends plain `EVAL` (never `EVALSHA`) for `.eval()`, so
    // one counter suffices; and `FLUSHDB` in `beforeEach` does not reset
    // commandstats, which is why these are deltas rather than absolutes.
    // `fileParallelism: false` means no other suite is issuing evals concurrently.
    const redis = getTestRedis();

    // ── Healthy composite path ────────────────────────────────────────────────
    const okPrefix = 'test:pcg-rel-helper-c-ok:';
    const okGuards = realGuards(okPrefix);
    await okGuards.providerConcurrencyGuard.tryAcquireAll('rel-c-ok', TENANT, ACCOUNT, 'vobiz');

    const beforeComposite = await evalCalls();
    const compositeOutcome = await releaseTelephonyLease(okGuards, {
      concurrencyKey: 'rel-c-ok',
      tenantId: TENANT,
      accountId: ACCOUNT,
      provider: 'vobiz',
      source: 'session_end',
    });
    const compositeEvals = (await evalCalls()) - beforeComposite;

    expect(compositeOutcome).toBe('composite');
    expect(compositeEvals).toBe(1);

    // ── Fallback path ─────────────────────────────────────────────────────────
    // Forced by the `no_release_all` decline: a provider guard exposing only
    // `release`. Deliberately NOT forced via `isDegraded()` — that decline also
    // fires the composite as best-effort Redis cleanup, so it costs a mixed
    // 1 composite + 2 per-scope evals (the degraded core guard releases into a
    // process-local counter and skips Redis entirely) and would measure something
    // other than "three release evaluations". `provider: undefined` is no good
    // either: the fallback then skips the provider scope and costs two. Only this
    // decline exercises the genuine three-guard teardown the claim is about, and
    // it does so through the real guard classes rather than by breaking Redis.
    const fbPrefix = 'test:pcg-rel-helper-c-fb:';
    const fbReal = realGuards(fbPrefix);
    await fbReal.providerConcurrencyGuard.tryAcquireAll('rel-c-fb', TENANT, ACCOUNT, 'vobiz');

    const fallbackGuards = {
      concurrencyGuard: fbReal.concurrencyGuard,
      accountConcurrencyGuard: fbReal.accountConcurrencyGuard,
      providerConcurrencyGuard: {
        release: (c: string, t: string, a: string, p: string) =>
          fbReal.providerConcurrencyGuard.release(c, t, a, p),
      },
    };

    const beforeFallback = await evalCalls();
    const fallbackOutcome = await releaseTelephonyLease(fallbackGuards, {
      concurrencyKey: 'rel-c-fb',
      tenantId: TENANT,
      accountId: ACCOUNT,
      provider: 'vobiz',
      source: 'session_end',
    });
    const fallbackEvals = (await evalCalls()) - beforeFallback;

    expect(fallbackOutcome).toBe('fallback');
    expect(fallbackEvals).toBe(3);
    expect(fallbackEvals).toBe(compositeEvals * 3);

    // The saving is in round trips only — the fallback must still fully release.
    await expect(redis.get(`${fbPrefix}active_calls`)).resolves.toBe('0');
    await expect(redis.get(`${fbPrefix}active_calls:account:${TENANT}:${ACCOUNT}`)).resolves.toBe('0');
    await expect(redis.get(`${fbPrefix}active_calls:provider:${TENANT}:${ACCOUNT}:vobiz`))
      .resolves.toBe('0');
  });

  it('treats a mismatched concurrency key as a terminal noop that releases nothing', async () => {
    const redis = getTestRedis();
    const prefix = 'test:pcg-rel-helper-d:';
    const guards = realGuards(prefix);

    await guards.providerConcurrencyGuard.tryAcquireAll('rel-d-real', TENANT, ACCOUNT, 'vobiz');

    // Releasing under the wrong key is the exact observable signature of key-format
    // drift between the composite and the two individual guard classes: the DELs
    // hit keys nobody wrote, `scopes` comes back 0, and the helper reports `noop`.
    // `noop` is TERMINAL — no per-scope fallback runs — so the lease survives with
    // nothing having failed and nothing logged as an error. That silence is why
    // tests A and B (which pin the formats together) are the real defence; this
    // test documents the failure mode they prevent.
    await expect(releaseTelephonyLease(guards, {
      concurrencyKey: 'rel-d-wrong',
      tenantId: TENANT,
      accountId: ACCOUNT,
      provider: 'vobiz',
      source: 'session_end',
    })).resolves.toBe('noop');

    await expect(redis.get(`${prefix}active_calls`)).resolves.toBe('1');
    await expect(redis.get(`${prefix}active_calls:account:${TENANT}:${ACCOUNT}`)).resolves.toBe('1');
    await expect(redis.get(`${prefix}active_calls:provider:${TENANT}:${ACCOUNT}:vobiz`))
      .resolves.toBe('1');

    // The correct key still settles it exactly once, so the lease was parked by the
    // noop rather than corrupted.
    await expect(releaseTelephonyLease(guards, {
      concurrencyKey: 'rel-d-real',
      tenantId: TENANT,
      accountId: ACCOUNT,
      provider: 'vobiz',
      source: 'session_end',
    })).resolves.toBe('composite');
    await expect(redis.get(`${prefix}active_calls`)).resolves.toBe('0');
    await expect(redis.get(`${prefix}active_calls:provider:${TENANT}:${ACCOUNT}:vobiz`))
      .resolves.toBe('0');
  });

  it('reports `partial` on a mismatched account, having released only the global scope', async () => {
    const redis = getTestRedis();
    const prefix = 'test:pcg-rel-helper-e:';
    const guards = realGuards(prefix);

    await guards.providerConcurrencyGuard.tryAcquireAll('rel-e-1', TENANT, ACCOUNT, 'vobiz');

    // The three scopes are NOT symmetric under a wrong tenant/account, and this is
    // the sharper edge of the mismatched-key family in test D. The account and
    // provider keys embed both ids, so those DELs miss — but the GLOBAL key is
    // `${prefix}active_calls:lock:<key>` with no tenant or account in it, so that
    // one still hits. `scopes` therefore comes back 1, not 0.
    //
    // One released scope can never be a complete lease (legacy holds 2, provider
    // mode 3), so this is reported as `partial`, NOT as the healthy `composite` —
    // which also arms the self-heal sweep to reconcile the two survivors. An
    // earlier revision of this test asserted `composite` here and documented that
    // as a known lie; the classification was fixed in review instead.
    await expect(releaseTelephonyLease(guards, {
      concurrencyKey: 'rel-e-1',
      tenantId: TENANT,
      accountId: 'account-someone-else',
      provider: 'vobiz',
      source: 'session_end',
    })).resolves.toBe('partial');

    await expect(redis.get(`${prefix}active_calls`)).resolves.toBe('0');
    await expect(redis.get(`${prefix}active_calls:account:${TENANT}:${ACCOUNT}`)).resolves.toBe('1');
    await expect(redis.get(`${prefix}active_calls:provider:${TENANT}:${ACCOUNT}:vobiz`))
      .resolves.toBe('1');

    // Replaying with the right scope mops up the two survivors, and reports
    // `composite` — 2 scopes, which is a complete legacy lease and therefore
    // indistinguishable from a provider-mode partial. That residual ambiguity is
    // documented on TelephonyReleaseOutcome and is why only `1` is flagged.
    await expect(releaseTelephonyLease(guards, {
      concurrencyKey: 'rel-e-1',
      tenantId: TENANT,
      accountId: ACCOUNT,
      provider: 'vobiz',
      source: 'session_end',
    })).resolves.toBe('composite');
    await expect(redis.get(`${prefix}active_calls:account:${TENANT}:${ACCOUNT}`)).resolves.toBe('0');
    await expect(redis.get(`${prefix}active_calls:provider:${TENANT}:${ACCOUNT}:vobiz`))
      .resolves.toBe('0');
    // Floored, not driven negative, by the global DEL that already missed.
    await expect(redis.get(`${prefix}active_calls`)).resolves.toBe('0');
  });
});
