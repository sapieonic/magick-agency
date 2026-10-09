import { getPool } from '@magick-agency/db';
import { redisCache } from '../../cache/redis-cache.js';
import type { TelephonyProviderRecord } from '@magick-agency/db/models/telephony-provider.model';

/*
 * Reads only: agency has one carrier, seeded by the baseline, so nothing here
 * creates, updates or invalidates a provider row.
 */

const PROVIDER_CACHE_TTL = 24 * 60 * 60; // 24 hours

/**
 * Key namespace for every provider cache entry. Versioned (`v2`) so that a change
 * to the cached row's shape can move to fresh keys instead of serving old entries
 * for the full 24h TTL; keys under a retired version are never read and simply
 * expire.
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
