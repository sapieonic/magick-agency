import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { providerConcurrencyRepository } from '@magick-agency/db/repositories/provider-concurrency.repository';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { uuidFor } from '../../../../../packages/db/test/integration/setup/factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { ConcurrencyGuard } from '../../../src/core/concurrency-guard.js';
import { AccountConcurrencyGuard } from '../../../src/core/account-concurrency-guard.js';
import { ProviderConcurrencyGuard } from '../../../src/core/provider-concurrency-guard.js';
import { acquireTelephonyConcurrency } from '../../../src/core/telephony-concurrency.js';
import { releaseTelephonyLease } from '../../../src/core/telephony-release.js';

/**
 * The concurrency guards are the only
 * admitter on agency's VoiceLink account, so this proves every refusal
 * scope against REAL Redis (6383, non-zero db) and REAL Postgres limits (5436):
 * `account_settings.max_concurrent_calls` and `account_provider_concurrency_allocations`
 * rows, read by the real repositories — nothing is mocked.
 *
 * Two admission entry points, each refused at each scope:
 *   - `acquireTelephonyConcurrency` with an owner made of the three real guards and
 *     NO `tryAcquireTelephonyConcurrency` (the per-scope compatibility path:
 *     global → account → provider, rolling back what it took on a refusal);
 *   - `ProviderConcurrencyGuard.tryAcquireAll` (provider mode: one Lua transaction
 *     over all three scopes, which increments nothing on a refusal).
 * Plus the release side: `releaseTelephonyLease` frees every scope either path took.
 *
 * The guard integration suite at
 * `test/integration/flows/concurrency-guards.test.ts` never drives the
 * compatibility funnel, and never refuses `global_full` or `provider_unallocated`.
 */

const PREFIX = 'ma-test:scopes:';
const TIMEOUT = 60;
const PROVIDER = 'voicelink';

const TENANT = uuidFor('scopes-tenant');
const LEGACY_ACCOUNT = uuidFor('scopes-legacy-account');
const PROVIDER_ACCOUNT = uuidFor('scopes-provider-account');

/** The three production guards on ONE client and ONE prefix, as the server builds them. */
function realGuards(globalLimit: number) {
  const redis = getTestRedis();
  return {
    concurrencyGuard: new ConcurrencyGuard(redis, PREFIX, globalLimit, TIMEOUT),
    accountConcurrencyGuard: new AccountConcurrencyGuard(redis, PREFIX, TIMEOUT),
    providerConcurrencyGuard: new ProviderConcurrencyGuard(redis, PREFIX, TIMEOUT, globalLimit),
  };
}

async function seedLegacy(accountId: string, maxConcurrentCalls: number): Promise<void> {
  await getTestPool().query(
    `INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls, concurrency_allocation_mode)
     VALUES ($1, $2, $3, 'legacy_total')`,
    [TENANT, accountId, maxConcurrentCalls],
  );
}

/** Provider mode through the real write path (total = sum of the rows). */
async function seedProviderMode(
  accountId: string,
  providers: Array<{ provider: string; max_concurrent_calls: number }>,
  expectedVersion = 1,
): Promise<void> {
  await providerConcurrencyRepository.replaceProviderBreakdown({
    tenant_id: TENANT,
    account_id: accountId,
    expected_version: expectedVersion,
    providers,
  });
}

async function counters(accountId: string) {
  const redis = getTestRedis();
  const read = async (key: string) => Number.parseInt((await redis.get(key)) ?? '0', 10);
  return {
    global: await read(`${PREFIX}active_calls`),
    account: await read(`${PREFIX}active_calls:account:${TENANT}:${accountId}`),
    provider: await read(`${PREFIX}active_calls:provider:${TENANT}:${accountId}:${PROVIDER}`),
  };
}

