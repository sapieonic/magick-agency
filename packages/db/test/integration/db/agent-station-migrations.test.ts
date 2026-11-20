// Real Postgres: the agent station redesign's migrations (docs/agent-station.md, backend plan BE-2,
// BE-3, BE-8, BE-9, BE-12, AS9):
//   0056_campaign_station_settings.sql      agency_campaigns.daily_target_calls, agent_script, phone_display
//   0057_contact_callback_booker.sql        agency_contacts.callback_booked_by_user_id, callback_booked_at
//   0058_contact_callback_booker_index.sql  idx_agency_contacts_my_callbacks, and 0057's CHECK validated
//   0059_session_help_state.sql             agency_agent_sessions.help_state
//   0060_session_event_break_overrun.sql    agency_agent_session_events.break_limit_minutes, break_overrun_seconds
// globalSetup has applied every migration. Pins each column (type, nullability, default: the large
// tables' columns nullable with no default, so their ADD COLUMNs rewrite nothing), each CHECK both
// ways and whether it is validated, the index by its definition (the invalid-index refusal, one built
// beforehand with CONCURRENTLY, the plan of My day's read shape), each Up's lock timeout, and down
// then up with rows in place.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, TENANT, insertCampaign, insertContact, insertRow, insertSession } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

// No migration lock: nothing else migrates this file's own database copy.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILES = [
  '0056_campaign_station_settings.sql',
  '0057_contact_callback_booker.sql',
  '0058_contact_callback_booker_index.sql',
  '0059_session_help_state.sql',
  '0060_session_event_break_overrun.sql',
] as const;

function stepsDownTo(file: string): number {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  return files.length - files.indexOf(file);
}

