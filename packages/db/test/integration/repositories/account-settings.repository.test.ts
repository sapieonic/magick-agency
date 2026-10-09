import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAccountSettings, uuidFor } from '../setup/factories.js';

/*
 * Ids: every free-form tenant/account label is wrapped in `uuidFor(label)`
 * and `uniqueKey()` returns UUIDs (the baseline types both columns UUID).
 * `default_ai_pipeline` is not a column. The getter cases cover
 * `getWebrtcMaxDurationSeconds` (seeded directly because the upsert does not
 * write it); the COALESCE and write-through cases use `analyze_calls`.
 */

// Redirect repository to test database
vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

// Must import AFTER vi.mock
const { accountSettingsRepository } = await import('../../../src/repositories/account-settings.repository.js');

describe('accountSettingsRepository (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    // truncateAll wipes the DB but NOT the repository's in-process row cache, so
    // clear it too — otherwise a row cached under a reused (tenant, account) in a
    // prior test would be served here instead of the freshly-inserted/absent row.
    accountSettingsRepository.clearCache();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  describe('upsert', () => {
    it('inserts new settings and returns the record', async () => {
      const result = await accountSettingsRepository.upsert({
        tenant_id: uuidFor('tenant-1'),
        account_id: uuidFor('account-1'),
        max_concurrent_calls: 10,
      });

      expect(result.id).toBeDefined();
      expect(result.tenant_id).toBe(uuidFor('tenant-1'));
      expect(result.account_id).toBe(uuidFor('account-1'));
      expect(result.max_concurrent_calls).toBe(10);
      expect(result.created_at).toBeDefined();
      expect(result.updated_at).toBeDefined();
    });

    it('updates on conflict (same tenant + account)', async () => {
      // Insert initial settings
      const initial = await accountSettingsRepository.upsert({
        tenant_id: uuidFor('tenant-1'),
        account_id: uuidFor('account-1'),
        max_concurrent_calls: 5,
      });

      expect(initial.max_concurrent_calls).toBe(5);

      // Upsert with new value — same tenant+account key
      const updated = await accountSettingsRepository.upsert({
        tenant_id: uuidFor('tenant-1'),
        account_id: uuidFor('account-1'),
        max_concurrent_calls: 20,
      });

      expect(updated.tenant_id).toBe(uuidFor('tenant-1'));
      expect(updated.account_id).toBe(uuidFor('account-1'));
      expect(updated.max_concurrent_calls).toBe(20);

      // Verify only one row exists in DB
      const pool = getTestPool();
      const { rows } = await pool.query(
        'SELECT * FROM account_settings WHERE tenant_id = $1 AND account_id = $2',
        [uuidFor('tenant-1'), uuidFor('account-1')]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].max_concurrent_calls).toBe(20);
    });

    it('allows different accounts under the same tenant to have independent settings', async () => {
      await accountSettingsRepository.upsert({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-A'), max_concurrent_calls: 3 });
      await accountSettingsRepository.upsert({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-B'), max_concurrent_calls: 15 });

      const settingsA = await accountSettingsRepository.findByTenantAndAccount(uuidFor('tenant-1'), uuidFor('account-A'));
      const settingsB = await accountSettingsRepository.findByTenantAndAccount(uuidFor('tenant-1'), uuidFor('account-B'));

      expect(settingsA!.max_concurrent_calls).toBe(3);
      expect(settingsB!.max_concurrent_calls).toBe(15);
    });
  });

  describe('getMaxConcurrentCalls', () => {
    it('returns the configured value when settings exist', async () => {
      await insertAccountSettings({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1'), max_concurrent_calls: 12 });

      const maxCalls = await accountSettingsRepository.getMaxConcurrentCalls(uuidFor('tenant-1'), uuidFor('account-1'));
      expect(maxCalls).toBe(12);
    });

    it('returns default 5 when no settings exist for tenant+account', async () => {
      const maxCalls = await accountSettingsRepository.getMaxConcurrentCalls(uuidFor('nonexistent-tenant'), uuidFor('nonexistent-account'));
      expect(maxCalls).toBe(5);
    });

    it('returns correct value after an upsert update', async () => {
      await accountSettingsRepository.upsert({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1'), max_concurrent_calls: 5 });
      await accountSettingsRepository.upsert({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1'), max_concurrent_calls: 25 });

      const maxCalls = await accountSettingsRepository.getMaxConcurrentCalls(uuidFor('tenant-1'), uuidFor('account-1'));
      expect(maxCalls).toBe(25);
    });
  });

  describe('webrtc_max_duration_seconds', () => {
    it('getWebrtcMaxDurationSeconds returns the configured value', async () => {
      await insertAccountSettings({
        tenant_id: uuidFor('tenant-1'),
        account_id: uuidFor('account-1'),
        max_concurrent_calls: 5,
        webrtc_max_duration_seconds: 900,
      });
      expect(await accountSettingsRepository.getWebrtcMaxDurationSeconds(uuidFor('tenant-1'), uuidFor('account-1'))).toBe(900);
    });

    it('getWebrtcMaxDurationSeconds returns null when no row exists', async () => {
      expect(await accountSettingsRepository.getWebrtcMaxDurationSeconds(uuidFor('nope'), uuidFor('nope'))).toBeNull();
    });

    it('getWebrtcMaxDurationSeconds returns null when the row has no override', async () => {
      await insertAccountSettings({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-1'), max_concurrent_calls: 5 });
      expect(await accountSettingsRepository.getWebrtcMaxDurationSeconds(uuidFor('tenant-1'), uuidFor('account-1'))).toBeNull();
    });
  });

  describe('findByTenantAndAccount', () => {
    it('returns the settings record when it exists', async () => {
      const inserted = await insertAccountSettings({ tenant_id: uuidFor('tenant-find'), account_id: uuidFor('account-find'), max_concurrent_calls: 8 });

      const found = await accountSettingsRepository.findByTenantAndAccount(uuidFor('tenant-find'), uuidFor('account-find'));

      expect(found).not.toBeNull();
      expect(found!.id).toBe(inserted.id);
      expect(found!.max_concurrent_calls).toBe(8);
    });

    it('returns null when no settings exist for tenant+account', async () => {
      const found = await accountSettingsRepository.findByTenantAndAccount(uuidFor('no-such-tenant'), uuidFor('no-such-account'));
      expect(found).toBeNull();
    });

    it('does not return settings for a different account', async () => {
      await insertAccountSettings({ tenant_id: uuidFor('tenant-1'), account_id: uuidFor('account-X'), max_concurrent_calls: 7 });

      const found = await accountSettingsRepository.findByTenantAndAccount(uuidFor('tenant-1'), uuidFor('account-Y'));
      expect(found).toBeNull();
    });
  });

  // Unique (tenant, account) per test so the repository's in-process row cache
  // (60s TTL, not reset by truncateAll) never carries a stale value between tests.
  const uniqueKey = () => ({ tenant_id: randomUUID(), account_id: randomUUID() });

  describe('analyze_calls / allow_recording toggles', () => {
    it('persists analyze_calls and allow_recording on the insert path', async () => {
      const key = uniqueKey();
      const result = await accountSettingsRepository.upsert({
        ...key,
        max_concurrent_calls: 5,
        analyze_calls: false,
        allow_recording: true,
      });
      expect(result.analyze_calls).toBe(false);
      expect(result.allow_recording).toBe(true);
    });

    it('defaults both toggles to NULL when not specified (inherit env default)', async () => {
      const key = uniqueKey();
      const result = await accountSettingsRepository.upsert({ ...key, max_concurrent_calls: 5 });
      expect(result.analyze_calls).toBeNull();
      expect(result.allow_recording).toBeNull();
    });

    it('getAnalyzeCalls / getAllowRecording return the stored values', async () => {
      const key = uniqueKey();
      await insertAccountSettings({ ...key, max_concurrent_calls: 5, analyze_calls: true, allow_recording: false });
      accountSettingsRepository.invalidate(key.tenant_id, key.account_id); // drop any negative cache from a prior read

      expect(await accountSettingsRepository.getAnalyzeCalls(key.tenant_id, key.account_id)).toBe(true);
      expect(await accountSettingsRepository.getAllowRecording(key.tenant_id, key.account_id)).toBe(false);
    });

    it('getAnalyzeCalls / getAllowRecording return null when no row exists', async () => {
      const key = uniqueKey();
      expect(await accountSettingsRepository.getAnalyzeCalls(key.tenant_id, key.account_id)).toBeNull();
      expect(await accountSettingsRepository.getAllowRecording(key.tenant_id, key.account_id)).toBeNull();
    });

    it('getAnalyzeCalls / getAllowRecording return null when the columns are NULL', async () => {
      const key = uniqueKey();
      await insertAccountSettings({ ...key, max_concurrent_calls: 5 }); // no toggles → NULL columns
      accountSettingsRepository.invalidate(key.tenant_id, key.account_id);

      expect(await accountSettingsRepository.getAnalyzeCalls(key.tenant_id, key.account_id)).toBeNull();
      expect(await accountSettingsRepository.getAllowRecording(key.tenant_id, key.account_id)).toBeNull();
    });

    it('COALESCE preserves analyze_calls/allow_recording when a concurrency-only update omits them', async () => {
      const key = uniqueKey();
      await accountSettingsRepository.upsert({
        ...key,
        max_concurrent_calls: 5,
        analyze_calls: true,
        allow_recording: false,
      });

      // Update only max_concurrent_calls — the two optional fields are omitted.
      const updated = await accountSettingsRepository.upsert({ ...key, max_concurrent_calls: 42 });

      expect(updated.max_concurrent_calls).toBe(42);
      expect(updated.analyze_calls).toBe(true);
      expect(updated.allow_recording).toBe(false);
    });

    it('can flip a previously-set toggle by passing an explicit value on update', async () => {
      const key = uniqueKey();
      await accountSettingsRepository.upsert({ ...key, max_concurrent_calls: 5, allow_recording: true });

      const updated = await accountSettingsRepository.upsert({ ...key, max_concurrent_calls: 5, allow_recording: false });
      expect(updated.allow_recording).toBe(false);
    });
  });

  describe('in-process row cache semantics', () => {
    it('upsert write-through: a fresh findByTenantAndAccount reflects the upserted row', async () => {
      const key = uniqueKey();
      const upserted = await accountSettingsRepository.upsert({
        ...key,
        max_concurrent_calls: 9,
        analyze_calls: true,
      });

      // No DB round-trip needed for correctness — the write-through seeded the cache —
      // but the value must equal the persisted row.
      const found = await accountSettingsRepository.findByTenantAndAccount(key.tenant_id, key.account_id);
      expect(found!.id).toBe(upserted.id);
      expect(found!.max_concurrent_calls).toBe(9);
      expect(found!.analyze_calls).toBe(true);
    });

    it('invalidate + re-read still returns the persisted row (re-loaded from DB)', async () => {
      const key = uniqueKey();
      const upserted = await accountSettingsRepository.upsert({ ...key, max_concurrent_calls: 11 });

      // Force the next read to bypass the write-through and hit the DB.
      accountSettingsRepository.invalidate(key.tenant_id, key.account_id);

      const found = await accountSettingsRepository.findByTenantAndAccount(key.tenant_id, key.account_id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(upserted.id);
      expect(found!.max_concurrent_calls).toBe(11);
    });

    it('getMaxConcurrentCalls bypasses the cache and sees an out-of-band DB change; findByTenantAndAccount stays cached until invalidate', async () => {
      const key = uniqueKey();
      await accountSettingsRepository.upsert({ ...key, max_concurrent_calls: 5 });

      // Out-of-band UPDATE (as another replica would do), bypassing the repository.
      const pool = getTestPool();
      await pool.query(
        'UPDATE account_settings SET max_concurrent_calls = $1 WHERE tenant_id = $2 AND account_id = $3',
        [77, key.tenant_id, key.account_id],
      );

      // getMaxConcurrentCalls reads the DB directly → sees the new value immediately.
      expect(await accountSettingsRepository.getMaxConcurrentCalls(key.tenant_id, key.account_id)).toBe(77);

      // findByTenantAndAccount is still serving the cached (pre-update) row.
      expect((await accountSettingsRepository.findByTenantAndAccount(key.tenant_id, key.account_id))!.max_concurrent_calls).toBe(5);

      // After invalidate it re-loads and reflects the out-of-band change.
      accountSettingsRepository.invalidate(key.tenant_id, key.account_id);
      expect((await accountSettingsRepository.findByTenantAndAccount(key.tenant_id, key.account_id))!.max_concurrent_calls).toBe(77);
    });
  });

  describe('unique constraint on (tenant_id, account_id)', () => {
    it('throws on direct SQL duplicate insert', async () => {
      const pool = getTestPool();

      await pool.query(
        `INSERT INTO account_settings (id, tenant_id, account_id, max_concurrent_calls)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), uuidFor('tenant-dup'), uuidFor('account-dup'), 5]
      );

      await expect(
        pool.query(
          `INSERT INTO account_settings (id, tenant_id, account_id, max_concurrent_calls)
           VALUES ($1, $2, $3, $4)`,
          [randomUUID(), uuidFor('tenant-dup'), uuidFor('account-dup'), 10]
        )
      ).rejects.toThrow();
    });
  });
});
