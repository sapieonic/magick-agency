// Real Postgres: migrations/0027_inbound_connect.sql (docs/inbound.md §6, P2). globalSetup has
// applied every migration. Pins the agent-side columns and their defaults, every CHECK from both
// sides, the disposition sources against the contract's list, the one-unsettled-call-per-session
// index (and that settling frees it), the live-from-digits and lapse indexes by definition AND by
// the planner using them for the probes they exist for, the backfill of P1's rows (settled at
// their end, the leg's recording flag, `updated_at` kept), the Down's refusal, and down then up.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENCY_INBOUND_DISPOSITION_SOURCES } from '@magick-agency/contracts/agency';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, TENANT, insertRow, insertTenant } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(async () => {
  await truncateAll();
  await insertTenant({ id: TENANT });
});
// 0024's Down refuses while an inbound call exists: leave none behind for the down → up suite.
afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

// No migration lock: nothing else migrates this file's own database copy, and after a refused
// Down the runner's unlock fails on its aborted transaction, so the lock lingers until the session
// ends, which a restore right after could race.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

const FILE = '0027_inbound_connect.sql';
const refused = (constraint: string) => ({ code: '23514', constraint });

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

/** A spine row; every NOT NULL without a default filled. */
async function call(o: Record<string, unknown> = {}) {
  return insertRow('agency_inbound_calls', {
    tenant_id: TENANT, account_id: ACCOUNT, provider_call_id: `CA-${randomUUID()}`, to_e164: '+14155550100', ...o,
  });
}

/** Columns that make a row offered to `session` (the session CHECK's offered arm). */
const offeredTo = (session: string) => ({ state: 'offered', session_id: session, offered_at: new Date(), offer_count: 1 });
/** Columns that make a row connected and bridged. */
const connectedTo = (session: string) => ({
  ...offeredTo(session), state: 'connected', bridged_at: new Date(), answered_by_user_id: randomUUID(),
});
/** Columns that make a row ended after it bridged, its outcome owed. */
const endedOwing = (session: string) => ({
  ...connectedTo(session), state: 'ended', outcome: 'answered', ended_at: new Date(), talk_seconds: 30,
});

