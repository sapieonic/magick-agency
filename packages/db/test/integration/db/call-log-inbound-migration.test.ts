// Real Postgres: migrations/0069_call_log_inbound_campaign.sql and 0070_call_log_inbound_indexes.sql
// (docs/call-log.md §4). globalSetup has applied every migration. Pins the campaign an inbound call
// is filed under (the two columns, the CHECK from every side, the vocabulary against the contract),
// the soft-phone call's link to the missed call it rang back, the backfill from the match with
// `updated_at` left alone, both indexes by definition, the invalid-index refusal, and down then up.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENCY_INBOUND_CAMPAIGN_SOURCES } from '@magick-agency/contracts/agency';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, TENANT, insertRow, insertTenant } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(async () => {
  await truncateAll();
  await insertTenant({ id: TENANT });
});
// 0024's Down (in the down → up suite) refuses while an inbound call exists: leave none behind.
afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const COLUMNS_FILE = '0069_call_log_inbound_campaign.sql';
const INDEX_FILE = '0070_call_log_inbound_indexes.sql';
const CHECK = 'ck_agency_inbound_calls_campaign_source';
const refused = { code: '23514', constraint: CHECK };

const INDEXES = {
  idx_agency_inbound_calls_campaign:
    'CREATE INDEX idx_agency_inbound_calls_campaign ON public.agency_inbound_calls USING btree (campaign_id, arrived_at DESC, id DESC) '
    + 'WHERE (campaign_id IS NOT NULL)',
  idx_agency_manual_calls_callback_of:
    'CREATE INDEX idx_agency_manual_calls_callback_of ON public.agency_manual_calls USING btree (callback_of_inbound_call_id) '
    + 'WHERE (callback_of_inbound_call_id IS NOT NULL)',
} as const;

function call(o: Record<string, unknown> = {}) {
  return insertRow('agency_inbound_calls', {
    tenant_id: TENANT, account_id: ACCOUNT, provider_call_id: `CA-${randomUUID()}`, to_e164: '+14155550100', ...o,
  });
}

