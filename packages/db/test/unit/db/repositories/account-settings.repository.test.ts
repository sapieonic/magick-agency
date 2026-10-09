import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock('../../../../src/connection.js', () => ({
  getPool: () => ({ query: mocks.query }),
}));

import { accountSettingsRepository } from '../../../../src/repositories/account-settings.repository.js';

// The getter cases exercise `getWebrtcMaxDurationSeconds` (a plain cached column
// read); there is no `analyze_dialer_calls` column (decision Q3b); the upsert
// binds 5 values. Ids stay non-UUID: the pool is mocked, nothing reaches Postgres.

const ROW = {
  tenant_id: 't1',
  account_id: 'a1',
  max_concurrent_calls: 7,
  webrtc_max_duration_seconds: 900,
  analyze_calls: true,
  allow_recording: false,
};

describe('accountSettingsRepository — row cache', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    // Every method uses a fresh (tenant, account) so tests don't share cache state.
    accountSettingsRepository.invalidate('t1', 'a1');
  });

  it('caches the row so repeated reads hit the DB once', async () => {
    mocks.query.mockResolvedValue({ rows: [ROW] });

    const a = await accountSettingsRepository.findByTenantAndAccount('t1', 'a1');
    const b = await accountSettingsRepository.findByTenantAndAccount('t1', 'a1');

    expect(a).toEqual(ROW);
    expect(b).toEqual(ROW);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('serves the three row-getters from a single cached read', async () => {
    accountSettingsRepository.invalidate('t2', 'a2');
    mocks.query.mockResolvedValue({ rows: [{ ...ROW, tenant_id: 't2', account_id: 'a2' }] });

    const [maxDuration, analyze, recording] = await Promise.all([
      accountSettingsRepository.getWebrtcMaxDurationSeconds('t2', 'a2'),
      accountSettingsRepository.getAnalyzeCalls('t2', 'a2'),
      accountSettingsRepository.getAllowRecording('t2', 'a2'),
    ]);

    expect(maxDuration).toBe(900);
    expect(analyze).toBe(true);
    expect(recording).toBe(false);
    // Concurrent row-getters collapse to one DB read via the cache's single-flight.
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('getMaxConcurrentCalls bypasses the cache (fresh DB read every call)', async () => {
    // The concurrency guard fronts this with its own cross-replica Redis cache
    // and invalidates it on settings change; serving a stale in-process row here
    // would re-poison that Redis cache. So it must read the DB directly.
    accountSettingsRepository.invalidate('t2b', 'a2b');
    mocks.query.mockResolvedValue({ rows: [{ max_concurrent_calls: 7 }] });

    await accountSettingsRepository.getMaxConcurrentCalls('t2b', 'a2b');
    await accountSettingsRepository.getMaxConcurrentCalls('t2b', 'a2b');

    // Two calls → two queries (not cached), and it selects only the limit column.
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect((mocks.query.mock.calls[0]![0] as string)).toMatch(/max_concurrent_calls/);
  });

  it('a cached row does NOT satisfy getMaxConcurrentCalls (no cross-cache poisoning)', async () => {
    accountSettingsRepository.invalidate('t2c', 'a2c');
    // Prime the row cache via a row-getter.
    mocks.query.mockResolvedValueOnce({ rows: [{ ...ROW, tenant_id: 't2c', account_id: 'a2c', max_concurrent_calls: 3 }] });
    await accountSettingsRepository.getAllowRecording('t2c', 'a2c');
    const callsAfterPrime = mocks.query.mock.calls.length;

    // Limit read must still hit the DB despite the primed row cache.
    mocks.query.mockResolvedValueOnce({ rows: [{ max_concurrent_calls: 3 }] });
    await accountSettingsRepository.getMaxConcurrentCalls('t2c', 'a2c');
    expect(mocks.query.mock.calls.length).toBe(callsAfterPrime + 1);
  });

  it('negatively caches a missing row (defaults) without re-querying', async () => {
    accountSettingsRepository.invalidate('t3', 'a3');
    mocks.query.mockResolvedValue({ rows: [] });

    expect(await accountSettingsRepository.getAllowRecording('t3', 'a3')).toBeNull(); // default (no row)
    expect(await accountSettingsRepository.findByTenantAndAccount('t3', 'a3')).toBeNull();
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it('write-through: upsert refreshes the row cache so the next row-getter sees the new value', async () => {
    accountSettingsRepository.invalidate('t4', 'a4');

    // Prime the cache with an initial row.
    mocks.query.mockResolvedValueOnce({ rows: [{ ...ROW, tenant_id: 't4', account_id: 'a4', allow_recording: false }] });
    expect(await accountSettingsRepository.getAllowRecording('t4', 'a4')).toBe(false);

    // Upsert returns the updated row; cache is seeded write-through.
    mocks.query.mockResolvedValueOnce({ rows: [{ ...ROW, tenant_id: 't4', account_id: 'a4', allow_recording: true }] });
    await accountSettingsRepository.upsert({ tenant_id: 't4', account_id: 'a4', max_concurrent_calls: 9, allow_recording: true });

    // Read served from the write-through cache — no additional SELECT.
    const callsBefore = mocks.query.mock.calls.length;
    expect(await accountSettingsRepository.getAllowRecording('t4', 'a4')).toBe(true);
    expect(mocks.query.mock.calls.length).toBe(callsBefore);
  });

  it('invalidate forces a fresh DB read', async () => {
    accountSettingsRepository.invalidate('t5', 'a5');
    mocks.query.mockResolvedValue({ rows: [{ ...ROW, tenant_id: 't5', account_id: 'a5' }] });

    await accountSettingsRepository.findByTenantAndAccount('t5', 'a5');
    accountSettingsRepository.invalidate('t5', 'a5');
    await accountSettingsRepository.findByTenantAndAccount('t5', 'a5');

    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it('findByTenantAndAccount issues a SELECT * scoped to (tenant, account)', async () => {
    accountSettingsRepository.invalidate('t-sel', 'a-sel');
    mocks.query.mockResolvedValue({ rows: [{ ...ROW, tenant_id: 't-sel', account_id: 'a-sel' }] });

    await accountSettingsRepository.findByTenantAndAccount('t-sel', 'a-sel');

    const sql = (mocks.query.mock.calls[0]![0] as string).replace(/\s+/g, ' ').trim();
    expect(sql).toMatch(/SELECT \* FROM account_settings WHERE tenant_id = \$1 AND account_id = \$2/);
    expect(mocks.query.mock.calls[0]![1]).toEqual(['t-sel', 'a-sel']);
  });

  it('does not share cache entries across different (tenant, account) keys', async () => {
    accountSettingsRepository.invalidate('tA', 'aA');
    accountSettingsRepository.invalidate('tB', 'aB');

    mocks.query.mockResolvedValueOnce({ rows: [{ ...ROW, tenant_id: 'tA', account_id: 'aA', allow_recording: true }] });
    mocks.query.mockResolvedValueOnce({ rows: [{ ...ROW, tenant_id: 'tB', account_id: 'aB', allow_recording: false }] });

    const a = await accountSettingsRepository.getAllowRecording('tA', 'aA');
    const b = await accountSettingsRepository.getAllowRecording('tB', 'aB');

    // Distinct keys → distinct cache slots → two separate DB reads.
    expect(a).toBe(true);
    expect(b).toBe(false);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  describe('per-getter null / false / value mapping', () => {
    it('maps a NULL webrtc_max_duration_seconds column to null (row present)', async () => {
      accountSettingsRepository.invalidate('tm1', 'am1');
      mocks.query.mockResolvedValue({ rows: [{ ...ROW, tenant_id: 'tm1', account_id: 'am1', webrtc_max_duration_seconds: null }] });
      expect(await accountSettingsRepository.getWebrtcMaxDurationSeconds('tm1', 'am1')).toBeNull();
    });

    it('returns the configured webrtc_max_duration_seconds value', async () => {
      accountSettingsRepository.invalidate('tm2', 'am2');
      mocks.query.mockResolvedValue({ rows: [{ ...ROW, tenant_id: 'tm2', account_id: 'am2', webrtc_max_duration_seconds: 2400 }] });
      expect(await accountSettingsRepository.getWebrtcMaxDurationSeconds('tm2', 'am2')).toBe(2400);
    });

    it('getWebrtcMaxDurationSeconds returns null when the row is absent', async () => {
      accountSettingsRepository.invalidate('tm3', 'am3');
      mocks.query.mockResolvedValue({ rows: [] });
      expect(await accountSettingsRepository.getWebrtcMaxDurationSeconds('tm3', 'am3')).toBeNull();
    });

    it('distinguishes analyze_calls false from true (and null on absent row)', async () => {
      accountSettingsRepository.invalidate('tm4', 'am4');
      accountSettingsRepository.invalidate('tm5', 'am5');
      accountSettingsRepository.invalidate('tm6', 'am6');

      mocks.query.mockResolvedValueOnce({ rows: [{ ...ROW, tenant_id: 'tm4', account_id: 'am4', analyze_calls: false }] });
      expect(await accountSettingsRepository.getAnalyzeCalls('tm4', 'am4')).toBe(false);

      mocks.query.mockResolvedValueOnce({ rows: [{ ...ROW, tenant_id: 'tm5', account_id: 'am5', analyze_calls: true }] });
      expect(await accountSettingsRepository.getAnalyzeCalls('tm5', 'am5')).toBe(true);

      mocks.query.mockResolvedValueOnce({ rows: [] });
      expect(await accountSettingsRepository.getAnalyzeCalls('tm6', 'am6')).toBeNull();
    });

    it('maps a NULL analyze_calls column to null (row present)', async () => {
      accountSettingsRepository.invalidate('tm7', 'am7');
      mocks.query.mockResolvedValue({ rows: [{ ...ROW, tenant_id: 'tm7', account_id: 'am7', analyze_calls: null }] });
      expect(await accountSettingsRepository.getAnalyzeCalls('tm7', 'am7')).toBeNull();
    });

    it('distinguishes allow_recording false from true (and null on absent row)', async () => {
      accountSettingsRepository.invalidate('tm8', 'am8');
      accountSettingsRepository.invalidate('tm9', 'am9');
      accountSettingsRepository.invalidate('tm10', 'am10');

      mocks.query.mockResolvedValueOnce({ rows: [{ ...ROW, tenant_id: 'tm8', account_id: 'am8', allow_recording: false }] });
      expect(await accountSettingsRepository.getAllowRecording('tm8', 'am8')).toBe(false);

      mocks.query.mockResolvedValueOnce({ rows: [{ ...ROW, tenant_id: 'tm9', account_id: 'am9', allow_recording: true }] });
      expect(await accountSettingsRepository.getAllowRecording('tm9', 'am9')).toBe(true);

      mocks.query.mockResolvedValueOnce({ rows: [] });
      expect(await accountSettingsRepository.getAllowRecording('tm10', 'am10')).toBeNull();
    });

    it('maps a NULL allow_recording column to null (row present)', async () => {
      accountSettingsRepository.invalidate('tm11', 'am11');
      mocks.query.mockResolvedValue({ rows: [{ ...ROW, tenant_id: 'tm11', account_id: 'am11', allow_recording: null }] });
      expect(await accountSettingsRepository.getAllowRecording('tm11', 'am11')).toBeNull();
    });
  });

  describe('getMaxConcurrentCalls', () => {
    it('returns the configured limit from a fresh DB read', async () => {
      accountSettingsRepository.invalidate('tmc1', 'amc1');
      mocks.query.mockResolvedValue({ rows: [{ max_concurrent_calls: 11 }] });
      expect(await accountSettingsRepository.getMaxConcurrentCalls('tmc1', 'amc1')).toBe(11);
    });

    it('returns the platform default of 5 when no row exists', async () => {
      accountSettingsRepository.invalidate('tmc2', 'amc2');
      mocks.query.mockResolvedValue({ rows: [] });
      expect(await accountSettingsRepository.getMaxConcurrentCalls('tmc2', 'amc2')).toBe(5);
    });

    it('selects ONLY the max_concurrent_calls column (not SELECT *) scoped to (tenant, account)', async () => {
      accountSettingsRepository.invalidate('tmc3', 'amc3');
      mocks.query.mockResolvedValue({ rows: [{ max_concurrent_calls: 4 }] });

      await accountSettingsRepository.getMaxConcurrentCalls('tmc3', 'amc3');

      const sql = (mocks.query.mock.calls[0]![0] as string).replace(/\s+/g, ' ').trim();
      expect(sql).toMatch(/SELECT max_concurrent_calls FROM account_settings WHERE tenant_id = \$1 AND account_id = \$2/);
      expect(sql).not.toMatch(/SELECT \*/);
      expect(mocks.query.mock.calls[0]![1]).toEqual(['tmc3', 'amc3']);
    });

    it('does not seed the row cache (a subsequent row-getter still queries)', async () => {
      accountSettingsRepository.invalidate('tmc4', 'amc4');

      mocks.query.mockResolvedValueOnce({ rows: [{ max_concurrent_calls: 6 }] });
      await accountSettingsRepository.getMaxConcurrentCalls('tmc4', 'amc4');

      // The limit read populated nothing cacheable — the row-getter must query too.
      mocks.query.mockResolvedValueOnce({ rows: [{ ...ROW, tenant_id: 'tmc4', account_id: 'amc4', allow_recording: true }] });
      expect(await accountSettingsRepository.getAllowRecording('tmc4', 'amc4')).toBe(true);

      expect(mocks.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('upsert write-through', () => {
    it('seeds the cache with the RETURNED row so the next row-getter needs no SELECT', async () => {
      accountSettingsRepository.invalidate('tu1', 'au1');
      mocks.query.mockResolvedValueOnce({
        rows: [{ ...ROW, tenant_id: 'tu1', account_id: 'au1', webrtc_max_duration_seconds: 1200, analyze_calls: true }],
      });

      await accountSettingsRepository.upsert({ tenant_id: 'tu1', account_id: 'au1', max_concurrent_calls: 3 });
      const callsAfterUpsert = mocks.query.mock.calls.length;

      // All three row-getters read straight from the write-through cache.
      expect(await accountSettingsRepository.getWebrtcMaxDurationSeconds('tu1', 'au1')).toBe(1200);
      expect(await accountSettingsRepository.getAnalyzeCalls('tu1', 'au1')).toBe(true);
      expect(await accountSettingsRepository.findByTenantAndAccount('tu1', 'au1')).toMatchObject({ account_id: 'au1' });
      expect(mocks.query.mock.calls.length).toBe(callsAfterUpsert);
    });

    it('write-throughs the RETURNED row even when the input omitted (NULL-preserving) fields', async () => {
      accountSettingsRepository.invalidate('tu2', 'au2');
      // Caller updates only max_concurrent_calls; DB's COALESCE preserves the
      // existing allow_recording=true, which the RETURNING row reflects.
      mocks.query.mockResolvedValueOnce({
        rows: [{ ...ROW, tenant_id: 'tu2', account_id: 'au2', allow_recording: true }],
      });

      await accountSettingsRepository.upsert({ tenant_id: 'tu2', account_id: 'au2', max_concurrent_calls: 5 });

      // The upsert passes null for the omitted fields (COALESCE = no change on update).
      const params = mocks.query.mock.calls[0]![1] as unknown[];
      expect(params).toEqual(['tu2', 'au2', 5, null, null]);

      const callsAfterUpsert = mocks.query.mock.calls.length;
      // The cached RETURNED row (not the null input) is what the getter sees.
      expect(await accountSettingsRepository.getAllowRecording('tu2', 'au2')).toBe(true);
      expect(mocks.query.mock.calls.length).toBe(callsAfterUpsert);
    });
  });

  it('listByTenant is uncached — a direct ORDER BY query every call', async () => {
    mocks.query.mockResolvedValue({ rows: [{ ...ROW }] });

    await accountSettingsRepository.listByTenant('t-list');
    await accountSettingsRepository.listByTenant('t-list');

    expect(mocks.query).toHaveBeenCalledTimes(2);
    const sql = (mocks.query.mock.calls[0]![0] as string).replace(/\s+/g, ' ').trim();
    expect(sql).toMatch(/SELECT \* FROM account_settings WHERE tenant_id = \$1 ORDER BY created_at DESC/);
    expect(mocks.query.mock.calls[0]![1]).toEqual(['t-list']);
  });
});

describe('accountSettingsRepository — TTL expiry (fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.query.mockReset();
    accountSettingsRepository.invalidate('tttl', 'attl');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-queries after the 60s TTL elapses, but serves from cache within it', async () => {
    mocks.query.mockResolvedValue({ rows: [{ ...ROW, tenant_id: 'tttl', account_id: 'attl' }] });

    await accountSettingsRepository.findByTenantAndAccount('tttl', 'attl');
    expect(mocks.query).toHaveBeenCalledTimes(1);

    // Just under the TTL: still cached.
    vi.advanceTimersByTime(59_000);
    await accountSettingsRepository.findByTenantAndAccount('tttl', 'attl');
    expect(mocks.query).toHaveBeenCalledTimes(1);

    // Past the 60s TTL: entry is stale → a fresh DB read.
    vi.advanceTimersByTime(2_000);
    await accountSettingsRepository.findByTenantAndAccount('tttl', 'attl');
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
});
