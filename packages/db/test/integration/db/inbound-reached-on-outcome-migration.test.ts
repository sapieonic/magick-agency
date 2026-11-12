// Real Postgres: migrations/0030_inbound_reached_on_outcome.sql (docs/inbound.md §7, §11). globalSetup
// has applied every migration. Pins:
//  - an outbound conversation (a campaign attempt, a soft-phone call) closes the customer's open
//    Missed rows on an outcome that says a person was reached, never on its bridge, never on a
//    no-contact outcome (voicemail, a lapse, a wrap-up redial's hand-off), never on an unbridged
//    call's outcome; a wrap-up redial that rang out still closes them; the outcome changed to a
//    person-reached code closes them, the same code written again does not;
//  - an inbound conversation still closes them at the bridge;
//  - the number is matched on its digits (a roster number stored as ingested);
//  - two closes at once, or a close beside a person's Mark handled, close a row once;
//  - the digits index by definition and by the planner, for the function's own probe;
//  - `closed_cause`: the CHECK against the contract's list, and the backfill;
//  - the Down restores 0028 exactly (the bridge closes again, the text index), and up again.
// The no-contact codes are spelled here as the server's constants spell them; the server's
// test/integration/agency/inbound-missed-reached.test.ts drives the triggers with the constants.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENCY_INBOUND_CLOSED_CAUSES } from '@magick-agency/contracts/agency';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import {
  ACCOUNT, TENANT, insertAccount, insertAttempt, insertCampaign, insertContact, insertManualCall, insertRow, insertSession,
  insertSoftphoneSession, insertTenant,
} from '../fixtures.js';
import { endPlanTransactions, inPlanTransaction } from '../plan-transaction.js';

const pool = () => getTestPool();
const CALLER = '+447700900123';
const FILE = '0030_inbound_reached_on_outcome.sql';

beforeEach(async () => {
  await truncateAll();
  await insertTenant({ id: TENANT });
});
afterEach(endPlanTransactions);
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

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

/** An ended call that reached nobody: an open Missed row. */
async function missed(o: Record<string, unknown> = {}) {
  return insertRow('agency_inbound_calls', {
    tenant_id: TENANT, account_id: ACCOUNT, provider_call_id: `CA-${randomUUID()}`, to_e164: '+14155550100',
    from_e164: CALLER, state: 'ended', outcome: 'closed', ended_at: new Date(), arrived_at: new Date(Date.now() - 3_600_000),
    follow_up_status: 'open', follow_up_reason: 'closed', ...o,
  });
}

async function followUp(id: string) {
  const { rows } = await pool().query(
    'SELECT follow_up_status, handled_reason, handled_by_user_id FROM agency_inbound_calls WHERE id = $1', [id]);
  return rows[0] as { follow_up_status: string; handled_reason: string | null; handled_by_user_id: string | null };
}

/** A campaign attempt to `phone`, reserved to a session of `agent`, bridged now unless `bridged: false`. */
async function attemptTo(phone: string, agent: string, o: { bridged?: boolean; account?: string; attempt?: Record<string, unknown> } = {}) {
  const account = o.account ?? ACCOUNT;
  const campaign = await insertCampaign({ account_id: account });
  const contact = await insertContact(campaign.id, { phone_e164: phone, account_id: account });
  const session = await insertSession(campaign.id, { agent_user_id: agent, account_id: account });
  return insertAttempt(campaign.id, contact.id, {
    reserved_agent_id: session.id, account_id: account, state: 'ended', dialed_at: new Date(Date.now() - 120_000),
    ...(o.bridged === false ? {} : { bridged_at: new Date(Date.now() - 60_000) }),
    ...o.attempt,
  });
}

/** A soft-phone call to `phone` by `agent`, bridged now unless `bridged: false`. */
async function softphoneTo(phone: string, agent: string, o: { bridged?: boolean } = {}) {
  const session = await insertSoftphoneSession({ agent_user_id: agent });
  return insertManualCall(session.id, {
    destination_e164: phone, agent_user_id: agent,
    ...(o.bridged === false ? {} : { state: 'bridged', bridged_at: new Date(Date.now() - 60_000) }),
  });
}

const outcome = (table: 'agency_call_attempts' | 'agency_manual_calls', id: string, code: string, db: Pick<PoolClient, 'query'> = pool()) =>
  db.query(
    table === 'agency_manual_calls'
      ? `UPDATE agency_manual_calls SET disposition_code = $2, disposition_source = 'softphone', dispositioned_at = now() WHERE id = $1`
      : 'UPDATE agency_call_attempts SET disposition_code = $2, dispositioned_at = now() WHERE id = $1',
    [id, code],
  );

