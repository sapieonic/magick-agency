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
 *  - (g) a placed soft-phone call that held the contact clears them (`settleFromManual`);
 *  - (h) a call-later the agent books on their own soft-phone call stamps them (`settleFromManual`
 *    with `mine`); a supervisor's on-behalf save, no call-later, or a contact not left `pending` do
 *    not; (i) its replay re-stamps for the agent and, for a supervisor, keeps them only while the
 *    time stays (`rescheduleFromManualReplay`);
 *  - (j) a call-later the agent who answered an inbound call books stamps them (`settleFromInbound`'s
 *    `callback` arm with `mine`), also over the customer's own missed-call callback (`callback_source`,
 *    which never has a booker and is cleared); a supervisor's on-behalf save, any other arm and the
 *    lapse clear them; (k) its replay as the soft phone's (`rescheduleFromInboundReplay`).
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

  /** A soft-phone call by AGENT that claimed `w`'s contact and bridged, ended, its outcome owed. */
  async function softPhoneCallOn(w: { campaignId: string; contactId: string }) {
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight', callback_booked_by_user_id = NULL,
                                      callback_booked_at = NULL WHERE id = $1`, [w.contactId]);
    // A session already left: one live session per agent, and the settlement never reads it.
    return insertManualCall(await insertSoftphoneSession({ agent_user_id: AGENT, state: 'offline', left_at: new Date() }), {
      campaign_id: w.campaignId, contact_id: w.contactId, contact_claimed: true, contact_prior_state: 'pending',
      state: 'ended', ended_at: new Date(), dialed_at: new Date(), bridged_at: new Date(), outcome: 'connected',
    });
  }

  function settleSoftPhone(callId: string, state: 'pending' | 'completed', at: Date | null, callbackBooker?: CallbackBooker) {
    return agencyContactRepository.settleFromManual({
      manualCallId: callId, decision: { contactState: state, nextAttemptAt: at, suppressedReason: null },
      charge: 'attempt', lastOutcome: 'connected', lastDisposition: 'callback', ...(callbackBooker !== undefined ? { callbackBooker } : {}),
    });
  }

  it('(h) the agent\'s own call-later on a soft-phone call stamps them; on behalf, none booked, or closed: none', async () => {
    const w = await conversationAwaitingWriteUp();
    const before = Date.now();
    expect(await settleSoftPhone((await softPhoneCallOn(w)).id, 'pending', CALLBACK_1, mine)).toMatchObject({ state: 'pending', applied: 'settled' });
    const b = await booker(w.contactId);
    expect(b.by).toBe(AGENT);
    expect(b.at!.getTime()).toBeGreaterThanOrEqual(before - 1000);

    for (const callbackBooker of [onBehalf, null, undefined] as const) {
      const v = await conversationAwaitingWriteUp();
      await settleSoftPhone((await softPhoneCallOn(v)).id, 'pending', CALLBACK_1, callbackBooker ?? undefined);
      expect(await booker(v.contactId), String(callbackBooker?.kind)).toMatchObject({ by: null, at: null });
    }
    const closed = await conversationAwaitingWriteUp();
    await settleSoftPhone((await softPhoneCallOn(closed)).id, 'completed', null, mine);
    expect(await booker(closed.contactId)).toMatchObject({ by: null, at: null, state: 'completed' });
  });

  it('(i) a soft-phone replay: the agent\'s re-stamps; a supervisor\'s keeps them while the time stays, clears them when moved', async () => {
    const w = await conversationAwaitingWriteUp();
    const call = await softPhoneCallOn(w);
    await settleSoftPhone(call.id, 'pending', CALLBACK_1, mine);
    const first = (await booker(w.contactId)).at!;
    const replay = (at: Date, callbackBooker: CallbackBooker) =>
      agencyContactRepository.rescheduleFromManualReplay({ manualCallId: call.id, dispositionCode: 'callback', nextAttemptAt: at, callbackBooker });
    expect(await replay(CALLBACK_1, onBehalf)).toMatchObject({ contactId: w.contactId });
    expect(await booker(w.contactId)).toMatchObject({ by: AGENT, at: first });
    await replay(CALLBACK_2, mine);
    expect((await booker(w.contactId)).by).toBe(AGENT);
    await replay(CALLBACK_1, onBehalf);
    expect(await booker(w.contactId)).toMatchObject({ by: null, at: null });
  });

  /** An inbound call AGENT answered, matched to `w`'s contact (left `pending`), ended, its outcome owed. */
  async function inboundCallOn(w: { campaignId: string; contactId: string }, contact: Record<string, unknown> = {}) {
    await getTestPool().query(
      `UPDATE agency_contacts SET state = 'pending', callback_booked_by_user_id = NULL, callback_booked_at = NULL,
              callback_source = $2, callback_due_at = $3 WHERE id = $1`,
      [w.contactId, contact['callback_source'] ?? null, contact['callback_due_at'] ?? null]);
    const now = new Date();
    const { rows } = await getTestPool().query<{ id: string }>(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, from_e164, to_e164, state, outcome,
                                         answered_at, bridged_at, answered_by_user_id, ended_at, matched_contact_id, matched_campaign_id)
       SELECT c.tenant_id, c.account_id, $2, c.phone_e164, '+919000000002', 'ended', 'answered', $3, $3, $4, $3, c.id, c.campaign_id
         FROM agency_contacts c WHERE c.id = $1
       RETURNING id`, [w.contactId, `CA-${randomUUID()}`, now, AGENT]);
    return rows[0]!.id;
  }

  it('(j) the agent\'s own call-later on an inbound call stamps them, over the customer\'s missed-call callback; otherwise cleared', async () => {
    const w = await conversationAwaitingWriteUp();
    const callId = await inboundCallOn(w, { callback_source: 'inbound', callback_due_at: new Date() });
    const before = Date.now();
    expect(await agencyContactRepository.settleFromInbound({
      inboundCallId: callId, settlement: { kind: 'callback', at: CALLBACK_1 }, lastDisposition: 'callback', callbackBooker: mine,
    })).toMatchObject({ state: 'pending', applied: 'settled' });
    const b = await booker(w.contactId);
    expect(b.by).toBe(AGENT);
    expect(b.at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const { rows: [c] } = await getTestPool().query('SELECT callback_source, next_attempt_at FROM agency_contacts WHERE id = $1', [w.contactId]);
    expect(c).toMatchObject({ callback_source: null, next_attempt_at: CALLBACK_1 });

    const cases: Array<[string, Parameters<typeof agencyContactRepository.settleFromInbound>[0]['settlement'], CallbackBooker | undefined]> = [
      ['on behalf', { kind: 'callback', at: CALLBACK_1 }, onBehalf],
      ['no booker given', { kind: 'callback', at: CALLBACK_1 }, undefined],
      ['nothing that moves it (the lapse)', { kind: 'none' }, mine],
      ['completed', { kind: 'completed' }, mine],
    ];
    for (const [label, settlement, callbackBooker] of cases) {
      const v = await conversationAwaitingWriteUp();
      const id = await inboundCallOn(v);
      // A booker from an earlier dialler call-later, which the reach settles.
      await getTestPool().query('UPDATE agency_contacts SET callback_booked_by_user_id = $2, callback_booked_at = now() WHERE id = $1', [v.contactId, AGENT]);
      await agencyContactRepository.settleFromInbound({
        inboundCallId: id, settlement, lastDisposition: 'callback', ...(callbackBooker ? { callbackBooker } : {}),
      });
      expect(await booker(v.contactId), label).toMatchObject({ by: null, at: null });
    }
  });

  it('(k) an inbound replay: the agent\'s re-stamps; a supervisor\'s keeps them while the time stays, clears them when moved', async () => {
    const w = await conversationAwaitingWriteUp();
    const callId = await inboundCallOn(w);
    await agencyContactRepository.settleFromInbound({
      inboundCallId: callId, settlement: { kind: 'callback', at: CALLBACK_1 }, lastDisposition: 'callback', callbackBooker: mine,
    });
    const replay = (at: Date, callbackBooker: CallbackBooker) =>
      agencyContactRepository.rescheduleFromInboundReplay({ inboundCallId: callId, dispositionCode: 'callback', nextAttemptAt: at, callbackBooker });
    await replay(CALLBACK_1, onBehalf);
    expect((await booker(w.contactId)).by).toBe(AGENT);
    await replay(CALLBACK_2, onBehalf);
    expect(await booker(w.contactId)).toMatchObject({ by: null, at: null });
    await replay(CALLBACK_1, mine);
    expect((await booker(w.contactId)).by).toBe(AGENT);
  });
});
