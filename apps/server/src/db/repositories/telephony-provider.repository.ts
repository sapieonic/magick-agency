import { getPool } from '@magick-agency/db';
import { redisCache } from '../../cache/redis-cache.js';
import type { TelephonyProviderRecord } from '@magick-agency/db/models/telephony-provider.model';

/*
 * PORT NOTE (magick-agency): master `src/db/repositories/telephony-provider.repository.ts`
 * @a1f0756a, READS ONLY. Deleted, with their only callers (the super-admin
 * telephony-provider CRUD routes and core's live-transfer S2S read):
 *  - `create`, `update` (+ `TelephonyProviderPreviousValues`,
 *    `TelephonyProviderUpdateResult`, `pickPrevious`) and `invalidateCache` —
 *    agency has one carrier, seeded by the baseline (plan Decided #3);
 *  - `findLiveTransferEnabledNames` — live transfer is AI escalation, and
 *    migration 074's `live_transfer_enabled` column is not in the baseline, so
 *    both it and `update` would fail on real Postgres.
 * The read-through cache (keys, TTL) is master's, unchanged.
 */

const PROVIDER_CACHE_TTL = 24 * 60 * 60; // 24 hours

/**
 * Key namespace for every provider cache entry. Versioned (`v2`) by migration
 * 074: rows cached under the old `cache:telco:` keys were read before
 * `live_transfer_enabled` existed, and with a 24h TTL they would otherwise keep
 * serving a row with no flag — which the live-transfer set reads as OFF — for a
 * full day after deploy. The old keys are never read again and simply expire.
 */
const KEY_PREFIX = 'cache:telco:v2';

export class TelephonyProviderRepository {
  async findAll(status?: string): Promise<TelephonyProviderRecord[]> {
    const cacheKey = `${KEY_PREFIX}:all:${status || 'any'}`;
    const cached = await redisCache.get<TelephonyProviderRecord[]>(cacheKey);
    if (cached) return cached;

    const pool = getPool();
    let rows: TelephonyProviderRecord[];
    if (status) {
      const result = await pool.query<TelephonyProviderRecord>(
        `SELECT * FROM telephony_providers WHERE status = $1 ORDER BY name`,
        [status],
      );
      rows = result.rows;
    } else {
      const result = await pool.query<TelephonyProviderRecord>(
        `SELECT * FROM telephony_providers ORDER BY name`,
      );
      rows = result.rows;
    }

    await redisCache.set(cacheKey, rows, PROVIDER_CACHE_TTL);
    return rows;
  }

  async findById(id: string): Promise<TelephonyProviderRecord | null> {
    const cacheKey = `${KEY_PREFIX}:id:${id}`;
    const cached = await redisCache.get<TelephonyProviderRecord>(cacheKey);
    if (cached) return cached;

    const pool = getPool();
    const result = await pool.query<TelephonyProviderRecord>(
      `SELECT * FROM telephony_providers WHERE id = $1`,
      [id],
    );
    const row = result.rows[0] || null;
    if (row) await redisCache.set(cacheKey, row, PROVIDER_CACHE_TTL);
    return row;
  }

  async findByName(name: string): Promise<TelephonyProviderRecord | null> {
    const cacheKey = `${KEY_PREFIX}:name:${name}`;
    const cached = await redisCache.get<TelephonyProviderRecord>(cacheKey);
    if (cached) return cached;

    const pool = getPool();
    const result = await pool.query<TelephonyProviderRecord>(
      `SELECT * FROM telephony_providers WHERE name = $1`,
      [name],
    );
    const row = result.rows[0] || null;
    if (row) await redisCache.set(cacheKey, row, PROVIDER_CACHE_TTL);
    return row;
  }
}

export const telephonyProviderRepository = new TelephonyProviderRepository();