async function columns(table: string, names: string[]): Promise<Record<string, string>> {
  const { rows } = await pool().query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`, [table, names]);
  return Object.fromEntries(rows.map((r) => [r.column_name,
    `${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}${r.column_default ? ` default ${r.column_default}` : ''}`]));
}

async function constraint(name: string): Promise<{ convalidated: boolean } | undefined> {
  const { rows } = await pool().query<{ convalidated: boolean }>('SELECT convalidated FROM pg_constraint WHERE conname = $1', [name]);
  return rows[0];
}

async function columnComment(table: string, column: string): Promise<string | null> {
  const { rows } = await pool().query<{ c: string | null }>(
    `SELECT col_description($1::regclass, attnum) AS c FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2`, [table, column]);
  return rows[0]?.c ?? null;
}

/** Expect the statement to violate `name`. */
async function refused(sql: string, params: unknown[], name: string): Promise<void> {
  await expect(pool().query(sql, params)).rejects.toMatchObject({ code: '23514', constraint: name });
}

/** The Up's statements, comments stripped, whitespace collapsed. */
function upStatements(file: string): string[] {
  const up = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').split(/^-- Down Migration/m)[0]!.split(/^-- Up Migration/m)[1]!;
  return up.replace(/--.*$/gm, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function downStatements(file: string): string[] {
  const down = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').split(/^-- Down Migration/m)[1]!;
  return down.replace(/--.*$/gm, '').split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

describe('agent station migrations: each Up and Down starts with a lock timeout', () => {
  it.each(FILES)('%s', (file) => {
    expect(upStatements(file)[0]).toBe("SET LOCAL lock_timeout = '10s'");
    expect(downStatements(file)[0]).toBe("SET LOCAL lock_timeout = '10s'");
  });
});

describe('0056 — the campaign\'s station settings', () => {
  it('adds the target (nullable, no default), the script (an object, default {}) and the display (default full)', async () => {
    expect(await columns('agency_campaigns', ['daily_target_calls', 'agent_script', 'phone_display'])).toEqual({
      daily_target_calls: 'integer',
      agent_script: "jsonb not null default '{}'::jsonb",
      phone_display: "character varying not null default 'full'::character varying",
    });
    expect(await insertCampaign()).toMatchObject({ daily_target_calls: null, agent_script: {}, phone_display: 'full' });
    expect(await columnComment('agency_campaigns', 'agent_script')).toMatch(/BE-8/);
  });

  it('holds each to its CHECK, validated', async () => {
    for (const name of ['ck_agency_campaign_daily_target_calls', 'ck_agency_campaign_agent_script', 'ck_agency_campaign_phone_display']) {
      expect(await constraint(name), name).toEqual({ convalidated: true });
    }
    const id = (await insertCampaign()).id;
    const set = (sql: string) => `UPDATE agency_campaigns SET ${sql} WHERE id = $1`;
    await pool().query(set('daily_target_calls = 1'), [id]);
    await pool().query(set('daily_target_calls = 2000'), [id]);
    await pool().query(set('daily_target_calls = NULL'), [id]);
    await refused(set('daily_target_calls = 0'), [id], 'ck_agency_campaign_daily_target_calls');
    await refused(set('daily_target_calls = 2001'), [id], 'ck_agency_campaign_daily_target_calls');
    await pool().query(set(`agent_script = '{"opening":"Namaste {name}","steps":[{"text":"Ask when"}]}'`), [id]);
    await refused(set(`agent_script = '[]'`), [id], 'ck_agency_campaign_agent_script');
    await refused(set(`agent_script = '"a script"'`), [id], 'ck_agency_campaign_agent_script');
    await pool().query(set(`phone_display = 'masked'`), [id]);
    await refused(set(`phone_display = 'hidden'`), [id], 'ck_agency_campaign_phone_display');
  });

  it('down drops the three; up adds them back with their defaults on the rows already there', async () => {
    const c = await insertCampaign({ daily_target_calls: 120, phone_display: 'masked' });
    await migrate('down', stepsDownTo(FILES[0]));
    try {
      expect(await columns('agency_campaigns', ['daily_target_calls', 'agent_script', 'phone_display'])).toEqual({});
      await migrate('up', 1);
      const { rows } = await pool().query('SELECT daily_target_calls, agent_script, phone_display FROM agency_campaigns WHERE id = $1', [c.id]);
      expect(rows).toEqual([{ daily_target_calls: null, agent_script: {}, phone_display: 'full' }]);
    } finally {
      await migrate('up');
    }
    expect(await constraint('ck_agency_campaign_phone_display')).toEqual({ convalidated: true });
  });
});

describe('0057 / 0058 — who booked a call-later, and the agent\'s list\'s index', () => {
  const NAME = 'idx_agency_contacts_my_callbacks';
  const DEFINITION = 'CREATE INDEX idx_agency_contacts_my_callbacks ON public.agency_contacts '
    + 'USING btree (campaign_id, callback_booked_by_user_id, next_attempt_at) '
    + "WHERE (((state)::text = 'pending'::text) AND (callback_booked_by_user_id IS NOT NULL))";
  const BUILD = "ON agency_contacts (campaign_id, callback_booked_by_user_id, next_attempt_at) WHERE state = 'pending' AND callback_booked_by_user_id IS NOT NULL";

  async function indexDef(): Promise<string | null> {
    const { rows } = await pool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [NAME]);
    return rows[0]?.indexdef ?? null;
  }

  async function recorded(file: string): Promise<boolean> {
    const { rows } = await pool().query('SELECT name FROM pgmigrations WHERE name = $1', [file.replace(/\.sql$/, '')]);
    return rows.length === 1;
  }

  it('adds both columns nullable with no default (no rewrite of the roster), and a contact has none', async () => {
    expect(await columns('agency_contacts', ['callback_booked_by_user_id', 'callback_booked_at'])).toEqual({
      callback_booked_by_user_id: 'uuid',
      callback_booked_at: 'timestamp with time zone',
    });
    const campaign = await insertCampaign();
    expect(await insertContact(campaign.id)).toMatchObject({ callback_booked_by_user_id: null, callback_booked_at: null });
    expect(await columnComment('agency_contacts', 'callback_booked_by_user_id')).toMatch(/BE-3/);
  });

  it('0057 adds the CHECK NOT VALID with the columns; 0058 validates it; it holds both set or both NULL', async () => {
    expect(upStatements(FILES[1])).toContain(
      'ALTER TABLE agency_contacts ADD CONSTRAINT ck_agency_contact_callback_booked CHECK ((callback_booked_by_user_id IS NULL) = (callback_booked_at IS NULL)) NOT VALID');
    expect(upStatements(FILES[2])).toContain('ALTER TABLE agency_contacts VALIDATE CONSTRAINT ck_agency_contact_callback_booked');
    expect(await constraint('ck_agency_contact_callback_booked')).toEqual({ convalidated: true });
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const set = (sql: string) => `UPDATE agency_contacts SET ${sql} WHERE id = $1`;
    await pool().query(set('callback_booked_by_user_id = $2, callback_booked_at = now()'), [contact.id, randomUUID()]);
    await pool().query(set('callback_booked_by_user_id = NULL, callback_booked_at = NULL'), [contact.id]);
    await refused(set('callback_booked_by_user_id = $2'), [contact.id, randomUUID()], 'ck_agency_contact_callback_booked');
    await refused(set('callback_booked_at = now()'), [contact.id], 'ck_agency_contact_callback_booked');
  });

  it('0058 defines the partial index exactly, with its comment, and builds it after the lock timeout', async () => {
    expect(await indexDef()).toBe(DEFINITION);
    const { rows } = await pool().query<{ c: string }>(`SELECT obj_description($1::regclass, 'pg_class') AS c`, [NAME]);
    expect(rows[0]!.c).toMatch(/My day/);
    const up = upStatements(FILES[2]);
    expect(up.findIndex((s) => s.startsWith('CREATE INDEX'))).toBe(1);
    // Not in 0057: an index built there would scan the roster under its ACCESS EXCLUSIVE.
    expect(upStatements(FILES[1]).some((s) => s.includes('CREATE INDEX'))).toBe(false);
  });

  it('My day\'s read shape walks the index: one agent\'s pending booked call-laters on a campaign, by due time', async () => {
    const campaign = await insertCampaign();
    const me = randomUUID();
    const values: string[] = [];
    for (let i = 0; i < 3000; i += 1) values.push(`('${campaign.id}', '${TENANT}', '${ACCOUNT}', '+1415555${String(i).padStart(4, '0')}')`);
    await pool().query(`INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164) VALUES ${values.join(', ')}`);
    await pool().query(
      `UPDATE agency_contacts SET callback_booked_by_user_id = $2, callback_booked_at = now(), next_attempt_at = now() + interval '1 hour'
        WHERE id IN (SELECT id FROM agency_contacts WHERE campaign_id = $1 LIMIT 5)`, [campaign.id, me]);
    await pool().query('ANALYZE agency_contacts');
    const { rows } = await pool().query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id, next_attempt_at FROM agency_contacts
        WHERE campaign_id = $1 AND state = 'pending' AND callback_booked_by_user_id = $2
          AND next_attempt_at < now() + interval '1 day'
        ORDER BY next_attempt_at LIMIT 20`, [campaign.id, me]);
    const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(plan).toContain(NAME);
    expect(plan).not.toMatch(/Seq Scan/);
  });

  it('0058 fails on an invalid index left under its name by a failed CREATE INDEX CONCURRENTLY', async () => {
    await migrate('down', stepsDownTo(FILES[2]));
    try {
      await pool().query(`CREATE INDEX ${NAME} ${BUILD}`);
      await pool().query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${NAME}'::regclass`);
      await expect(migrate('up')).rejects.toThrow(new RegExp(`invalid index.*${NAME}`));
      expect(await recorded(FILES[2])).toBe(false);
    } finally {
      await pool().query(`DROP INDEX IF EXISTS ${NAME}`);
      await migrate('up');
    }
    expect(await indexDef()).toBe(DEFINITION);
  });

  it('0058 records itself over one built beforehand with CONCURRENTLY under its name', async () => {
    await migrate('down', stepsDownTo(FILES[2]));
    try {
      await pool().query(`CREATE INDEX CONCURRENTLY ${NAME} ${BUILD}`);
      await migrate('up');
      expect(await recorded(FILES[2])).toBe(true);
    } finally {
      await migrate('up');
    }
    expect(await indexDef()).toBe(DEFINITION);
  });

  it('down through 0057 drops the index, the CHECK and the columns; up restores them over the rows there', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id, { callback_booked_by_user_id: randomUUID(), callback_booked_at: new Date() });
    await migrate('down', stepsDownTo(FILES[1]));
    try {
      expect(await indexDef()).toBeNull();
      expect(await constraint('ck_agency_contact_callback_booked')).toBeUndefined();
      expect(await columns('agency_contacts', ['callback_booked_by_user_id', 'callback_booked_at'])).toEqual({});
      await migrate('up', 2);
      const { rows } = await pool().query('SELECT callback_booked_by_user_id, callback_booked_at FROM agency_contacts WHERE id = $1', [contact.id]);
      expect(rows).toEqual([{ callback_booked_by_user_id: null, callback_booked_at: null }]);
    } finally {
      await migrate('up');
    }
    expect(await indexDef()).toBe(DEFINITION);
    expect(await constraint('ck_agency_contact_callback_booked')).toEqual({ convalidated: true });
  });
});

