// Real Postgres: migrations/0003_agency_attempt_indexes.sql. globalSetup has applied every
// migration. Each index is asserted by definition AND by the planner being able to use it for
// the query it exists for — a partial index whose predicate the query does not imply is never
// chosen, and that is invisible in the definition alone (the baseline's live-attempt index was
// exactly that).
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { closeTestPool, getTestPool } from '../setup/test-utils.js';
import { insertPlanRoster } from '../fixtures.js';
import { PLAN_ROSTER_TIMEOUT_MS, endPlanTransactions, inPlanTransaction } from '../plan-transaction.js';

// A test that timed out with its roster transaction still running must not hold the tables for
// the next test or file (plan-transaction.ts).
afterEach(endPlanTransactions);
afterAll(closeTestPool);

async function indexDef(name: string): Promise<string | undefined> {
  const { rows } = await getTestPool().query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
    [name],
  );
  return rows[0]?.indexdef;
}

/**
 * The plan for `sql` with sequential scans priced out, so the test's near-empty tables do not
 * make a scan cheaper than any index. What remains is whether the index is USABLE for the
 * predicate — the property a partial index can silently lack. With `roster`, over a campaign's
 * roster and attempts of the test's own, ANALYZEd in the rolled-back transaction
 * ({@link insertPlanRoster}: without it the contacts' plan followed the statistics and index
 * sizes earlier files left). `sql` may name the roster's campaign (a function of its id): a plan
 * for a campaign with no rows is priced on a one-row estimate, where the indexes tie again.
 */
async function planOf(
  sql: string | ((rosterCampaign: string) => string),
  without: string[] = [],
  opts: { roster?: boolean } = {},
): Promise<string> {
  return inPlanTransaction(async (client) => {
    const roster = opts.roster ? `'${await insertPlanRoster(client)}'::uuid` : CAMPAIGN;
    await client.query('SET LOCAL enable_seqscan = off');
    // An equally usable index the test does not ask about, dropped inside the rolled-back
    // transaction: on a near-empty table the two tie, and the planner's pick follows whatever
    // rows earlier files left.
    for (const index of without) await client.query(`DROP INDEX ${index}`);
    const text = typeof sql === 'function' ? sql(roster) : sql;
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${text}`);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  });
}

const CAMPAIGN = "'00000000-0000-0000-0000-000000000001'::uuid";

describe('0003 — agency attempt and contact indexes', () => {
  it('idx_agency_attempts_live is partial on state <> ended, and countLive can use it', async () => {
    expect(await indexDef('idx_agency_attempts_live')).toMatch(
      /ON public\.agency_call_attempts USING btree \(campaign_id\) WHERE \(\(state\)::text <> 'ended'::text\)/,
    );
    // countLive's own text (AgencyAttemptRepository.countLive). 0005's account-wide live index
    // carries the same predicate and holds the same few rows here (one account): dropped, so the
    // question stays this index's usability. Over the roster's campaign (40,200 attempts, 200
    // live), not an empty one: on near-empty tables the pick followed whatever statistics autovacuum
    // or earlier files left, and once went to a full scan of `uq_agency_attempt_number`.
    const tie = ['idx_agency_attempts_account_live'];
    expect(await planOf(
      (campaign) => `SELECT COUNT(*)::text AS n FROM agency_call_attempts WHERE campaign_id = ${campaign} AND state <> 'ended'`,
      tie,
      { roster: true },
    )).toContain('idx_agency_attempts_live');
    // The reaper's `state = ANY(<live states>)` implies the new predicate too.
    expect(await planOf(
      (campaign) => `SELECT * FROM agency_call_attempts WHERE campaign_id = ${campaign}
          AND state = ANY('{queued,dialing,ringing,answered,bridged}'::varchar[])`,
      tie,
      { roster: true },
    )).toContain('idx_agency_attempts_live');
  }, PLAN_ROSTER_TIMEOUT_MS);

  it('idx_agency_attempts_answered serves the abandonment window', async () => {
    expect(await indexDef('idx_agency_attempts_answered')).toMatch(
      /\(answered_at\) WHERE \(answered_at IS NOT NULL\)/,
    );
    // The window's predicate without its `GROUP BY campaign_id`: with the grouping, a full
    // scan of `idx_agency_attempts_keyset` (campaign_id first) saves the sort, and on the
    // test's near-empty table that tie goes either way with whatever rows earlier files left.
    // Usability of the partial index for the predicate is the property under test.
    expect(await planOf(
      `SELECT COUNT(*) FROM agency_call_attempts a
        WHERE a.state = 'ended' AND a.answered_at IS NOT NULL
          AND a.answered_at > now() - ('24' || ' hours')::interval`,
    )).toContain('idx_agency_attempts_answered');
  });

  it('idx_agency_contacts_connected drives the lapsed-wrap-up sweep', async () => {
    expect(await indexDef('idx_agency_contacts_connected')).toMatch(
      /ON public\.agency_contacts USING btree \(id\) WHERE \(\(state\)::text = 'connected'::text\)/,
    );
    expect(await planOf(
      `SELECT a.id FROM agency_call_attempts a
         JOIN agency_contacts ct ON ct.id = a.contact_id
        WHERE a.state = 'ended' AND a.outcome = 'connected' AND a.bridged_at IS NOT NULL
          AND a.disposition_code IS NULL AND ct.state = 'connected'`,
      [],
      { roster: true },
    )).toContain('idx_agency_contacts_connected');
  }, PLAN_ROSTER_TIMEOUT_MS);

  it('drops idx_agency_attempts_reporting; the keyset index serves campaign + created_at', async () => {
    expect(await indexDef('idx_agency_attempts_reporting')).toBeUndefined();
    expect(await planOf(
      `SELECT count(*) FROM agency_call_attempts
        WHERE campaign_id = ${CAMPAIGN} AND created_at >= now() - interval '2 days'`,
    )).toContain('idx_agency_attempts_keyset');
  });
});
