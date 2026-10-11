import { getPool } from '@magick-agency/db';
import type { TelephonyProviderRecord } from '@magick-agency/db/models/telephony-provider.model';

/*
 * Reads only: the provider rows are seeded by the migrations (`voicelink`, and
 * `plivo` inactive), so nothing here creates or updates one.
 *
 * Uncached, deliberately. `status` is what the super-admin number-creation gate
 * ("Telephony provider is not active") and the `?status=` listing read, and a
 * migration that flips a provider's status changes it with a plain UPDATE. A cache
 * in front of these reads would keep serving the old status until its TTL ran out,
 * and nothing in the process can invalidate an entry for a row it never writes. The
 * only callers are those two super-admin routes, and the table holds one row per
 * carrier, so every read goes to Postgres.
 */
export class TelephonyProviderRepository {
  async findAll(status?: string): Promise<TelephonyProviderRecord[]> {
    const pool = getPool();
    if (status) {
      const result = await pool.query<TelephonyProviderRecord>(
        `SELECT * FROM telephony_providers WHERE status = $1 ORDER BY name`,
        [status],
      );
      return result.rows;
    }
    const result = await pool.query<TelephonyProviderRecord>(
      `SELECT * FROM telephony_providers ORDER BY name`,
    );
    return result.rows;
  }

  async findById(id: string): Promise<TelephonyProviderRecord | null> {
    const result = await getPool().query<TelephonyProviderRecord>(
      `SELECT * FROM telephony_providers WHERE id = $1`,
      [id],
    );
    return result.rows[0] || null;
  }

  async findByName(name: string): Promise<TelephonyProviderRecord | null> {
    const result = await getPool().query<TelephonyProviderRecord>(
      `SELECT * FROM telephony_providers WHERE name = $1`,
      [name],
    );
    return result.rows[0] || null;
  }
}

export const telephonyProviderRepository = new TelephonyProviderRepository();
