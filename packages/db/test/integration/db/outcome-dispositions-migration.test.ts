// Real Postgres: migrations/0022_outcome_dispositions.sql (docs/decisions.md, OD1–OD8).
// globalSetup has applied every migration. Pins the campaign mapping column (an object,
// `{}` by default, so an existing campaign maps nothing), the attempt's automatic-outcome
// column (only on an unanswered outcome, beside a write-up's own code), the attempts CHECK
// added NOT VALID (no scan of the largest table), and down then up.
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

// No migration lock: nothing else migrates this file's own database copy, and after a refused
// Down the runner's unlock fails on its aborted transaction, so the lock lingers until the session
// ends, which a restore right after could race.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0022_outcome_dispositions.sql';

async function column(table: string, name: string) {
  const { rows } = await pool().query<{ data_type: string; is_nullable: string; column_default: string | null; character_maximum_length: number | null }>(
    `SELECT data_type, is_nullable, column_default, character_maximum_length
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, name],
  );
  return rows[0];
}

describe('0022 — automatic outcomes for unanswered calls', () => {
  it('agency_campaigns.outcome_dispositions is JSONB NOT NULL DEFAULT {}: an existing campaign maps nothing', async () => {
    expect(await column('agency_campaigns', 'outcome_dispositions')).toMatchObject({
      data_type: 'jsonb', is_nullable: 'NO', column_default: "'{}'::jsonb",
    });
    const campaign = await insertCampaign();
    expect(campaign['outcome_dispositions']).toEqual({});
  });

  it('the mapping must be a JSON object (ck_agency_campaign_outcome_dispositions)', async () => {
    await expect(insertCampaign({ outcome_dispositions: JSON.stringify(['busy']) }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_campaign_outcome_dispositions' });
    const mapped = await insertCampaign({ outcome_dispositions: JSON.stringify({ busy: 'retry_later' }) });
    expect(mapped['outcome_dispositions']).toEqual({ busy: 'retry_later' });
  });

  it('agency_call_attempts.auto_disposition_code is a nullable VARCHAR(50), NULL by default', async () => {
    expect(await column('agency_call_attempts', 'auto_disposition_code')).toMatchObject({
      data_type: 'character varying', is_nullable: 'YES', column_default: null, character_maximum_length: 50,
    });
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const attempt = await insertAttempt(campaign.id, contact.id, { state: 'ended', outcome: 'no_answer' });
    expect(attempt['auto_disposition_code']).toBeNull();
  });

  it('an automatic outcome rides only on an unanswered outcome (ck_agency_attempt_auto_disposition)', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    let n = 0;
    for (const outcome of ['no_answer', 'busy', 'failed', 'invalid', 'abandoned']) {
      n += 1;
      const row = await insertAttempt(campaign.id, contact.id, {
        state: 'ended', outcome, attempt_number: n, auto_disposition_code: 'retry_later',
      });
      expect(row['auto_disposition_code']).toBe('retry_later');
    }
    for (const outcome of ['connected', 'canceled', 'agent_disconnected', 'orphaned']) {
      n += 1;
      await expect(insertAttempt(campaign.id, contact.id, {
        state: 'ended', outcome, attempt_number: n, auto_disposition_code: 'retry_later',
      })).rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_attempt_auto_disposition' });
    }
    // An attempt still live has no outcome, so it cannot carry one either.
    n += 1;
    await expect(insertAttempt(campaign.id, contact.id, {
      state: 'dialing', attempt_number: n, auto_disposition_code: 'retry_later',
    })).rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_attempt_auto_disposition' });
  });

  it('a write-up on the same attempt is not refused: the two codes are separate facts', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const row = await insertAttempt(campaign.id, contact.id, {
      state: 'ended', outcome: 'busy', auto_disposition_code: 'retry_later', disposition_code: 'callback',
    });
    expect(row).toMatchObject({ auto_disposition_code: 'retry_later', disposition_code: 'callback' });
  });

  it('the attempts CHECK is added NOT VALID (enforced on writes, no scan); the campaigns CHECK is validated', async () => {
    const { rows } = await pool().query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conname IN ('ck_agency_attempt_auto_disposition', 'ck_agency_campaign_outcome_dispositions')
        ORDER BY conname`);
    expect(rows).toEqual([
      { conname: 'ck_agency_attempt_auto_disposition', convalidated: false },
      { conname: 'ck_agency_campaign_outcome_dispositions', convalidated: true },
    ]);
  });

  it('down drops both columns (and their CHECKs); up adds them back with their defaults', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const campaign = await insertCampaign({ outcome_dispositions: JSON.stringify({ busy: 'retry_later' }) });
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe(files[files.indexOf(FILE) - 1]!.replace(/\.sql$/, ''));
      expect(await column('agency_campaigns', 'outcome_dispositions')).toBeUndefined();
      expect(await column('agency_call_attempts', 'auto_disposition_code')).toBeUndefined();
    } finally {
      await migrate('up');
    }
    const { rows } = await pool().query('SELECT outcome_dispositions FROM agency_campaigns WHERE id = $1', [campaign.id]);
    expect(rows[0]).toEqual({ outcome_dispositions: {} });
    expect(await column('agency_call_attempts', 'auto_disposition_code')).toMatchObject({ is_nullable: 'YES' });
  });
});
