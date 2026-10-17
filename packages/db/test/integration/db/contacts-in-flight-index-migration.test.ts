// Real Postgres: migrations/0004_agency_contacts_in_flight_index.sql. globalSetup has applied
// every migration. Asserted by definition AND by the planner being able to use it for the
// stranded-contact sweep (AgencyContactRepository.findStrandedInFlight), as the 0003 suite does.
import { afterAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { closeTestPool, getTestPool } from '../setup/test-utils.js';

afterAll(closeTestPool);

/** The plan for `sql` with sequential scans priced out (see attempt-indexes-migration.test.ts). */
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

describe('0004 — in_flight contacts index', () => {
  it('idx_agency_contacts_in_flight is partial on in_flight and drives the stranded-contact sweep', async () => {
    const { rows } = await getTestPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_agency_contacts_in_flight'`,
    );
    expect(rows[0]?.indexdef).toMatch(
      /ON public\.agency_contacts USING btree \(id\) WHERE \(\(state\)::text = 'in_flight'::text\)/,
    );
    // findStrandedInFlight's own text.
    const plan = await planOf(
      `SELECT ct.id, ct.tenant_id, ct.campaign_id
         FROM agency_contacts ct
        WHERE ct.state = 'in_flight'
          AND ct.updated_at < now()
          AND NOT EXISTS (
                SELECT 1 FROM agency_call_attempts a
                 WHERE a.contact_id = ct.id
                   AND (a.state <> 'ended' OR a.updated_at >= now()))
        ORDER BY ct.updated_at
        LIMIT 500`,
    );
    expect(plan).toContain('idx_agency_contacts_in_flight');
    expect(plan).toContain('uq_agency_attempt_number');
  });
});
