import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession, noLiveAttempts } = await import(
  './agency-factories.js'
);
const { agencyAttemptRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { AgencyReaper } = await import('../../../src/agency/reaper.js');
const { AUTO_DISPOSITION_CODE } = await import('../../../src/agency/disposition.js');

/**
 * The wrap-up redial's SQL, on real Postgres:
 *
 *  - `beginWrapupRedial`: one transaction that takes the customer back
 *    (`connected → in_flight`), closes the redialled attempt `redialed` and inserts the
 *    linked redial — and, on every refusal, writes NOTHING;
 *  - the lapsed-wrap-up sweep's widened predicate (`findLapsedWrapups`: a redial is
 *    owed the conversation's outcome whether or not it bridged) and the reaper routing
 *    such a redial as the `connected` call it continues.
 */
beforeEach(truncateAll);
afterAll(closeTestPool);

const CATALOG = JSON.stringify([{ code: 'sale', label: 'Sale', is_success: true, terminal: true }]);

async function heldConversation(opts: { contactState?: string; attempt?: Record<string, unknown> } = {}) {
  // Paused, not running: neither the transaction nor the sweep reads the status. (Once also
  // forced by one running campaign per account, a rule migration 0015 dropped.)
  const campaign = await insertAgencyCampaign({ status: 'paused', allow_wrapup_redial: true, disposition_catalog: CATALOG });
  const campaignId = campaign.id as string;
  const session = await insertAgentSession(campaignId, { state: 'wrapup' });
  const contact = await insertAgencyContact(campaignId, { state: opts.contactState ?? 'connected', attempt_count: 1 });
  const original = await insertAgencyAttempt(campaignId, contact.id as string, {
    attempt_number: 1, state: 'ended', outcome: 'connected', reserved_agent_id: session.id,
    dialed_at: new Date(), answered_at: new Date(), bridged_at: new Date(), ended_at: new Date(),
    notes: 'call me after six', ...opts.attempt,
  });
  return {
    campaignId, sessionId: session.id as string, contactId: contact.id as string,
    attemptId: original.id as string, actor: session.agent_user_id as string,
  };
}

const begin = (c: Awaited<ReturnType<typeof heldConversation>>) => agencyAttemptRepository.beginWrapupRedial({
  redialOfAttemptId: c.attemptId, sessionId: c.sessionId, actorUserId: c.actor,
  callerId: '+919000000001', disposition: 'redialed',
});

const rows = async (c: { contactId: string; attemptId: string }) => ({
  contact: (await getTestPool().query<{ state: string; attempt_count: number }>(
    'SELECT state, attempt_count FROM agency_contacts WHERE id = $1', [c.contactId])).rows[0]!,
  original: (await getTestPool().query<{ disposition_code: string | null; dispositioned_at: Date | null }>(
    'SELECT disposition_code, dispositioned_at FROM agency_call_attempts WHERE id = $1', [c.attemptId])).rows[0]!,
  attempts: Number((await getTestPool().query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM agency_call_attempts WHERE contact_id = $1', [c.contactId])).rows[0]!.n),
});

describe('beginWrapupRedial (real Postgres)', () => {
  it('takes the customer back, closes the original `redialed` and inserts the linked redial', async () => {
    const c = await heldConversation();
    const res = await begin(c);
    if (!res.ok) throw new Error(`expected ok, got ${res.reason}`);
    expect(res.attempt).toMatchObject({
      redial_of_attempt_id: c.attemptId, redial_number: 1, attempt_number: 2, state: 'queued',
      reserved_agent_id: c.sessionId, notes: 'call me after six',
    });
    const after = await rows(c);
    expect(after.contact).toEqual({ state: 'in_flight', attempt_count: 1 }); // uncharged
    expect(after.original.disposition_code).toBe('redialed');
    expect(after.attempts).toBe(2);
  });

  it('refuses `disposition_already_submitted` when the outcome is in, writing nothing', async () => {
    const c = await heldConversation({ attempt: { disposition_code: 'sale', dispositioned_at: new Date() } });
    expect(await begin(c)).toEqual({ ok: false, reason: 'disposition_already_submitted' });
    const after = await rows(c);
    expect(after.contact.state).toBe('connected');
    expect(after.original.disposition_code).toBe('sale');
    expect(after.attempts).toBe(1);
  });

  it('refuses `contact_not_held` when the customer is no longer parked for this call, writing nothing', async () => {
    const released = await heldConversation({ contactState: 'completed' });
    expect(await begin(released)).toEqual({ ok: false, reason: 'contact_not_held' });
    expect(await rows(released)).toMatchObject({ contact: { state: 'completed' }, original: { disposition_code: null }, attempts: 1 });

    // A newer attempt on the contact (a later call): not this conversation's customer any more.
    const later = await heldConversation();
    await insertAgencyAttempt(later.campaignId, later.contactId, { attempt_number: 2, state: 'ended', outcome: 'no_answer' });
    expect(await begin(later)).toEqual({ ok: false, reason: 'contact_not_held' });
    expect(await rows(later)).toMatchObject({ contact: { state: 'connected' }, original: { disposition_code: null }, attempts: 2 });
  });

  it('refuses `already_redialed` on the redial index (the backstop), rolling the take back', async () => {
    // Unreachable past the row lock in practice (the first redial stamps the code); staged
    // by hand: a redial of this attempt already exists, numbered BELOW it so the
    // "newer attempt" rule does not refuse first.
    const c = await heldConversation({ attempt: { attempt_number: 2 } });
    await insertAgencyAttempt(c.campaignId, c.contactId, {
      attempt_number: 1, state: 'ended', outcome: 'no_answer', redial_of_attempt_id: c.attemptId, redial_number: 1,
    });
    expect(await begin(c)).toEqual({ ok: false, reason: 'already_redialed' });
    // The whole transaction rolled back: the customer is still held, the original open.
    expect(await rows(c)).toMatchObject({ contact: { state: 'connected' }, original: { disposition_code: null }, attempts: 2 });
  });
});

describe('the lapsed-wrap-up sweep and a redial (real Postgres)', () => {
  /** End `attemptId` far enough in the past that its wrap-up has lapsed. */
  const lapse = (attemptId: string) => getTestPool().query(
    `UPDATE agency_call_attempts
        SET ended_at = now() - interval '1 hour', wrapup_seconds = 30
      WHERE id = $1`, [attemptId]);

  it('finds a redial that never bridged (it owes the conversation\'s outcome), and closes it as the connected call it continues', async () => {
    const c = await heldConversation({ attempt: { disposition_code: 'redialed' } });
    // The redial rang out: no bridge, and the customer is held `connected` for the outcome.
    const redial = await insertAgencyAttempt(c.campaignId, c.contactId, {
      attempt_number: 2, state: 'ended', outcome: 'no_answer', reserved_agent_id: c.sessionId,
      redial_of_attempt_id: c.attemptId, redial_number: 1, dialed_at: new Date(),
    });
    await lapse(redial.id as string);
    // A paced dial that rang out with the same shape is NOT owed anything.
    const paced = await heldConversation({ attempt: { bridged_at: null, outcome: 'no_answer' } });
    await lapse(paced.attemptId);

    const found = (await agencyAttemptRepository.findLapsedWrapups(120)).map((r) => r.id);
    expect(found).toContain(redial.id);
    expect(found).not.toContain(paced.attemptId);

    expect(await new AgencyReaper({ ...noLiveAttempts() }).sweepLapsedWrapups()).toBe(1);
    const closed = (await getTestPool().query<{ disposition_code: string | null }>(
      'SELECT disposition_code FROM agency_call_attempts WHERE id = $1', [redial.id])).rows[0]!;
    expect(closed.disposition_code).toBe(AUTO_DISPOSITION_CODE);
    // Routed as `connected` (the default policy: not retryable ⇒ completed), not as the
    // redial's own `no_answer` (which would put the customer back on the roster).
    const contact = (await getTestPool().query<{ state: string; attempt_count: number }>(
      'SELECT state, attempt_count FROM agency_contacts WHERE id = $1', [c.contactId])).rows[0]!;
    expect(contact.state).toBe('completed');
  });
});
