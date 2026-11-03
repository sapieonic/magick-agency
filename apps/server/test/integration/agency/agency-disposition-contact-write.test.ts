import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));

const {
  insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession,
  insertManualCall, insertSoftphoneSession,
} = await import('./agency-factories.js');
const { agencyAttemptRepository, agencyContactRepository } = await import(
  '../../../src/db/repositories/agency.repository.js'
);

/**
 * ─── The disposition route's contact write, against real Postgres ────────────────
 *
 * `AgencyContactRepository.releaseFromDisposition` is the route's only write to the
 * contact (`api/routes/agency/attempts.ts`). A same-code replay of a disposition is a
 * success and reaches it again, possibly long after the first submit, so it writes only
 * while the contact still belongs to the attempt being written up. Every case here is a
 * contact that has moved on (or not), with the real writes that move it, and asserts the
 * row.
 *
 * Before the fix the route wrote with an unconditional `markState`: (b)–(f) all moved the
 * contact. Mutation-checked: dropping the newest-attempt clause reds (c); dropping the
 * state arms (any state passes) reds (b) and (d); dropping the soft-phone clause reds (e)
 * and (f); dropping only its `m.created_at > r.created_at` half reds (f); dropping the
 * `pending`-on-this-code arm reds (g); dropping the DNC arm reds (h).
 */

const CALLBACK_1 = new Date('2099-01-02T10:00:00.000Z');
const CALLBACK_2 = new Date('2099-01-03T15:30:00.000Z');

