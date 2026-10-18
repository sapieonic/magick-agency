import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgencyContact, insertAgencyContacts } from './agency-factories.js';
import {
  assertReRunningPlan, freshTables, withReRunningPlan,
} from '../../../../../packages/db/test/helpers/rerun-plan.js';

// The repository's queries go to `pinned.client` while a case holds one, so they
// run with that connection's planner settings.
const pinned = vi.hoisted(() => ({ client: null as null | pg.PoolClient }));
vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => pinned.client ?? getTestPool(),
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
 * the order integration files ran in and with autovacuum. The case below gets
 * that plan every time, by the recipe in `packages/db/test/helpers/rerun-plan.ts`
 * (fresh table, statistics from one row, a connection without the alternatives).
 */
/** The claim as it was. */
const OLD_CLAIM = `UPDATE agency_contacts SET state = 'in_flight', updated_at = now()
  WHERE id IN (SELECT id FROM agency_contacts
                WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at <= now()
                  AND suppressed_reason IS DISTINCT FROM 'dnc'
                ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT $2)
  RETURNING *`;

describe('agencyContactRepository.claimDialable', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('claims at most `limit` contacts even when the plan re-runs the locking subquery', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    // One contact, statistics, then the rest, in `next_attempt_at` order.
    await freshTables(getTestPool(), ['agency_contacts']);
    for (let i = 1; i <= 6; i++) {
      await insertAgencyContact(campaign.id, { source_row_number: i });
      if (i === 1) await getTestPool().query('ANALYZE agency_contacts');
    }

    const [first, next] = await withReRunningPlan(getTestPool(), async (client) => {
      await assertReRunningPlan(client, 'agency_contacts', OLD_CLAIM, [campaign.id, 1]);
      pinned.client = client;
      try {
        return [
          await repo.agencyContactRepository.claimDialable(campaign.id, 1),
          await repo.agencyContactRepository.claimDialable(campaign.id, 2),
        ];
      } finally {
        pinned.client = null;
      }
    });
    expect(first).toHaveLength(1);
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
