// Real Postgres: migrations/0011_insights_foundation.sql. globalSetup has applied every migration.
// Pins the reopen flag, the dials-placed counter (its default, its CHECK, the two triggers that
// keep it: exactly one per placed dial, IN6), the backfill, and the four insights read indexes by
// definition and by the planner using them for the read they exist for.
import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import type { PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../../../src/migrations-dir.js';
import { TEST_DB_URL } from '../../helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { ACCOUNT, TENANT, insertAttempt, insertCampaign, insertContact } from '../fixtures.js';

const pool = () => getTestPool();

beforeEach(truncateAll);
afterAll(closeTestPool);

async function column(table: string, name: string) {
  const { rows } = await pool().query<{ data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, name],
  );
  return rows[0];
}

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await pool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`, [name]);
  return rows[0]?.indexdef;
}

async function indexComment(name: string): Promise<string | null> {
  const { rows } = await pool().query<{ c: string | null }>(
    `SELECT obj_description(c.oid, 'pg_class') AS c FROM pg_class c WHERE c.relname = $1`, [name]);
  return rows[0]?.c ?? null;
}

/**
 * The plan for `sql` with sequential and bitmap scans priced out, so the test's near-empty tables
 * do not make a scan cheaper than any index. What remains is whether the index is usable, and
 * whether it covers the read (Index Only Scan).
 */
async function planOf(sql: string, params: unknown[] = []): Promise<string> {
  const client: PoolClient = await pool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`, params);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const ROSTER_CAMPAIGNS = 4;
const ROSTER_NAME = 'Insights plan roster';

/**
 * 20,000 contacts over four campaigns of this account, interleaved row by row (as several
 * campaigns' imports land in one table), COMMITTED and then `VACUUM (ANALYZE)`d so the visibility
 * map marks the pages all-visible, as autovacuum keeps a production table. Returns the campaign a
 * plan reads (a quarter of the rows, scattered over every page).
 */
