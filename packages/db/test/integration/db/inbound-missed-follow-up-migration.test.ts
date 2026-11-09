// Real Postgres: migrations/0028_inbound_missed_follow_up.sql (docs/inbound.md §7, §11). globalSetup
// has applied every migration. Pins `handled_reason` and its CHECK against the contract's list; the
// three triggers that close a Missed row when the customer is put through to an agent (a campaign
// attempt, a soft-phone call, a later inbound call), what they leave alone, and that two closes at
// once, or a close beside a person's Mark handled, close a row once; the two indexes by definition
// and by the planner using them; the Down and up again.
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { runner } from 'node-pg-migrate';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AGENCY_INBOUND_HANDLED_REASONS } from '@magick-agency/contracts/agency';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import {
  ACCOUNT, TENANT, insertAccount, insertAttempt, insertCampaign, insertContact, insertManualCall, insertRow, insertSession,
  insertSoftphoneSession, insertTenant,
} from '../fixtures.js';

const pool = () => getTestPool();
const CALLER = '+447700900123';

beforeEach(async () => {
  await truncateAll();
  await insertTenant({ id: TENANT });
});
// 0024's Down refuses while an inbound call exists: leave none behind for the down → up suite.
afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {} });

const FILE = '0028_inbound_missed_follow_up.sql';

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
    'SELECT follow_up_status, handled_reason, handled_by_user_id, handled_at FROM agency_inbound_calls WHERE id = $1', [id]);
  return rows[0] as { follow_up_status: string; handled_reason: string | null; handled_by_user_id: string | null; handled_at: Date | null };
}

/** A campaign attempt to `phone`, reserved to a session of `agent`. */
async function attemptTo(phone: string, agent: string, account = ACCOUNT) {
  const campaign = await insertCampaign({ account_id: account });
  const contact = await insertContact(campaign.id, { phone_e164: phone, account_id: account });
  const session = await insertSession(campaign.id, { agent_user_id: agent, account_id: account });
  return insertAttempt(campaign.id, contact.id, { reserved_agent_id: session.id, account_id: account, state: 'answered' });
}

const bridge = (table: string, id: string, at: Date = new Date(), db: Pick<PoolClient, 'query'> = pool()) =>
  db.query(`UPDATE ${table} SET bridged_at = $2 WHERE id = $1`, [id, at]);

describe('0028 — handled_reason', () => {
  it('is NULL on an open row, one of the contract`s reasons on a handled one, and nothing else', async () => {
    expect(AGENCY_INBOUND_HANDLED_REASONS).toEqual(['marked', 'reached']);
    const open = await missed();
    expect(open['handled_reason']).toBeNull();
    for (const reason of AGENCY_INBOUND_HANDLED_REASONS) {
      await missed({ follow_up_status: 'handled', handled_at: new Date(), handled_reason: reason });
    }
    // A row handled before 0028 (no reason) is still allowed: a person marked it.
    await missed({ follow_up_status: 'handled', handled_at: new Date() });
    for (const bad of [
      { handled_reason: 'marked' },
      { follow_up_status: 'handled', handled_at: new Date(), handled_reason: 'swept' },
    ]) {
      await expect(missed(bad)).rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_inbound_calls_handled_reason' });
    }
  });
});