/** ANALYZE inside a rolled-back transaction, never bare (statistics outlive the rows). */
async function planOf(sql: string, params: unknown[]): Promise<string> {
  const client: PoolClient = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query('ANALYZE agency_inbound_calls');
    await client.query('ANALYZE agency_contacts');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('0027 — the columns', () => {
  it('adds the agent side with its defaults; a P1-style row reads as nobody\'s', async () => {
    const { rows } = await pool().query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agency_inbound_calls'
          AND column_name = ANY($1::text[]) ORDER BY column_name`,
      [['session_id', 'queued_at', 'offered_at', 'offer_count', 'recording_requested', 'disposition_code',
        'disposition_source', 'notes', 'callback_at', 'dispositioned_by_user_id', 'dispositioned_at',
        'dispositioned_on_behalf', 'settled_at', 'voicemail_seconds', 'clash_attempt_id']]);
    expect(Object.fromEntries(rows.map((r) => [r.column_name, `${r.data_type}${r.is_nullable === 'NO' ? ' not null' : ''}`]))).toEqual({
      callback_at: 'timestamp with time zone',
      clash_attempt_id: 'uuid',
      disposition_code: 'character varying',
      disposition_source: 'character varying',
      dispositioned_at: 'timestamp with time zone',
      dispositioned_by_user_id: 'uuid',
      dispositioned_on_behalf: 'boolean not null',
      notes: 'text',
      offer_count: 'smallint not null',
      offered_at: 'timestamp with time zone',
      queued_at: 'timestamp with time zone',
      recording_requested: 'boolean not null',
      session_id: 'uuid',
      settled_at: 'timestamp with time zone',
      voicemail_seconds: 'integer',
    });
    const row = await call();
    expect(row).toMatchObject({
      session_id: null, offer_count: 0, recording_requested: false, dispositioned_on_behalf: false, settled_at: null,
    });
  });
});

describe('0027 — the CHECKs', () => {
  it('session: offered and connected need the session, the offer time and an offer; nothing earlier has a session', async () => {
    const s = randomUUID();
    await expect(call({ state: 'offered', offered_at: new Date(), offer_count: 1 })).rejects.toMatchObject(refused('ck_agency_inbound_calls_session'));
    await expect(call({ state: 'offered', session_id: s, offer_count: 1 })).rejects.toMatchObject(refused('ck_agency_inbound_calls_session'));
    await expect(call({ ...offeredTo(s), offer_count: 0 })).rejects.toMatchObject(refused('ck_agency_inbound_calls_session'));
    for (const state of ['arrived', 'greeting', 'queued']) {
      await expect(call({ state, session_id: randomUUID() })).rejects.toMatchObject(refused('ck_agency_inbound_calls_session'));
    }
    await expect(call({ offer_count: -1 })).rejects.toMatchObject(refused('ck_agency_inbound_calls_session'));
    expect(await call(offeredTo(randomUUID()))).toMatchObject({ state: 'offered' });
    expect(await call(connectedTo(randomUUID()))).toMatchObject({ state: 'connected' });
    // An ended call keeps the session it was with (or never had one).
    expect(await call({ ...endedOwing(randomUUID()) })).toMatchObject({ state: 'ended' });
    expect(await call({ state: 'queued', offer_count: 2, offered_at: new Date() })).toMatchObject({ state: 'queued' });
  });

  it('settled: only once ended; an ended call offered to a session but never bridged is settled', async () => {
    await expect(call({ settled_at: new Date() })).rejects.toMatchObject(refused('ck_agency_inbound_calls_settled'));
    await expect(call({ ...connectedTo(randomUUID()), settled_at: new Date() })).rejects.toMatchObject(refused('ck_agency_inbound_calls_settled'));
    const offeredEnded = { ...offeredTo(randomUUID()), state: 'ended', outcome: 'abandoned_in_queue', ended_at: new Date() };
    await expect(call(offeredEnded)).rejects.toMatchObject(refused('ck_agency_inbound_calls_settled'));
    expect(await call({ ...offeredEnded, settled_at: new Date() })).toMatchObject({ state: 'ended' });
    // A sessionless ended row (P1's) is not constrained: nothing reads its settlement.
    expect(await call({ state: 'ended', outcome: 'closed', ended_at: new Date() })).toMatchObject({ settled_at: null });
    // Bridged and ended: unsettled is the owed outcome; settled is fine too.
    expect(await call(endedOwing(randomUUID()))).toMatchObject({ settled_at: null });
    expect(await call({ ...endedOwing(randomUUID()), settled_at: new Date() })).toMatchObject({ state: 'ended' });
  });

  it('disposition: only on a bridged call, with its source and time; the source only with a code; campaign exactly with a match', async () => {
    const coded = (o: Record<string, unknown>) => call({
      ...endedOwing(randomUUID()), disposition_code: 'sale', disposition_source: 'route', dispositioned_at: new Date(),
      settled_at: new Date(), ...o,
    });
    expect(await coded({})).toMatchObject({ disposition_code: 'sale' });
    await expect(call({ state: 'ended', outcome: 'closed', ended_at: new Date(), settled_at: new Date(), disposition_code: 'sale',
      disposition_source: 'route', dispositioned_at: new Date() })).rejects.toMatchObject(refused('ck_agency_inbound_calls_disposition'));
    await expect(coded({ disposition_source: null })).rejects.toMatchObject(refused('ck_agency_inbound_calls_disposition'));
    await expect(coded({ dispositioned_at: null })).rejects.toMatchObject(refused('ck_agency_inbound_calls_disposition'));
    await expect(coded({ disposition_code: '' })).rejects.toMatchObject(refused('ck_agency_inbound_calls_disposition'));
    await expect(coded({ disposition_source: 'softphone' })).rejects.toMatchObject(refused('ck_agency_inbound_calls_disposition'));
    // `campaign` exactly when the call matched a campaign.
    await expect(coded({ disposition_source: 'campaign' })).rejects.toMatchObject(refused('ck_agency_inbound_calls_disposition'));
    const match = { matched_contact_id: randomUUID(), matched_campaign_id: randomUUID() };
    expect(await coded({ ...match, disposition_source: 'campaign' })).toMatchObject({ disposition_source: 'campaign' });
    await expect(coded({ ...match, disposition_source: 'route' })).rejects.toMatchObject(refused('ck_agency_inbound_calls_disposition'));
    // Who saved it, and on behalf, only with a code.
    const owing = endedOwing(randomUUID());
    await expect(call({ ...owing, disposition_source: 'route' })).rejects.toMatchObject(refused('ck_agency_inbound_calls_disposition'));
    await expect(call({ ...owing, dispositioned_at: new Date() })).rejects.toMatchObject(refused('ck_agency_inbound_calls_disposition'));
    await expect(call({ ...owing, dispositioned_by_user_id: randomUUID() })).rejects.toMatchObject(refused('ck_agency_inbound_calls_disposition'));
    await expect(coded({ dispositioned_on_behalf: true })).rejects.toMatchObject(refused('ck_agency_inbound_calls_disposition'));
    expect(await coded({ dispositioned_on_behalf: true, dispositioned_by_user_id: randomUUID() })).toMatchObject({ dispositioned_on_behalf: true });
    // Notes and a callback may be written before the outcome (autosave).
    expect(await call({ ...owing, notes: 'rang about the bill' })).toMatchObject({ notes: 'rang about the bill' });
  });

  it('every disposition source the contract lists is one the CHECK takes, and nothing else is', async () => {
    const { rows } = await pool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'ck_agency_inbound_calls_disposition'`);
    const listed = [...rows[0]!.def.matchAll(/'([a-z_]+)'::character varying/g)].map((m) => m[1]).filter((v) => v !== '');
    expect(new Set(listed)).toEqual(new Set(AGENCY_INBOUND_DISPOSITION_SOURCES));
  });

  it('voicemail: a length only with the voicemail, never negative', async () => {
    const ended = { state: 'ended', outcome: 'voicemail', ended_at: new Date(), settled_at: new Date() };
    await expect(call({ ...ended, voicemail_seconds: 12 })).rejects.toMatchObject(refused('ck_agency_inbound_calls_voicemail'));
    await expect(call({ ...ended, voicemail_key: 'k', voicemail_seconds: -1 })).rejects.toMatchObject(refused('ck_agency_inbound_calls_voicemail'));
    expect(await call({ ...ended, voicemail_key: 'k', voicemail_seconds: 12 })).toMatchObject({ voicemail_seconds: 12 });
  });
});