async function column(table: string, name: string) {
  const { rows } = await pool().query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`, [table, name]);
  return rows[0];
}

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

const migrationsFrom = (file: string) => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  return files.length - files.indexOf(file);
};

describe('0069 — the campaign an inbound call is filed under, and the call back\'s link', () => {
  it('the columns: nullable, no default', async () => {
    expect(await column('agency_inbound_calls', 'campaign_id')).toEqual({ data_type: 'uuid', is_nullable: 'YES', column_default: null });
    expect(await column('agency_inbound_calls', 'campaign_source')).toEqual({ data_type: 'character varying', is_nullable: 'YES', column_default: null });
    expect(await column('agency_manual_calls', 'callback_of_inbound_call_id')).toEqual({ data_type: 'uuid', is_nullable: 'YES', column_default: null });
    expect(await call()).toMatchObject({ campaign_id: null, campaign_source: null });
  });

  it('the CHECK: both together, and a source of the contract\'s list', async () => {
    expect([...AGENCY_INBOUND_CAMPAIGN_SOURCES]).toEqual(['contact', 'route', 'agent', 'supervisor']);
    for (const source of AGENCY_INBOUND_CAMPAIGN_SOURCES) {
      expect(await call({ campaign_id: randomUUID(), campaign_source: source })).toMatchObject({ campaign_source: source });
    }
    await expect(call({ campaign_id: randomUUID() })).rejects.toMatchObject(refused);
    await expect(call({ campaign_source: 'contact' })).rejects.toMatchObject(refused);
    await expect(call({ campaign_id: randomUUID(), campaign_source: 'guess' })).rejects.toMatchObject(refused);
    const { rows } = await pool().query<{ convalidated: boolean }>('SELECT convalidated FROM pg_constraint WHERE conname = $1', [CHECK]);
    expect(rows).toEqual([{ convalidated: true }]);
  });

  it('down drops the columns; up files each matched call under its campaign (updated_at kept), an unmatched one under none', async () => {
    await migrate('down', migrationsFrom(COLUMNS_FILE));
    try {
      expect(await column('agency_inbound_calls', 'campaign_id')).toBeUndefined();
      expect(await column('agency_inbound_calls', 'campaign_source')).toBeUndefined();
      expect(await column('agency_manual_calls', 'callback_of_inbound_call_id')).toBeUndefined();
      const old = new Date('2026-01-01T00:00:00Z');
      const campaign = randomUUID();
      const matched = await call({ matched_contact_id: randomUUID(), matched_campaign_id: campaign, updated_at: old });
      const unmatched = await call({ updated_at: old });
      await migrate('up');
      const read = async (id: unknown) =>
        (await pool().query('SELECT campaign_id, campaign_source, updated_at FROM agency_inbound_calls WHERE id = $1', [id])).rows[0];
      expect(await read(matched['id'])).toEqual({ campaign_id: campaign, campaign_source: 'contact', updated_at: old });
      expect(await read(unmatched['id'])).toEqual({ campaign_id: null, campaign_source: null, updated_at: old });
    } finally {
      await migrate('up');
    }
    expect(await column('agency_inbound_calls', 'campaign_id')).toBeDefined();
  });
});

describe('0069 on a large table: the columns added and the backfill run before the deploy (its header, DEPLOYMENT.md)', () => {
  const validated = async () =>
    (await pool().query<{ convalidated: boolean }>('SELECT convalidated FROM pg_constraint WHERE conname = $1', [CHECK])).rows[0]?.convalidated;

  it('finds the columns and the batches\' work, files only what arrived since, and keeps updated_at', async () => {
    await migrate('down', migrationsFrom(COLUMNS_FILE));
    try {
      const old = new Date('2026-01-01T00:00:00Z');
      const campaign = randomUUID();
      const batched = await call({ matched_contact_id: randomUUID(), matched_campaign_id: campaign, updated_at: old });
      const unmatched = await call({ updated_at: old });
      // Step 1 of the documented procedure: the columns, on the older schema.
      await pool().query(
        `ALTER TABLE agency_inbound_calls
           ADD COLUMN IF NOT EXISTS campaign_id UUID,
           ADD COLUMN IF NOT EXISTS campaign_source VARCHAR(16)`);
      // Step 2: one batch, exactly as written there.
      const client = await pool().connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '5s'`);
        await client.query('ALTER TABLE agency_inbound_calls DISABLE TRIGGER trg_agency_inbound_calls_updated_at');
        const batch = await client.query(
          `UPDATE agency_inbound_calls
              SET campaign_id = matched_campaign_id, campaign_source = 'contact'
            WHERE id IN (SELECT id FROM agency_inbound_calls
                          WHERE matched_campaign_id IS NOT NULL AND campaign_id IS NULL
                          LIMIT 10000)`);
        expect(batch.rowCount).toBe(1);
        await client.query('ALTER TABLE agency_inbound_calls ENABLE TRIGGER trg_agency_inbound_calls_updated_at');
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      // A call that arrived after the last batch, written by the older server: matched, not filed.
      const late = await call({ matched_contact_id: randomUUID(), matched_campaign_id: campaign, updated_at: old });
      // Step 3: the deploy.
      await migrate('up');
      const read = async (id: unknown) =>
        (await pool().query('SELECT campaign_id, campaign_source, updated_at FROM agency_inbound_calls WHERE id = $1', [id])).rows[0];
      expect(await read(batched['id'])).toEqual({ campaign_id: campaign, campaign_source: 'contact', updated_at: old });
      expect(await read(late['id'])).toEqual({ campaign_id: campaign, campaign_source: 'contact', updated_at: old });
      expect(await read(unmatched['id'])).toEqual({ campaign_id: null, campaign_source: null, updated_at: old });
      // The trigger is back on for everyone else.
      const { rows: [touched] } = await pool().query('UPDATE agency_inbound_calls SET caller_dnc = true WHERE id = $1 RETURNING updated_at', [late['id']]);
      expect((touched.updated_at as Date).getTime()).toBeGreaterThan(old.getTime());
      expect(await validated()).toBe(true);
      const { rows } = await pool().query('SELECT name FROM pgmigrations WHERE name = ANY($1::text[]) ORDER BY name', [[COLUMNS_FILE, INDEX_FILE].map((f) => f.replace(/\.sql$/, ''))]);
      expect(rows).toHaveLength(2);
    } finally {
      await migrate('up');
    }
  });

  it('refuses columns added beforehand with the wrong type, and records nothing', async () => {
    await migrate('down', migrationsFrom(COLUMNS_FILE));
    try {
      await pool().query('ALTER TABLE agency_inbound_calls ADD COLUMN campaign_id UUID, ADD COLUMN campaign_source TEXT');
      await expect(migrate('up')).rejects.toThrow(/added beforehand with the wrong type/);
      const { rows } = await pool().query('SELECT name FROM pgmigrations WHERE name = $1', [COLUMNS_FILE.replace(/\.sql$/, '')]);
      expect(rows).toEqual([]);
    } finally {
      await pool().query('ALTER TABLE agency_inbound_calls DROP COLUMN IF EXISTS campaign_source, DROP COLUMN IF EXISTS campaign_id');
      await migrate('up');
    }
    expect(await column('agency_inbound_calls', 'campaign_source')).toEqual({ data_type: 'character varying', is_nullable: 'YES', column_default: null });
  });

  it('the CHECK is added NOT VALID by 0069 and validated by 0070', async () => {
    // Down past 0069, then 0069 alone: a validated CHECK is never un-validated by 0070's Down.
    await migrate('down', migrationsFrom(COLUMNS_FILE));
    try {
      await migrate('up', 1);
      expect(await column('agency_inbound_calls', 'campaign_id')).toBeDefined();
      expect(await validated()).toBe(false);
      // NOT VALID still checks every new row.
      await expect(call({ campaign_id: randomUUID() })).rejects.toMatchObject(refused);
    } finally {
      await migrate('up');
    }
    expect(await validated()).toBe(true);
  });
});

