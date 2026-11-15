// Real Postgres: migrations/0044_recording_honours_request.sql (RC1). globalSetup has applied every
// migration. Pins that its Up marks for an Insights recompute exactly the buckets of attempts whose
// call holds a recording URL it did not ask for, writes nothing else (the URLs stay), and that
// down then up runs.
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAttempt, insertCall, insertCampaign, insertContact } from '../fixtures.js';

afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0044_recording_honours_request.sql';

/** Re-run 0044's Up (and every later migration's down and up around it). */
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

describe('0044 — recordings a call did not ask for', () => {
  beforeEach(() => truncateAll());

  it("marks only the buckets of attempts whose call holds a recording it did not ask for, and keeps the URLs", async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign['id'] as string);
    const at = (iso: string) => new Date(iso);
    // One call per bucket, an hour apart: unrequested with a URL (marked), requested with a URL,
    // unrequested with none (neither marked).
    const cases = [
      { requested: false, url: 'https://recording.example/a.mp3', dialed: '2026-11-01T10:05:00Z' },
      { requested: true, url: 'https://recording.example/b.mp3', dialed: '2026-11-01T11:05:00Z' },
      { requested: false, url: null, dialed: '2026-11-01T12:05:00Z' },
    ];
    let n = 0;
    for (const c of cases) {
      const call = await insertCall({ recording_requested: c.requested, recording_url: c.url, campaign_id: campaign['id'] });
      n += 1;
      await insertAttempt(campaign['id'] as string, contact['id'] as string, {
        attempt_number: n, webrtc_call_id: call['id'], dialed_at: at(c.dialed), state: 'ended', outcome: 'connected',
      });
    }
    // The inserts' own triggers marked every bucket; start from none.
    await getTestPool().query('DELETE FROM agency_insights_rollup_dirty');

    await rerun();

    const bucket = (await getTestPool().query<{ b: string }>(
      `SELECT agency_insights_bucket($1::timestamptz)::text AS b`, [at(cases[0]!.dialed)])).rows[0]!.b;
    expect(await marks()).toEqual([{ campaign_id: campaign['id'], bucket_start: bucket }]);
    const urls = await getTestPool().query<{ recording_url: string | null }>(
      'SELECT recording_url FROM agency_calls ORDER BY recording_url NULLS LAST');
    expect(urls.rows.map((r) => r.recording_url)).toEqual(['https://recording.example/a.mp3', 'https://recording.example/b.mp3', null]);
  });

  it('marks nothing when every recording was asked for', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign['id'] as string);
    const call = await insertCall({ recording_requested: true, recording_url: 'https://recording.example/c.mp3', campaign_id: campaign['id'] });
    await insertAttempt(campaign['id'] as string, contact['id'] as string, { webrtc_call_id: call['id'], dialed_at: new Date('2026-11-01T10:05:00Z') });
    await getTestPool().query('DELETE FROM agency_insights_rollup_dirty');

    await rerun();

    expect(await marks()).toEqual([]);
  });
});
