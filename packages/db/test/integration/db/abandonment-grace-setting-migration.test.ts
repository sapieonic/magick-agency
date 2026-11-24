// Real Postgres: migrations/0075_abandonment_grace_setting.sql and
// 0076_abandonment_grace_check_validate.sql (decisions AG1–AG5). globalSetup has applied every
// migration. Pins the campaign's `abandonment_grace_ms` and the attempt's `bridge_grace_ms`
// (INTEGER NOT NULL DEFAULT 3000, whole seconds 1–5 by CHECK), the attempt CHECK added NOT VALID
// by 0075 (no scan of the largest table under its lock) and validated by 0076, that a row written
// before 0075 reads the 3 s it was counted with, and down then up.
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAttempt, insertCampaign, insertContact } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0075_abandonment_grace_setting.sql';

async function column(table: string, name: string) {
  const { rows } = await pool().query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, name],
  );
  return rows[0];
}

async function checks(): Promise<Array<{ conname: string; convalidated: boolean }>> {
  const { rows } = await pool().query<{ conname: string; convalidated: boolean }>(
    `SELECT conname, convalidated FROM pg_constraint
      WHERE conname IN ('ck_agency_campaign_abandonment_grace', 'ck_agency_attempt_bridge_grace')
      ORDER BY conname`);
  return rows;
}

/** Roll back to just before 0075, so its Up is the next to run. Returns the restore. */
async function downToBefore0075(): Promise<() => Promise<void>> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  await migrate('down', files.length - files.indexOf(FILE));
  return async () => { await migrate('up'); };
}