describe('0027 — one unsettled inbound call per session', () => {
  it('refuses a second, whatever the state; settling the first frees the session', async () => {
    const s = randomUUID();
    const first = await call(endedOwing(s));
    await expect(call(offeredTo(s))).rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_inbound_calls_session_unsettled' });
    await expect(call(connectedTo(s))).rejects.toMatchObject({ code: '23505', constraint: 'uq_agency_inbound_calls_session_unsettled' });
    // Another session is not affected, and settled rows of the same session never count.
    expect(await call(offeredTo(randomUUID()))).toMatchObject({ state: 'offered' });
    await pool().query('UPDATE agency_inbound_calls SET settled_at = now() WHERE id = $1', [first.id]);
    expect(await call(offeredTo(s))).toMatchObject({ session_id: s });
    expect(await indexDef('uq_agency_inbound_calls_session_unsettled')).toBe(
      'CREATE UNIQUE INDEX uq_agency_inbound_calls_session_unsettled ON public.agency_inbound_calls USING btree (session_id) '
      + 'WHERE ((session_id IS NOT NULL) AND (settled_at IS NULL))');
  });
});

/** The inbound arm of `numberLiveSql` (apps/server/src/db/repositories/agency/assignment-sql.ts), verbatim, for a digits value. */
const INBOUND_BUSY_PROBE = `SELECT EXISTS (
              SELECT 1 FROM agency_inbound_calls inb
               WHERE inb.tenant_id = $1::uuid
                 AND inb.account_id = $2::uuid
                 AND regexp_replace(inb.from_e164, '[^0-9]', '', 'g') = $3::text
                 AND inb.from_e164 IS NOT NULL AND ((inb.state <> 'ended' AND inb.state <> 'arrived') OR (inb.bridged_at IS NOT NULL AND inb.settled_at IS NULL)))`;

/** The lapse sweep's pick (`AgencyInboundCallRepository.lapseUnsettled`), its WHERE verbatim without the sessions join. */
const LAPSE_PICK = `SELECT c.id FROM agency_inbound_calls c
          WHERE c.bridged_at IS NOT NULL AND c.settled_at IS NULL AND c.state = 'ended'
            AND c.ended_at < now() - make_interval(secs => $1::double precision / 1000)
          ORDER BY c.ended_at LIMIT 500`;

