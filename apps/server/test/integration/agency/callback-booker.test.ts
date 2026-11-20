import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));

const {
  insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession, insertManualCall, insertSoftphoneSession,
} = await import('./agency-factories.js');
const { agencyContactRepository } = await import('../../../src/db/repositories/agency.repository.js');
type CallbackBooker = import('../../../src/agency/call-later.js').CallbackBooker;

/**
 * Who booked a call-later (agent station BE-3, 0057), against real Postgres: the disposition's
 * contact write (`releaseFromDisposition`) stamps `callback_booked_by_user_id` / `_at` in the same
 * guarded statement as the release, and the contact's next settled call clears them.
 *
 *  - (a) the agent's own call-later stamps them, now;
 *  - (b) a supervisor's on-behalf save never stamps;
 *  - (c) a supervisor's on-behalf replay keeps the agent's booker while the time stays, clears it when moved;
 *  - (d) the agent's own replay re-stamps;
 *  - (e) nothing booked, or a contact left anything but `pending`, or DNC-suppressed: none;
 *  - (f) the next placed call clears them (`chargeAttempt`); a dial that never went out
 *    (`unclaim`) and an our-fault redial (`chargeOurFaultAttempt`) keep them;
 *  - (g) a placed soft-phone call that held the contact clears them (`settleFromManual`).
 */

const AGENT = randomUUID();
const CALLBACK_1 = new Date('2099-01-02T10:00:00.000Z');
const CALLBACK_2 = new Date('2099-01-03T15:30:00.000Z');

async function booker(id: string): Promise<{ by: string | null; at: Date | null; state: string }> {
  const { rows } = await getTestPool().query(
    'SELECT callback_booked_by_user_id AS by, callback_booked_at AS at, state FROM agency_contacts WHERE id = $1', [id]);
  return rows[0];
}

/** One conversation that ended ten minutes ago, its contact parked `connected` for the write-up. */
async function conversationAwaitingWriteUp() {
  const campaign = await insertAgencyCampaign({ status: 'running' });
  const contact = await insertAgencyContact(campaign.id, { state: 'connected', attempt_count: 1 });
  // One live session per agent (`uq_agency_agent_live_tenant`): each conversation's own agent; the
  // booker the write is handed is the test's to choose.
  const session = await insertAgentSession(campaign.id, { state: 'wrapup' });
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
  const attempt = await insertAgencyAttempt(campaign.id, contact.id, {
    state: 'ended', outcome: 'connected', reserved_agent_id: session.id,
    dialed_at: tenMinutesAgo, answered_at: tenMinutesAgo, bridged_at: tenMinutesAgo, ended_at: tenMinutesAgo,
    created_at: tenMinutesAgo,
  });
  return { campaignId: campaign.id as string, contactId: contact.id as string, attemptId: attempt.id as string };
}

function release(
  w: { contactId: string; attemptId: string },
  code: string,
  state: 'completed' | 'pending' | 'suppressed',
  nextAttemptAt: Date | null,
  callbackBooker: CallbackBooker,
) {
  return agencyContactRepository.releaseFromDisposition({
    contactId: w.contactId, attemptId: w.attemptId, dispositionCode: code, state,
    lastOutcome: 'connected', nextAttemptAt, suppressedReason: state === 'suppressed' ? 'disposition' : null, callbackBooker,
  });
}

const mine = { kind: 'mine' as const, userId: AGENT };
const onBehalf = { kind: 'on_behalf' as const };

