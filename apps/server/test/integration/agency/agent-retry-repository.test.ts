import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));

const { insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt } = await import('./agency-factories.js');
const { agencyAgentRetryRepository } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * ─── The agent's own writes on their contacts, on real Postgres ─────────────────
 *
 * `AgencyAgentRetryRepository` (contact assignment CA7): the set-based reopen and the claim an
 * agent's own dial takes (and gives back). Eligibility is `agentRetryBlockSql`, re-evaluated
 * inside each write under the row lock; ownership is in every WHERE.
 *
 * Mutation-checked: dropping `assigned_user_id = caller` from the reopen's UPDATE (and its
 * lock) reds "foreign ids"; dropping it from the claim reds "another agent's contact";
 * removing the re-evaluated `agentRetryBlockSql IS NULL` from the reopen's UPDATE reds the
 * concurrency case; removing the cooldown arm of `agentRetryBlockSql` reds the cooldown
 * cases; removing the same-number probe from the claim reds "one live call per number";
 * dropping the row-version check from `releaseRefusedAgentDialClaim` reds "touched since the
 * claim", and putting the live-attempt guard in it reds "ignores the OTHER live attempt".
 */

const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const SETTINGS = { allowed: true, rounds: 1, cooldownMinutes: 30, callbackCodes: ['callback'] };

type Row = {
  state: string; next_attempt_at: Date; agent_retry_rounds_used: number;
  override_retry_delay: boolean; override_calling_hours: boolean; assigned_user_id: string | null;
};
async function row(id: string): Promise<Row> {
  const { rows } = await getTestPool().query<Row>(
    `SELECT state, next_attempt_at, agent_retry_rounds_used, override_retry_delay, override_calling_hours, assigned_user_id
       FROM agency_contacts WHERE id = $1`, [id]);
  return rows[0]!;
}

const owned = (campaignId: string, o: Record<string, unknown> = {}, owner = AGENT) =>
  insertAgencyContact(campaignId, { assigned_user_id: owner, assigned_at: new Date(), ...o }) as Promise<{ id: string; phone_e164: string }>;

/** A contact last attempted `minutesAgo` minutes ago (the cooldown reads the attempts). */
async function attemptedAgo(campaignId: string, contactId: string, minutesAgo: number, n = 1): Promise<void> {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  await insertAgencyAttempt(campaignId, contactId, { attempt_number: n, state: 'ended', outcome: 'no_answer', created_at: at, ended_at: at });
}

const notReached = { state: 'exhausted', attempt_count: 3, last_outcome: 'no_answer' };