describe('0059 — the state Need help was raised in', () => {
  it('adds help_state nullable with no default; its CHECK is NOT VALID and enforced: a state only on a raised request, one of the six', async () => {
    expect(await columns('agency_agent_sessions', ['help_state'])).toEqual({ help_state: 'character varying' });
    expect(await constraint('ck_agency_agent_sessions_help_state')).toEqual({ convalidated: false });
    const campaign = await insertCampaign();
    const s = await insertSession(campaign.id);
    expect(s).toMatchObject({ help_state: null });
    const set = (sql: string) => `UPDATE agency_agent_sessions SET ${sql} WHERE id = $1`;
    await refused(set(`help_state = 'available'`), [s.id], 'ck_agency_agent_sessions_help_state');
    for (const state of ['offline', 'available', 'reserved', 'on_call', 'wrapup', 'break']) {
      await pool().query(set('help_raised_at = now(), help_state = $2'), [s.id, state]);
    }
    await refused(set(`help_state = 'lunch'`), [s.id], 'ck_agency_agent_sessions_help_state');
    // Clearing the request without its state is refused: the two are cleared together.
    await refused(set('help_raised_at = NULL'), [s.id], 'ck_agency_agent_sessions_help_state');
    await pool().query(set('help_raised_at = NULL, help_state = NULL'), [s.id]);
  });

  it('down drops it; up adds it back NULL, an open request kept', async () => {
    const campaign = await insertCampaign();
    const s = await insertSession(campaign.id, { help_raised_at: new Date(), help_state: 'on_call' });
    await migrate('down', stepsDownTo(FILES[3]));
    try {
      expect(await columns('agency_agent_sessions', ['help_state'])).toEqual({});
      await migrate('up', 1);
      const { rows } = await pool().query('SELECT help_state, help_raised_at IS NOT NULL AS open FROM agency_agent_sessions WHERE id = $1', [s.id]);
      expect(rows).toEqual([{ help_state: null, open: true }]);
    } finally {
      await migrate('up');
    }
  });
});

