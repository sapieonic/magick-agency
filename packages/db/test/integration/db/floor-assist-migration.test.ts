// Real Postgres: migrations/0052_floor_assist.sql (the Live floor's Phase 3: Need help, LF4, and
// supervisor messages, LF5). globalSetup has applied every migration. Pins the session's four help
// columns (nullable, no default: the ADD COLUMNs rewrite nothing), the help CHECK both ways (NOT
// VALID, enforced on writes), the partial index of the requests not answered and the plan that
// reads it, the messages table (its CHECK, its defaults, the purge's index), the Up's lock timeout,
// and down then up with rows in place.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertCampaign, insertSession } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0052_floor_assist.sql';
const HELP_COLUMNS = ['help_answered_at', 'help_answered_by', 'help_call_id', 'help_raised_at'];
const TENANT = '0f000000-0000-4000-8000-000000000001';
const ACCOUNT = '0f000000-0000-4000-8000-000000000002';
const USER = '0f000000-0000-4000-8000-000000000003';

async function columns(table: string, names?: string[]): Promise<Record<string, string>> {
  const { rows } = await pool().query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 ${names ? 'AND column_name = ANY($2)' : ''}`,
    names ? [table, names] : [table]);
  return Object.fromEntries(rows.map((r) => [r.column_name,
    `${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}${r.column_default ? ` default ${r.column_default}` : ''}`]));
}

async function session(): Promise<string> {
  const campaign = await insertCampaign();
  const s = await insertSession(campaign.id as string);
  return s.id as string;
}

/** Expect the statement to violate `constraint`. */
async function refused(sql: string, params: unknown[], constraint: string): Promise<void> {
  await expect(pool().query(sql, params)).rejects.toMatchObject({ code: '23514', constraint });
}

describe('0052 — floor assist', () => {
  it('adds the four help columns, nullable with no default, and every session has none', async () => {
    expect(await columns('agency_agent_sessions', HELP_COLUMNS)).toEqual({
      help_raised_at: 'timestamp with time zone',
      help_call_id: 'uuid',
      help_answered_at: 'timestamp with time zone',
      help_answered_by: 'uuid',
    });
    const id = await session();
    const { rows } = await pool().query('SELECT help_raised_at, help_call_id, help_answered_at, help_answered_by FROM agency_agent_sessions WHERE id = $1', [id]);
    expect(rows[0]).toEqual({ help_raised_at: null, help_call_id: null, help_answered_at: null, help_answered_by: null });
  });

  it('the help CHECK is NOT VALID and enforced on writes: answered with its answerer, only once raised, never before the raise; a call only on a raised request', async () => {
    const { rows } = await pool().query<{ convalidated: boolean; def: string }>(
      `SELECT convalidated, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_agency_agent_sessions_help'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.convalidated).toBe(false);
    const id = await session();
    const set = (sql: string) => `UPDATE agency_agent_sessions SET ${sql} WHERE id = $1`;
    // Allowed: raised; raised on a call; answered after the raise; everything cleared again.
    await pool().query(set('help_raised_at = now(), help_call_id = gen_random_uuid()'), [id]);
    await pool().query(set(`help_answered_at = help_raised_at + interval '1 second', help_answered_by = $2`), [id, USER]);
    await pool().query(set('help_raised_at = NULL, help_call_id = NULL, help_answered_at = NULL, help_answered_by = NULL'), [id]);
    // Refused.
    await refused(set('help_call_id = gen_random_uuid()'), [id], 'ck_agency_agent_sessions_help');
    await refused(set('help_answered_at = now(), help_answered_by = $2'), [id, USER], 'ck_agency_agent_sessions_help');
    await pool().query(set('help_raised_at = now()'), [id]);
    await refused(set('help_answered_at = now()'), [id], 'ck_agency_agent_sessions_help');
    await refused(set('help_answered_by = $2'), [id, USER], 'ck_agency_agent_sessions_help');
    await refused(set(`help_answered_at = help_raised_at - interval '1 second', help_answered_by = $2`), [id, USER], 'ck_agency_agent_sessions_help');
  });

  it('indexes the requests not answered, by tenant and account, and an account\'s open requests read it', async () => {
    const { rows } = await pool().query<{ def: string }>(
      `SELECT pg_get_indexdef('idx_agency_agent_sessions_help_open'::regclass) AS def`);
    expect(rows[0]!.def).toBe(
      'CREATE INDEX idx_agency_agent_sessions_help_open ON public.agency_agent_sessions USING btree (tenant_id, account_id, help_raised_at) '
      + 'WHERE ((help_raised_at IS NOT NULL) AND (help_answered_at IS NULL))');
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM agency_agent_sessions
          WHERE tenant_id = $1 AND account_id = $2 AND left_at IS NULL
            AND help_raised_at IS NOT NULL AND help_answered_at IS NULL`, [TENANT, ACCOUNT]);
      expect(plan.rows.map((r) => r['QUERY PLAN']).join('\n')).toContain('idx_agency_agent_sessions_help_open');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('creates agency_supervisor_messages: its columns and defaults, the purge\'s index', async () => {
    expect(await columns('agency_supervisor_messages')).toEqual({
      id: 'uuid not null default gen_random_uuid()',
      tenant_id: 'uuid not null',
      account_id: 'uuid not null',
      session_id: 'uuid not null',
      agent_user_id: 'uuid not null',
      sender_user_id: 'uuid not null',
      text: 'text not null',
      sent_at: 'timestamp with time zone not null default now()',
      delivered: 'boolean not null default false',
    });
    const { rows } = await pool().query<{ def: string }>(
      `SELECT pg_get_indexdef('idx_agency_supervisor_messages_sent_at'::regclass) AS def`);
    expect(rows[0]!.def).toBe('CREATE INDEX idx_agency_supervisor_messages_sent_at ON public.agency_supervisor_messages USING btree (sent_at)');
  });

  it('a message holds 1 to 500 characters, already trimmed (characters, not bytes)', async () => {
    const insert = 'INSERT INTO agency_supervisor_messages (tenant_id, account_id, session_id, agent_user_id, sender_user_id, text) VALUES ($1, $2, $3, $4, $5, $6) RETURNING delivered, sent_at';
    const ids = [TENANT, ACCOUNT, TENANT, USER, ACCOUNT];
    const ok = await pool().query(insert, [...ids, 'Offer the 3-month plan']);
    expect(ok.rows[0]).toMatchObject({ delivered: false });
    // 500 Telugu characters are 1,500 bytes, and still one message.
    await pool().query(insert, [...ids, 'త'.repeat(500)]);
    for (const text of ['', ' hello', 'hello\n', 'x'.repeat(501), 'త'.repeat(501)]) {
      await refused(insert, [...ids, text], 'ck_agency_supervisor_messages_text');
    }
  });

  it('starts its Up with a lock timeout, before the ALTERs', () => {
    const up = readFileSync(join(MIGRATIONS_DIR, FILE), 'utf8').split('-- Down Migration')[0]!.split('-- Up Migration')[1]!;
    const statements = up.replace(/--.*$/gm, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '10s'");
    expect(statements[1]).toMatch(/^ALTER TABLE agency_agent_sessions ADD COLUMN IF NOT EXISTS help_raised_at TIMESTAMPTZ,/);
  });

  it('down drops the table, the index, the CHECK and the columns; up adds them back null on the sessions already there', async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const id = await session();
    await pool().query('UPDATE agency_agent_sessions SET help_raised_at = now() WHERE id = $1', [id]);
    await migrate('down', files.length - files.indexOf(FILE));
    try {
      expect(await columns('agency_agent_sessions', HELP_COLUMNS)).toEqual({});
      expect(await columns('agency_supervisor_messages')).toEqual({});
      const idx = await pool().query(`SELECT 1 FROM pg_class WHERE relname = 'idx_agency_agent_sessions_help_open'`);
      expect(idx.rowCount).toBe(0);
      await migrate('up', 1);
      const { rows } = await pool().query('SELECT help_raised_at FROM agency_agent_sessions WHERE id = $1', [id]);
      expect(rows).toEqual([{ help_raised_at: null }]);
      expect(Object.keys(await columns('agency_supervisor_messages'))).toHaveLength(9);
    } finally {
      await migrate('up');
    }
    expect(Object.keys(await columns('agency_agent_sessions', HELP_COLUMNS))).toHaveLength(4);
  });
});