describe('0028 — a Missed row closes when the customer is put through', () => {
  it('a campaign attempt closes the account`s open rows from its contact`s number that rang before it, as its agent', async () => {
    const agent = randomUUID();
    const otherAccount = (await insertAccount(TENANT)).id;
    const before = await missed();
    const alsoBefore = await missed({ outcome: 'overflow', follow_up_reason: 'overflow' });
    const otherNumber = await missed({ from_e164: '+447700900999' });
    const withheld = await missed({ from_e164: null });
    const inOtherAccount = await missed({ account_id: otherAccount });
    const tenantDefault = await missed({ account_id: null });
    const alreadyHandled = await missed({ follow_up_status: 'handled', handled_at: new Date('2026-11-01T10:00:00Z'), handled_reason: 'marked', handled_by_user_id: randomUUID() });
    const attempt = await attemptTo(CALLER, agent);
    const bridgedAt = new Date();
    const after = await missed({ arrived_at: new Date(bridgedAt.getTime() + 60_000) });

    await bridge('agency_call_attempts', attempt.id, bridgedAt);

    for (const id of [before.id, alsoBefore.id]) {
      expect(await followUp(id)).toMatchObject({ follow_up_status: 'handled', handled_reason: 'reached', handled_by_user_id: agent });
      expect((await followUp(id)).handled_at).not.toBeNull();
    }
    for (const id of [otherNumber.id, withheld.id, inOtherAccount.id, tenantDefault.id, after.id]) {
      expect(await followUp(id), id).toMatchObject({ follow_up_status: 'open', handled_reason: null, handled_at: null });
    }
    // Handled already: who handled it, why and when are kept.
    expect(await followUp(alreadyHandled.id)).toMatchObject({
      follow_up_status: 'handled', handled_reason: 'marked', handled_at: new Date('2026-11-01T10:00:00Z'),
    });
  });

  it('fires only as bridged_at is first set: other writes to the attempt close nothing', async () => {
    const attempt = await attemptTo(CALLER, randomUUID());
    const row = await missed();
    await pool().query(`UPDATE agency_call_attempts SET state = 'ringing', dialed_at = now() WHERE id = $1`, [attempt.id]);
    expect((await followUp(row.id)).follow_up_status).toBe('open');
    await bridge('agency_call_attempts', attempt.id);
    const late = await missed({ arrived_at: new Date(Date.now() - 1_000) });
    // bridged_at written again (the setState COALESCE): not a new conversation.
    await pool().query('UPDATE agency_call_attempts SET bridged_at = bridged_at, talk_seconds = 5 WHERE id = $1', [attempt.id]);
    expect((await followUp(late.id)).follow_up_status).toBe('open');
  });

  it('a soft-phone call closes the rows from the number it dialled, as the agent who placed it', async () => {
    const agent = randomUUID();
    const session = await insertSoftphoneSession();
    const call = await insertManualCall(session.id, { destination_e164: CALLER, agent_user_id: agent });
    const row = await missed();
    const otherNumber = await missed({ from_e164: '+447700900999' });
    await bridge('agency_manual_calls', call.id);
    expect(await followUp(row.id)).toMatchObject({ follow_up_status: 'handled', handled_reason: 'reached', handled_by_user_id: agent });
    expect((await followUp(otherNumber.id)).follow_up_status).toBe('open');
  });

  it('a later inbound call put through closes the caller`s earlier rows, never itself', async () => {
    const agent = randomUUID();
    const earlier = await missed();
    const live = await insertRow('agency_inbound_calls', {
      tenant_id: TENANT, account_id: ACCOUNT, provider_call_id: `CA-${randomUUID()}`, to_e164: '+14155550100', from_e164: CALLER,
      state: 'offered', session_id: randomUUID(), offered_at: new Date(), offer_count: 1,
    });
    await pool().query(
      `UPDATE agency_inbound_calls SET state = 'connected', bridged_at = now(), answered_by_user_id = $2 WHERE id = $1`, [live.id, agent]);
    expect(await followUp(earlier.id)).toMatchObject({ follow_up_status: 'handled', handled_reason: 'reached', handled_by_user_id: agent });
    const { rows } = await pool().query('SELECT state, follow_up_status FROM agency_inbound_calls WHERE id = $1', [live.id]);
    expect(rows[0]).toEqual({ state: 'connected', follow_up_status: null });
  });

  it('two conversations at once close a row once: the second waits for the first and finds it handled', async () => {
    const first = randomUUID();
    const second = randomUUID();
    const row = await missed();
    const attempt = await attemptTo(CALLER, first);
    const softphone = await insertManualCall((await insertSoftphoneSession()).id, { destination_e164: CALLER, agent_user_id: second });
    const a: PoolClient = await pool().connect();
    const b: PoolClient = await pool().connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await bridge('agency_call_attempts', attempt.id, new Date(), a);
      // B's close blocks on the row A's trigger locked.
      const waiting = bridge('agency_manual_calls', softphone.id, new Date(), b);
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      await waiting;
      await b.query('COMMIT');
    } finally {
      a.release();
      b.release();
    }
    expect(await followUp(row.id)).toMatchObject({ follow_up_status: 'handled', handled_reason: 'reached', handled_by_user_id: first });
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
      const waiting = bridge('agency_call_attempts', attempt.id);
      await new Promise((r) => setTimeout(r, 200));
      await a.query('COMMIT');
      await waiting;
    } finally {
      a.release();
    }
    expect(await followUp(row.id)).toMatchObject({ follow_up_status: 'handled', handled_reason: 'marked', handled_by_user_id: person });
  });
});

