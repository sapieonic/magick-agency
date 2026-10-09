import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { uuidFor } from '../setup/factories.js';

/*
 * Real-Postgres coverage of `accountSettingsRepository.setRecordingAnalysisToggles`,
 * the toggles-only writer the super-admin settings route uses instead of a
 * read-concurrency-then-`upsert`.
 *
 * The first case is the race itself, on the real `upsert` SQL: the old pattern
 * reverts a concurrency write that lands between its read and its write. The rest
 * pin that the new writer cannot, and its COALESCE / insert / write-through.
 */

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

const { accountSettingsRepository } = await import('../../../src/repositories/account-settings.repository.js');
const { providerConcurrencyRepository } = await import('../../../src/repositories/provider-concurrency.repository.js');

const T = uuidFor('toggles-writer-tenant');
const A = uuidFor('toggles-writer-account');

async function row() {
  const { rows } = await getTestPool().query(
    `SELECT max_concurrent_calls, concurrency_allocation_version, allow_recording, analyze_calls,
            webrtc_max_duration_seconds
       FROM account_settings WHERE tenant_id = $1 AND account_id = $2`,
    [T, A],
  );
  return rows[0];
}

describe('accountSettingsRepository.setRecordingAnalysisToggles (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    accountSettingsRepository.clearCache();
    await accountSettingsRepository.upsert({ tenant_id: T, account_id: A, max_concurrent_calls: 5 });
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('the race it closes: read-concurrency-then-upsert undoes a concurrency write that lands in between', async () => {
    const read = await accountSettingsRepository.getMaxConcurrentCalls(T, A); // 5
    await providerConcurrencyRepository.switchToLegacy({
      tenant_id: T, account_id: A, expected_version: 1, max_concurrent_calls: 20,
    });
    expect(await row()).toMatchObject({ max_concurrent_calls: 20, concurrency_allocation_version: 2 });

    // The upsert-everything pattern, which the route no longer uses.
    await accountSettingsRepository.upsert({ tenant_id: T, account_id: A, max_concurrent_calls: read, allow_recording: true });

    expect(await row()).toMatchObject({ max_concurrent_calls: 5, concurrency_allocation_version: 3 });
  });

  it('the toggles-only writer leaves a concurrency write that landed first exactly as written', async () => {
    await providerConcurrencyRepository.switchToLegacy({
      tenant_id: T, account_id: A, expected_version: 1, max_concurrent_calls: 20,
    });

    await accountSettingsRepository.setRecordingAnalysisToggles(T, A, { allow_recording: true, analyze_calls: false });

    expect(await row()).toMatchObject({
      max_concurrent_calls: 20, concurrency_allocation_version: 2, allow_recording: true, analyze_calls: false,
    });
  });

  it('is a PATCH: an omitted or null toggle keeps its stored value', async () => {
    await accountSettingsRepository.setRecordingAnalysisToggles(T, A, { allow_recording: true, analyze_calls: true });
    await accountSettingsRepository.setRecordingAnalysisToggles(T, A, { analyze_calls: false });
    expect(await row()).toMatchObject({ allow_recording: true, analyze_calls: false });

    await accountSettingsRepository.setRecordingAnalysisToggles(T, A, { allow_recording: null, analyze_calls: true });
    expect(await row()).toMatchObject({ allow_recording: true, analyze_calls: true });
  });

  it('creates the row at the column defaults when the account has none', async () => {
    const other = uuidFor('toggles-writer-fresh-account');
    const record = await accountSettingsRepository.setRecordingAnalysisToggles(T, other, { allow_recording: false });

    expect(record).toMatchObject({
      tenant_id: T, account_id: other, max_concurrent_calls: 5, concurrency_allocation_version: 1,
      allow_recording: false, analyze_calls: null, webrtc_max_duration_seconds: null,
    });
  });

  it('writes through the row cache: the next cached read sees the toggles', async () => {
    await accountSettingsRepository.getAllowRecording(T, A); // warm the cache (NULL)
    await accountSettingsRepository.setRecordingAnalysisToggles(T, A, { allow_recording: true, analyze_calls: true });
    // Change the row behind the cache: a cached read must return the written value.
    await getTestPool().query(
      `UPDATE account_settings SET allow_recording = false WHERE tenant_id = $1 AND account_id = $2`, [T, A],
    );

    expect(await accountSettingsRepository.getAllowRecording(T, A)).toBe(true);
    expect(await accountSettingsRepository.getAnalyzeCalls(T, A)).toBe(true);
  });
});