describe('AgencyAgentRetryRepository.reopenForAgent', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('reopens named not-reached contacts: pending, due now, one round spent', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const exhausted = await owned(campaign.id, notReached);
    const busy = await owned(campaign.id, { state: 'pending', attempt_count: 1, last_outcome: 'busy', next_attempt_at: new Date(Date.now() + 3_600_000) });
    await attemptedAgo(campaign.id, exhausted.id, 60);
    await attemptedAgo(campaign.id, busy.id, 60);

    const before = Date.now();
    const out = await agencyAgentRetryRepository.reopenForAgent({
      campaignId: campaign.id, userId: AGENT, contactIds: [exhausted.id, busy.id], settings: SETTINGS,
    });
    expect(out.reopened.sort()).toEqual([exhausted.id, busy.id].sort());
    expect(out).toMatchObject({ skipped: [], skippedTotal: 0 });
    for (const id of [exhausted.id, busy.id]) {
      const r = await row(id);
      expect(r).toMatchObject({ state: 'pending', agent_retry_rounds_used: 1 });
      expect(r.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now());
      expect(r.next_attempt_at.getTime()).toBeGreaterThan(before - 5_000);
    }
  });

  it('skips with the reason: not reached only, never DNC, rounds and cooldown bound', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const fresh = await owned(campaign.id, { state: 'pending' });
    const reached = await owned(campaign.id, { state: 'completed', attempt_count: 1, last_outcome: 'connected' });
    const dnc = await owned(campaign.id, { state: 'suppressed', suppressed_reason: 'dnc', attempt_count: 1 });
    const spent = await owned(campaign.id, { ...notReached, agent_retry_rounds_used: 1 });
    const cooling = await owned(campaign.id, notReached);
    await attemptedAgo(campaign.id, cooling.id, 5);

    const out = await agencyAgentRetryRepository.reopenForAgent({
      campaignId: campaign.id, userId: AGENT,
      contactIds: [fresh.id, reached.id, dnc.id, spent.id, cooling.id], settings: SETTINGS,
    });
    expect(out.reopened).toEqual([]);
    expect(out.skippedTotal).toBe(5);
    expect(Object.fromEntries(out.skipped.map((s) => [s.contact_id, s.blocked]))).toEqual({
      [fresh.id]: 'not_retryable',
      [reached.id]: 'not_retryable',
      [dnc.id]: 'suppressed',
      [spent.id]: 'rounds_used',
      [cooling.id]: 'cooldown',
    });
    expect((await row(cooling.id)).state).toBe('exhausted');
    expect((await row(dnc.id)).state).toBe('suppressed');
  });

  it('rounds: a second reopen of the same contact is refused at 1 round, allowed at 2', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const c = await owned(campaign.id, notReached);
    const reopen = (rounds: number) => agencyAgentRetryRepository.reopenForAgent({
      campaignId: campaign.id, userId: AGENT, contactIds: [c.id], settings: { ...SETTINGS, rounds, cooldownMinutes: 0 },
    });
    expect((await reopen(1)).reopened).toEqual([c.id]);
    // Pacing dialled it and it was not reached again.
    await getTestPool().query(`UPDATE agency_contacts SET state = 'exhausted', attempt_count = 4 WHERE id = $1`, [c.id]);
    expect((await reopen(1)).skipped).toEqual([{ contact_id: c.id, blocked: 'rounds_used' }]);
    expect((await reopen(2)).reopened).toEqual([c.id]);
    expect((await row(c.id)).agent_retry_rounds_used).toBe(2);
  });

  it('cooldown: a held retry-delay override lets the reopen through and is spent; not spent when not needed', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const cooling = await owned(campaign.id, { ...notReached, override_retry_delay: true });
    await attemptedAgo(campaign.id, cooling.id, 5);
    const cool = await owned(campaign.id, { ...notReached, override_retry_delay: true });
    await attemptedAgo(campaign.id, cool.id, 120);

    const out = await agencyAgentRetryRepository.reopenForAgent({
      campaignId: campaign.id, userId: AGENT, contactIds: [cooling.id, cool.id], settings: SETTINGS,
    });
    expect(out.reopened.sort()).toEqual([cooling.id, cool.id].sort());
    expect((await row(cooling.id)).override_retry_delay).toBe(false);
    expect((await row(cool.id)).override_retry_delay).toBe(true);
  });

  it('foreign and missing ids are dropped from both lists, and never touched', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const other = await insertAgencyCampaign({ status: 'paused' });
    const mine = await owned(campaign.id, notReached);
    const theirs = await owned(campaign.id, notReached, OTHER_AGENT);
    const pool = await insertAgencyContact(campaign.id, notReached);
    const elsewhere = await owned(other.id, notReached);

    const out = await agencyAgentRetryRepository.reopenForAgent({
      campaignId: campaign.id, userId: AGENT,
      contactIds: [mine.id, theirs.id, pool.id as string, elsewhere.id, randomUUID()], settings: SETTINGS,
    });
    expect(out).toEqual({ reopened: [mine.id], skipped: [], skippedTotal: 0 });
    for (const id of [theirs.id, pool.id as string, elsewhere.id]) expect((await row(id)).state).toBe('exhausted');
  });

  it('all: reopens every eligible one; skipped lists only not-reached contacts still blocked', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const a = await owned(campaign.id, notReached);
    const b = await owned(campaign.id, { state: 'pending', attempt_count: 2, last_outcome: 'no_answer', next_attempt_at: new Date(Date.now() + 3_600_000) });
    // Not reached but already due: in the queue as it is, so not a candidate.
    await owned(campaign.id, { state: 'pending', attempt_count: 1, last_outcome: 'no_answer' });
    const spent = await owned(campaign.id, { ...notReached, agent_retry_rounds_used: 1 });
    await owned(campaign.id, { state: 'pending' });
    await owned(campaign.id, { state: 'completed', attempt_count: 1, last_outcome: 'connected' });
    await owned(campaign.id, notReached, OTHER_AGENT);

    const out = await agencyAgentRetryRepository.reopenForAgent({
      campaignId: campaign.id, userId: AGENT, contactIds: null, settings: SETTINGS,
    });
    expect(out.reopened.sort()).toEqual([a.id, b.id].sort());
    expect(out.skipped).toEqual([{ contact_id: spent.id, blocked: 'rounds_used' }]);
    expect(out.skippedTotal).toBe(1);
  });

  it('a concurrent change committed while the reopen waits is seen: a contact claimed meanwhile is not reopened', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const c = await owned(campaign.id, notReached);
    const holder = await getTestPool().connect();
    try {
      await holder.query('BEGIN');
      // Something else takes the row first (an agent's own dial claiming it).
      await holder.query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = $1`, [c.id]);
      const pending = agencyAgentRetryRepository.reopenForAgent({
        campaignId: campaign.id, userId: AGENT, contactIds: [c.id], settings: SETTINGS,
      });
      await new Promise((r) => setTimeout(r, 150));
      await holder.query('COMMIT');
      const out = await pending;
      expect(out.reopened).toEqual([]);
      expect(out.skipped).toEqual([{ contact_id: c.id, blocked: 'not_retryable' }]);
      expect(await row(c.id)).toMatchObject({ state: 'in_flight', agent_retry_rounds_used: 0 });
    } finally {
      holder.release();
    }
  });

  it('two concurrent reopens of one contact spend one round between them', async () => {
    // Repeated: the race (each transaction's own `now()`) needs the second to have begun
    // before the first committed, which one run may or may not produce.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    for (let i = 0; i < 10; i++) {
      const c = await owned(campaign.id, notReached);
      const all = await Promise.all([0, 1, 2].map(() => agencyAgentRetryRepository.reopenForAgent({
        campaignId: campaign.id, userId: AGENT, contactIds: [c.id], settings: { ...SETTINGS, rounds: 5 },
      })));
      expect(all.flatMap((o) => o.reopened), `run ${i}`).toEqual([c.id]);
      expect((await row(c.id)).agent_retry_rounds_used, `run ${i}`).toBe(1);
    }
  });
});

describe('AgencyAgentRetryRepository.claimForAgentDial / releaseAgentDialClaim', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  const claim = (campaignId: string, contactId: string, basis: 'due' | 'retry_delay' | 'retry_round', o: {
    userId?: string; spendCallingHours?: boolean; settings?: typeof SETTINGS;
  } = {}) => agencyAgentRetryRepository.claimForAgentDial({
    contactId, campaignId, userId: o.userId ?? AGENT, basis,
    spendCallingHours: o.spendCallingHours ?? false, settings: o.settings ?? SETTINGS,
  });

  it('due: claims, spends nothing', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const c = await owned(campaign.id, { state: 'pending' });
    const got = await claim(campaign.id, c.id, 'due');
    expect(got?.spent).toEqual({ round: false, retryDelay: false, callingHours: false, agentReopen: false });
    expect(got?.contact.state).toBe('in_flight');
    expect(got?.prior.state).toBe('pending');
  });

  it('retry_delay: a pending contact not yet due, holding the override, spends it', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const later = new Date(Date.now() + 86_400_000);
    const c = await owned(campaign.id, { state: 'pending', attempt_count: 1, last_outcome: 'connected', last_disposition: 'callback', next_attempt_at: later, override_retry_delay: true });
    const got = await claim(campaign.id, c.id, 'retry_delay');
    expect(got?.spent).toEqual({ round: false, retryDelay: true, callingHours: false, agentReopen: false });
    expect(await row(c.id)).toMatchObject({ state: 'in_flight', override_retry_delay: false });
    // The exact undo puts the time and the override back.
    expect(await agencyAgentRetryRepository.releaseAgentDialClaim(c.id, got!)).toBe(true);
    expect(await row(c.id)).toMatchObject({ state: 'pending', next_attempt_at: later, override_retry_delay: true, agent_retry_rounds_used: 0 });
  });

  it('retry_round: an exhausted contact spends a round; the undo gives it back to exhausted', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const c = await owned(campaign.id, notReached);
    await attemptedAgo(campaign.id, c.id, 60);
    const got = await claim(campaign.id, c.id, 'retry_round');
    expect(got?.spent.round).toBe(true);
    expect(await row(c.id)).toMatchObject({ state: 'in_flight', agent_retry_rounds_used: 1 });
    // A refused round (rounds spent) cannot be claimed again while it is held.
    expect(await claim(campaign.id, c.id, 'retry_round')).toBeNull();
    expect(await agencyAgentRetryRepository.releaseAgentDialClaim(c.id, got!)).toBe(true);
    expect(await row(c.id)).toMatchObject({ state: 'exhausted', agent_retry_rounds_used: 0 });
  });

  it('retry_round is refused under the cooldown and when rounds are used (re-evaluated at the claim)', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const cooling = await owned(campaign.id, notReached);
    await attemptedAgo(campaign.id, cooling.id, 5);
    expect(await claim(campaign.id, cooling.id, 'retry_round')).toBeNull();
    const spent = await owned(campaign.id, { ...notReached, agent_retry_rounds_used: 1 });
    expect(await claim(campaign.id, spent.id, 'retry_round')).toBeNull();
    expect((await row(cooling.id)).state).toBe('exhausted');
  });

  it('another agent\'s contact, or the pool\'s, is never claimed', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const theirs = await owned(campaign.id, { state: 'pending' }, OTHER_AGENT);
    const pool = await insertAgencyContact(campaign.id, { state: 'pending' });
    expect(await claim(campaign.id, theirs.id, 'due')).toBeNull();
    expect(await claim(campaign.id, pool.id as string, 'due')).toBeNull();
    expect((await row(theirs.id)).state).toBe('pending');
  });

  it('one live call per number: refused while another contact on the number is on a call', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const c = await owned(campaign.id, { state: 'pending' });
    await insertAgencyContact(campaign.id, { state: 'connected', phone_e164: c.phone_e164 });
    expect(await claim(campaign.id, c.id, 'due')).toBeNull();
    expect(await agencyAgentRetryRepository.numberIsLive(campaign.id, c.id)).toBe(true);
    expect((await row(c.id)).state).toBe('pending');
  });

  it('one live call per number across the ACCOUNT: another campaign of it blocks, another account does not (MC4)', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const sibling = await insertAgencyCampaign({ status: 'running' });
    const c = await owned(campaign.id, { state: 'pending' });
    const elsewhere = await insertAgencyContact(sibling.id, { state: 'in_flight', phone_e164: c.phone_e164 });
    expect(await claim(campaign.id, c.id, 'due')).toBeNull();
    expect(await agencyAgentRetryRepository.numberIsLive(campaign.id, c.id)).toBe(true);
    expect((await row(c.id)).state).toBe('pending');

    // The same number live only on ANOTHER account's campaign: claimed.
    await getTestPool().query(`UPDATE agency_contacts SET state = 'completed' WHERE id = $1`, [elsewhere.id]);
    const otherAccount = randomUUID();
    const foreign = await insertAgencyCampaign({ status: 'running', account_id: otherAccount });
    await insertAgencyContact(foreign.id, { state: 'connected', phone_e164: c.phone_e164, account_id: otherAccount });
    expect(await agencyAgentRetryRepository.numberIsLive(campaign.id, c.id)).toBe(false);
    expect((await claim(campaign.id, c.id, 'due'))?.contact.state).toBe('in_flight');
  });

  it('DNC is never claimed, whatever overrides it holds', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const c = await owned(campaign.id, {
      state: 'pending', suppressed_reason: 'dnc', attempt_count: 2, last_outcome: 'no_answer',
      override_retry_delay: true, override_calling_hours: true, override_extra_attempts: 5,
    });
    for (const basis of ['due', 'retry_delay', 'retry_round'] as const) {
      expect(await claim(campaign.id, c.id, basis, { spendCallingHours: true })).toBeNull();
    }
    expect(await row(c.id)).toMatchObject({ state: 'pending', override_calling_hours: true, override_retry_delay: true });
  });

  it('the calling-hours override is spent with the claim, once', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const c = await owned(campaign.id, { state: 'pending', override_calling_hours: true });
    const first = await claim(campaign.id, c.id, 'due', { spendCallingHours: true });
    expect(first?.spent.callingHours).toBe(true);
    expect((await row(c.id)).override_calling_hours).toBe(false);
    // The call happened and settled back to pending: the override is gone, so a second
    // closed-window dial cannot spend it again.
    await getTestPool().query(`UPDATE agency_contacts SET state = 'pending' WHERE id = $1`, [c.id]);
    expect(await claim(campaign.id, c.id, 'due', { spendCallingHours: true })).toBeNull();
    expect(await claim(campaign.id, c.id, 'due')).not.toBeNull();
  });

  it('the undo is guarded: not while an attempt on the contact is live, and a DNC mark meanwhile wins', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const c = await owned(campaign.id, { state: 'pending' });
    const got = await claim(campaign.id, c.id, 'due');
    const attempt = await insertAgencyAttempt(campaign.id, c.id, { state: 'dialing' });
    expect(await agencyAgentRetryRepository.releaseAgentDialClaim(c.id, got!)).toBe(false);
    await getTestPool().query(`UPDATE agency_call_attempts SET state = 'ended', outcome = 'failed' WHERE id = $1`, [attempt.id]);
    await getTestPool().query(`UPDATE agency_contacts SET suppressed_reason = 'dnc' WHERE id = $1`, [c.id]);
    expect(await agencyAgentRetryRepository.releaseAgentDialClaim(c.id, got!)).toBe(true);
    expect((await row(c.id)).state).toBe('suppressed');
  });

  it('a refused attempt insert: the undo ignores the OTHER live attempt and gives back the state, the round and the overrides', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const c = await owned(campaign.id, { ...notReached, override_calling_hours: true });
    await attemptedAgo(campaign.id, c.id, 60);
    const got = await claim(campaign.id, c.id, 'retry_round', { spendCallingHours: true });
    expect(got?.spent).toMatchObject({ round: true, callingHours: true });
    // Something else holds a live attempt on the contact: the claim's attempt insert is refused.
    await insertAgencyAttempt(campaign.id, c.id, { attempt_number: 2, state: 'dialing' });
    expect(await agencyAgentRetryRepository.releaseAgentDialClaim(c.id, got!)).toBe(false);
    expect(await agencyAgentRetryRepository.releaseRefusedAgentDialClaim(c.id, got!)).toBe(true);
    expect(await row(c.id)).toMatchObject({ state: 'exhausted', agent_retry_rounds_used: 0, override_calling_hours: true });
    // Once: the row version has moved, so a second undo finds nothing.
    expect(await agencyAgentRetryRepository.releaseRefusedAgentDialClaim(c.id, got!)).toBe(false);
  });

  it('a refused attempt insert: the undo leaves a contact any writer has touched since the claim', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const c = await owned(campaign.id, notReached);
    await attemptedAgo(campaign.id, c.id, 60);
    const got = await claim(campaign.id, c.id, 'retry_round');
    // The other attempt settled the contact, and a pacing tick took it again for an attempt of
    // its own: `in_flight` once more, but not this claim's to undo.
    await getTestPool().query(`UPDATE agency_contacts SET state = 'pending' WHERE id = $1`, [c.id]);
    await getTestPool().query(`UPDATE agency_contacts SET state = 'in_flight' WHERE id = $1`, [c.id]);
    expect(await agencyAgentRetryRepository.releaseRefusedAgentDialClaim(c.id, got!)).toBe(false);
    expect(await row(c.id)).toMatchObject({ state: 'in_flight', agent_retry_rounds_used: 1 });
    // A write that leaves every column as it was (a DNC freeze re-asserted) moves the version too.
    const again = await claim(campaign.id, (await owned(campaign.id, { state: 'pending' })).id, 'due');
    await getTestPool().query(`UPDATE agency_contacts SET state = state WHERE id = $1`, [again!.contact.id]);
    expect(await agencyAgentRetryRepository.releaseRefusedAgentDialClaim(again!.contact.id, again!)).toBe(false);
  });
});