async function insertVacuumedRoster(): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids)
     SELECT $1, $2, $3, ARRAY['+14155550100'] FROM generate_series(1, $4::int) RETURNING id`,
    [TENANT, ACCOUNT, ROSTER_NAME, ROSTER_CAMPAIGNS]);
  const campaigns = rows.map((r) => r.id);
  await pool().query(
    `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, state)
     SELECT ($1::uuid[])[1 + g % $4::int], $2, $3, '+1415555' || lpad((g % 10000)::text, 4, '0'),
            CASE WHEN g % 100 = 0 THEN 'in_flight' WHEN g % 100 = 1 THEN 'connected'
                 WHEN g % 2 = 0 THEN 'pending' ELSE 'completed' END
       FROM generate_series(1, 20000) g`,
    [campaigns, TENANT, ACCOUNT, ROSTER_CAMPAIGNS]);
  await pool().query('VACUUM (ANALYZE) agency_contacts');
  return campaigns[0]!;
}

/** The roster's rows gone, and their pages given back (a later file sizes the table by its pages). */
async function removeVacuumedRoster(): Promise<void> {
  await pool().query(
    `DELETE FROM agency_contacts WHERE campaign_id IN (SELECT id FROM agency_campaigns WHERE name = $1)`, [ROSTER_NAME]);
  await pool().query('DELETE FROM agency_campaigns WHERE name = $1', [ROSTER_NAME]);
  await pool().query('VACUUM agency_contacts');
}

async function dialsPlaced(contactId: string): Promise<number> {
  const { rows } = await pool().query<{ n: number }>('SELECT dials_placed AS n FROM agency_contacts WHERE id = $1', [contactId]);
  return rows[0]!.n;
}

const CAMPAIGN = '00000000-0000-0000-0000-000000000001';

// No migration lock: nothing else migrates this file's own database copy, and after a refused
// Down the runner's unlock fails on its aborted transaction, so the lock lingers until the session
// ends, which a restore right after could race.
const migrate = (direction: 'up' | 'down', count = Infinity) =>
  runner({ databaseUrl: TEST_DB_URL, dir: MIGRATIONS_DIR, direction, migrationsTable: 'pgmigrations', count, log: () => {}, noLock: true });

describe('0011 — insights foundation', () => {
  it('agency_call_attempts.agent_reopened is NOT NULL DEFAULT false', async () => {
    expect(await column('agency_call_attempts', 'agent_reopened')).toEqual({
      data_type: 'boolean', is_nullable: 'NO', column_default: 'false',
    });
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    expect((await insertAttempt(campaign.id, contact.id))['agent_reopened']).toBe(false);
  });

  it('agency_contacts.dials_placed is NOT NULL DEFAULT 0 and never negative', async () => {
    expect(await column('agency_contacts', 'dials_placed')).toEqual({
      data_type: 'integer', is_nullable: 'NO', column_default: '0',
    });
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    expect(contact['dials_placed']).toBe(0);
    await expect(pool().query('UPDATE agency_contacts SET dials_placed = -1 WHERE id = $1', [contact.id]))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_contact_dials_placed' });
  });

  it('counts each placed dial exactly once: insert with dialed_at, NULL → value, never twice, never unplaced', async () => {
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id);
    const other = await insertContact(campaign.id, { phone_e164: '+14155550102' });

    // Inserted already placed (dialed_at set): counts.
    await insertAttempt(campaign.id, contact.id, { attempt_number: 1, state: 'ended', dialed_at: new Date() });
    expect(await dialsPlaced(contact.id)).toBe(1);

    // Inserted queued (the dialer's path), then stamped dialing: counts on the stamp.
    const queued = await insertAttempt(campaign.id, contact.id, { attempt_number: 2 });
    expect(await dialsPlaced(contact.id)).toBe(1);
    await pool().query(`UPDATE agency_call_attempts SET state = 'dialing', dialed_at = now() WHERE id = $1`, [queued.id]);
    expect(await dialsPlaced(contact.id)).toBe(2);

    // A second write of dialed_at (setState's COALESCE re-writes it on every transition) and a
    // later transition do not count again.
    await pool().query(`UPDATE agency_call_attempts SET dialed_at = now() + interval '1 second' WHERE id = $1`, [queued.id]);
    await pool().query(
      `UPDATE agency_call_attempts SET state = 'ended', outcome = 'no_answer', dialed_at = COALESCE(NULL, dialed_at), ended_at = now()
        WHERE id = $1`, [queued.id]);
    expect(await dialsPlaced(contact.id)).toBe(2);

    // An attempt never placed (abandoned before the dial) does not count, whatever else it writes.
    const unplaced = await insertAttempt(campaign.id, contact.id, { attempt_number: 3 });
    await pool().query(
      `UPDATE agency_call_attempts SET state = 'ended', outcome = 'abandoned', ended_at = now() WHERE id = $1`, [unplaced.id]);
    expect(await dialsPlaced(contact.id)).toBe(2);

    // Only the attempt's own contact moves.
    expect(await dialsPlaced(other.id)).toBe(0);
  });

  it('counting a dial does not move the contact\'s updated_at; an edit of the contact still does', async () => {
    // The stranded-contact sweep reads updated_at ("untouched since"): a dial stamped on the
    // contact must not reset it. trg_agency_contacts_updated_at skips only the counter's
    // nested update.
    const campaign = await insertCampaign();
    const contact = await insertContact(campaign.id, { state: 'in_flight', updated_at: new Date('2000-01-01T00:00:00Z') });
    const updatedAt = async () => (await pool().query<{ u: Date }>(
      'SELECT updated_at AS u FROM agency_contacts WHERE id = $1', [contact.id])).rows[0]!.u.getUTCFullYear();

    await insertAttempt(campaign.id, contact.id, { attempt_number: 1, state: 'ended', dialed_at: new Date() });
    const queued = await insertAttempt(campaign.id, contact.id, { attempt_number: 2 });
    await pool().query(`UPDATE agency_call_attempts SET state = 'dialing', dialed_at = now() WHERE id = $1`, [queued.id]);
    expect(await dialsPlaced(contact.id)).toBe(2);
    expect(await updatedAt()).toBe(2000);

    await pool().query(`UPDATE agency_contacts SET state = 'pending' WHERE id = $1`, [contact.id]);
    expect(await updatedAt()).toBeGreaterThan(2000);
  });

  it('a wrap-up redial is a placed dial like any other (IN6)', async () => {
    const campaign = await insertCampaign({ allow_wrapup_redial: true });
    const contact = await insertContact(campaign.id);
    const original = await insertAttempt(campaign.id, contact.id, {
      attempt_number: 1, state: 'ended', outcome: 'connected', dialed_at: new Date(), wrapup_resolution: 'redialed',
    });
    const redial = await insertAttempt(campaign.id, contact.id, {
      attempt_number: 2, redial_of_attempt_id: original.id, redial_number: 1,
    });
    await pool().query(`UPDATE agency_call_attempts SET state = 'dialing', dialed_at = now() WHERE id = $1`, [redial.id]);
    expect(await dialsPlaced(contact.id)).toBe(2);
  });

  it('the insights indexes exist with their definitions and comments', async () => {
    // 0026 rebuilt it with `callback_source` (the inbound callback isCallbackSql reads); its own test
    // pins that its down restores this file's definition.
    expect(await indexDef('idx_agency_contacts_insights')).toBe(
      'CREATE INDEX idx_agency_contacts_insights ON public.agency_contacts USING btree (campaign_id, state) '
      + 'INCLUDE (next_attempt_at, suppressed_reason, attempt_count, dials_placed, last_outcome, last_disposition, assigned_user_id, callback_source)',
    );
    expect(await indexDef('idx_agency_attempts_campaign_dialed')).toBe(
      'CREATE INDEX idx_agency_attempts_campaign_dialed ON public.agency_call_attempts USING btree (campaign_id, dialed_at) '
      + 'WHERE (dialed_at IS NOT NULL)',
    );
    expect(await indexDef('idx_agency_attempts_campaign_callback')).toBe(
      'CREATE INDEX idx_agency_attempts_campaign_callback ON public.agency_call_attempts USING btree (campaign_id, callback_at) '
      + 'WHERE (callback_at IS NOT NULL)',
    );
    expect(await indexDef('idx_agency_session_events_campaign_at')).toBe(
      'CREATE INDEX idx_agency_session_events_campaign_at ON public.agency_agent_session_events USING btree (campaign_id, at)',
    );
    for (const name of ['idx_agency_contacts_insights', 'idx_agency_attempts_campaign_dialed',
      'idx_agency_attempts_campaign_callback', 'idx_agency_session_events_campaign_at']) {
      expect(await indexComment(name), name).toMatch(/^Insights /);
    }
  });

  // Over a roster of the test's own, committed and VACUUM ANALYZEd: an index-only scan is priced
  // by how much of the table the visibility map marks all-visible, and only a VACUUM outside a
  // transaction sets it. Planned on the near-empty tables a full run leaves (as it was), the pick
  // followed whether autovacuum's ANALYZE had landed and went to idx_agency_contacts_assignee about
  // one full run in four; seeded inside a rolled-back transaction (0003/0004's roster) nothing is
  // all-visible, an index-only scan costs what an index scan does, and the narrower
  // idx_agency_contacts_assignee wins every time. The roster's rows and pages go again before the
  // test ends (deleted, then VACUUM gives the pages back, as 0017's test does), so a later file
  // does not plan over a table sized by them. The ANALYZE's column statistics stay: no plan test
  // leans on agency_contacts' statistics without ANALYZEing its own rows first.
  it('a roster bucket count for one campaign is an Index Only Scan on idx_agency_contacts_insights', async () => {
    const campaign = await insertVacuumedRoster();
    try {
      const plan = await planOf(
        `SELECT state, count(*)::int AS n,
                count(*) FILTER (WHERE suppressed_reason IS NOT NULL)::int AS suppressed,
                sum(dials_placed)::int AS dials, count(assigned_user_id)::int AS assigned
           FROM agency_contacts WHERE campaign_id = $1 GROUP BY state`,
        [campaign],
      );
      expect(plan, plan).toMatch(/Index Only Scan using idx_agency_contacts_insights on agency_contacts/);
      expect(plan, plan).toMatch(/Index Cond: \(campaign_id = /);
    } finally {
      await removeVacuumedRoster();
    }
    // Seeding, two VACUUMs and a delete: seconds on a loaded machine, as 0017's roster test.
  }, 60_000);

  // The ranged reads plan over the near-empty tables a full run leaves: each is phrased so its
  // index is the only one that serves it whole (the only index giving the range in order).

  it('the ranged attempt and session-event reads use their indexes, in order', async () => {
    const dialed = await planOf(
      `SELECT id, dialed_at FROM agency_call_attempts
        WHERE campaign_id = $1 AND dialed_at >= now() - interval '1 day' AND dialed_at < now()
        ORDER BY dialed_at`, [CAMPAIGN],
    );
    expect(dialed).toMatch(/Index Scan using idx_agency_attempts_campaign_dialed/);
    expect(dialed).not.toMatch(/Sort/);
    const callback = await planOf(
      `SELECT id, callback_at FROM agency_call_attempts
        WHERE campaign_id = $1 AND callback_at >= now() - interval '7 days' AND callback_at < now()
        ORDER BY callback_at`, [CAMPAIGN],
    );
    expect(callback).toMatch(/Index Scan using idx_agency_attempts_campaign_callback/);
    expect(callback).not.toMatch(/Sort/);
    const events = await planOf(
      `SELECT agent_user_id, to_state, at FROM agency_agent_session_events
        WHERE campaign_id = $1 AND at >= now() - interval '1 day' AND at < now()
        ORDER BY at`, [CAMPAIGN],
    );
    expect(events).toMatch(/Index Scan using idx_agency_session_events_campaign_at/);
    expect(events).not.toMatch(/Sort/);
  });

  it('down drops everything; up re-applies and backfills dials_placed from the placed attempts', async () => {
    // Down through 0011, whatever migrations came after it (each later one's down first).
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    await migrate('down', files.length - files.indexOf('0011_insights_foundation.sql'));
    // Seeded under 0010 (no counter, no triggers), backdated at insert (an UPDATE would be
    // re-stamped by the updated_at trigger), so the backfill's effect on updated_at shows.
    const old = { updated_at: new Date('2000-01-01T00:00:00Z') };
    const campaign = await insertCampaign();
    const a = await insertContact(campaign.id, old);
    const b = await insertContact(campaign.id, { ...old, phone_e164: '+14155550102' });
    const c = await insertContact(campaign.id, { ...old, phone_e164: '+14155550103' });
    try {
      await insertAttempt(campaign.id, a.id, { attempt_number: 1, state: 'ended', dialed_at: new Date() });
      await insertAttempt(campaign.id, a.id, { attempt_number: 2, state: 'ended', dialed_at: new Date() });
      await insertAttempt(campaign.id, a.id, { attempt_number: 3, state: 'ended' }); // never placed
      await insertAttempt(campaign.id, b.id, { attempt_number: 1, state: 'ended', dialed_at: new Date() });

      const ledger = await pool().query<{ name: string }>('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
      expect(ledger.rows[0]!.name).toBe('0010_contact_assignment_index_and_checks');
      expect(await column('agency_contacts', 'dials_placed')).toBeUndefined();
      expect(await column('agency_call_attempts', 'agent_reopened')).toBeUndefined();
      const left = await pool().query(
        `SELECT 'idx' AS k, indexname AS n FROM pg_indexes WHERE indexname IN
           ('idx_agency_contacts_insights', 'idx_agency_attempts_campaign_dialed',
            'idx_agency_attempts_campaign_callback', 'idx_agency_session_events_campaign_at')
         UNION ALL SELECT 'trg', tgname FROM pg_trigger WHERE tgname LIKE 'trg_agency_attempts_dial_placed%'
         UNION ALL SELECT 'fn', proname FROM pg_proc WHERE proname = 'agency_attempt_count_placed_dial'
         UNION ALL SELECT 'ck', conname FROM pg_constraint WHERE conname = 'ck_agency_contact_dials_placed'`);
      expect(left.rows).toEqual([]);
    } finally {
      await migrate('up');
    }

    // The backfill: placed attempts per contact, and the contacts keep their updated_at.
    const { rows } = await pool().query<{ id: string; dials_placed: number; updated_at: Date }>(
      'SELECT id, dials_placed, updated_at FROM agency_contacts WHERE campaign_id = $1', [campaign.id]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(a.id)!.dials_placed).toBe(2);
    expect(byId.get(b.id)!.dials_placed).toBe(1);
    expect(byId.get(c.id)!.dials_placed).toBe(0);
    for (const r of rows) expect(r.updated_at.getUTCFullYear(), 'backfill moved updated_at').toBe(2000);
    // And the updated_at trigger is back on.
    const touched = await pool().query<{ updated_at: Date }>(
      `UPDATE agency_contacts SET context = '{"x":1}' WHERE id = $1 RETURNING updated_at`, [c.id]);
    expect(touched.rows[0]!.updated_at.getUTCFullYear()).toBeGreaterThan(2000);

    // The triggers work after the re-apply.
    await insertAttempt(campaign.id, c.id, { attempt_number: 1, state: 'ended', dialed_at: new Date() });
    expect(await dialsPlaced(c.id)).toBe(1);
  });
});