describe('0060 — a break over its limit, on the event that ended it', () => {
  async function event(o: Record<string, unknown> = {}): Promise<Record<string, unknown> & { id: string }> {
    const campaign = await insertCampaign();
    const s = await insertSession(campaign.id);
    return insertRow('agency_agent_session_events', {
      session_id: s.id, tenant_id: TENANT, account_id: ACCOUNT, campaign_id: campaign.id,
      agent_user_id: s.agent_user_id, from_state: 'break', to_state: 'available', ...o,
    });
  }

  it('adds both columns nullable with no default (no rewrite of the event log), and an event has none', async () => {
    expect(await columns('agency_agent_session_events', ['break_limit_minutes', 'break_overrun_seconds'])).toEqual({
      break_limit_minutes: 'smallint',
      break_overrun_seconds: 'integer',
    });
    expect(await event()).toMatchObject({ break_limit_minutes: null, break_overrun_seconds: null });
    expect(await columnComment('agency_agent_session_events', 'break_overrun_seconds')).toMatch(/BE-12/);
  });

  it('its CHECK is NOT VALID and enforced: both together, only out of a break, the limit 1–240, the overrun positive', async () => {
    expect(await constraint('ck_agency_session_event_break_overrun')).toEqual({ convalidated: false });
    expect(await event({ break_limit_minutes: 15, break_overrun_seconds: 412 })).toMatchObject({ break_limit_minutes: 15, break_overrun_seconds: 412 });
    expect(await event({ to_state: 'offline', break_limit_minutes: 240, break_overrun_seconds: 1 })).toMatchObject({ break_overrun_seconds: 1 });
    const name = 'ck_agency_session_event_break_overrun';
    await expect(event({ break_limit_minutes: 15 })).rejects.toMatchObject({ code: '23514', constraint: name });
    await expect(event({ break_overrun_seconds: 60 })).rejects.toMatchObject({ code: '23514', constraint: name });
    await expect(event({ break_limit_minutes: 15, break_overrun_seconds: 0 })).rejects.toMatchObject({ code: '23514', constraint: name });
    await expect(event({ break_limit_minutes: 0, break_overrun_seconds: 60 })).rejects.toMatchObject({ code: '23514', constraint: name });
    await expect(event({ break_limit_minutes: 241, break_overrun_seconds: 60 })).rejects.toMatchObject({ code: '23514', constraint: name });
    await expect(event({ from_state: 'available', to_state: 'break', break_limit_minutes: 15, break_overrun_seconds: 60 }))
      .rejects.toMatchObject({ code: '23514', constraint: name });
  });

  it('down drops them; up adds them back NULL on the events there', async () => {
    const e = await event({ break_limit_minutes: 15, break_overrun_seconds: 412 });
    await migrate('down', stepsDownTo(FILES[4]));
    try {
      expect(await columns('agency_agent_session_events', ['break_limit_minutes', 'break_overrun_seconds'])).toEqual({});
      await migrate('up', 1);
      const { rows } = await pool().query('SELECT break_limit_minutes, break_overrun_seconds FROM agency_agent_session_events WHERE id = $1', [e.id]);
      expect(rows).toEqual([{ break_limit_minutes: null, break_overrun_seconds: null }]);
    } finally {
      await migrate('up');
    }
  });
});