describe('0030 — a campaign conversation closes Missed rows on a person-reached outcome', () => {
  it('not at the bridge; a human outcome closes the account`s open rows from the number that rang before it, as its agent', async () => {
    const agent = randomUUID();
    const otherAccount = (await insertAccount(TENANT)).id;
    const before = await missed();
    const alsoBefore = await missed({ outcome: 'overflow', follow_up_reason: 'overflow' });
    const otherNumber = await missed({ from_e164: '+447700900999' });
    const withheld = await missed({ from_e164: null });
    const inOtherAccount = await missed({ account_id: otherAccount });
    const tenantDefault = await missed({ account_id: null });
    const attempt = await attemptTo(CALLER, agent, { bridged: false });
    // The bridge alone (0028's trigger) closes nothing now.
    await pool().query('UPDATE agency_call_attempts SET bridged_at = now() - interval \'1 minute\' WHERE id = $1', [attempt.id]);
    expect((await followUp(before.id)).follow_up_status).toBe('open');
    // A call that rang after the conversation began is not closed by it.
    const after = await missed({ arrived_at: new Date(Date.now() - 1_000) });

    await outcome('agency_call_attempts', attempt.id, 'callback');

    for (const id of [before.id, alsoBefore.id]) {
      expect(await followUp(id)).toEqual({ follow_up_status: 'handled', handled_reason: 'reached', handled_by_user_id: agent });
    }
    for (const id of [otherNumber.id, withheld.id, inOtherAccount.id, tenantDefault.id, after.id]) {
      expect((await followUp(id)).follow_up_status, id).toBe('open');
    }
  });

  it('a no-contact outcome closes nothing: voicemail, a lapse, a wrap-up redial`s hand-off', async () => {
    for (const code of ['voicemail', 'no_disposition', 'redialed']) {
      const row = await missed();
      const attempt = await attemptTo(CALLER, randomUUID());
      await outcome('agency_call_attempts', attempt.id, code);
      expect((await followUp(row.id)).follow_up_status, code).toBe('open');
      await pool().query('DELETE FROM agency_inbound_calls');
    }
  });

  it('an unbridged attempt`s outcome closes nothing; a wrap-up redial that rang out closes them', async () => {
    const row = await missed();
    const unbridged = await attemptTo(CALLER, randomUUID(), { bridged: false });
    await outcome('agency_call_attempts', unbridged.id, 'callback');
    expect((await followUp(row.id)).follow_up_status).toBe('open');

    const agent = randomUUID();
    const redial = await attemptTo(CALLER, agent, { bridged: false, attempt: { redial_number: 1 } });
    await outcome('agency_call_attempts', redial.id, 'callback');
    expect(await followUp(row.id)).toEqual({ follow_up_status: 'handled', handled_reason: 'reached', handled_by_user_id: agent });
  });

  it('an outcome changed from voicemail to a person closes them; the same code written again does not fire again', async () => {
    const row = await missed();
    const attempt = await attemptTo(CALLER, randomUUID());
    await outcome('agency_call_attempts', attempt.id, 'voicemail');
    expect((await followUp(row.id)).follow_up_status).toBe('open');
    await outcome('agency_call_attempts', attempt.id, 'callback');
    expect((await followUp(row.id)).follow_up_status).toBe('handled');

    // Reopened by a person, then the same outcome written again (a replay): it stays open.
    await pool().query(
      `UPDATE agency_inbound_calls SET follow_up_status = 'open', handled_reason = NULL, handled_by_user_id = NULL, handled_at = NULL
        WHERE id = $1`, [row.id]);
    await outcome('agency_call_attempts', attempt.id, 'callback');
    await pool().query('UPDATE agency_call_attempts SET notes = $2 WHERE id = $1', [attempt.id, 'more notes']);
    expect((await followUp(row.id)).follow_up_status).toBe('open');
  });
});

