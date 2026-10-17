import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgencyContacts } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const repo = await import('../../../src/db/repositories/agency.repository.js');

/**
 * `claimDialable` never claims more than `limit`, whatever plan Postgres picks.
 *
 * The pacing tick pairs claimed contacts with reserved agents by index
 * (`reserved[index]`), so a claim longer than the reservation hands the tail an
 * `undefined` session: `agency:agent:undefined:state` written to Redis, and (with a
 * station stub that owns everyone) a dial with no agent behind it.
 *
 * The claim used to be `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED
 * LIMIT n)`. Planned as a nested-loop semi join, the locking subquery is the inner
 * side and is re-run for every outer row; each re-run skips the rows this same
 * statement has already updated, so LIMIT 1 claimed the whole roster. Postgres
 * picks that plan from the table's statistics, which is why it came and went with
 * the order integration files ran in and with autovacuum. Statistics taken while
 * the table had pages but no live rows (rows deleted, not truncated) reliably give
 * that plan, so that is the setup.
 */
describe('agencyContactRepository.claimDialable', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('claims at most `limit` contacts even when the plan re-runs the locking subquery', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    // Pages but no live rows when analysed: the planner then expects one row and
    // joins with a nested loop, the plan that re-runs the subquery.
    const pool = getTestPool();
    await insertAgencyContacts(campaign.id, 6);
    await pool.query('DELETE FROM agency_contacts');
    await pool.query('ANALYZE agency_contacts');
    await insertAgencyContacts(campaign.id, 6);
    const { rows: plan } = await pool.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN UPDATE agency_contacts SET state = 'in_flight'
        WHERE id IN (SELECT id FROM agency_contacts WHERE campaign_id = $1
                      ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1)`,
      [campaign.id],
    );
    // The precondition, asserted: without this plan the case proves nothing.
    expect(plan.map((r) => r['QUERY PLAN']).join('\n')).toContain('Nested Loop Semi Join');

    const first = await repo.agencyContactRepository.claimDialable(campaign.id, 1);
    expect(first).toHaveLength(1);
    const next = await repo.agencyContactRepository.claimDialable(campaign.id, 2);
    expect(next).toHaveLength(2);

    // Exactly what was returned went in flight; the rest are still on the roster.
    const { rows } = await getTestPool().query<{ state: string; n: number }>(
      `SELECT state, count(*)::int AS n FROM agency_contacts WHERE campaign_id = $1 GROUP BY state`,
      [campaign.id],
    );
    expect(Object.fromEntries(rows.map((r) => [r.state, r.n]))).toEqual({ in_flight: 3, pending: 3 });
    expect(new Set([...first, ...next].map((c) => c.id)).size).toBe(3);
    expect([...first, ...next].every((c) => c.state === 'in_flight')).toBe(true);
  });

  it('claims in next_attempt_at order and leaves contacts that are not due', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const now = Date.now();
    const [late, early] = await insertAgencyContacts(campaign.id, 2);
    await insertAgencyContacts(campaign.id, 1, {
      source_row_number: 3, next_attempt_at: new Date(now + 3_600_000),
    });
    await getTestPool().query(
      `UPDATE agency_contacts SET next_attempt_at = $2 WHERE id = $1`, [late!.id, new Date(now - 1_000)],
    );
    await getTestPool().query(
      `UPDATE agency_contacts SET next_attempt_at = $2 WHERE id = $1`, [early!.id, new Date(now - 60_000)],
    );

    expect((await repo.agencyContactRepository.claimDialable(campaign.id, 1)).map((c) => c.id)).toEqual([early!.id]);
    // The future one is not due, so a limit of 5 still claims only the one left.
    expect((await repo.agencyContactRepository.claimDialable(campaign.id, 5)).map((c) => c.id)).toEqual([late!.id]);
  });
});
