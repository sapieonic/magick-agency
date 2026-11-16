// Real Postgres: migrations/0041_promise_to_pay.sql (docs/decisions.md, PT1–PT14).
// globalSetup has applied every migration. Pins the promise columns on the three call tables
// (exact NUMERIC, an amount only beside a date, a promise only beside an outcome), the contact's
// latest-promise columns and their all-or-none CHECK, the CHECKs added NOT VALID (no scan of the
// big tables) and validated by 0044_promise_checks_validate.sql, the partial index built by
// 0045_promise_contacts_index.sql and not under 0041's ACCESS EXCLUSIVE, and down then up.
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAttempt, insertCampaign, insertContact, insertManualCall, insertSoftphoneSession } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0041_promise_to_pay.sql';
const INDEX_FILE = '0045_promise_contacts_index.sql';
const INDEX_DEF =
  'CREATE INDEX idx_agency_contacts_promise ON public.agency_contacts USING btree (campaign_id, promise_date) WHERE (promise_date IS NOT NULL)';

async function promiseIndexDef(): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_agency_contacts_promise'`);
  return rows[0]?.indexdef;
}

async function column(table: string, name: string) {
  const { rows } = await pool().query<{ data_type: string; is_nullable: string; numeric_precision: number | null; numeric_scale: number | null }>(
    `SELECT data_type, is_nullable, numeric_precision, numeric_scale
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, name],
  );
  return rows[0];
}

const PROMISED = {
  promise_date: '2026-11-18',
  promise_due_from: '2026-11-17T18:30:00Z',
  promise_due_until: '2026-11-18T18:30:00Z',
  promise_call_at: '2026-11-15T10:00:00Z',
};

describe('0041 — promise to pay', () => {
  it('each call table carries a nullable DATE and an exact NUMERIC(14,2)', async () => {
    for (const table of ['agency_call_attempts', 'agency_manual_calls', 'agency_inbound_calls', 'agency_contacts']) {
      expect(await column(table, 'promise_date')).toMatchObject({ data_type: 'date', is_nullable: 'YES' });
      expect(await column(table, 'promise_amount')).toMatchObject({
        data_type: 'numeric', is_nullable: 'YES', numeric_precision: 14, numeric_scale: 2,
      });
    }
    for (const name of ['promise_due_from', 'promise_due_until', 'promise_call_at', 'promise_followed_up_at']) {
      expect(await column('agency_contacts', name)).toMatchObject({ data_type: 'timestamp with time zone', is_nullable: 'YES' });
    }
  });

  it('an attempt keeps the amount exactly and refuses an amount without a date, a negative one, or a promise without an outcome', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const row = await insertAttempt(campaign.id, contact.id, {
      state: 'ended', outcome: 'connected', disposition_code: 'ptp', promise_date: '2026-11-18', promise_amount: '12500.10',
    });
    expect(row).toMatchObject({ promise_amount: '12500.10' });
    const { rows } = await pool().query('SELECT promise_date::text AS d FROM agency_call_attempts WHERE id = $1', [row.id]);
    expect(rows[0]).toEqual({ d: '2026-11-18' });
    for (const [n, o] of [
      [2, { disposition_code: 'ptp', promise_amount: '5' }],
      [3, { disposition_code: 'ptp', promise_date: '2026-11-18', promise_amount: '-0.01' }],
      [4, { promise_date: '2026-11-18' }],
    ] as const) {
      await expect(insertAttempt(campaign.id, contact.id, { state: 'ended', outcome: 'connected', attempt_number: n, ...o }))
        .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_attempt_promise' });
    }
  });

  it('a soft-phone call has the same rule', async () => {
    const session = await insertSoftphoneSession();
    await expect(insertManualCall(session.id, { promise_date: '2026-11-18' }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_manual_call_promise' });
  });

  it('a contact\'s promise is all-or-none, its amount and follow-up need a date, and its day ends after it starts', async () => {
    const campaign = await insertCampaign();
    const ok = await insertContact(campaign.id, { ...PROMISED, promise_amount: '0' });
    expect(ok).toMatchObject({ promise_amount: '0.00', promise_followed_up_at: null });
    const bad: Array<Record<string, unknown>> = [
      { promise_date: '2026-11-18' },
      { ...PROMISED, promise_call_at: null },
      { promise_amount: '1' },
      { promise_followed_up_at: '2026-11-19T00:00:00Z' },
      { ...PROMISED, promise_amount: '-1' },
      { ...PROMISED, promise_due_until: PROMISED.promise_due_from },
    ];
    for (const o of bad) {
      await expect(insertContact(campaign.id, o)).rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_contact_promise' });
    }
  });

  it('0041 adds the CHECKs NOT VALID (enforced on writes, no scan of the big tables); 0044 validates them', async () => {
    const promiseChecks = async () => (await pool().query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE 'ck_agency_%promise' ORDER BY conname`)).rows;
    const names = ['ck_agency_attempt_promise', 'ck_agency_contact_promise', 'ck_agency_inbound_call_promise', 'ck_agency_manual_call_promise'];
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      await migrate('up', 1); // 0041 on its own
      expect(await promiseChecks()).toEqual(names.map((conname) => ({ conname, convalidated: false })));
    } finally {
      await migrate('up');
    }
    expect(await promiseChecks()).toEqual(names.map((conname) => ({ conname, convalidated: true })));
  });

  it('idx_agency_contacts_promise is partial on contacts holding a promise', async () => {
    expect(await promiseIndexDef()).toBe(INDEX_DEF);
  });

  it('0041 builds no index (its ALTERs hold ACCESS EXCLUSIVE until commit); 0045 builds it in its own transaction', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      await migrate('up', 1); // 0041 on its own
      expect(await promiseIndexDef()).toBeUndefined();
      // Nothing between 0041 and 0045 builds it either.
      await migrate('up', files.indexOf(INDEX_FILE) - files.indexOf(FILE) - 1);
      expect(await promiseIndexDef()).toBeUndefined();
      await migrate('up', 1); // 0045
      expect(await promiseIndexDef()).toBe(INDEX_DEF);
    } finally {
      await migrate('up');
    }
  });

  it('0045 fails on an invalid index left under its name by a failed CREATE INDEX CONCURRENTLY', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(INDEX_FILE));
    try {
      // What a failed concurrent build leaves: the index exists, marked not valid.
      await pool().query(`CREATE INDEX idx_agency_contacts_promise ON agency_contacts (campaign_id, promise_date) WHERE promise_date IS NOT NULL`);
      await pool().query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_agency_contacts_promise'::regclass`);
      await expect(migrate('up')).rejects.toThrow(/invalid index.*idx_agency_contacts_promise/);
      const { rows } = await pool().query(`SELECT name FROM pgmigrations WHERE name = $1`, [INDEX_FILE.replace(/\.sql$/, '')]);
      expect(rows).toEqual([]);
    } finally {
      await pool().query('DROP INDEX IF EXISTS idx_agency_contacts_promise');
      await migrate('up');
    }
    expect(await promiseIndexDef()).toBe(INDEX_DEF);
  });

  it('0045 down drops the index and leaves the columns; up builds it again', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(INDEX_FILE));
    try {
      expect(await promiseIndexDef()).toBeUndefined();
      expect(await column('agency_contacts', 'promise_date')).toMatchObject({ data_type: 'date' });
    } finally {
      await migrate('up');
    }
    expect(await promiseIndexDef()).toBe(INDEX_DEF);
  });

  it('down (through 0045) drops every column, CHECK and the index; up adds them back', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe(files[files.indexOf(FILE) - 1]!.replace(/\.sql$/, ''));
      for (const table of ['agency_call_attempts', 'agency_manual_calls', 'agency_inbound_calls', 'agency_contacts']) {
        expect(await column(table, 'promise_date')).toBeUndefined();
      }
      const idx = await pool().query(`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_agency_contacts_promise'`);
      expect(idx.rowCount).toBe(0);
    } finally {
      await migrate('up');
    }
    expect(await column('agency_contacts', 'promise_followed_up_at')).toMatchObject({ is_nullable: 'YES' });
  });
});