async function contactRow(id: string) {
  const { rows } = await getTestPool().query<{
    state: string; last_outcome: string | null; last_disposition: string | null;
    next_attempt_at: Date | null; suppressed_reason: string | null; attempt_count: number;
  }>(
    `SELECT state, last_outcome, last_disposition, next_attempt_at, suppressed_reason, attempt_count
       FROM agency_contacts WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

/** One conversation that ended ten minutes ago, its contact parked `connected` for the write-up. */
async function conversationAwaitingWriteUp(onCampaign?: string) {
  const campaign = onCampaign ? { id: onCampaign } : await insertAgencyCampaign({ status: 'running' });
  const contact = await insertAgencyContact(campaign.id, { state: 'connected', attempt_count: 1 });
  const session = await insertAgentSession(campaign.id, { state: 'wrapup' });
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
  const attempt = await insertAgencyAttempt(campaign.id, contact.id, {
    state: 'ended', outcome: 'connected', reserved_agent_id: session.id,
    dialed_at: tenMinutesAgo, answered_at: tenMinutesAgo, bridged_at: tenMinutesAgo, ended_at: tenMinutesAgo,
    created_at: tenMinutesAgo,
  });
  return { campaignId: campaign.id as string, contactId: contact.id as string, attemptId: attempt.id as string };
}

/** The route's write for a code, as it calls it. */
function release(
  w: { contactId: string; attemptId: string },
  code: string,
  state: 'completed' | 'pending' | 'suppressed',
  nextAttemptAt: Date | null = null,
  suppressedReason: string | null = null,
) {
  return agencyContactRepository.releaseFromDisposition({
    contactId: w.contactId, attemptId: w.attemptId, dispositionCode: code, state,
    lastOutcome: 'connected', nextAttemptAt, suppressedReason,
  });
}

/** Pacing's own claim, as one tick runs it: the contact is `in_flight`, its attempt row not yet written. */
async function pacingClaims(campaignId: string, contactId: string) {
  const claimed = await agencyContactRepository.claimDialable(campaignId, 10);
  expect(claimed.map((c) => c.id)).toEqual([contactId]);
}

describe('the disposition route\'s contact write lands only while the contact is still the attempt\'s', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('(a) the first submit releases the contact parked for this write-up', async () => {
    const w = await conversationAwaitingWriteUp();
    expect(await release(w, 'callback', 'pending', CALLBACK_1)).toEqual({ state: 'pending', suppressed_reason: null });
    expect(await contactRow(w.contactId)).toMatchObject({
      state: 'pending', last_disposition: 'callback', last_outcome: 'connected',
      next_attempt_at: CALLBACK_1, attempt_count: 1,
    });
  });

  it('(b) a replay after the contact was re-claimed by pacing leaves it `in_flight` under its new dial', async () => {
    const w = await conversationAwaitingWriteUp();
    await release(w, 'voicemail', 'pending', new Date(Date.now() - 1000));
    await pacingClaims(w.campaignId, w.contactId);

    expect(await release(w, 'voicemail', 'pending', new Date(Date.now() + 240 * 60_000))).toBeNull();
    expect((await contactRow(w.contactId)).state).toBe('in_flight');
    // Nothing can claim it while its dial is placed.
    expect(await agencyContactRepository.claimDialable(w.campaignId, 10)).toEqual([]);
  });

  it('(c) a replay after a LATER call settled the contact does not move it (the call-2 sale stands)', async () => {
    const w = await conversationAwaitingWriteUp();
    await release(w, 'voicemail', 'pending', new Date(Date.now() - 1000));
    // Call 2: pacing claims it, dials, bridges, parks it for its own write-up, which is a sale.
    await pacingClaims(w.campaignId, w.contactId);
    const second = await agencyAttemptRepository.create({
      campaignId: w.campaignId, contactId: w.contactId,
      tenantId: (await getTestPool().query('SELECT tenant_id FROM agency_contacts WHERE id = $1', [w.contactId])).rows[0].tenant_id,
      accountId: (await getTestPool().query('SELECT account_id FROM agency_contacts WHERE id = $1', [w.contactId])).rows[0].account_id,
      callerId: '+919000000001', reservedAgentId: (await insertAgentSession(w.campaignId)).id as string,
    });
    expect(second).not.toBeNull();
    await agencyAttemptRepository.setState(second!.id, 'ended', { outcome: 'connected', bridged_at: new Date(), ended_at: new Date() });
    await agencyContactRepository.markState(w.contactId, 'connected');
    // While call 2 is awaiting its write-up, call 1's replay must not release it...
    expect(await release(w, 'voicemail', 'pending', new Date(Date.now() + 240 * 60_000))).toBeNull();
    expect((await contactRow(w.contactId)).state).toBe('connected');
    // ...call 2's own write-up does...
    expect(await release({ contactId: w.contactId, attemptId: second!.id }, 'sale', 'completed'))
      .toEqual({ state: 'completed', suppressed_reason: null });
    // ...and call 1's late replay after it does not reopen the sale.
    expect(await release(w, 'voicemail', 'pending', new Date(Date.now() + 240 * 60_000))).toBeNull();
    expect(await contactRow(w.contactId)).toMatchObject({ state: 'completed', last_disposition: 'sale' });
  });

  it('(d) a replay after its own first write closed the contact writes nothing (idempotent)', async () => {
    const w = await conversationAwaitingWriteUp();
    expect(await release(w, 'sale', 'completed')).not.toBeNull();
    const before = await contactRow(w.contactId);
    expect(await release(w, 'sale', 'completed')).toBeNull();
    expect(await contactRow(w.contactId)).toEqual(before);
  });

  it('(e) a replay while a soft-phone call holds the contact\'s claim leaves the claim alone', async () => {
    const w = await conversationAwaitingWriteUp();
    await release(w, 'callback', 'pending', CALLBACK_1);
    // The soft phone claims the pending contact (pending → in_flight, `contact_claimed`).
    const softphone = await insertSoftphoneSession();
    const claim = await agencyContactRepository.claimForManual(w.campaignId, w.contactId);
    expect(claim.outcome).toBe('claimed');
    await insertManualCall(softphone as never, {
      campaign_id: w.campaignId, contact_id: w.contactId, contact_claimed: true, contact_prior_state: 'pending', state: 'dialing',
    });

    expect(await release(w, 'callback', 'pending', CALLBACK_2)).toBeNull();
    expect(await contactRow(w.contactId)).toMatchObject({ state: 'in_flight', next_attempt_at: CALLBACK_1 });
  });

  it('(f) a replay after a soft-phone call claimed AND settled the contact does not overwrite that settlement', async () => {
    const w = await conversationAwaitingWriteUp();
    await release(w, 'callback', 'pending', CALLBACK_1);
    // A manual call claimed it, and its own `callback` outcome settled it back to
    // `pending` on the same code, at its own time. No attempt row is written for a
    // manual call, so only the manual-call clause can see this.
    const softphone = await insertSoftphoneSession();
    await agencyContactRepository.claimForManual(w.campaignId, w.contactId);
    const manual = await insertManualCall(softphone as never, {
      campaign_id: w.campaignId, contact_id: w.contactId, contact_claimed: true, contact_prior_state: 'pending',
      state: 'ended', ended_at: new Date(), outcome: 'connected', disposition_code: 'callback', disposition_source: 'campaign',
    });
    const settled = await agencyContactRepository.settleFromManual({
      manualCallId: manual.id as string,
      decision: { contactState: 'pending', nextAttemptAt: CALLBACK_2, suppressedReason: null },
      charge: 'attempt', lastOutcome: 'connected', lastDisposition: 'callback',
    });
    expect(settled).toMatchObject({ state: 'pending', applied: 'settled' });
    await getTestPool().query('UPDATE agency_manual_calls SET settled_at = now() WHERE id = $1', [manual.id]);

    expect(await release(w, 'callback', 'pending', CALLBACK_1)).toBeNull();
    expect(await contactRow(w.contactId)).toMatchObject({ state: 'pending', next_attempt_at: CALLBACK_2, attempt_count: 2 });
  });

  it('(g) a replay that corrects the callback time moves the contact it released, while it is still pending on that code', async () => {
    const w = await conversationAwaitingWriteUp();
    await release(w, 'callback', 'pending', CALLBACK_1);
    expect(await release(w, 'callback', 'pending', CALLBACK_2)).toEqual({ state: 'pending', suppressed_reason: null });
    expect(await contactRow(w.contactId)).toMatchObject({
      state: 'pending', next_attempt_at: CALLBACK_2, last_disposition: 'callback', attempt_count: 1,
    });
  });

  it('(h) after a mid-call DNC mark the write-up still records its code, and the contact stays suppressed', async () => {
    const w = await conversationAwaitingWriteUp();
    const { rows: [c] } = await getTestPool().query<{ phone_e164: string }>(
      'SELECT phone_e164 FROM agency_contacts WHERE id = $1', [w.contactId]);
    await agencyContactRepository.suppressByPhone(w.campaignId, c!.phone_e164, 'dnc', { alwaysContactId: w.contactId });
    const before = await contactRow(w.contactId);

    expect(await release(w, 'callback', 'pending', CALLBACK_1)).toEqual({ state: 'suppressed', suppressed_reason: 'dnc' });
    // The retry instant is frozen with the state: no "suppressed, next call Wednesday".
    expect(await contactRow(w.contactId)).toMatchObject({
      state: 'suppressed', suppressed_reason: 'dnc', last_disposition: 'callback', next_attempt_at: before.next_attempt_at,
    });
  });

  it('(i) another attempt\'s id, or a contact that is not the attempt\'s, writes nothing', async () => {
    const w = await conversationAwaitingWriteUp();
    const other = await conversationAwaitingWriteUp(w.campaignId);
    expect(await release({ contactId: w.contactId, attemptId: other.attemptId }, 'sale', 'completed')).toBeNull();
    expect((await contactRow(w.contactId)).state).toBe('connected');
  });
});
