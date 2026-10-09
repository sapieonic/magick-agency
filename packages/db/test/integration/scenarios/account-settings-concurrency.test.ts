import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAccountSettings, uuidFor } from '../setup/factories.js';

// Tenant/account labels are wrapped in `uuidFor` (UUID columns), and the one
// inline-literal SQL check binds them as parameters.

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

const { accountSettingsRepository } = await import('../../../src/repositories/account-settings.repository.js');

describe('Account settings and concurrency scenarios (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  // ── Upsert behavior ──────────────────────────────────────────────────

  describe('upsert', () => {
    it('creates new settings when none exist', async () => {
      const settings = await accountSettingsRepository.upsert(
        { tenant_id: uuidFor('new-t'), account_id: uuidFor('new-a'), max_concurrent_calls: 10 },
      );

      expect(settings).not.toBeNull();
      expect(settings!.tenant_id).toBe(uuidFor('new-t'));
      expect(settings!.account_id).toBe(uuidFor('new-a'));
      expect(Number(settings!.max_concurrent_calls)).toBe(10);
    });

    it('updates existing settings', async () => {
      await insertAccountSettings({
        tenant_id: uuidFor('upd-t'),
        account_id: uuidFor('upd-a'),
        max_concurrent_calls: 5,
      });

      const updated = await accountSettingsRepository.upsert(
        { tenant_id: uuidFor('upd-t'), account_id: uuidFor('upd-a'), max_concurrent_calls: 20 },
      );

      expect(Number(updated!.max_concurrent_calls)).toBe(20);
    });

    it('upsert is idempotent — same value twice has no side effect', async () => {
      await accountSettingsRepository.upsert({ tenant_id: uuidFor('idem-t'), account_id: uuidFor('idem-a'), max_concurrent_calls: 15 });
      const second = await accountSettingsRepository.upsert({ tenant_id: uuidFor('idem-t'), account_id: uuidFor('idem-a'), max_concurrent_calls: 15 });

      expect(Number(second!.max_concurrent_calls)).toBe(15);

      // Only one row exists
      const pool = getTestPool();
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM account_settings WHERE tenant_id = $1 AND account_id = $2`,
        [uuidFor('idem-t'), uuidFor('idem-a')],
      );
      expect(rows[0].count).toBe(1);
    });
  });

  // ── findByTenantAccount ───────────────────────────────────────────────

  describe('findByTenantAccount', () => {
    it('returns settings for existing tenant+account', async () => {
      await insertAccountSettings({
        tenant_id: uuidFor('find-t'),
        account_id: uuidFor('find-a'),
        max_concurrent_calls: 8,
      });

      const found = await accountSettingsRepository.findByTenantAndAccount(uuidFor('find-t'), uuidFor('find-a'));
      expect(found).not.toBeNull();
      expect(Number(found!.max_concurrent_calls)).toBe(8);
    });

    it('returns null for non-existent tenant+account', async () => {
      const found = await accountSettingsRepository.findByTenantAndAccount(uuidFor('no-t'), uuidFor('no-a'));
      expect(found).toBeNull();
    });
  });

  // ── Per-account isolation ─────────────────────────────────────────────

  describe('per-account isolation', () => {
    it('different accounts under same tenant have independent settings', async () => {
      await accountSettingsRepository.upsert({ tenant_id: uuidFor('shared-t'), account_id: uuidFor('acc-X'), max_concurrent_calls: 5 });
      await accountSettingsRepository.upsert({ tenant_id: uuidFor('shared-t'), account_id: uuidFor('acc-Y'), max_concurrent_calls: 20 });

      const settingsX = await accountSettingsRepository.findByTenantAndAccount(uuidFor('shared-t'), uuidFor('acc-X'));
      const settingsY = await accountSettingsRepository.findByTenantAndAccount(uuidFor('shared-t'), uuidFor('acc-Y'));

      expect(Number(settingsX!.max_concurrent_calls)).toBe(5);
      expect(Number(settingsY!.max_concurrent_calls)).toBe(20);
    });

    it('different tenants have independent settings', async () => {
      await accountSettingsRepository.upsert({ tenant_id: uuidFor('tenant-A'), account_id: uuidFor('acc-1'), max_concurrent_calls: 3 });
      await accountSettingsRepository.upsert({ tenant_id: uuidFor('tenant-B'), account_id: uuidFor('acc-1'), max_concurrent_calls: 50 });

      const settingsA = await accountSettingsRepository.findByTenantAndAccount(uuidFor('tenant-A'), uuidFor('acc-1'));
      const settingsB = await accountSettingsRepository.findByTenantAndAccount(uuidFor('tenant-B'), uuidFor('acc-1'));

      expect(Number(settingsA!.max_concurrent_calls)).toBe(3);
      expect(Number(settingsB!.max_concurrent_calls)).toBe(50);
    });
  });

  // ── Concurrency limit ranges ──────────────────────────────────────────

  describe('concurrency limit ranges', () => {
    it('stores minimum concurrency (1)', async () => {
      const settings = await accountSettingsRepository.upsert({ tenant_id: uuidFor('min-t'), account_id: uuidFor('min-a'), max_concurrent_calls: 1 });
      expect(Number(settings!.max_concurrent_calls)).toBe(1);
    });

    it('stores high concurrency limit', async () => {
      const settings = await accountSettingsRepository.upsert({ tenant_id: uuidFor('max-t'), account_id: uuidFor('max-a'), max_concurrent_calls: 1000 });
      expect(Number(settings!.max_concurrent_calls)).toBe(1000);
    });

    it('updating from high to low works', async () => {
      await accountSettingsRepository.upsert({ tenant_id: uuidFor('swing-t'), account_id: uuidFor('swing-a'), max_concurrent_calls: 100 });
      const updated = await accountSettingsRepository.upsert({ tenant_id: uuidFor('swing-t'), account_id: uuidFor('swing-a'), max_concurrent_calls: 2 });
      expect(Number(updated!.max_concurrent_calls)).toBe(2);
    });
  });

  // ── Settings with default values ──────────────────────────────────────

  describe('default behavior', () => {
    it('accounts without settings should get default concurrency (tested at application layer)', async () => {
      // No settings inserted for this tenant/account
      const settings = await accountSettingsRepository.findByTenantAndAccount(uuidFor('no-settings-t'), uuidFor('no-settings-a'));
      expect(settings).toBeNull();
      // Application layer uses default of 5 when settings is null
    });
  });
});