describe('0027 — the indexes', () => {
  it('live-from-digits: the contacts\' digits expression on the caller\'s number, over the busy calls only', async () => {
    expect(await indexDef('idx_agency_inbound_calls_live_from_digits')).toBe(
      'CREATE INDEX idx_agency_inbound_calls_live_from_digits ON public.agency_inbound_calls USING btree '
      + '(tenant_id, account_id, regexp_replace((from_e164)::text, \'[^0-9]\'::text, \'\'::text, \'g\'::text)) '
      + 'WHERE ((from_e164 IS NOT NULL) AND ((((state)::text <> \'ended\'::text) AND ((state)::text <> \'arrived\'::text)) '
      + 'OR ((bridged_at IS NOT NULL) AND (settled_at IS NULL))))');
    // Byte for byte the contacts' expression (idx_agency_contacts_account_live_digits), column swapped.
    const contacts = await indexDef('idx_agency_contacts_account_live_digits');
    expect(contacts).toContain('regexp_replace((phone_e164)::text, \'[^0-9]\'::text, \'\'::text, \'g\'::text)');
    expect(await indexDef('idx_agency_inbound_calls_unsettled_lapse')).toBe(
      'CREATE INDEX idx_agency_inbound_calls_unsettled_lapse ON public.agency_inbound_calls USING btree (ended_at) '
      + 'WHERE ((bridged_at IS NOT NULL) AND (settled_at IS NULL))');
  });

  it('the planner probes them on a large history with a busy floor elsewhere, and the probe answers right', async () => {
    // History: 20,000 ended, settled calls from many numbers on this account and others.
    await pool().query(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, from_e164, to_e164, state, outcome, ended_at,
                                         settled_at, follow_up_status, follow_up_reason)
       SELECT $1, CASE WHEN g % 10 = 0 THEN $2::uuid ELSE ('00000000-0000-4000-8000-' || lpad((g % 50)::text, 12, '0'))::uuid END,
              'CA-' || g, '+4477009' || lpad(g::text, 5, '0'), '+14155550100', 'ended', 'closed', now(), now(), 'open', 'closed'
         FROM generate_series(1, 20000) g`, [TENANT, ACCOUNT]);
    // Owed outcomes elsewhere, and the one we look for.
    await pool().query(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, from_e164, to_e164, state, outcome, ended_at,
                                         bridged_at, answered_by_user_id, session_id, offered_at, offer_count, talk_seconds)
       SELECT $1, ('00000000-0000-4000-8000-' || lpad((g % 50)::text, 12, '0'))::uuid, 'CA-owed-' || g,
              '+4478009' || lpad(g::text, 5, '0'), '+14155550100', 'ended', 'answered', now() - interval '1 hour',
              now() - interval '2 hours', gen_random_uuid(), gen_random_uuid(), now() - interval '2 hours', 1, 60
         FROM generate_series(1, 300) g`, [TENANT]);
    await call({ from_e164: '+447700912345', state: 'queued' });
    // Not admitted (refused at the cap): holds no line, keeps nothing busy.
    await call({ from_e164: '+447700912399', state: 'arrived' });

    const busy = await planOf(INBOUND_BUSY_PROBE, [TENANT, ACCOUNT, '447700912345']);
    expect(busy).toMatch(/idx_agency_inbound_calls_live_from_digits/);
    expect((await pool().query(INBOUND_BUSY_PROBE, [TENANT, ACCOUNT, '447700912345'])).rows[0].exists).toBe(true);
    // The same number on another account, or a settled call from it, keeps nothing busy.
    expect((await pool().query(INBOUND_BUSY_PROBE, [TENANT, randomUUID(), '447700912345'])).rows[0].exists).toBe(false);
    expect((await pool().query(INBOUND_BUSY_PROBE, [TENANT, ACCOUNT, '447700900010'])).rows[0].exists).toBe(false);
    expect((await pool().query(INBOUND_BUSY_PROBE, [TENANT, ACCOUNT, '447700912399'])).rows[0].exists).toBe(false);

    const lapse = await planOf(LAPSE_PICK, [1_800_000]);
    expect(lapse).toMatch(/idx_agency_inbound_calls_unsettled_lapse/);
    expect((await pool().query(LAPSE_PICK, [1_800_000])).rows).toHaveLength(300);
  });
});