/**
 * The plan of `sql` over a seeded history: 40 accounts × 300 ended calls over 30 days, every 50th an
 * open Missed row. Seeded and ANALYZEd inside a rolled-back transaction, never bare (statistics
 * outlive the rows); `params` gets one of the seeded accounts.
 */
async function planOverHistory(sql: string, params: (account: string) => unknown[]): Promise<string> {
  const client: PoolClient = await pool().connect();
  try {
    await client.query('BEGIN');
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
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params(accounts[7]!));
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('0028 — the indexes', () => {
  it('are defined as the migration says', async () => {
    expect(await indexDef('idx_agency_inbound_calls_missed_open_from')).toMatch(
      /ON public\.agency_inbound_calls USING btree \(tenant_id, account_id, from_e164\) WHERE \(\(\(follow_up_status\)::text = 'open'::text\) AND \(from_e164 IS NOT NULL\)\)/);
    expect(await indexDef('idx_agency_inbound_calls_account_arrived')).toMatch(
      /ON public\.agency_inbound_calls USING btree \(tenant_id, account_id, arrived_at\)$/);
  });

  it('the triggers` probe uses the open-Missed index', async () => {
    const plan = await planOverHistory(
      `SELECT id FROM agency_inbound_calls m
        WHERE m.tenant_id = $1::uuid AND m.account_id = $2::uuid AND m.from_e164 = $3::text
          AND m.follow_up_status = 'open' AND m.arrived_at <= now()`,
      (account) => [TENANT, account, '+447700900050'],
    );
    expect(plan).toMatch(/idx_agency_inbound_calls_missed_open_from/);
  });

  it('the summary`s range read uses the account-arrival index', async () => {
    const plan = await planOverHistory(
      `SELECT COUNT(*) FROM agency_inbound_calls c
        WHERE c.tenant_id = $1::uuid AND c.account_id = $2::uuid
          AND c.arrived_at >= $3::timestamptz AND c.arrived_at < $4::timestamptz AND c.state = 'ended'`,
      (account) => [TENANT, account, new Date(Date.now() - 7 * 86_400_000), new Date()],
    );
    expect(plan).toMatch(/idx_agency_inbound_calls_account_arrived/);
  });
});

describe('0028 — the Down and up again', () => {
  const files = () => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const downToBefore = () => migrate('down', files().length - files().indexOf(FILE));

  it('drops the triggers, the function, the indexes and the column; up re-applies them, and a reached row stays handled', async () => {
    const row = await missed();
    await bridge('agency_call_attempts', (await attemptTo(CALLER, randomUUID())).id);
    await downToBefore();
    try {
      expect(await indexDef('idx_agency_inbound_calls_missed_open_from')).toBeUndefined();
      expect(await indexDef('idx_agency_inbound_calls_account_arrived')).toBeUndefined();
      const triggers = await pool().query(`SELECT tgname FROM pg_trigger WHERE tgname LIKE '%inbound_reached'`);
      expect(triggers.rows).toEqual([]);
      const fns = await pool().query(`SELECT proname FROM pg_proc WHERE proname LIKE '%inbound_reached' OR proname = 'agency_inbound_close_reached_missed'`);
      expect(fns.rows).toEqual([]);
      const cols = await pool().query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'agency_inbound_calls' AND column_name = 'handled_reason'`);
      expect(cols.rows).toEqual([]);
      const { rows } = await pool().query('SELECT follow_up_status FROM agency_inbound_calls WHERE id = $1', [row.id]);
      expect(rows[0]).toEqual({ follow_up_status: 'handled' });
      // With 0028 down, a conversation closes nothing.
      const open = await missed();
      await bridge('agency_call_attempts', (await attemptTo(CALLER, randomUUID())).id);
      expect((await pool().query('SELECT follow_up_status FROM agency_inbound_calls WHERE id = $1', [open.id])).rows[0]).toEqual({ follow_up_status: 'open' });
    } finally {
      await migrate('up');
    }
    expect(await indexDef('idx_agency_inbound_calls_missed_open_from')).toBeDefined();
    const again = await missed();
    await bridge('agency_call_attempts', (await attemptTo(CALLER, randomUUID())).id);
    expect((await followUp(again.id)).handled_reason).toBe('reached');
  });
});
