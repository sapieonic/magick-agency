/*
 * PORT NOTE (magick-agency): ported from master test/unit/db/repositories/telephony-provider.repository.test.ts@a1f0756a
 * (19 cases → 10: 9 verbatim, 10 deleted, 1 new). The repository is READS ONLY here
 * (see its PORT NOTE): `create`, `update` and `findLiveTransferEnabledNames` are
 * deleted with the telephony-provider CRUD routes and core's live-transfer read, so
 * their cases are deleted with them —
 *  - findLiveTransferEnabledNames: 'queries only enabled AND active providers, ordered by SQL',
 *    'returns an empty set as-is (no carrier enabled is a valid answer)',
 *    'never reads or writes Redis — every call is answered from Postgres',
 *    'a read that SELECTed before a disable cannot leave the old set behind after invalidation';
 *  - create: 'should invalidate list caches after create';
 *  - update: 'should invalidate list + specific caches after update',
 *    'writes live_transfer_enabled and returns the new row with the value it replaced',
 *    'never busts tenant metadata caches itself — that side effect belongs to the route',
 *    'returns null when the provider is not found',
 *    'should not invalidate cache when no fields changed (current row doubles as previous)'.
 * The `metadata-cache.js` mock is removed: it existed only for the deleted
 * create/update assertions, and agency has no such module. `getPool` is mocked at
 * `@magick-agency/db` (the path rule). NEW: 'exposes the reads only' pins the
 * deletion.
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

// PORT NOTE (magick-agency): fixture drops `live_transfer_enabled` with the model field (type-only).
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

  // PORT NOTE (magick-agency): NEW. Pins the deletion of every writer and of the
  // live-transfer read (module note above), so a re-added `update` that writes
  // migration 074's `live_transfer_enabled` — absent from the baseline — reds here
  // rather than failing on real Postgres.
  it('exposes the reads only — create, update and findLiveTransferEnabledNames are deleted', () => {
    const methods = Object.getOwnPropertyNames(TelephonyProviderRepository.prototype)
      .filter((m) => m !== 'constructor')
      .sort();
    expect(methods).toEqual(['findAll', 'findById', 'findByName']);
  });
});
