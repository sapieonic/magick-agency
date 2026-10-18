import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const repo = await import('../../../src/db/repositories/agency.repository.js');

/**
 * `unclaimMany` against real Postgres: the batch form of `unclaim` the pacing
 * tick returns a halted batch through. It binds a `uuid[]`, which a mocked pool
 * cannot check.
 */
describe('agencyContactRepository.unclaimMany', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('returns every in-flight contact to pending at the given instant, and touches nothing else', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const a = await insertAgencyContact(campaign.id, { state: 'in_flight' });
    const b = await insertAgencyContact(campaign.id, { state: 'in_flight' });
    const done = await insertAgencyContact(campaign.id, { state: 'completed' });
    const at = new Date(Date.now() + 3_600_000);

    await repo.agencyContactRepository.unclaimMany([a.id, b.id, done.id], at);
    await repo.agencyContactRepository.unclaimMany([], at); // a no-op, not a malformed statement

    const { rows } = await getTestPool().query<{ id: string; state: string; next_attempt_at: Date }>(
      'SELECT id, state, next_attempt_at FROM agency_contacts WHERE campaign_id = $1', [campaign.id],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of [a.id, b.id]) {
      expect(byId.get(id)!.state).toBe('pending');
      expect(byId.get(id)!.next_attempt_at.getTime()).toBe(at.getTime());
    }
    // Only `in_flight` rows are returned: a settled contact is not resurrected.
    expect(byId.get(done.id)!.state).toBe('completed');
  });
});
