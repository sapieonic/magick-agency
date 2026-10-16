// Real Postgres: migrations/0003_agency_attempt_indexes.sql. globalSetup has applied every
// migration. Each index is asserted by definition AND by the planner being able to use it for
// the query it exists for — a partial index whose predicate the query does not imply is never
// chosen, and that is invisible in the definition alone (the baseline's live-attempt index was
// exactly that).
import { afterAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { closeTestPool, getTestPool } from '../setup/test-utils.js';

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
 * predicate — the property a partial index can silently lack.
 */
async function planOf(sql: string): Promise<string> {
  const client: PoolClient = await getTestPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF) ${sql}`);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const CAMPAIGN = "'00000000-0000-0000-0000-000000000001'::uuid";

describe('0003 — agency attempt and contact indexes', () => {
  it('idx_agency_attempts_live is partial on state <> ended, and countLive can use it', async () => {
    expect(await indexDef('idx_agency_attempts_live')).toMatch(
      /ON public\.agency_call_attempts USING btree \(campaign_id\) WHERE \(\(state\)::text <> 'ended'::text\)/,
    );
    // countLive's own text (AgencyAttemptRepository.countLive).
    expect(await planOf(
      `SELECT COUNT(*)::text AS n FROM agency_call_attempts WHERE campaign_id = ${CAMPAIGN} AND state <> 'ended'`,
    )).toContain('idx_agency_attempts_live');
    // The reaper's `state = ANY(<live states>)` implies the new predicate too.
    expect(await planOf(
      `SELECT * FROM agency_call_attempts WHERE campaign_id = ${CAMPAIGN}
          AND state = ANY('{queued,dialing,ringing,answered,bridged}'::varchar[])`,
    )).toContain('idx_agency_attempts_live');
  });

  it('idx_agency_attempts_answered serves the abandonment window', async () => {
    expect(await indexDef('idx_agency_attempts_answered')).toMatch(
      /\(answered_at\) WHERE \(answered_at IS NOT NULL\)/,
    );
    expect(await planOf(
      `SELECT a.campaign_id, COUNT(*) FROM agency_call_attempts a
        WHERE a.state = 'ended' AND a.answered_at IS NOT NULL
          AND a.answered_at > now() - ('24' || ' hours')::interval
        GROUP BY a.campaign_id`,
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
    )).toContain('idx_agency_contacts_connected');
  });

  it('drops idx_agency_attempts_reporting; the keyset index serves campaign + created_at', async () => {
    expect(await indexDef('idx_agency_attempts_reporting')).toBeUndefined();
    expect(await planOf(
      `SELECT count(*) FROM agency_call_attempts
        WHERE campaign_id = ${CAMPAIGN} AND created_at >= now() - interval '2 days'`,
    )).toContain('idx_agency_attempts_keyset');
  });
});
