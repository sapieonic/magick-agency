// Real Postgres: migrations/0020_carrier_refusing_calls_pause.sql (decisions B18–B20, PL11).
// globalSetup has applied every migration. Pins the widened pause_reason CHECK, then down (a
// carrier_refusing_calls pause rewritten to supervisor, the old CHECK back) and up again.
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertCampaign } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {} });

const FILE = '0020_carrier_refusing_calls_pause.sql';

/** Roll 0020 (and anything after it) back, run `body`, and always re-apply. */
async function whileDown(body: () => Promise<void>): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  await migrate('down', files.length - files.indexOf(FILE));
  try {
    await body();
  } finally {
    await migrate('up');
  }
}

describe('0020 — the carrier_refusing_calls pause', () => {
  it('pause_reason accepts carrier_refusing_calls beside the others, and nothing else', async () => {
    const campaign = await insertCampaign({ status: 'paused' });
    for (const reason of ['supervisor', 'abandonment_ceiling', 'carrier_auth', 'carrier_account_unavailable', 'carrier_refusing_calls']) {
      await pool().query('UPDATE agency_campaigns SET pause_reason = $1 WHERE id = $2', [reason, campaign.id]);
    }
    await expect(pool().query(`UPDATE agency_campaigns SET pause_reason = 'carrier_refusing' WHERE id = $1`, [campaign.id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_campaign_pause_reason' });
  });

  it('down rewrites a carrier_refusing_calls pause to supervisor (still paused) and refuses the reason; up accepts it again', async () => {
    const campaign = await insertCampaign({ status: 'paused', pause_reason: 'carrier_refusing_calls', paused_at: new Date() });
    await whileDown(async () => {
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe('0019_carrier_account_unavailable_pause');
      const row = await pool().query<{ status: string; pause_reason: string }>(
        'SELECT status, pause_reason FROM agency_campaigns WHERE id = $1', [campaign.id]);
      expect(row.rows[0]).toEqual({ status: 'paused', pause_reason: 'supervisor' });
      await expect(pool().query(`UPDATE agency_campaigns SET pause_reason = 'carrier_refusing_calls' WHERE id = $1`, [campaign.id]))
        .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_campaign_pause_reason' });
    });
    await pool().query(`UPDATE agency_campaigns SET pause_reason = 'carrier_refusing_calls' WHERE id = $1`, [campaign.id]);
  });
});
