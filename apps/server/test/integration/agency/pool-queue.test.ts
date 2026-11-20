import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { readAgentQueueState, readPoolQueueState } = await import('../../../src/agency/pacing/agent-queue.js');
const { agencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * A `pool` campaign's shared queue (agent station BE-5), read on real Postgres: the one probe per
 * campaign (`probeCampaignQueue`) pacing sends as the `queue` frame to every available agent, and
 * the bootstrap and `ready` carry. One case per reason, the earliest `next_due_at`, and the
 * campaign's whole roster read as the pool (owners are ignored on `pool`).
 */

const CATALOG = [
  { code: 'interested', label: 'Interested' },
  { code: 'call_back', label: 'Call back', requires_datetime: true },
];

async function poolCampaign(overrides: Record<string, unknown> = {}) {
  const row = await insertAgencyCampaign({
    status: 'running', assignment_mode: 'pool', disposition_catalog: JSON.stringify(CATALOG), ...overrides,
  });
  return (await agencyCampaignRepository.findById(row.id as string))!;
}

/** An open contact due `inSeconds` from now (negative: already due). */
function open(campaignId: string, inSeconds: number, extra: Record<string, unknown> = {}) {
  return insertAgencyContact(campaignId, { next_attempt_at: new Date(Date.now() + inSeconds * 1_000), ...extra });
}
const callBack = { attempt_count: 1, last_outcome: 'connected', last_disposition: 'call_back' };

describe('the pool campaign\'s shared queue (BE-5)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('queue_empty: nothing open (closed and DNC contacts are not open)', async () => {
    const c = await poolCampaign();
    await open(c.id, -60, { state: 'completed' });
    await open(c.id, -60, { suppressed_reason: 'dnc' });
    expect(await readPoolQueueState(c, new Date())).toEqual({ due: false, reason: 'queue_empty', next_due_at: null });
  });

  it('due: an open contact is due now, whoever owns it', async () => {
    const c = await poolCampaign();
    await open(c.id, -5, { assigned_user_id: randomUUID(), assigned_at: new Date() });
    await open(c.id, 3_600);
    expect(await readPoolQueueState(c, new Date())).toEqual({ due: true, reason: null, next_due_at: null });
  });

  it('waiting_for_retry: open, none due, one not a call-later; the earliest time', async () => {
    const c = await poolCampaign();
    const soon = await open(c.id, 600);
    await open(c.id, 1_200, callBack);
    expect(await readPoolQueueState(c, new Date())).toEqual({
      due: false, reason: 'waiting_for_retry', next_due_at: (soon.next_attempt_at as Date).toISOString(),
    });
  });

  it('callbacks_later: every open contact is a call-later booked for later (an inbound one too)', async () => {
    const c = await poolCampaign();
    const first = await open(c.id, 600, callBack);
    await open(c.id, 900, { callback_source: 'inbound', callback_due_at: new Date(Date.now() + 900_000) });
    expect(await readPoolQueueState(c, new Date())).toEqual({
      due: false, reason: 'callbacks_later', next_due_at: (first.next_attempt_at as Date).toISOString(),
    });
  });

  it('outside_calling_hours: the window is closed, with the earliest open contact', async () => {
    // A window that is never open: no calling days.
    const c = await poolCampaign({ calling_days: [] });
    const first = await open(c.id, -60);
    expect(await readPoolQueueState(c, new Date())).toEqual({
      due: true, reason: null, next_due_at: null,
    });
    // Nothing due: the closed window is the reason.
    await getTestPool().query('UPDATE agency_contacts SET next_attempt_at = now() + interval \'1 hour\' WHERE id = $1', [first.id]);
    const state = await readPoolQueueState(c, new Date());
    expect(state).toMatchObject({ due: false, reason: 'outside_calling_hours' });
    expect(state.next_due_at).not.toBeNull();
  });

  it('readAgentQueueState on a pool campaign is the shared state (the bootstrap, `ready`, My contacts)', async () => {
    const c = await poolCampaign();
    await open(c.id, 600, callBack);
    expect((await readAgentQueueState(c, randomUUID()))?.reason).toBe('callbacks_later');
  });

  it('another campaign\'s contacts are never read', async () => {
    const c = await poolCampaign();
    const other = await poolCampaign();
    await open(other.id, -60);
    expect((await readPoolQueueState(c, new Date())).reason).toBe('queue_empty');
  });
});
