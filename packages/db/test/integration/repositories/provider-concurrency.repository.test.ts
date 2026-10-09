import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { uuidFor } from '../setup/factories.js';

// Tenant/account labels are wrapped in `uuidFor` (UUID columns).
// Provider names ('vobiz', 'twilio') are opaque allocation keys.

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

const {
  ConcurrencyAllocationVersionConflictError,
  providerConcurrencyRepository,
} = await import('../../../src/repositories/provider-concurrency.repository.js');

describe('providerConcurrencyRepository (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('replaces the provider breakdown atomically and derives the account total', async () => {
    const saved = await providerConcurrencyRepository.replaceProviderBreakdown({
      tenant_id: uuidFor('tenant-1'),
      account_id: uuidFor('account-1'),
      expected_version: 1,
      providers: [
        { provider: 'vobiz', max_concurrent_calls: 30 },
        { provider: 'voicelink', max_concurrent_calls: 20 },
      ],
    });

    expect(saved).toMatchObject({
      mode: 'provider_breakdown',
      version: 2,
      total_concurrency: 50,
    });
    expect(saved.providers).toEqual([
      { provider: 'vobiz', max_concurrent_calls: 30 },
      { provider: 'voicelink', max_concurrent_calls: 20 },
    ]);
    expect(await providerConcurrencyRepository.getProviderLimit(
      uuidFor('tenant-1'), uuidFor('account-1'), 'vobiz',
    )).toEqual({ mode: 'provider_breakdown', limit: 30, total: 50, version: 2 });
    expect(await providerConcurrencyRepository.getProviderLimit(
      uuidFor('tenant-1'), uuidFor('account-1'), 'twilio',
    )).toEqual({ mode: 'provider_breakdown', limit: null, total: 50, version: 2 });
  });

  it('rejects stale writers without changing the stored allocation', async () => {
    await providerConcurrencyRepository.replaceProviderBreakdown({
      tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1'), expected_version: 1,
      providers: [{ provider: 'vobiz', max_concurrent_calls: 30 }],
    });

    await expect(providerConcurrencyRepository.replaceProviderBreakdown({
      tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1'), expected_version: 1,
      providers: [{ provider: 'vobiz', max_concurrent_calls: 99 }],
    })).rejects.toBeInstanceOf(ConcurrencyAllocationVersionConflictError);

    const current = await providerConcurrencyRepository.getAllocation(uuidFor('tenant-1'), uuidFor('account-1'));
    expect(current.total_concurrency).toBe(30);
    expect(current.version).toBe(2);
  });

  it('can create a missing legacy allocation and preserves the last provider snapshot', async () => {
    await providerConcurrencyRepository.replaceProviderBreakdown({
      tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1'), expected_version: 1,
      providers: [{ provider: 'vobiz', max_concurrent_calls: 30 }],
    });
    const legacy = await providerConcurrencyRepository.switchToLegacy({
      tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1'), expected_version: 2,
      max_concurrent_calls: 12,
    });
    expect(legacy).toMatchObject({ mode: 'legacy_total', version: 3, total_concurrency: 12 });

    const rows = await getTestPool().query(
      `SELECT * FROM account_provider_concurrency_allocations
        WHERE tenant_id = $1 AND account_id = $2`,
      [uuidFor('tenant-1'), uuidFor('account-1')],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ telephony_provider: 'vobiz', max_concurrent_calls: 30 });
    expect(legacy.providers).toEqual([{ provider: 'vobiz', max_concurrent_calls: 30 }]);

    const created = await providerConcurrencyRepository.switchToLegacy({
      tenant_id: uuidFor('tenant-2'), account_id: uuidFor('account-2'), expected_version: 1,
      max_concurrent_calls: 7,
    });
    expect(created).toMatchObject({ mode: 'legacy_total', version: 2, total_concurrency: 7 });
  });
});
