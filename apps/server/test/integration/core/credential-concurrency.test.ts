import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { closePool, initDbPool } from '@magick-agency/db';
import { providerConcurrencyRepository } from '@magick-agency/db/repositories/provider-concurrency.repository';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { uuidFor } from '../../../../../packages/db/test/integration/setup/factories.js';
import { TEST_REDIS_URL, closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { acquireTelephonyConcurrency } from '../../../src/core/telephony-concurrency.js';
import { releaseTelephonyLease } from '../../../src/core/telephony-release.js';
import { TelephonyGuardHost } from '../../../src/core/telephony-guard-host.js';
import { config } from '../../../src/config/index.js';
import { createConcurrencyControl } from '../../../src/core/voice-concurrency-control.js';
import { scopeRoom } from '../../../src/agency/pacing/dial-scopes.js';

// A dead media worker's reap (`cluster/primary.ts` `reapSlot`) hands its leases back through the
// voice engine's guard host: the engine is this file's host, and no agency runtime is running.
const voice = vi.hoisted(() => ({ guardHost: null as unknown }));
vi.mock('../../../src/bootstrap/voice.js', () => ({ getVoiceEngine: () => (voice.guardHost ? voice : null) }));
vi.mock('../../../src/bootstrap/agency.js', () => ({ getAgencyRuntime: () => null, configureAgencyRuntime: () => undefined }));
const { reapSlot } = await import('../../../src/cluster/primary.js');

/**
 * A tenant carrier account's own concurrency cap (docs/carriers.md CR13) against REAL Redis
 * (6383, non-zero db) and REAL Postgres (`telephony_credentials.max_concurrent_calls`, the
 * allocation rows), nothing mocked. The admission is the production `TelephonyGuardHost`'s, on the
 * real config's key prefix, so the Lua and the host's legacy path run as in production:
 *
 *  - provider mode: the credential scope is a fourth scope of the one composite transaction
 *    (every scope or none); legacy mode: taken after global and account, both handed back on a
 *    refusal;
 *  - the cap is tenant-wide: calls on two accounts of the tenant share it, and the service's own
 *    account (no credential) never touches it;
 *  - every call on a credential takes its lease and counter, capped or not, so a cap set on a
 *    carrier account with calls already live binds at once against them (no call admitted until
 *    fewer than the cap are live), and the super-admin's count reads them all;
 *  - release (four scopes in one transaction, the per-scope fallback), extend, the
 *    generation-fenced reconcile of a drifted counter, the repair of a partial lease;
 *  - races: many processes (each its own Redis connection and guard set) admitting at once never
 *    put more calls on the credential than its cap;
 *  - a cap lowered below the calls live ends none; new calls wait.
 */

const PREFIX = config.redis.keyPrefix;
const TENANT = uuidFor('cred-cap-tenant');
const ACCOUNT_A = uuidFor('cred-cap-account-a');
const ACCOUNT_B = uuidFor('cred-cap-account-b');
const PROVIDER = 'plivo';

/** The production guard host on one Redis connection (a media worker has its own). */
function host(redis: Redis = getTestRedis()) {
  return new TelephonyGuardHost(redis);
}
type Host = ReturnType<typeof host>;

const admit = (h: Host, key: string, accountId: string, credentialId: string | null, provider = PROVIDER) =>
  acquireTelephonyConcurrency(h, key, TENANT, accountId, provider, 600, credentialId);
const release = (h: Host, key: string, accountId: string, credentialId: string | null, provider = PROVIDER) =>
  releaseTelephonyLease(h, { concurrencyKey: key, tenantId: TENANT, accountId, provider, source: 'webrtc', credentialId });

async function seedProviderMode(accountId: string, limit = 10): Promise<void> {
  await providerConcurrencyRepository.replaceProviderBreakdown({
    tenant_id: TENANT, account_id: accountId, expected_version: 1,
    providers: [{ provider: PROVIDER, max_concurrent_calls: limit }, { provider: 'voicelink', max_concurrent_calls: limit }],
  });
}

async function seedLegacy(accountId: string, limit = 10): Promise<void> {
  await getTestPool().query(
    `INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls, concurrency_allocation_mode)
     VALUES ($1, $2, $3, 'legacy_total')`, [TENANT, accountId, limit]);
}

async function credential(cap: number | null): Promise<string> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref, max_concurrent_calls)
     VALUES ($1, 'plivo', $2, $3, $4) RETURNING id`,
    [TENANT, `cred-${Math.random().toString(36).slice(2, 8)}`, `MA${Math.random().toString(36).slice(2, 20).toUpperCase().padEnd(18, 'X')}`, cap]);
  return rows[0]!.id;
}

const read = async (key: string) => Number.parseInt((await getTestRedis().get(key)) ?? '0', 10);
const credentialCount = (id: string) => read(`${PREFIX}active_calls:credential:${id}`);
const credentialLock = (id: string, key: string) => `${PREFIX}active_calls:credential:${id}:lock:${key}`;
async function counters(accountId: string) {
  return {
    global: await read(`${PREFIX}active_calls`),
    account: await read(`${PREFIX}active_calls:account:${TENANT}:${accountId}`),
    provider: await read(`${PREFIX}active_calls:provider:${TENANT}:${accountId}:${PROVIDER}`),
  };
}

describe('a carrier account\'s own concurrency cap against real Redis + Postgres (CR13)', () => {
  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  });

  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
    await getTestPool().query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1, 'Cap', $2) ON CONFLICT (id) DO NOTHING`, [TENANT, `cap-${TENANT.slice(0, 8)}`]);
    await getTestPool().query(
      `INSERT INTO telephony_providers (name, display_name, status) VALUES ('voicelink', 'VoiceLink', 'active'), ('plivo', 'Plivo', 'active')
       ON CONFLICT (name) DO NOTHING`);
  });

  afterAll(async () => {
    await closePool();
    await closeTestPool();
    await closeTestRedis();
  });

  describe('provider mode: a fourth scope of the one transaction', () => {
    it('the cap binds across two accounts of the tenant; a refusal moves no counter; the service account is unaffected', async () => {
      await seedProviderMode(ACCOUNT_A);
      await seedProviderMode(ACCOUNT_B);
      const cred = await credential(2);
      const h = host();

      await expect(admit(h, 'a-1', ACCOUNT_A, cred)).resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: true });
      await expect(admit(h, 'b-1', ACCOUNT_B, cred)).resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: true });
      expect(await credentialCount(cred)).toBe(2);
      const beforeA = await counters(ACCOUNT_A);
      const beforeB = await counters(ACCOUNT_B);

      await expect(admit(h, 'a-2', ACCOUNT_A, cred)).resolves.toEqual({ result: 'credential_full', providerScoped: true });
      await expect(admit(h, 'b-2', ACCOUNT_B, cred)).resolves.toEqual({ result: 'credential_full', providerScoped: true });
      expect(await counters(ACCOUNT_A)).toEqual(beforeA);
      expect(await counters(ACCOUNT_B)).toEqual(beforeB);
      expect(await credentialCount(cred)).toBe(2);
      expect(await getTestRedis().exists(credentialLock(cred, 'a-2'), `${PREFIX}active_calls:lock:a-2`)).toBe(0);

      // The service's own account, same tenant and account: no credential, no credential scope.
      await expect(admit(h, 's-1', ACCOUNT_A, null, 'voicelink')).resolves.toMatchObject({ result: 'acquired' });
      expect(await credentialCount(cred)).toBe(2);

      // A call ends: its four scopes come back in one transaction, and the next call is admitted.
      await expect(release(h, 'a-1', ACCOUNT_A, cred)).resolves.toBe('composite');
      expect(await credentialCount(cred)).toBe(1);
      await expect(admit(h, 'b-2', ACCOUNT_B, cred)).resolves.toMatchObject({ result: 'acquired' });
    });

    it('releaseAll hands back four scopes for a call on a carrier account, capped or not', async () => {
      await seedProviderMode(ACCOUNT_A);
      const capped = await credential(3);
      const uncapped = await credential(null);
      const h = host();
      await admit(h, 'c-1', ACCOUNT_A, capped);
      await admit(h, 'u-1', ACCOUNT_A, uncapped);
      expect(await credentialCount(uncapped)).toBe(1);
      await expect(h.providerConcurrencyGuard.releaseAll('c-1', TENANT, ACCOUNT_A, PROVIDER, capped)).resolves.toEqual({ status: 'released', scopes: 4 });
      await expect(h.providerConcurrencyGuard.releaseAll('u-1', TENANT, ACCOUNT_A, PROVIDER, uncapped)).resolves.toEqual({ status: 'released', scopes: 4 });
      // Idempotent: a second teardown moves nothing.
      await expect(h.providerConcurrencyGuard.releaseAll('c-1', TENANT, ACCOUNT_A, PROVIDER, capped)).resolves.toEqual({ status: 'released', scopes: 0 });
      expect(await credentialCount(capped)).toBe(0);
      expect(await credentialCount(uncapped)).toBe(0);
      expect(await counters(ACCOUNT_A)).toEqual({ global: 0, account: 0, provider: 0 });
    });

    it('extendAll extends all four leases, and refuses (extending none) when the credential lease is gone', async () => {
      await seedProviderMode(ACCOUNT_A);
      const cred = await credential(2);
      const h = host();
      await admit(h, 'e-1', ACCOUNT_A, cred);
      const redis = getTestRedis();
      await expect(h.providerConcurrencyGuard.extendAll('e-1', TENANT, ACCOUNT_A, PROVIDER, 5_000, cred))
        .resolves.toBe(true);
      expect(await redis.ttl(credentialLock(cred, 'e-1'))).toBeGreaterThan(600);
      expect(await redis.ttl(`${PREFIX}active_calls:lock:e-1`)).toBeGreaterThan(600);

      await redis.del(credentialLock(cred, 'e-1'));
      const globalTtl = await redis.ttl(`${PREFIX}active_calls:lock:e-1`);
      await expect(h.providerConcurrencyGuard.extendAll('e-1', TENANT, ACCOUNT_A, PROVIDER, 9_000, cred))
        .resolves.toBe(false);
      expect(await redis.ttl(`${PREFIX}active_calls:lock:e-1`)).toBeLessThanOrEqual(globalTtl);
    });

    it('extendAll extends an uncapped call\'s credential lease with the others', async () => {
      await seedProviderMode(ACCOUNT_A);
      const cred = await credential(null);
      const h = host();
      await admit(h, 'eu-1', ACCOUNT_A, cred);
      await expect(h.providerConcurrencyGuard.extendAll('eu-1', TENANT, ACCOUNT_A, PROVIDER, 5_000, cred)).resolves.toBe(true);
      expect(await getTestRedis().ttl(credentialLock(cred, 'eu-1'))).toBeGreaterThan(600);
    });

    it('a partial lease (only the credential lease survived) is repaired, counters rebuilt, and the call re-admitted', async () => {
      await seedProviderMode(ACCOUNT_A);
      const cred = await credential(1);
      const h = host();
      await admit(h, 'p-1', ACCOUNT_A, cred);
      const redis = getTestRedis();
      // A non-atomic teardown that lost three of the four leases: their counters still say 1.
      await redis.del(`${PREFIX}active_calls:lock:p-1`, `${PREFIX}active_calls:account:${TENANT}:${ACCOUNT_A}:lock:p-1`,
        `${PREFIX}active_calls:provider:${TENANT}:${ACCOUNT_A}:${PROVIDER}:lock:p-1`);

      await expect(admit(h, 'p-1', ACCOUNT_A, cred)).resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: true });
      expect(await counters(ACCOUNT_A)).toEqual({ global: 1, account: 1, provider: 1 });
      expect(await credentialCount(cred)).toBe(1);
      expect(await redis.exists(credentialLock(cred, 'p-1'))).toBe(1);
    });

    it('an uncapped call\'s partial lease (its credential lease lost) is repaired, its counter rebuilt', async () => {
      await seedProviderMode(ACCOUNT_A);
      const cred = await credential(null);
      const h = host();
      await admit(h, 'pu-1', ACCOUNT_A, cred);
      await getTestRedis().del(credentialLock(cred, 'pu-1'));
      await expect(admit(h, 'pu-1', ACCOUNT_A, cred)).resolves.toEqual({ result: 'acquired', providerScoped: true, newlyAcquired: true });
      expect(await credentialCount(cred)).toBe(1);
      expect(await counters(ACCOUNT_A)).toEqual({ global: 1, account: 1, provider: 1 });
    });

    it('a partial lease missing only its credential lease is repaired too', async () => {
      await seedProviderMode(ACCOUNT_A);
      const cred = await credential(1);
      const h = host();
      await admit(h, 'q-1', ACCOUNT_A, cred);
      await getTestRedis().del(credentialLock(cred, 'q-1'));
      // The credential counter still reads 1 with no lease: a fresh call would be refused, but
      // the repair rebuilds it from the leases (0) before the retry.
      await expect(admit(h, 'q-1', ACCOUNT_A, cred)).resolves.toMatchObject({ result: 'acquired' });
      expect(await credentialCount(cred)).toBe(1);
      expect(await counters(ACCOUNT_A)).toEqual({ global: 1, account: 1, provider: 1 });
    });
  });

  describe('legacy mode: after the global and account scopes', () => {
    it('the cap binds across two legacy accounts, and a refusal hands global and account back', async () => {
      await seedLegacy(ACCOUNT_A);
      await seedLegacy(ACCOUNT_B);
      const cred = await credential(1);
      const h = host();
      await expect(admit(h, 'l-1', ACCOUNT_A, cred)).resolves.toMatchObject({ result: 'acquired' });
      const before = await counters(ACCOUNT_B);
      await expect(admit(h, 'l-2', ACCOUNT_B, cred)).resolves.toEqual({ result: 'credential_full', providerScoped: false });
      expect(await counters(ACCOUNT_B)).toEqual(before);
      expect(await read(`${PREFIX}active_calls`)).toBe(1);
      // Released through the composite: three scopes (no provider lease on a legacy account).
      await expect(release(h, 'l-1', ACCOUNT_A, cred)).resolves.toBe('composite');
      expect(await credentialCount(cred)).toBe(0);
      await expect(admit(h, 'l-2', ACCOUNT_B, cred)).resolves.toMatchObject({ result: 'acquired' });
    });

    it('an uncapped call on a legacy account takes and hands back its credential lease too', async () => {
      await seedLegacy(ACCOUNT_A);
      const cred = await credential(null);
      const h = host();
      await expect(admit(h, 'lu-1', ACCOUNT_A, cred)).resolves.toEqual({ result: 'acquired', providerScoped: false, newlyAcquired: true });
      await expect(admit(h, 'lu-2', ACCOUNT_A, cred)).resolves.toMatchObject({ result: 'acquired' });
      expect(await credentialCount(cred)).toBe(2);
      expect(await getTestRedis().exists(credentialLock(cred, 'lu-1'))).toBe(1);
      await expect(h.credentialConcurrencyGuard.getCounts([cred])).resolves.toEqual({ status: 'available', counts: new Map([[cred, 2]]) });
      await expect(release(h, 'lu-1', ACCOUNT_A, cred)).resolves.toBe('composite');
      expect(await credentialCount(cred)).toBe(1);
    });

    it('a provider-mode account and a legacy account of the tenant share one cap', async () => {
      await seedProviderMode(ACCOUNT_A);
      await seedLegacy(ACCOUNT_B);
      const cred = await credential(2);
      const h = host();
      await admit(h, 'm-1', ACCOUNT_A, cred);
      await admit(h, 'm-2', ACCOUNT_B, cred);
      await expect(admit(h, 'm-3', ACCOUNT_A, cred)).resolves.toMatchObject({ result: 'credential_full' });
      await expect(admit(h, 'm-4', ACCOUNT_B, cred)).resolves.toMatchObject({ result: 'credential_full' });
      expect(await credentialCount(cred)).toBe(2);
    });
  });

  describe('the per-scope fallback and the reconcile', () => {
    it('the per-scope release (composite declined) releases the credential lease too', async () => {
      await seedProviderMode(ACCOUNT_A);
      const cred = await credential(2);
      const h = host();
      await admit(h, 'f-1', ACCOUNT_A, cred);
      // No provider named: the composite is declined, every scope released through its own guard.
      await expect(releaseTelephonyLease(h, {
        concurrencyKey: 'f-1', tenantId: TENANT, accountId: ACCOUNT_A, provider: undefined, source: 'webrtc', credentialId: cred,
      })).resolves.toBe('fallback');
      expect(await credentialCount(cred)).toBe(0);
    });

    it('reconcileAll rebuilds a drifted counter from its leases and drops one with none, under the generation fence', async () => {
      await seedProviderMode(ACCOUNT_A);
      const live = await credential(5);
      const stale = await credential(5);
      const h = host();
      await admit(h, 'r-1', ACCOUNT_A, live);
      const redis = getTestRedis();
      // Crash drift: counters left high with their leases expired.
      await redis.set(`${PREFIX}active_calls:credential:${live}`, '4');
      await redis.set(`${PREFIX}active_calls:credential:${stale}`, '3');
      await expect(h.credentialConcurrencyGuard.reconcileAll()).resolves.toEqual({ credentialsChecked: 2, credentialsReconciled: 2 });
      expect(await credentialCount(live)).toBe(1);
      expect(await redis.exists(`${PREFIX}active_calls:credential:${stale}`)).toBe(0);
      // Clean now (the dropped counter left nothing to find).
      await expect(h.credentialConcurrencyGuard.reconcileAll()).resolves.toEqual({ credentialsChecked: 1, credentialsReconciled: 0 });
      // The other scopes' reconciles never read the credential keys as theirs.
      await expect(h.providerConcurrencyGuard.reconcileAll()).resolves.toMatchObject({ providersReconciled: 0 });
      await expect(h.accountConcurrencyGuard.reconcileAll()).resolves.toMatchObject({ accountsReconciled: 0 });
      await expect(h.concurrencyGuard.reconcile()).resolves.toMatchObject({ before: 1, after: 1 });
    });

    it('the per-scope release and the reconcile cover an uncapped credential\'s leases', async () => {
      await seedProviderMode(ACCOUNT_A);
      const cred = await credential(null);
      const h = host();
      for (const k of ['ur-1', 'ur-2', 'ur-3']) await admit(h, k, ACCOUNT_A, cred);
      expect(await credentialCount(cred)).toBe(3);
      await expect(releaseTelephonyLease(h, {
        concurrencyKey: 'ur-1', tenantId: TENANT, accountId: ACCOUNT_A, provider: undefined, source: 'webrtc', credentialId: cred,
      })).resolves.toBe('fallback');
      expect(await credentialCount(cred)).toBe(2);
      // Crash drift on the uncapped counter, both ways: rebuilt from its two live leases.
      const redis = getTestRedis();
      await redis.set(`${PREFIX}active_calls:credential:${cred}`, '9');
      await expect(h.credentialConcurrencyGuard.reconcileAll()).resolves.toEqual({ credentialsChecked: 1, credentialsReconciled: 1 });
      expect(await credentialCount(cred)).toBe(2);
      await redis.set(`${PREFIX}active_calls:credential:${cred}`, '0');
      await expect(h.reconcileConcurrency('periodic')).resolves.toBe(true);
      expect(await credentialCount(cred)).toBe(2);
    });

    it('a dead media worker\'s reap hands back its calls\' credential leases, capped or not', async () => {
      await seedProviderMode(ACCOUNT_A);
      await seedLegacy(ACCOUNT_B);
      const capped = await credential(5);
      const uncapped = await credential(null);
      const h = host();
      voice.guardHost = h;
      try {
        const held = [
          { key: 'w-1', accountId: ACCOUNT_A, credentialId: uncapped },
          { key: 'w-2', accountId: ACCOUNT_B, credentialId: uncapped },
          { key: 'w-3', accountId: ACCOUNT_A, credentialId: capped },
        ];
        for (const x of held) await admit(h, x.key, x.accountId, x.credentialId);
        expect(await credentialCount(uncapped)).toBe(2);
        await reapSlot({} as never, 1, null, held.map((x) => ({
          callId: x.key, concurrencyKey: x.key, tenantId: TENANT, accountId: x.accountId, provider: PROVIDER, credentialId: x.credentialId,
        })));
        expect(await credentialCount(uncapped)).toBe(0);
        expect(await credentialCount(capped)).toBe(0);
        expect(await getTestRedis().exists(credentialLock(uncapped, 'w-1'), credentialLock(uncapped, 'w-2'))).toBe(0);
        expect(await read(`${PREFIX}active_calls`)).toBe(0);
      } finally {
        voice.guardHost = null;
      }
    });

    it('getCounts reads the live calls per credential', async () => {
      await seedProviderMode(ACCOUNT_A);
      const a = await credential(5);
      const b = await credential(5);
      const h = host();
      await admit(h, 'g-1', ACCOUNT_A, a);
      await admit(h, 'g-2', ACCOUNT_A, a);
      await expect(h.credentialConcurrencyGuard.getCounts([a, b])).resolves.toEqual({ status: 'available', counts: new Map([[a, 2], [b, 0]]) });
    });
  });

  describe('races and changes', () => {
    it('many processes admitting at once never put more calls on the credential than its cap', async () => {
      await seedProviderMode(ACCOUNT_A, 100);
      await seedLegacy(ACCOUNT_B, 100);
      const CAP = 3;
      const cred = await credential(CAP);
      // Four "workers", each its own Redis connection and guard set, as media workers are.
      const conns = Array.from({ length: 4 }, () => new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 2 }));
      try {
        const hosts = conns.map((c) => host(c));
        for (let round = 0; round < 5; round++) {
          const attempts = Array.from({ length: 40 }, (_, i) => ({
            key: `race-${round}-${i}`, account: i % 2 === 0 ? ACCOUNT_A : ACCOUNT_B, h: hosts[i % hosts.length]!,
          }));
          const results = await Promise.all(attempts.map((x) => admit(x.h, x.key, x.account, cred)));
          const won = attempts.filter((_, i) => results[i]!.result === 'acquired');
          expect(won.length).toBe(CAP);
          expect(results.filter((r) => r.result !== 'acquired').every((r) => r.result === 'credential_full')).toBe(true);
          expect(await credentialCount(cred)).toBe(CAP);
          // The losers left nothing behind on any scope.
          expect(await read(`${PREFIX}active_calls`)).toBe(CAP);
          await Promise.all(won.map((x) => release(x.h, x.key, x.account, cred)));
          expect(await credentialCount(cred)).toBe(0);
          expect(await read(`${PREFIX}active_calls`)).toBe(0);
        }
      } finally {
        await Promise.all(conns.map((c) => c.quit()));
      }
    });

    it('a cap lowered below the calls live ends none of them; new calls wait until enough have ended', async () => {
      await seedProviderMode(ACCOUNT_A);
      const cred = await credential(3);
      const h = host();
      for (const k of ['d-1', 'd-2', 'd-3']) await admit(h, k, ACCOUNT_A, cred);
      await getTestPool().query('UPDATE telephony_credentials SET max_concurrent_calls = 1 WHERE id = $1', [cred]);
      // The write drops the cached cap, as the super-admin route does through the seam.
      h.credentialConcurrencyGuard.invalidateCap(cred);
      for (const k of ['d-1', 'd-2', 'd-3']) expect(await getTestRedis().exists(credentialLock(cred, k))).toBe(1);
      await expect(admit(h, 'd-5', ACCOUNT_A, cred)).resolves.toMatchObject({ result: 'credential_full' });
      await release(h, 'd-1', ACCOUNT_A, cred);
      await release(h, 'd-2', ACCOUNT_A, cred);
      await expect(admit(h, 'd-5', ACCOUNT_A, cred)).resolves.toMatchObject({ result: 'credential_full' });
      await release(h, 'd-3', ACCOUNT_A, cred);
      await expect(admit(h, 'd-5', ACCOUNT_A, cred)).resolves.toMatchObject({ result: 'acquired' });
      // Cleared: no cap of its own, so never full, but the call is still counted.
      await getTestPool().query('UPDATE telephony_credentials SET max_concurrent_calls = NULL WHERE id = $1', [cred]);
      h.credentialConcurrencyGuard.invalidateCap(cred);
      await expect(admit(h, 'd-6', ACCOUNT_A, cred)).resolves.toMatchObject({ result: 'acquired' });
      await expect(admit(h, 'd-7', ACCOUNT_A, cred)).resolves.toMatchObject({ result: 'acquired' });
      expect(await getTestRedis().exists(credentialLock(cred, 'd-6'))).toBe(1);
      expect(await credentialCount(cred)).toBe(3);
    });

    it.each(['provider_breakdown', 'legacy_total'] as const)(
      '%s: a cap set on a carrier account with 30 calls live admits none until fewer than 10 are live; the count reads 30',
      async (mode) => {
        if (mode === 'provider_breakdown') await seedProviderMode(ACCOUNT_A, 50);
        else await seedLegacy(ACCOUNT_A, 50);
        const cred = await credential(null);
        const h = host();
        const control = createConcurrencyControl(h);
        const live = Array.from({ length: 30 }, (_, i) => `live-${i}`);
        for (const k of live) await expect(admit(h, k, ACCOUNT_A, cred)).resolves.toMatchObject({ result: 'acquired' });
        // No cap: every call counted.
        await expect(control.getCredentialCounts([cred])).resolves.toEqual({ status: 'available', counts: new Map([[cred, 30]]) });

        // A super-admin sets max_concurrent_calls = 10 (the route writes, then drops the cached cap
        // through the seam).
        await getTestPool().query('UPDATE telephony_credentials SET max_concurrent_calls = 10 WHERE id = $1', [cred]);
        await control.invalidateCredentialLimit(cred);

        // The console's "N of M in use" reads 30, and pacing's room on the carrier account is 0.
        await expect(control.getCredentialCounts([cred])).resolves.toEqual({ status: 'available', counts: new Map([[cred, 30]]) });
        const reading = { key: `credential:${cred}`, kind: 'carrier_account' as const, limit: 10, live: 30, pendingAtSnapshot: 0, grantedAtSnapshot: 0 };
        expect(scopeRoom(reading, 0)).toBe(0);

        const before = await counters(ACCOUNT_A);
        await expect(admit(h, 'new-0', ACCOUNT_A, cred)).resolves.toMatchObject({ result: 'credential_full' });
        expect(await counters(ACCOUNT_A)).toEqual(before);
        // 20 end: 10 live, still full.
        for (const k of live.slice(0, 20)) await release(h, k, ACCOUNT_A, cred);
        expect(await credentialCount(cred)).toBe(10);
        await expect(admit(h, 'new-1', ACCOUNT_A, cred)).resolves.toMatchObject({ result: 'credential_full' });
        // One more ends: 9 live, and exactly one new call is admitted.
        await release(h, live[20]!, ACCOUNT_A, cred);
        await expect(admit(h, 'new-2', ACCOUNT_A, cred)).resolves.toMatchObject({ result: 'acquired' });
        await expect(admit(h, 'new-3', ACCOUNT_A, cred)).resolves.toMatchObject({ result: 'credential_full' });
        expect(await credentialCount(cred)).toBe(10);
      },
    );
  });
});