describe('0030 — a soft-phone conversation closes Missed rows on a person-reached outcome', () => {
  it('a bridged call`s human outcome closes them as its agent; voicemail, a lapse or an unbridged call`s outcome does not', async () => {
    const row = await missed();
    for (const code of ['voicemail', 'no_disposition']) {
      await outcome('agency_manual_calls', (await softphoneTo(CALLER, randomUUID())).id, code);
      expect((await followUp(row.id)).follow_up_status, code).toBe('open');
    }
    await outcome('agency_manual_calls', (await softphoneTo(CALLER, randomUUID(), { bridged: false })).id, 'interested');
    expect((await followUp(row.id)).follow_up_status).toBe('open');

    const agent = randomUUID();
    const call = await softphoneTo(CALLER, agent);
    // The bridge alone closes nothing.
    expect((await followUp(row.id)).follow_up_status).toBe('open');
    await outcome('agency_manual_calls', call.id, 'interested');
    expect(await followUp(row.id)).toEqual({ follow_up_status: 'handled', handled_reason: 'reached', handled_by_user_id: agent });
  });
});

describe('0030 — the number by its digits', () => {
  it('a roster number stored as ingested matches the caller`s E.164 (the caller`s is canonical, CHECKed)', async () => {
    const row = await missed();
    const other = await missed({ from_e164: '+447700900124' });
    const attempt = await attemptTo('+44 (7700) 900-123', randomUUID());
    await outcome('agency_call_attempts', attempt.id, 'callback');
    expect((await followUp(row.id)).follow_up_status).toBe('handled');
    expect((await followUp(other.id)).follow_up_status).toBe('open');
  });

  it('a number with no digits matches nothing', async () => {
    const row = await missed();
    const attempt = await attemptTo('anonymous', randomUUID());
    await outcome('agency_call_attempts', attempt.id, 'callback');
    expect((await followUp(row.id)).follow_up_status).toBe('open');
  });
});

describe('0030 — closes once', () => {
  it('two outcomes at once close a row once: the second waits for the first and finds it handled', async () => {
    const first = randomUUID();
    const row = await missed();
    const attempt = await attemptTo(CALLER, first);
    const softphone = await softphoneTo(CALLER, randomUUID());
    const a: PoolClient = await pool().connect();
    const b: PoolClient = await pool().connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await outcome('agency_call_attempts', attempt.id, 'callback', a);
      const waiting = outcome('agency_manual_calls', softphone.id, 'interested', b);
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      await waiting;
      await b.query('COMMIT');
    } finally {
      a.release();
      b.release();
    }
    expect(await followUp(row.id)).toEqual({ follow_up_status: 'handled', handled_reason: 'reached', handled_by_user_id: first });
  });

  it('a person`s Mark handled at the same instant wins or loses whole: never both', async () => {
    const person = randomUUID();
    const row = await missed();
    const attempt = await attemptTo(CALLER, randomUUID());
    const a: PoolClient = await pool().connect();
    try {
      await a.query('BEGIN');
      await a.query(
        `UPDATE agency_inbound_calls SET follow_up_status = 'handled', handled_reason = 'marked', handled_by_user_id = $2, handled_at = now()
          WHERE id = $1 AND follow_up_status = 'open'`, [row.id, person]);
      const waiting = outcome('agency_call_attempts', attempt.id, 'callback');
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      await waiting;
    } finally {
      a.release();
    }
    expect(await followUp(row.id)).toEqual({ follow_up_status: 'handled', handled_reason: 'marked', handled_by_user_id: person });
  });
});

