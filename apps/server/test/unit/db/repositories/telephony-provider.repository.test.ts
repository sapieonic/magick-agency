/*
 * The repository is READS ONLY: there is no `create`, `update` or
 * `findLiveTransferEnabledNames`, and no `metadata-cache` module. `getPool` is mocked at
 * `@magick-agency/db`. 'exposes the reads only' pins the absence of writers.
 *
 * It is also UNCACHED: a provider's `status` is flipped by a migration's UPDATE, and
 * the number-creation gate and the `?status=` listing must see the new value on the
 * next read. The Redis cache module is mocked only so a re-added cache read shows up
 * as a call here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  pool: { query: vi.fn() },
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}));

vi.mock('@magick-agency/db', () => ({ getPool: () => mocks.pool }));
vi.mock('../../../../src/cache/redis-cache.js', () => ({
  redisCache: { get: mocks.cacheGet, set: mocks.cacheSet, del: mocks.cacheDel },
}));

import { TelephonyProviderRepository } from '../../../../src/db/repositories/telephony-provider.repository.js';

const provider = {
  id: 'tp-1', name: 'plivo', display_name: 'Plivo',
  status: 'inactive' as const, created_at: new Date(), updated_at: new Date(),
};
const activated = { ...provider, status: 'active' as const };

function expectNoCache(): void {
  expect(mocks.cacheGet).not.toHaveBeenCalled();
  expect(mocks.cacheSet).not.toHaveBeenCalled();
}

describe('TelephonyProviderRepository', () => {
  let repo: TelephonyProviderRepository;

  beforeEach(() => {
    repo = new TelephonyProviderRepository();
    vi.clearAllMocks();
    // Queued one-shot rows survive `clearAllMocks`; a failing case must not leak them.
    mocks.pool.query.mockReset();
    // A stale entry, as a cache in front of these reads would hold one.
    mocks.cacheGet.mockResolvedValue(provider);
  });

  describe('findAll', () => {
    it('reads every provider from Postgres', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [provider] });
      expect(await repo.findAll()).toEqual([provider]);
      expect(mocks.pool.query).toHaveBeenCalledWith('SELECT * FROM telephony_providers ORDER BY name');
      expectNoCache();
    });

    it('filters by status in SQL, and a status flipped between reads shows on the next one', async () => {
      mocks.pool.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [activated] });
      expect(await repo.findAll('active')).toEqual([]);
      // The migration's UPDATE lands here.
      expect(await repo.findAll('active')).toEqual([activated]);
      expect(mocks.pool.query).toHaveBeenCalledTimes(2);
      expect(mocks.pool.query).toHaveBeenLastCalledWith(
        'SELECT * FROM telephony_providers WHERE status = $1 ORDER BY name', ['active'],
      );
      expectNoCache();
    });
  });

  describe('findById', () => {
    it('reads the row from Postgres every time, so an activated provider passes the gate at once', async () => {
      mocks.pool.query.mockResolvedValueOnce({ rows: [provider] }).mockResolvedValueOnce({ rows: [activated] });
      expect((await repo.findById('tp-1'))?.status).toBe('inactive');
      expect((await repo.findById('tp-1'))?.status).toBe('active');
      expect(mocks.pool.query).toHaveBeenCalledTimes(2);
      expect(mocks.pool.query).toHaveBeenLastCalledWith('SELECT * FROM telephony_providers WHERE id = $1', ['tp-1']);
      expectNoCache();
    });

    it('returns null for an unknown id', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      expect(await repo.findById('tp-999')).toBeNull();
      expectNoCache();
    });
  });

  describe('findByName', () => {
    it('reads the row from Postgres', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [activated] });
      expect(await repo.findByName('plivo')).toEqual(activated);
      expect(mocks.pool.query).toHaveBeenCalledWith('SELECT * FROM telephony_providers WHERE name = $1', ['plivo']);
      expectNoCache();
    });
  });

  // Pins the absence of every writer and of the live-transfer read, so a re-added `update` that writes
  // `live_transfer_enabled` — absent from the baseline — reds here
  // rather than failing on real Postgres.
  it('exposes the reads only — create, update and findLiveTransferEnabledNames are deleted', () => {
    const methods = Object.getOwnPropertyNames(TelephonyProviderRepository.prototype)
      .filter((m) => m !== 'constructor')
      .sort();
    expect(methods).toEqual(['findAll', 'findById', 'findByName']);
  });
});