describe('0070 — the Call log\'s inbound indexes', () => {
  it('defines both exactly, with their comments', async () => {
    for (const [name, definition] of Object.entries(INDEXES)) {
      expect(await indexDef(name)).toBe(definition);
      const { rows } = await pool().query<{ c: string | null }>(`SELECT obj_description($1::regclass, 'pg_class') AS c`, [name]);
      expect(rows[0]!.c).toMatch(/call-log\.md/);
    }
  });

  it('fails on an invalid index left under a name by a failed CREATE INDEX CONCURRENTLY', async () => {
    const name = 'idx_agency_inbound_calls_campaign';
    await migrate('down', migrationsFrom(INDEX_FILE));
    try {
      await pool().query(`CREATE INDEX ${name} ON agency_inbound_calls (campaign_id, arrived_at DESC, id DESC) WHERE campaign_id IS NOT NULL`);
      await pool().query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${name}'::regclass`);
      await expect(migrate('up')).rejects.toThrow(new RegExp(`invalid index.*${name}`));
      const { rows } = await pool().query('SELECT name FROM pgmigrations WHERE name = $1', [INDEX_FILE.replace(/\.sql$/, '')]);
      expect(rows).toEqual([]);
    } finally {
      await pool().query(`DROP INDEX IF EXISTS ${name}`);
      await migrate('up');
    }
    expect(await indexDef(name)).toBe(INDEXES[name]);
  });

  it('down drops both; up restores them', async () => {
    await migrate('down', migrationsFrom(INDEX_FILE));
    try {
      for (const name of Object.keys(INDEXES)) expect(await indexDef(name)).toBeUndefined();
    } finally {
      await migrate('up');
    }
    for (const [name, definition] of Object.entries(INDEXES)) expect(await indexDef(name)).toBe(definition);
  });
});