describe('0030 — the digits index', () => {
  it('is defined on the digits of from_e164, open rows with a number only', async () => {
    expect(await indexDef('idx_agency_inbound_calls_missed_open_from')).toBeUndefined();
    expect(await indexDef('idx_agency_inbound_calls_missed_open_digits')).toMatch(
      /ON public\.agency_inbound_calls USING btree \(tenant_id, account_id, regexp_replace\(\(from_e164\)::text, '\[\^0-9\]'::text, ''::text, 'g'::text\)\) WHERE \(\(\(follow_up_status\)::text = 'open'::text\) AND \(from_e164 IS NOT NULL\)\)/);
  });

  it('serves the close`s probe over a seeded, ANALYZEd history', async () => {
    const plan = await inPlanTransaction(async (client) => {
      const accounts: string[] = [];
      for (let i = 0; i < 40; i++) {
        accounts.push((await insertRow('accounts', { tenant_id: TENANT, name: 'acct', slug: `a-${randomUUID()}` }, client)).id);
      }
      await client.query(
        `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, to_e164, from_e164, state, outcome, ended_at,
                                           arrived_at, follow_up_status, follow_up_reason)
         SELECT $1::uuid, a.id, 'CA-' || a.id || '-' || g, '+14155550100', '+4477009' || lpad(g::text, 5, '0'),
                'ended', CASE WHEN g % 50 = 0 THEN 'closed' ELSE 'abandoned_in_queue' END, now(),
                now() - (g % 720) * interval '1 hour',
                CASE WHEN g % 50 = 0 THEN 'open' END, CASE WHEN g % 50 = 0 THEN 'closed' END
           FROM unnest($2::uuid[]) AS a(id), generate_series(1, 300) g`,
        [TENANT, accounts],
      );
      await client.query('ANALYZE agency_inbound_calls');
      // The function's UPDATE, as it runs it (the digits computed once).
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) UPDATE agency_inbound_calls m SET follow_up_status = 'handled'
          WHERE m.tenant_id = $1::uuid AND m.account_id = $2::uuid
            AND regexp_replace(m.from_e164, '[^0-9]', '', 'g') = $3::text AND m.from_e164 IS NOT NULL
            AND m.follow_up_status = 'open' AND m.arrived_at <= now()`,
        [TENANT, accounts[7], '447700900050'],
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toMatch(/idx_agency_inbound_calls_missed_open_digits/);
  });
});

describe('0030 — closed_cause', () => {
  it('is NULL or one of the contract`s causes', async () => {
    expect(AGENCY_INBOUND_CLOSED_CAUSES).toEqual(['hours', 'switched_off', 'no_route', 'credential_inactive']);
    for (const cause of [null, ...AGENCY_INBOUND_CLOSED_CAUSES]) {
      expect((await missed({ closed_cause: cause }))['closed_cause']).toBe(cause);
    }
    await expect(missed({ closed_cause: 'holiday' })).rejects.toMatchObject({
      code: '23514', constraint: 'ck_agency_inbound_calls_closed_cause',
    });
  });
});

describe('0030 — the Down and up again', () => {
  const files = () => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const downToBefore = () => migrate('down', files().length - files().indexOf(FILE));

  it('restores 0028 (the bridge closes, the text index) and drops the column; up backfills why closed calls were closed', async () => {
    await downToBefore();
    let route: Record<string, unknown> | undefined;
    let closedWithRoute: Record<string, unknown> | undefined;
    let closedNoRoute: Record<string, unknown> | undefined;
    let afterHoursVoicemail: Record<string, unknown> | undefined;
    let overflow: Record<string, unknown> | undefined;
    try {
      expect(await indexDef('idx_agency_inbound_calls_missed_open_digits')).toBeUndefined();
      expect(await indexDef('idx_agency_inbound_calls_missed_open_from')).toBeDefined();
      const cols = await pool().query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'agency_inbound_calls' AND column_name = 'closed_cause'`);
      expect(cols.rows).toEqual([]);
      // 0028's bridge trigger is back: a bridge alone closes the row.
      const row = await missed();
      const attempt = await attemptTo(CALLER, randomUUID(), { bridged: false });
      await pool().query('UPDATE agency_call_attempts SET bridged_at = now() WHERE id = $1', [attempt.id]);
      expect((await followUp(row.id)).follow_up_status).toBe('handled');
      await pool().query('DELETE FROM agency_inbound_calls');

      route = await insertRow('agency_inbound_routes', { tenant_id: TENANT, account_id: ACCOUNT, name: 'Main', timezone: 'Europe/London' });
      closedWithRoute = await missed({ route_id: route['id'] });
      closedNoRoute = await missed();
      afterHoursVoicemail = await missed({ route_id: route['id'], outcome: 'voicemail', voicemail_key: 'vm/x' });
      overflow = await missed({ route_id: route['id'], outcome: 'overflow', follow_up_reason: 'overflow' });
    } finally {
      await migrate('up');
    }
    const cause = async (row: Record<string, unknown> | undefined) =>
      (await pool().query('SELECT closed_cause FROM agency_inbound_calls WHERE id = $1', [row!['id']])).rows[0]!.closed_cause;
    expect(await cause(closedWithRoute)).toBe('hours');
    expect(await cause(closedNoRoute)).toBe('no_route');
    expect(await cause(afterHoursVoicemail)).toBe('hours');
    expect(await cause(overflow)).toBeNull();
    // 0030 again: the bridge closes nothing, the outcome does.
    await pool().query('DELETE FROM agency_inbound_calls');
    const again = await missed();
    const attempt = await attemptTo(CALLER, randomUUID());
    expect((await followUp(again.id)).follow_up_status).toBe('open');
    await outcome('agency_call_attempts', attempt.id, 'callback');
    expect((await followUp(again.id)).handled_reason).toBe('reached');
  });
});