async function locksFor(callId: string, accountId: string): Promise<number> {
  return getTestRedis().exists(
    `${PREFIX}active_calls:lock:${callId}`,
    `${PREFIX}active_calls:account:${TENANT}:${accountId}:lock:${callId}`,
    `${PREFIX}active_calls:provider:${TENANT}:${accountId}:${PROVIDER}:lock:${callId}`,
  );
}

describe('telephony guard scopes against real Redis + Postgres (integration)', () => {
  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  });

  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
  });

  afterAll(async () => {
    await closePool();
    await closeTestPool();
    await closeTestRedis();
  });

  describe('acquireTelephonyConcurrency — per-scope compatibility path (no tryAcquireTelephonyConcurrency)', () => {
    it('refuses global_full when maxConcurrentCalls is reached, taking no account scope', async () => {
      await seedLegacy(LEGACY_ACCOUNT, 5);
      const owner = realGuards(1);

      // `newlyAcquired: false` is the real guard's answer for a legacy account on this
      // path: the real provider guard's single-scope `tryAcquire` reports legacy as
      // `{ acquired, providerScoped: false, newlyAcquired: false }` and the funnel forwards it.
      await expect(acquireTelephonyConcurrency(owner, 'g-1', TENANT, LEGACY_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'acquired', providerScoped: false, newlyAcquired: false });
      await expect(acquireTelephonyConcurrency(owner, 'g-2', TENANT, LEGACY_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'global_full', providerScoped: false });

      expect(await counters(LEGACY_ACCOUNT)).toEqual({ global: 1, account: 1, provider: 0 });
      expect(await locksFor('g-2', LEGACY_ACCOUNT)).toBe(0);
    });

    it('refuses account_full at account_settings.max_concurrent_calls (legacy mode) and rolls the global scope back', async () => {
      await seedLegacy(LEGACY_ACCOUNT, 1);
      const owner = realGuards(10);

      // `newlyAcquired: false` is the real guard's answer for a legacy account on this
      // path: the real provider guard's single-scope `tryAcquire` reports legacy as
      // `{ acquired, providerScoped: false, newlyAcquired: false }` and the funnel forwards it.
      await expect(acquireTelephonyConcurrency(owner, 'a-1', TENANT, LEGACY_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'acquired', providerScoped: false, newlyAcquired: false });
      const before = await counters(LEGACY_ACCOUNT);
      expect(before).toEqual({ global: 1, account: 1, provider: 0 });

      await expect(acquireTelephonyConcurrency(owner, 'a-2', TENANT, LEGACY_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'account_full', providerScoped: false });

      // The global slot `a-2` took first is handed back: the counter is where it was.
      expect(await counters(LEGACY_ACCOUNT)).toEqual(before);
      expect(await owner.concurrencyGuard.getCurrentCount()).toBe(1);
      expect(await locksFor('a-2', LEGACY_ACCOUNT)).toBe(0);
    });

    it('refuses provider_full at the voicelink allocation and rolls the account and global scopes back', async () => {
      // total = 2 (voicelink 1 + other 1), so the account scope has room and only
      // the provider scope can refuse.
      await seedProviderMode(PROVIDER_ACCOUNT, [
        { provider: PROVIDER, max_concurrent_calls: 1 },
        { provider: 'other-carrier', max_concurrent_calls: 1 },
      ]);
      const owner = realGuards(10);

      await expect(acquireTelephonyConcurrency(owner, 'p-1', TENANT, PROVIDER_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: true });
      const before = await counters(PROVIDER_ACCOUNT);
      expect(before).toEqual({ global: 1, account: 1, provider: 1 });

      await expect(acquireTelephonyConcurrency(owner, 'p-2', TENANT, PROVIDER_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'provider_full', providerScoped: true });

      expect(await counters(PROVIDER_ACCOUNT)).toEqual(before);
      expect(await locksFor('p-2', PROVIDER_ACCOUNT)).toBe(0);
    });

    it('refuses provider_unallocated in provider mode with no voicelink row, holding nothing', async () => {
      await seedProviderMode(PROVIDER_ACCOUNT, [{ provider: 'other-carrier', max_concurrent_calls: 2 }]);
      const owner = realGuards(10);

      await expect(acquireTelephonyConcurrency(owner, 'u-1', TENANT, PROVIDER_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'provider_unallocated', providerScoped: true });

      expect(await counters(PROVIDER_ACCOUNT)).toEqual({ global: 0, account: 0, provider: 0 });
      expect(await locksFor('u-1', PROVIDER_ACCOUNT)).toBe(0);
    });

    it('releaseTelephonyLease frees every scope the compatibility path took (legacy: 2, provider mode: 3)', async () => {
      await seedLegacy(LEGACY_ACCOUNT, 5);
      await seedProviderMode(PROVIDER_ACCOUNT, [{ provider: PROVIDER, max_concurrent_calls: 2 }]);
      const owner = realGuards(10);

      await acquireTelephonyConcurrency(owner, 'r-legacy', TENANT, LEGACY_ACCOUNT, PROVIDER);
      await acquireTelephonyConcurrency(owner, 'r-provider', TENANT, PROVIDER_ACCOUNT, PROVIDER);
      expect(await locksFor('r-legacy', LEGACY_ACCOUNT)).toBe(2);
      expect(await locksFor('r-provider', PROVIDER_ACCOUNT)).toBe(3);
      expect(await owner.concurrencyGuard.getCurrentCount()).toBe(2);

      await expect(releaseTelephonyLease(owner, {
        concurrencyKey: 'r-legacy', tenantId: TENANT, accountId: LEGACY_ACCOUNT, provider: PROVIDER, source: 'session_end',
      })).resolves.toBe('composite');
      await expect(releaseTelephonyLease(owner, {
        concurrencyKey: 'r-provider', tenantId: TENANT, accountId: PROVIDER_ACCOUNT, provider: PROVIDER, source: 'session_end',
      })).resolves.toBe('composite');

      expect(await counters(LEGACY_ACCOUNT)).toEqual({ global: 0, account: 0, provider: 0 });
      expect(await counters(PROVIDER_ACCOUNT)).toEqual({ global: 0, account: 0, provider: 0 });
      expect(await locksFor('r-legacy', LEGACY_ACCOUNT)).toBe(0);
      expect(await locksFor('r-provider', PROVIDER_ACCOUNT)).toBe(0);
    });
  });

  describe('ProviderConcurrencyGuard.tryAcquireAll — provider mode (one transaction)', () => {
    it('refuses global_full when the global limit is reached', async () => {
      await seedProviderMode(PROVIDER_ACCOUNT, [{ provider: PROVIDER, max_concurrent_calls: 5 }]);
      const { providerConcurrencyGuard } = realGuards(1);

      await expect(providerConcurrencyGuard.tryAcquireAll('cg-1', TENANT, PROVIDER_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: true });
      await expect(providerConcurrencyGuard.tryAcquireAll('cg-2', TENANT, PROVIDER_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'global_full', providerScoped: true });

      expect(await counters(PROVIDER_ACCOUNT)).toEqual({ global: 1, account: 1, provider: 1 });
      expect(await locksFor('cg-2', PROVIDER_ACCOUNT)).toBe(0);
    });

    it('refuses account_full at the account total, leaving the global counter where it was', async () => {
      // Reachable without an impossible fixture: a call on another carrier is still
      // live (draining) when the operator moves that capacity to voicelink, so the
      // account total is reached while voicelink still has room.
      await seedProviderMode(PROVIDER_ACCOUNT, [
        { provider: PROVIDER, max_concurrent_calls: 1 },
        { provider: 'other-carrier', max_concurrent_calls: 1 },
      ]);
      const { providerConcurrencyGuard } = realGuards(10);
      await expect(providerConcurrencyGuard.tryAcquireAll('ca-other', TENANT, PROVIDER_ACCOUNT, 'other-carrier'))
        .resolves.toMatchObject({ result: 'acquired' });
      await expect(providerConcurrencyGuard.tryAcquireAll('ca-1', TENANT, PROVIDER_ACCOUNT, PROVIDER))
        .resolves.toMatchObject({ result: 'acquired' });

      await seedProviderMode(PROVIDER_ACCOUNT, [{ provider: PROVIDER, max_concurrent_calls: 2 }], 2);
      await providerConcurrencyGuard.invalidateLimits(TENANT, PROVIDER_ACCOUNT);

      const before = await counters(PROVIDER_ACCOUNT);
      expect(before).toEqual({ global: 2, account: 2, provider: 1 });

      await expect(providerConcurrencyGuard.tryAcquireAll('ca-2', TENANT, PROVIDER_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'account_full', providerScoped: true });

      expect(await counters(PROVIDER_ACCOUNT)).toEqual(before);
      expect(await locksFor('ca-2', PROVIDER_ACCOUNT)).toBe(0);
    });

    it('refuses provider_full at the voicelink allocation', async () => {
      await seedProviderMode(PROVIDER_ACCOUNT, [
        { provider: PROVIDER, max_concurrent_calls: 1 },
        { provider: 'other-carrier', max_concurrent_calls: 1 },
      ]);
      const { providerConcurrencyGuard } = realGuards(10);

      await expect(providerConcurrencyGuard.tryAcquireAll('cp-1', TENANT, PROVIDER_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: true });
      await expect(providerConcurrencyGuard.tryAcquireAll('cp-2', TENANT, PROVIDER_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'provider_full', providerScoped: true });

      expect(await counters(PROVIDER_ACCOUNT)).toEqual({ global: 1, account: 1, provider: 1 });
      expect(await locksFor('cp-2', PROVIDER_ACCOUNT)).toBe(0);
    });

    it('refuses provider_unallocated in provider mode with no voicelink row, touching no counter', async () => {
      await seedProviderMode(PROVIDER_ACCOUNT, [{ provider: 'other-carrier', max_concurrent_calls: 2 }]);
      const { providerConcurrencyGuard } = realGuards(10);

      await expect(providerConcurrencyGuard.tryAcquireAll('cu-1', TENANT, PROVIDER_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'provider_unallocated', providerScoped: true });

      expect(await counters(PROVIDER_ACCOUNT)).toEqual({ global: 0, account: 0, provider: 0 });
      expect(await locksFor('cu-1', PROVIDER_ACCOUNT)).toBe(0);
    });

    it('releaseTelephonyLease frees all three scopes of a composite lease, and the capacity is real', async () => {
      await seedProviderMode(PROVIDER_ACCOUNT, [{ provider: PROVIDER, max_concurrent_calls: 1 }]);
      const guards = realGuards(10);

      await guards.providerConcurrencyGuard.tryAcquireAll('cr-1', TENANT, PROVIDER_ACCOUNT, PROVIDER);
      expect(await counters(PROVIDER_ACCOUNT)).toEqual({ global: 1, account: 1, provider: 1 });
      await expect(guards.providerConcurrencyGuard.tryAcquireAll('cr-2', TENANT, PROVIDER_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'account_full', providerScoped: true });

      await expect(releaseTelephonyLease(guards, {
        concurrencyKey: 'cr-1', tenantId: TENANT, accountId: PROVIDER_ACCOUNT, provider: PROVIDER, source: 'session_end',
      })).resolves.toBe('composite');

      expect(await counters(PROVIDER_ACCOUNT)).toEqual({ global: 0, account: 0, provider: 0 });
      expect(await locksFor('cr-1', PROVIDER_ACCOUNT)).toBe(0);
      await expect(guards.providerConcurrencyGuard.tryAcquireAll('cr-2', TENANT, PROVIDER_ACCOUNT, PROVIDER))
        .resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: true });
    });
  });
});
