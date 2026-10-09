import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { uuidFor } from '../setup/factories.js';

/*
 * NEW (magick-agency, lane A, authorised by the lead): real-Postgres coverage of
 * `accountSettingsRepository.setWebrtcMaxDurationSeconds`, the writer half of
 * `getWebrtcMaxDurationSeconds` (plan §3.2 moved core's
 * `webrtc_max_duration_seconds` flag onto `account_settings`). No core source.
 *
 * Pins: insert-or-update on `(tenant_id, account_id)`; the write touches ONLY
 * this column (concurrency, its mode/version and both toggles keep their
 * values); the TtlCache write-through (the next cached read on this process sees
 * it, without a DB round trip); the baseline CHECK (`> 0`) still refuses what a
 * route would never send. The route's 60..14400 bound is the route's, tested
 * with the route.
 */

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

const { accountSettingsRepository } = await import('../../../src/repositories/account-settings.repository.js');

const T = uuidFor('webrtc-writer-tenant');
const A = uuidFor('webrtc-writer-account');

async function row() {
  const { rows } = await getTestPool().query(
    `SELECT max_concurrent_calls, analyze_calls, allow_recording, concurrency_allocation_mode,
            concurrency_allocation_version, webrtc_max_duration_seconds
       FROM account_settings WHERE tenant_id = $1 AND account_id = $2`,
    [T, A],
  );
  return rows[0];
}

describe('accountSettingsRepository.setWebrtcMaxDurationSeconds (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    accountSettingsRepository.clearCache();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('creates the row at the column defaults when the account has none', async () => {
    const record = await accountSettingsRepository.setWebrtcMaxDurationSeconds(T, A, 900);

    expect(record.webrtc_max_duration_seconds).toBe(900);
    expect(await row()).toEqual({
      max_concurrent_calls: 5,
      analyze_calls: null,
      allow_recording: null,
      concurrency_allocation_mode: 'legacy_total',
      concurrency_allocation_version: 1,
      webrtc_max_duration_seconds: 900,
    });
  });

  it('updates ONLY this column on an existing row (concurrency, mode, version and toggles unchanged)', async () => {
    await accountSettingsRepository.upsert({
      tenant_id: T, account_id: A, max_concurrent_calls: 17, analyze_calls: true, allow_recording: false,
    });
    await getTestPool().query(
      `UPDATE account_settings SET concurrency_allocation_version = 4 WHERE tenant_id = $1 AND account_id = $2`,
      [T, A],
    );
    const before = await getTestPool().query(
      `SELECT updated_at FROM account_settings WHERE tenant_id = $1 AND account_id = $2`, [T, A],
    );

    await accountSettingsRepository.setWebrtcMaxDurationSeconds(T, A, 14_400);

    expect(await row()).toEqual({
      max_concurrent_calls: 17,
      analyze_calls: true,
      allow_recording: false,
      concurrency_allocation_mode: 'legacy_total',
      concurrency_allocation_version: 4,
      webrtc_max_duration_seconds: 14_400,
    });
    const after = await getTestPool().query(
      `SELECT updated_at FROM account_settings WHERE tenant_id = $1 AND account_id = $2`, [T, A],
    );
    expect(new Date(after.rows[0].updated_at).getTime())
      .toBeGreaterThanOrEqual(new Date(before.rows[0].updated_at).getTime());
  });

  it('writes through the row cache: the next cached read sees the new value without a stale copy', async () => {
    await accountSettingsRepository.setWebrtcMaxDurationSeconds(T, A, 600);
    expect(await accountSettingsRepository.getWebrtcMaxDurationSeconds(T, A)).toBe(600);

    await accountSettingsRepository.setWebrtcMaxDurationSeconds(T, A, 1_800);
    // Change the row behind the cache: a cached read must return the written value.
    await getTestPool().query(
      `UPDATE account_settings SET webrtc_max_duration_seconds = 61 WHERE tenant_id = $1 AND account_id = $2`,
      [T, A],
    );
    expect(await accountSettingsRepository.getWebrtcMaxDurationSeconds(T, A)).toBe(1_800);
  });

  it('the baseline CHECK refuses a non-positive value (23514)', async () => {
    await expect(accountSettingsRepository.setWebrtcMaxDurationSeconds(T, A, 0))
      .rejects.toMatchObject({ code: '23514' });
  });
});