describe('0075 / 0076 — the abandonment grace per campaign, stamped on each attempt', () => {
  it('both columns are INTEGER NOT NULL DEFAULT 3000', async () => {
    for (const [table, name] of [['agency_campaigns', 'abandonment_grace_ms'], ['agency_call_attempts', 'bridge_grace_ms']] as const) {
      expect(await column(table, name)).toEqual({ data_type: 'integer', is_nullable: 'NO', column_default: '3000' });
    }
    // The attempt's column is not named as the campaign's: the predicate's columns are unqualified.
    expect(await column('agency_call_attempts', 'abandonment_grace_ms')).toBeUndefined();
    expect(await column('agency_campaigns', 'bridge_grace_ms')).toBeUndefined();
  });

  it('a row that names neither takes 3000', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const attempt = await insertAttempt(campaign.id, contact.id);
    expect(campaign['abandonment_grace_ms']).toBe(3000);
    expect(attempt['bridge_grace_ms']).toBe(3000);
  });

  it('whole seconds from 1 to 5 are allowed on both, and nothing else', async () => {
    for (const ms of [1000, 2000, 3000, 4000, 5000]) {
      const campaign = await insertCampaign({ abandonment_grace_ms: ms });
      const contact = await insertContact(campaign.id);
      expect(await insertAttempt(campaign.id, contact.id, { bridge_grace_ms: ms })).toMatchObject({ bridge_grace_ms: ms });
    }
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    for (const ms of [0, 500, 2500, 6000, -1000]) {
      await expect(insertCampaign({ abandonment_grace_ms: ms }))
        .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_campaign_abandonment_grace' });
      await expect(insertAttempt(campaign.id, contact.id, { bridge_grace_ms: ms }))
        .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_attempt_bridge_grace' });
    }
    await expect(insertCampaign({ abandonment_grace_ms: null })).rejects.toMatchObject({ code: '23502' });
  });

  it('0075 adds the attempt CHECK NOT VALID (no scan under its lock) and the campaign CHECK validated; 0076 validates the attempt CHECK', async () => {
    const restore = await downToBefore0075();
    try {
      await migrate('up', 1); // 0075 on its own
      expect(await checks()).toEqual([
        { conname: 'ck_agency_attempt_bridge_grace', convalidated: false },
        { conname: 'ck_agency_campaign_abandonment_grace', convalidated: true },
      ]);
    } finally {
      await restore();
    }
    expect(await checks()).toEqual([
      { conname: 'ck_agency_attempt_bridge_grace', convalidated: true },
      { conname: 'ck_agency_campaign_abandonment_grace', convalidated: true },
    ]);
  });

  it('an attempt and a campaign written before 0075 read 3000, the grace they were counted with', async () => {
    const restore = await downToBefore0075();
    let attemptId: string;
    let campaignId: string;
    try {
      const campaign = await insertCampaign();
      const contact = await insertContact(campaign.id);
      const attempt = await insertAttempt(campaign.id, contact.id, { state: 'ended', outcome: 'connected' });
      expect(attempt['bridge_grace_ms']).toBeUndefined();
      attemptId = attempt.id;
      campaignId = campaign.id;
    } finally {
      await restore();
    }
    const { rows } = await pool().query<{ g: number; c: number }>(
      `SELECT a.bridge_grace_ms AS g, c.abandonment_grace_ms AS c
         FROM agency_call_attempts a JOIN agency_campaigns c ON c.id = a.campaign_id WHERE a.id = $1 AND c.id = $2`,
      [attemptId, campaignId]);
    expect(rows).toEqual([{ g: 3000, c: 3000 }]);
  });

  it('0075 finds the column and CHECK DEPLOYMENT.md adds beforehand on a large table, and 0076 has nothing left to validate', async () => {
    const restore = await downToBefore0075();
    try {
      // DEPLOYMENT.md 12, "Deploying the per-campaign abandonment grace", with the server running.
      await pool().query('ALTER TABLE agency_call_attempts ADD COLUMN IF NOT EXISTS bridge_grace_ms INTEGER NOT NULL DEFAULT 3000');
      await pool().query(`ALTER TABLE agency_call_attempts
        ADD CONSTRAINT ck_agency_attempt_bridge_grace
          CHECK (bridge_grace_ms IN (1000, 2000, 3000, 4000, 5000)) NOT VALID`);
      await pool().query('ALTER TABLE agency_call_attempts VALIDATE CONSTRAINT ck_agency_attempt_bridge_grace');
    } finally {
      await restore();
    }
    expect(await checks()).toEqual([
      { conname: 'ck_agency_attempt_bridge_grace', convalidated: true },
      { conname: 'ck_agency_campaign_abandonment_grace', convalidated: true },
    ]);
    expect(await column('agency_call_attempts', 'bridge_grace_ms')).toEqual({ data_type: 'integer', is_nullable: 'NO', column_default: '3000' });
  });

  it.each([
    ['a column with another type', 'ALTER TABLE agency_call_attempts ADD COLUMN bridge_grace_ms SMALLINT NOT NULL DEFAULT 3000', /bridge_grace_ms was added beforehand/],
    ['a column with another default', 'ALTER TABLE agency_call_attempts ADD COLUMN bridge_grace_ms INTEGER NOT NULL DEFAULT 1000', /bridge_grace_ms was added beforehand/],
    ['a CHECK with other values', `ALTER TABLE agency_call_attempts ADD COLUMN bridge_grace_ms INTEGER NOT NULL DEFAULT 3000,
       ADD CONSTRAINT ck_agency_attempt_bridge_grace CHECK (bridge_grace_ms IN (1000, 3000)) NOT VALID`, /ck_agency_attempt_bridge_grace was added beforehand/],
  ])('0075 refuses %s added beforehand, and changes nothing', async (_label, sql, message) => {
    const restore = await downToBefore0075();
    try {
      await pool().query(sql);
      await expect(migrate('up')).rejects.toThrow(message);
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe('0074_abandonment_grace_rollup_rebuild');
      expect(await column('agency_campaigns', 'abandonment_grace_ms')).toBeUndefined();
    } finally {
      await pool().query('ALTER TABLE agency_call_attempts DROP COLUMN IF EXISTS bridge_grace_ms');
      await restore();
    }
    expect(await checks()).toHaveLength(2);
  });

  it('down (through 0076) drops both columns and CHECKs; up adds them back', async () => {
    const restore = await downToBefore0075();
    try {
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe('0074_abandonment_grace_rollup_rebuild');
      expect(await column('agency_campaigns', 'abandonment_grace_ms')).toBeUndefined();
      expect(await column('agency_call_attempts', 'bridge_grace_ms')).toBeUndefined();
      expect(await checks()).toEqual([]);
    } finally {
      await restore();
    }
    expect(await column('agency_call_attempts', 'bridge_grace_ms')).toMatchObject({ data_type: 'integer' });
    expect(await checks()).toHaveLength(2);
  });
});
