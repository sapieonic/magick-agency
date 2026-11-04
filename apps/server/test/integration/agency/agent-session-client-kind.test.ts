import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgentSession } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyAgentSessionRepository: repo } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * `readForStationAttach` on real Postgres: the station attach's session read, which also
 * records the attaching app (`client_kind`, 0006) in the same statement. A mocked pool
 * could not see the `UNION ALL` of the CTE's two arms disagree on a column, nor `$2`
 * untyped in two contexts (42P08).
 */
describe('AgencyAgentSessionRepository.readForStationAttach', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  async function row(id: string) {
    const { rows } = await getTestPool().query<{ client_kind: string; updated_at: Date; xmin: string }>(
      'SELECT client_kind, updated_at, xmin::text AS xmin FROM agency_agent_sessions WHERE id = $1', [id],
    );
    return rows[0]!;
  }

  it('writes the kind when it changes and answers the row as it stands after the write', async () => {
    const campaign = await insertAgencyCampaign();
    const session = await insertAgentSession(campaign.id);
    expect((await row(session.id)).client_kind).toBe('web');

    const read = await repo.readForStationAttach(session.id, 'mobile');
    expect(read).toMatchObject({ id: session.id, campaign_id: campaign.id, client_kind: 'mobile', state: 'available', left_at: null });
    expect((await row(session.id)).client_kind).toBe('mobile');

    const back = await repo.readForStationAttach(session.id, 'web');
    expect(back?.client_kind).toBe('web');
    expect((await row(session.id)).client_kind).toBe('web');
  });

  it('writes nothing when the kind is unchanged (the common reconnect): the same tuple, the same answer as findById', async () => {
    const campaign = await insertAgencyCampaign();
    const session = await insertAgentSession(campaign.id, { client_kind: 'mobile' });
    const before = await row(session.id);

    const read = await repo.readForStationAttach(session.id, 'mobile');
    // `findById`'s row, plus the campaign's mode (the factory's default, `pool`).
    expect(read).toEqual({ ...(await repo.findById(session.id)), campaign_assignment_mode: 'pool' });
    const after = await row(session.id);
    // xmin moves on any UPDATE, even one to the same value.
    expect(after.xmin).toBe(before.xmin);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
  });

  it('never writes a session that has left, and still answers it (the attach refuses it 4404)', async () => {
    const campaign = await insertAgencyCampaign();
    const session = await insertAgentSession(campaign.id, { left_at: new Date(), state: 'offline' });
    const before = await row(session.id);

    const read = await repo.readForStationAttach(session.id, 'mobile');
    expect(read?.left_at).toBeInstanceOf(Date);
    expect(read?.client_kind).toBe('web');
    expect((await row(session.id)).xmin).toBe(before.xmin);
  });

  it("carries the campaign's assignment mode, on the written row and on the unchanged one", async () => {
    const campaign = await insertAgencyCampaign({ assignment_mode: 'strict' });
    const session = await insertAgentSession(campaign.id);
    expect((await repo.readForStationAttach(session.id, 'mobile'))?.campaign_assignment_mode).toBe('strict');
    expect((await repo.readForStationAttach(session.id, 'mobile'))?.campaign_assignment_mode).toBe('strict');
  });

  it('answers null for no such session', async () => {
    expect(await repo.readForStationAttach(randomUUID(), 'mobile')).toBeNull();
  });

  it('a soft-phone session records its kind too', async () => {
    const session = await insertAgentSession(null as unknown as string, {
      kind: 'softphone', campaign_id: null, state: 'break', break_reason: 'soft_phone',
    });
    const read = await repo.readForStationAttach(session.id, 'mobile');
    expect(read?.client_kind).toBe('mobile');
    // No campaign, so no mode.
    expect(read?.campaign_assignment_mode).toBeNull();
    // Leave nothing behind for 0005's Down (the db suite's down → up).
    await getTestPool().query('DELETE FROM agency_agent_sessions WHERE id = $1', [session.id]);
  });
});