describe('0027 — the backfill, the Down and up again', () => {
  const files = () => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const downToBefore = () => migrate('down', files().length - files().indexOf(FILE));

  it('settles P1\'s ended rows at their end, mirrors the leg\'s recording flag, and keeps updated_at', async () => {
    await downToBefore();
    try {
      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe(files()[files().indexOf(FILE) - 1]!.replace(/\.sql$/, ''));
      const endedAt = new Date('2026-11-01T10:00:00Z');
      const touched = new Date('2026-11-01T10:00:05Z');
      const ended = await call({ state: 'ended', outcome: 'closed', ended_at: endedAt, follow_up_status: 'open', follow_up_reason: 'closed' });
      const live = await call({ state: 'greeting' });
      const leg = await insertRow('agency_calls', {
        tenant_id: TENANT, account_id: ACCOUNT, caller_id: '+14155550100', destination_phone: '+447700900001',
        status: 'in_progress', origin: 'inbound', inbound_call_id: live.id, recording_requested: true,
      });
      await pool().query('UPDATE agency_inbound_calls SET webrtc_call_id = $2 WHERE id = $1', [live.id, leg.id]);
      await pool().query('ALTER TABLE agency_inbound_calls DISABLE TRIGGER trg_agency_inbound_calls_updated_at');
      await pool().query('UPDATE agency_inbound_calls SET updated_at = $1', [touched]);
      await pool().query('ALTER TABLE agency_inbound_calls ENABLE TRIGGER trg_agency_inbound_calls_updated_at');
    } finally {
      await migrate('up');
    }
    const { rows } = await pool().query(
      'SELECT state, settled_at, ended_at, recording_requested, updated_at FROM agency_inbound_calls ORDER BY state');
    expect(rows).toEqual([
      expect.objectContaining({ state: 'ended', settled_at: new Date('2026-11-01T10:00:00Z'), recording_requested: false,
        updated_at: new Date('2026-11-01T10:00:05Z') }),
      expect.objectContaining({ state: 'greeting', settled_at: null, recording_requested: true,
        updated_at: new Date('2026-11-01T10:00:05Z') }),
    ]);
    // The trigger is back on.
    await pool().query(`UPDATE agency_inbound_calls SET notes = 'x' WHERE state = 'greeting'`);
    const after = await pool().query(`SELECT updated_at FROM agency_inbound_calls WHERE state = 'greeting'`);
    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(new Date('2026-11-01T10:00:05Z').getTime());
  });

  it('Down refuses while a call is with an agent, owes its outcome, or carries what an agent wrote', async () => {
    for (const row of [
      offeredTo(randomUUID()),
      endedOwing(randomUUID()),
      { state: 'greeting', notes: 'n' },
      { ...endedOwing(randomUUID()), settled_at: new Date(), disposition_code: 'sale', disposition_source: 'route', dispositioned_at: new Date() },
    ]) {
      await truncateAll();
      await insertTenant({ id: TENANT });
      await call(row);
      // Down through 0027 (the migrations after it go first, and come back after).
      try {
        await expect(downToBefore()).rejects.toThrow(/0027_inbound_connect down/);
        expect(await indexDef('uq_agency_inbound_calls_session_unsettled')).toBeDefined();
      } finally {
        await migrate('up');
      }
    }
  });

  it('down drops the indexes, CHECKs and columns; up re-applies them', async () => {
    await call({ state: 'ended', outcome: 'closed', ended_at: new Date(), settled_at: new Date() });
    await downToBefore();
    try {
      for (const name of ['uq_agency_inbound_calls_session_unsettled', 'idx_agency_inbound_calls_live_from_digits', 'idx_agency_inbound_calls_unsettled_lapse']) {
        expect(await indexDef(name)).toBeUndefined();
      }
      const { rows } = await pool().query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'agency_inbound_calls' AND column_name IN ('session_id', 'settled_at')`);
      expect(rows).toEqual([]);
      const checks = await pool().query(`SELECT conname FROM pg_constraint WHERE conname LIKE 'ck_agency_inbound_calls_%'
        AND conname IN ('ck_agency_inbound_calls_session', 'ck_agency_inbound_calls_settled', 'ck_agency_inbound_calls_disposition', 'ck_agency_inbound_calls_voicemail')`);
      expect(checks.rows).toEqual([]);
    } finally {
      await migrate('up');
    }
    expect(await indexDef('uq_agency_inbound_calls_session_unsettled')).toBeDefined();
  });
});
