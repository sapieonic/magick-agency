/*
 * The repository is READS ONLY: there is no `create`, `update` or
 * `findLiveTransferEnabledNames`, and no `metadata-cache` module. `getPool` is mocked at
 * `@magick-agency/db`. 'exposes the reads only' pins the absence of writers.
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
  id: 'tp-1', name: 'twilio', display_name: 'Twilio',
  status: 'active' as const, created_at: new Date(), updated_at: new Date(),
};

describe('TelephonyProviderRepository', () => {
  let repo: TelephonyProviderRepository;

  beforeEach(() => {
    repo = new TelephonyProviderRepository();
    vi.clearAllMocks();
    mocks.cacheGet.mockResolvedValue(null);
  });

  // ─── findAll ──────────────────────────────────────────────
  describe('findAll', () => {
    it('should return cached providers on hit', async () => {
      mocks.cacheGet.mockResolvedValue([provider]);
      const result = await repo.findAll();
      expect(result).toEqual([provider]);
      expect(mocks.pool.query).not.toHaveBeenCalled();
    });

    it('should query DB on cache miss and cache result', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [provider] });
      const result = await repo.findAll();
      expect(result).toEqual([provider]);
      expect(mocks.cacheSet).toHaveBeenCalledWith('cache:telco:v2:all:any', [provider], 24 * 60 * 60);
    });

    it('should use status-specific cache key', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [provider] });
      await repo.findAll('active');
      expect(mocks.cacheGet).toHaveBeenCalledWith('cache:telco:v2:all:active');
      expect(mocks.cacheSet).toHaveBeenCalledWith('cache:telco:v2:all:active', [provider], 24 * 60 * 60);
    });

    it('should not write back on cache hit', async () => {
      mocks.cacheGet.mockResolvedValue([provider]);
      await repo.findAll();
      expect(mocks.cacheSet).not.toHaveBeenCalled();
    });
  });

  // ─── findById ─────────────────────────────────────────────
  describe('findById', () => {
    it('should return cached provider on hit', async () => {
      mocks.cacheGet.mockResolvedValue(provider);
      const result = await repo.findById('tp-1');
      expect(result).toEqual(provider);
      expect(mocks.pool.query).not.toHaveBeenCalled();
    });

    it('should query DB on miss and cache', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [provider] });
      const result = await repo.findById('tp-1');
      expect(result).toEqual(provider);
      expect(mocks.cacheSet).toHaveBeenCalledWith('cache:telco:v2:id:tp-1', provider, 24 * 60 * 60);
    });

    it('should not cache null result', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [] });
      const result = await repo.findById('tp-999');
      expect(result).toBeNull();
      expect(mocks.cacheSet).not.toHaveBeenCalled();
    });
  });

  // ─── findByName ───────────────────────────────────────────
  describe('findByName', () => {
    it('should return cached provider on hit', async () => {
      mocks.cacheGet.mockResolvedValue(provider);
      const result = await repo.findByName('twilio');
      expect(result).toEqual(provider);
      expect(mocks.pool.query).not.toHaveBeenCalled();
    });

    it('should query DB on miss and cache', async () => {
      mocks.pool.query.mockResolvedValue({ rows: [provider] });
      await repo.findByName('twilio');
      expect(mocks.cacheSet).toHaveBeenCalledWith('cache:telco:v2:name:twilio', provider, 24 * 60 * 60);
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