describe('the call-later\'s booker on the disposition\'s contact write', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('(a) the agent\'s own call-later stamps them, in the release', async () => {
    const w = await conversationAwaitingWriteUp();
    const before = Date.now();
    expect(await release(w, 'callback', 'pending', CALLBACK_1, mine)).toMatchObject({ state: 'pending' });
    const b = await booker(w.contactId);
    expect(b.by).toBe(AGENT);
    expect(b.at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  // FALSIFIED: with the on-behalf arm stamping like `mine` (or the route passing `mine` for an
  // on-behalf save, `callbackBookerOf`), this reds.
  it('(b) a supervisor\'s on-behalf save never stamps a booker', async () => {
    const w = await conversationAwaitingWriteUp();
    await release(w, 'callback', 'pending', CALLBACK_1, onBehalf);
    expect(await booker(w.contactId)).toMatchObject({ by: null, at: null, state: 'pending' });
  });

  it('(c) a supervisor\'s replay keeps the agent\'s booker while the time stays, and clears it when they move it', async () => {
    const w = await conversationAwaitingWriteUp();
    await release(w, 'callback', 'pending', CALLBACK_1, mine);
    const stamped = await booker(w.contactId);
    await release(w, 'callback', 'pending', CALLBACK_1, onBehalf);
    expect(await booker(w.contactId)).toEqual(stamped);
    await release(w, 'callback', 'pending', CALLBACK_2, onBehalf);
    expect(await booker(w.contactId)).toMatchObject({ by: null, at: null, state: 'pending' });
  });

  it('(d) the agent\'s own replay that corrects the time stamps them again', async () => {
    const w = await conversationAwaitingWriteUp();
    await release(w, 'callback', 'pending', CALLBACK_1, onBehalf);
    await release(w, 'callback', 'pending', CALLBACK_2, mine);
    expect((await booker(w.contactId)).by).toBe(AGENT);
  });

  it('(e) nothing booked, a contact left closed, or DNC-suppressed: no booker', async () => {
    const plain = await conversationAwaitingWriteUp();
    await release(plain, 'sale', 'completed', null, null);
    expect(await booker(plain.contactId)).toMatchObject({ by: null, at: null, state: 'completed' });

    // Even handed `mine`, a contact the write does not leave pending carries none.
    const closed = await conversationAwaitingWriteUp();
    await release(closed, 'callback', 'completed', null, mine);
    expect(await booker(closed.contactId)).toMatchObject({ by: null, state: 'completed' });

    const dnc = await conversationAwaitingWriteUp();
    await getTestPool().query(`UPDATE agency_contacts SET suppressed_reason = 'dnc' WHERE id = $1`, [dnc.contactId]);
    await release(dnc, 'callback', 'pending', CALLBACK_1, mine);
    expect(await booker(dnc.contactId)).toMatchObject({ by: null, state: 'suppressed' });
  });

  it('(f) the next placed call clears them; a dial that never went out and an our-fault redial keep them', async () => {
    const w = await conversationAwaitingWriteUp();
    await release(w, 'callback', 'pending', new Date(Date.now() - 1000), mine);
    const stamped = await booker(w.contactId);

    // Claimed for its dial, then given back before the carrier saw it.
    expect((await agencyContactRepository.claimDialable(w.campaignId, 10)).map((c) => c.id)).toEqual([w.contactId]);
    await agencyContactRepository.unclaim(w.contactId, new Date(Date.now() - 1000));
    expect(await booker(w.contactId)).toMatchObject({ by: stamped.by, at: stamped.at });

    // The claim hands the dialer the booker with the contact (BE-4 reads it there).
    const [claimed] = await agencyContactRepository.claimDialable(w.campaignId, 10);
    expect(claimed!.callback_booked_by_user_id).toBe(AGENT);

    await agencyContactRepository.chargeOurFaultAttempt(w.contactId, 'agent_disconnected');
    expect((await booker(w.contactId)).by).toBe(AGENT);

    await agencyContactRepository.chargeAttempt(w.contactId, 'no_answer');
    expect(await booker(w.contactId)).toMatchObject({ by: null, at: null });
  });

  it('(g) a placed soft-phone call that held the contact clears them', async () => {
    const w = await conversationAwaitingWriteUp();
    await release(w, 'callback', 'pending', CALLBACK_1, mine);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = $1`, [w.contactId]);
    const call = await insertManualCall(await insertSoftphoneSession(), {
      campaign_id: w.campaignId, contact_id: w.contactId, contact_claimed: true, contact_prior_state: 'pending',
      state: 'ended', ended_at: new Date(), dialed_at: new Date(), bridged_at: new Date(), outcome: 'connected',
    });
    await agencyContactRepository.settleFromManual({
      manualCallId: call.id, decision: null, charge: 'attempt', lastOutcome: 'connected', lastDisposition: null,
    });
    expect(await booker(w.contactId)).toMatchObject({ by: null, at: null });
  });
});
