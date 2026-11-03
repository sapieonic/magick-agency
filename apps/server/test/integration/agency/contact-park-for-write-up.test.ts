import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
const { agencyContactRepository } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * `parkForWriteUp`: the settle-time park of a conversation (paced, `bumpAttempt`) or a
 * wrap-up redial (uncharged) in `connected`, held for the agent's write-up — ONLY while
 * the call still holds the contact (`in_flight` / `connected`) and the attempt has no
 * disposition. The defect it closes: a disposition saved while the call was live
 * released the contact, and the call's end then re-parked it `connected` behind a
 * write-up already taken, where nothing (the lapsed sweep reads
 * `disposition_code IS NULL`) ever releases it.
 */
describe('agencyContactRepository.parkForWriteUp (real Postgres)', () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await closeTestPool(); });

  async function setup(contactState: string, attemptPatch: Record<string, unknown> = {}, contactPatch: Record<string, unknown> = {}) {
    const campaign = await insertAgencyCampaign();
    const contact = await insertAgencyContact(campaign.id as string, { state: contactState, attempt_count: 1, ...contactPatch });
    const attempt = await insertAgencyAttempt(campaign.id as string, contact.id as string, {
      state: 'ended', outcome: 'connected', bridged_at: new Date(), ended_at: new Date(), ...attemptPatch,
    });
    return { contactId: contact.id as string, attemptId: attempt.id as string };
  }
  const row = async (id: string) => (await getTestPool().query<{
    state: string; attempt_count: number; last_outcome: string | null; suppressed_reason: string | null;
  }>('SELECT state, attempt_count, last_outcome, suppressed_reason FROM agency_contacts WHERE id = $1', [id])).rows[0]!;

  it('parks a contact the call still holds (in_flight or connected), charging only when asked', async () => {
    const a = await setup('in_flight');
    expect(await agencyContactRepository.parkForWriteUp({ ...a, lastOutcome: 'no_answer' })).toBe(true);
    expect(await row(a.contactId)).toMatchObject({ state: 'connected', attempt_count: 1, last_outcome: 'no_answer' });

    const b = await setup('connected');
    expect(await agencyContactRepository.parkForWriteUp({ ...b, lastOutcome: 'connected', bumpAttempt: true })).toBe(true);
    expect(await row(b.contactId)).toMatchObject({ state: 'connected', attempt_count: 2, last_outcome: 'connected' });
  });

  it('never re-parks a contact a disposition already released (the mid-call write-up)', async () => {
    // The disposition route moved the contact to `completed` and stamped the attempt.
    const a = await setup('completed', { disposition_code: 'sale' }, { last_outcome: 'connected', last_disposition: 'sale' });
    expect(await agencyContactRepository.parkForWriteUp({ ...a, lastOutcome: 'no_answer' })).toBe(false);
    expect(await row(a.contactId)).toMatchObject({ state: 'completed', attempt_count: 1, last_outcome: 'connected' });

    // A retry the disposition scheduled: `pending`, left as it is; a paced dial is still charged.
    const b = await setup('pending', { disposition_code: 'callback' });
    expect(await agencyContactRepository.parkForWriteUp({ ...b, lastOutcome: 'connected', bumpAttempt: true })).toBe(false);
    expect(await row(b.contactId)).toMatchObject({ state: 'pending', attempt_count: 2 });
  });

  it('does not park a contact whose attempt is already dispositioned, even while it still reads in_flight', async () => {
    // The disposition landed before anything parked the contact (its release wrote
    // nothing): parking it now would strand it `connected`; `in_flight` behind a
    // terminal attempt is the stranded-contact sweep's to requeue.
    const a = await setup('in_flight', { disposition_code: 'sale' });
    expect(await agencyContactRepository.parkForWriteUp({ ...a, lastOutcome: 'connected' })).toBe(false);
    expect((await row(a.contactId)).state).toBe('in_flight');
  });

  it('keeps the DNC rule: a contact marked do-not-call stays suppressed', async () => {
    const a = await setup('suppressed', {}, { suppressed_reason: 'dnc' });
    expect(await agencyContactRepository.parkForWriteUp({ ...a, lastOutcome: 'connected', bumpAttempt: true })).toBe(false);
    expect(await row(a.contactId)).toMatchObject({ state: 'suppressed', suppressed_reason: 'dnc', attempt_count: 2 });
    // And a held row carrying the reason (a pre-fix shape) is written `suppressed`, never `connected`.
    const b = await setup('in_flight', {}, { suppressed_reason: 'dnc' });
    expect(await agencyContactRepository.parkForWriteUp({ ...b, lastOutcome: 'connected' })).toBe(false);
    expect((await row(b.contactId)).state).toBe('suppressed');
  });

  it('writes nothing for an attempt that is not this contact\'s', async () => {
    const a = await setup('in_flight');
    const other = await setup('in_flight');
    expect(await agencyContactRepository.parkForWriteUp({ contactId: a.contactId, attemptId: other.attemptId, lastOutcome: 'x' })).toBe(false);
    expect((await row(a.contactId)).state).toBe('in_flight');
  });
});
