import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));

const { insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession } = await import('./agency-factories.js');
const { agencyContactRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { settleContact } = await import('../../../src/agency/dialer/contact-settlement.js');
const { overrideGrantOf } = await import('../../../src/agency/contact-overrides.js');
const { resolveDispositionDecision } = await import('../../../src/agency/disposition-policy.js');

/**
 * ─── Outcome overrides and callback ownership, written on real Postgres ──────────
 *
 * D8 grant (the disposition's write REPLACES the contact's override columns), D8 spend (an
 * `extra_attempts` override keeps a contact whose `max_attempts` is spent `pending`, at the
 * settlement and at the disposition), and D4 (a booked callback in the pool goes to the agent
 * who took the call). The acceptance: a "Promise To Pay" outcome granting 3 extra attempts lets
 * the contact be dialled past `max_attempts` exactly 3 more times; a DNC outcome still stops it.
 *
 * Mutation-checked: dropping the decrement floor (`override_extra_attempts - 1` with no `> 0`
 * check in `applyExtraAttemptOverride`) reds the CHECK-violating "nothing left" case and the
 * acceptance count; dropping the per-attempt guard (`override_applied` already holding
 * `extra_attempts`) reds "a replayed settlement"; granting on a replay reds "a replay never
 * re-grants".
 */

const AGENT = randomUUID();
const OWNER = randomUUID();
const FUTURE = new Date('2099-01-02T10:00:00.000Z');

const PTP = {
  code: 'promise_to_pay', label: 'Promise To Pay', is_success: true, requires_datetime: true,
  override: { extra_attempts: 3, retry_delay: true },
};
const VOICEMAIL = { code: 'voicemail', label: 'Voicemail', retry: { delay_minutes: 30, max_attempts: 3 } };
const DNC = { code: 'do_not_call', label: 'Do not call', suppress: true };
const CATALOG = JSON.stringify([PTP, VOICEMAIL, DNC, { code: 'interested', label: 'Interested', terminal: true }]);
const POLICY = JSON.stringify({ no_answer: { delay_minutes: 0, max_attempts: 3 } });

type Row = {
  state: string; attempt_count: number; next_attempt_at: Date; assigned_user_id: string | null;
  override_disposition: string | null; override_extra_attempts: number; override_retry_delay: boolean;
  override_calling_hours: boolean; override_granted_at: Date | null; suppressed_reason: string | null;
};
async function row(id: string): Promise<Row> {
  const { rows } = await getTestPool().query<Row>(
    `SELECT state, attempt_count, next_attempt_at, assigned_user_id, override_disposition, override_extra_attempts,
            override_retry_delay, override_calling_hours, override_granted_at, suppressed_reason
       FROM agency_contacts WHERE id = $1`, [id]);
  return rows[0]!;
}
async function applied(attemptId: string): Promise<string[]> {
  const { rows } = await getTestPool().query<{ override_applied: string[] }>(
    'SELECT override_applied FROM agency_call_attempts WHERE id = $1', [attemptId]);
  return rows[0]!.override_applied;
}
async function events(contactId: string) {
  const { rows } = await getTestPool().query<{ from_user_id: string | null; to_user_id: string; actor_user_id: string; reason: string }>(
    'SELECT from_user_id, to_user_id, actor_user_id, reason FROM agency_contact_assignment_events WHERE contact_id = $1', [contactId]);
  return rows;
}

/** A conversation ended and parked `connected` for its write-up, on attempt `n`. */
async function parked(o: { mode?: string; contact?: Record<string, unknown>; attemptNumber?: number } = {}) {
  const campaign = await insertAgencyCampaign({
    status: 'running', disposition_catalog: CATALOG, retry_policy: POLICY, assignment_mode: o.mode ?? 'strict',
  });
  const n = o.attemptNumber ?? 1;
  const contact = await insertAgencyContact(campaign.id, { state: 'connected', attempt_count: n, last_outcome: 'connected', ...o.contact });
  const session = await insertAgentSession(campaign.id, { agent_user_id: AGENT, state: 'wrapup' });
  const attempt = await insertAgencyAttempt(campaign.id, contact.id, {
    attempt_number: n, state: 'ended', outcome: 'connected', reserved_agent_id: session.id,
    bridged_at: new Date(), ended_at: new Date(),
  });
  return { campaign, contactId: contact.id as string, attemptId: attempt.id as string, sessionId: session.id as string };
}

/** The disposition route's write, as it calls it for `entry`. */
function dispose(w: { contactId: string; attemptId: string }, entry: typeof PTP | typeof VOICEMAIL | typeof DNC | { code: string; label: string; terminal?: boolean }, o: {
  attemptsUsed?: number; callbackAt?: Date | null; callbackOwner?: string | null;
} = {}) {
  const decision = resolveDispositionDecision(entry as never, {
    now: new Date(), attemptsUsed: o.attemptsUsed ?? 1, callbackAt: o.callbackAt ?? null,
  });
  return agencyContactRepository.releaseFromDisposition({
    contactId: w.contactId, attemptId: w.attemptId, dispositionCode: entry.code,
    state: decision.contactState, lastOutcome: 'connected',
    nextAttemptAt: decision.nextAttemptAt, suppressedReason: decision.suppressedReason ?? null,
    grant: overrideGrantOf(entry as never),
    extraAttempt: decision.reason === 'disposition_attempts_reached'
      ? { reason: decision.reason, delayMinutes: 30, now: new Date() } : null,
    callbackOwner: o.callbackOwner ? { userId: o.callbackOwner } : null,
  });
}

/** Pacing claims the contact, dials attempt `n`, nobody answers, and the dialer settles it. */
async function dialNoAnswer(campaign: Record<string, unknown>, contactId: string, sessionId: string, n: number): Promise<string> {
  await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = $1`, [contactId]);
  const attempt = await insertAgencyAttempt(campaign['id'] as string, contactId, {
    attempt_number: n, state: 'ended', outcome: 'no_answer', reserved_agent_id: sessionId, ended_at: new Date(),
  });
  const { rows: [c] } = await getTestPool().query('SELECT * FROM agency_campaigns WHERE id = $1', [campaign['id']]);
  const { rows: [k] } = await getTestPool().query('SELECT * FROM agency_contacts WHERE id = $1', [contactId]);
  await settleContact({
    attemptId: attempt.id as string, campaignId: c.id, contactId, sessionId, ownerReplica: 'r1',
    tenantId: c.tenant_id, accountId: c.account_id, callerId: '+919000000001', attemptNumber: n,
    campaign: c, contact: k,
  } as never, 'no_answer', false, null);
  return attempt.id as string;
}

describe('D8 grant, D4 callback owner: the disposition write', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('a granting outcome REPLACES the override columns; the callback in the pool goes to the agent who took the call', async () => {
    const w = await parked({ contact: {
      override_disposition: 'older_code', override_extra_attempts: 5, override_calling_hours: true,
      override_granted_at: new Date('2026-01-01T00:00:00Z'),
    } });
    const out = await dispose(w, PTP, { callbackAt: FUTURE, callbackOwner: AGENT });
    expect(out).toMatchObject({ state: 'pending', overrideGranted: true, assignedTo: AGENT, extraAttemptSpent: false });
    const r = await row(w.contactId);
    expect(r).toMatchObject({
      state: 'pending', next_attempt_at: FUTURE, assigned_user_id: AGENT,
      override_disposition: 'promise_to_pay', override_extra_attempts: 3, override_retry_delay: true,
      override_calling_hours: false,
    });
    expect(r.override_granted_at!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await events(w.contactId)).toEqual([{ from_user_id: null, to_user_id: AGENT, actor_user_id: AGENT, reason: 'callback' }]);
  });

  it('a replay never re-grants (a spent grant is not topped back up) and never re-assigns', async () => {
    const w = await parked();
    await dispose(w, PTP, { callbackAt: FUTURE, callbackOwner: AGENT });
    await getTestPool().query('UPDATE agency_contacts SET override_extra_attempts = 1, assigned_user_id = NULL, assigned_at = NULL WHERE id = $1', [w.contactId]);
    const replay = await dispose(w, PTP, { callbackAt: new Date('2099-02-02T10:00:00Z'), callbackOwner: AGENT });
    expect(replay).toMatchObject({ state: 'pending', overrideGranted: false, assignedTo: null });
    expect(await row(w.contactId)).toMatchObject({ override_extra_attempts: 1, assigned_user_id: null });
    expect(await events(w.contactId)).toHaveLength(1);
  });

  it('a non-granting outcome leaves an existing grant alone', async () => {
    const w = await parked({ contact: { override_disposition: 'promise_to_pay', override_extra_attempts: 2, override_retry_delay: true } });
    await dispose(w, { code: 'interested', label: 'Interested', terminal: true });
    expect(await row(w.contactId)).toMatchObject({
      state: 'completed', override_disposition: 'promise_to_pay', override_extra_attempts: 2, override_retry_delay: true,
    });
  });

  it('a contact someone owns keeps its owner (no history row)', async () => {
    const w = await parked({ contact: { assigned_user_id: OWNER, assigned_at: new Date() } });
    const out = await dispose(w, PTP, { callbackAt: FUTURE, callbackOwner: AGENT });
    expect(out?.assignedTo).toBeNull();
    expect((await row(w.contactId)).assigned_user_id).toBe(OWNER);
    expect(await events(w.contactId)).toEqual([]);
  });

  it('no owner is given when the route passes none (a pool campaign, a non-callback outcome)', async () => {
    const w = await parked({ mode: 'pool' });
    await dispose(w, PTP, { callbackAt: FUTURE, callbackOwner: null });
    expect((await row(w.contactId)).assigned_user_id).toBeNull();
    expect(await events(w.contactId)).toEqual([]);
  });

  it('a DNC outcome suppresses whatever the contact holds; nothing is spent or granted', async () => {
    const w = await parked({ attemptNumber: 3, contact: { override_extra_attempts: 5, override_calling_hours: true } });
    const out = await dispose(w, DNC, { attemptsUsed: 3 });
    expect(out).toMatchObject({ state: 'suppressed', extraAttemptSpent: false, overrideGranted: false });
    expect(await row(w.contactId)).toMatchObject({ state: 'suppressed', suppressed_reason: 'dnc', override_extra_attempts: 5 });
  });
});

describe('D8 spend: extra attempts past max_attempts', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('the disposition retry\'s exhaustion: spends one, records it on the attempt, and a replay spends nothing', async () => {
    const w = await parked({ attemptNumber: 3, contact: { override_extra_attempts: 2, override_disposition: 'promise_to_pay' } });
    const before = Date.now();
    const first = await dispose(w, VOICEMAIL, { attemptsUsed: 3 });
    expect(first).toMatchObject({ state: 'pending', extraAttemptSpent: true });
    const r = await row(w.contactId);
    expect(r).toMatchObject({ state: 'pending', override_extra_attempts: 1 });
    // The rule's own delay (30 minutes).
    expect(r.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before + 30 * 60_000 - 2_000);
    expect(await applied(w.attemptId)).toEqual(['extra_attempts']);

    const replay = await dispose(w, VOICEMAIL, { attemptsUsed: 3 });
    expect(replay).toMatchObject({ state: 'pending', extraAttemptSpent: false });
    expect(await row(w.contactId)).toMatchObject({ state: 'pending', override_extra_attempts: 1, next_attempt_at: r.next_attempt_at });
    expect(await applied(w.attemptId)).toEqual(['extra_attempts']);
  });

  it('nothing left: exhausted, and the count never goes below 0', async () => {
    const w = await parked({ attemptNumber: 3 });
    expect(await dispose(w, VOICEMAIL, { attemptsUsed: 3 })).toMatchObject({ state: 'exhausted', extraAttemptSpent: false });
    expect(await row(w.contactId)).toMatchObject({ state: 'exhausted', override_extra_attempts: 0 });
    expect(await applied(w.attemptId)).toEqual([]);
  });

  it('a replayed settlement spends at most once per attempt', async () => {
    const w = await parked({ attemptNumber: 3, contact: { state: 'in_flight', override_extra_attempts: 2 } });
    const decision = { contactState: 'exhausted' as const, nextAttemptAt: null, reason: 'max_attempts_reached' };
    const settle = () => agencyContactRepository.markExhaustedOrSpendExtraAttempt({
      contactId: w.contactId, attemptId: w.attemptId, decision, delayMinutes: 0, now: new Date(),
    });
    expect(await settle()).toMatchObject({ state: 'pending', extraAttemptSpent: true });
    expect(await settle()).toMatchObject({ extraAttemptSpent: false });
    expect(await row(w.contactId)).toMatchObject({ state: 'pending', override_extra_attempts: 1 });
    expect(await applied(w.attemptId)).toEqual(['extra_attempts']);
  });

  it('a DNC-marked contact settles suppressed and spends nothing', async () => {
    const w = await parked({ attemptNumber: 3, contact: { state: 'suppressed', suppressed_reason: 'dnc', override_extra_attempts: 2 } });
    const out = await agencyContactRepository.markExhaustedOrSpendExtraAttempt({
      contactId: w.contactId, attemptId: w.attemptId,
      decision: { contactState: 'exhausted', nextAttemptAt: null, reason: 'max_attempts_reached' }, delayMinutes: 0, now: new Date(),
    });
    expect(out).toMatchObject({ state: 'suppressed', extraAttemptSpent: false });
    expect(await row(w.contactId)).toMatchObject({ state: 'suppressed', override_extra_attempts: 2 });
  });

  it('ACCEPTANCE: Promise To Pay (extra_attempts 3) lets the contact be dialled past max_attempts exactly 3 more times', async () => {
    // Attempt 3 of a `no_answer` max of 3 connected; the customer promised to pay and asked
    // for a callback. Without the override the callback's own dial is the last one.
    const w = await parked({ attemptNumber: 3 });
    await dispose(w, PTP, { callbackAt: new Date(Date.now() - 1000), callbackOwner: AGENT });
    expect(await row(w.contactId)).toMatchObject({ state: 'pending', override_extra_attempts: 3, assigned_user_id: AGENT });

    // Dial 4 (the callback) is not answered: past max_attempts, so it would be exhausted.
    const outcomes: Array<{ n: number; state: string; extra: number; applied: string[] }> = [];
    for (let n = 4; n <= 8; n++) {
      const r0 = await row(w.contactId);
      if (r0.state !== 'pending') break;
      const attemptId = await dialNoAnswer(w.campaign, w.contactId, w.sessionId, n);
      const r = await row(w.contactId);
      outcomes.push({ n, state: r.state, extra: r.override_extra_attempts, applied: await applied(attemptId) });
    }
    expect(outcomes).toEqual([
      { n: 4, state: 'pending', extra: 2, applied: ['extra_attempts'] },
      { n: 5, state: 'pending', extra: 1, applied: ['extra_attempts'] },
      { n: 6, state: 'pending', extra: 0, applied: ['extra_attempts'] },
      { n: 7, state: 'exhausted', extra: 0, applied: [] },
    ]);
    // Dials 5, 6 and 7 happened past the dial that would have exhausted it: three more.
    expect((await row(w.contactId)).attempt_count).toBe(7);
  });

  it('ACCEPTANCE: a DNC outcome on a granted contact stops it at once; the grant is never spent', async () => {
    const w = await parked({ attemptNumber: 3 });
    await dispose(w, PTP, { callbackAt: new Date(Date.now() - 1000), callbackOwner: AGENT });
    // The callback connects; the customer says stop.
    await getTestPool().query(`UPDATE agency_contacts SET state = 'connected' WHERE id = $1`, [w.contactId]);
    const callback = await insertAgencyAttempt(w.campaign.id as string, w.contactId, {
      attempt_number: 4, state: 'ended', outcome: 'connected', reserved_agent_id: w.sessionId, ended_at: new Date(),
    });
    await dispose({ contactId: w.contactId, attemptId: callback.id as string }, DNC, { attemptsUsed: 4 });
    expect(await row(w.contactId)).toMatchObject({ state: 'suppressed', suppressed_reason: 'dnc', override_extra_attempts: 3 });
    // A later settlement write cannot spend it back open (the DNC freeze).
    const out = await agencyContactRepository.markExhaustedOrSpendExtraAttempt({
      contactId: w.contactId, attemptId: callback.id as string,
      decision: { contactState: 'exhausted', nextAttemptAt: null, reason: 'max_attempts_reached' }, delayMinutes: 0, now: new Date(),
    });
    expect(out).toMatchObject({ state: 'suppressed', extraAttemptSpent: false });
  });
});
