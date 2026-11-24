// Real Postgres: migrations/0074_abandonment_grace_rollup_rebuild.sql (AG1). globalSetup has
// applied every migration. Pins that its Up marks every bucket the Insights rollup holds for a
// recompute, and only those, so the stored `abandoned` counts are rebuilt with the 3 s grace,
// leaves the rollup rows and the attempts as they were, and that down then up runs.
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertCampaign } from '../fixtures.js';

afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0074_abandonment_grace_rollup_rebuild.sql';

/** Re-run 0074's Up (and every later migration's down and up around it). */
async function rerun(): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  await migrate('down', files.length - files.indexOf(FILE));
  await migrate('up');
}

async function marks(): Promise<Array<{ campaign_id: string; bucket_start: string }>> {
  const { rows } = await getTestPool().query<{ campaign_id: string; bucket_start: string }>(
    `SELECT DISTINCT campaign_id, bucket_start::text FROM agency_insights_rollup_dirty ORDER BY 1, 2`);
  return rows;
}

async function bucket(campaignId: string, iso: string, abandoned: number): Promise<string> {
  const { rows } = await getTestPool().query<{ b: string }>(
    `INSERT INTO agency_insights_rollup_buckets (campaign_id, bucket_start, dials, answered, abandoned)
     VALUES ($1, agency_insights_bucket($2::timestamptz), 10, 5, $3)
     RETURNING bucket_start::text AS b`,
    [campaignId, iso, abandoned]);
  return rows[0]!.b;
}

describe('0074 — the rollup is rebuilt for the 3 s abandonment grace', () => {
  beforeEach(() => truncateAll());

  it('marks every bucket the rollup holds, and changes no rollup row', async () => {
    const a = await insertCampaign();
    const b = await insertCampaign();
    const expected = [
      { campaign_id: a['id'] as string, bucket_start: await bucket(a['id'] as string, '2026-11-23T10:05:00Z', 2) },
      { campaign_id: a['id'] as string, bucket_start: await bucket(a['id'] as string, '2026-11-23T11:20:00Z', 0) },
      { campaign_id: b['id'] as string, bucket_start: await bucket(b['id'] as string, '2026-11-23T10:05:00Z', 1) },
    ].sort((x, y) => (x.campaign_id + x.bucket_start).localeCompare(y.campaign_id + y.bucket_start));
    await getTestPool().query('DELETE FROM agency_insights_rollup_dirty');

    await rerun();

    expect(await marks()).toEqual(expected);
    // The job recomputes them; the migration itself writes no count.
    const { rows } = await getTestPool().query<{ abandoned: string }>(
      'SELECT abandoned::text FROM agency_insights_rollup_buckets ORDER BY abandoned');
    expect(rows.map((r) => r.abandoned)).toEqual(['0', '1', '2']);
  });

  it('marks nothing when the rollup holds no bucket', async () => {
    await insertCampaign();
    await getTestPool().query('DELETE FROM agency_insights_rollup_dirty');

    await rerun();

    expect(await marks()).toEqual([]);
  });
});
