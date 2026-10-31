import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import {
  insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertManualCall, insertSoftphoneSession,
} from './agency-factories.js';

/**
 * ─── THE ROSTER CONTACT UNDER A SOFT-PHONE CALL (docs/softphone.md §5) ───────
 *
 * The roster match, the claim, the release and the settlement, each against real
 * rows, one case per row of the §5 table: a `pending` contact is claimed and its
 * outcome settles it through the same disposition decision as the station; an
 * `in_flight` one is refused; `connected` and the terminal states are linked only,
 * where only suppress applies and nothing is ever reopened. And the stranded-contact
 * sweep leaves a contact alone while a manual call holds it.
 *
 * Decisions are produced by the REAL pure function (`resolveDispositionDecision`),
 * so a drift between what the station decides and what the soft phone writes shows
 * up here.
 */

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));
vi.mock('@magick-agency/observability', () => ({
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { agencyContactRepository: contacts, agencyManualCallRepository: calls } = await import(
  '../../../src/db/repositories/agency.repository.js'
);
const { resolveDispositionDecision } = await import('../../../src/agency/disposition-policy.js');
const { applyNoOutcomeSettlement, noOutcomeSettlementFor } = await import('../../../src/agency/softphone/manual-settlement.js');
const { withTransaction } = await import('@magick-agency/db/utils/transaction');
const { CONTACT_PHONE_DIGITS_SQL } = await import('../../../src/db/repositories/agency/sql-fragments.js');

const NOW = new Date();
const decide = (entry: Parameters<typeof resolveDispositionDecision>[0], attemptsUsed = 1, callbackAt: Date | null = null) =>
  resolveDispositionDecision(entry, { now: NOW, attemptsUsed, callbackAt });

const SUPPRESS = decide({ code: 'do_not_call', label: 'DNC', suppress: true });
const TERMINAL = decide({ code: 'sold', label: 'Sold', terminal: true, is_success: true });
const CALLBACK_AT = new Date(Date.now() + 86_400_000);
const CALLBACK = decide({ code: 'callback', label: 'Callback', requires_datetime: true }, 1, CALLBACK_AT);
const RETRY = decide({ code: 'voicemail', label: 'VM', retry: { delay_minutes: 30, max_attempts: 3 } }, 1);
const RETRY_SPENT = decide({ code: 'voicemail', label: 'VM', retry: { delay_minutes: 30, max_attempts: 3 } }, 3);

async function contactRow(id: string) {
  const { rows } = await getTestPool().query('SELECT * FROM agency_contacts WHERE id = $1', [id]);
  return rows[0];
}

/** A tagged manual call on `campaign` linked to `contact`, claimed or not. */
async function callOn(campaignId: string, contactId: string, claimed: boolean) {
  const session = await insertSoftphoneSession();
  return insertManualCall(session, {
    campaign_id: campaignId, contact_id: contactId,
    contact_claimed: claimed, contact_prior_state: claimed ? 'pending' : null,
    state: 'ended', ended_at: new Date(), dialed_at: new Date(), bridged_at: new Date(), outcome: 'connected',
  });
}

const settle = (manualCallId: string, decision: typeof SUPPRESS | null, placed = true) =>
  contacts.settleFromManual({
    manualCallId, decision, charge: placed ? 'attempt' : 'none', lastOutcome: 'connected', lastDisposition: decision ? 'code' : null,
  });

describe('soft-phone roster contact (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  // ── the match ─────────────────────────────────────────────────────────────

  it('findForManualMatch: the same number however the roster stored it, this campaign only, oldest first', async () => {
    const campaign = await insertAgencyCampaign();
    const other = await insertAgencyCampaign();
    const a = await insertAgencyContact(campaign.id, { phone_e164: '+91 98123-45678', created_at: new Date('2026-10-01') });
    const b = await insertAgencyContact(campaign.id, { phone_e164: '+919812345678', created_at: new Date('2026-10-02') });
    await insertAgencyContact(campaign.id, { phone_e164: '+919812345679' });
    await insertAgencyContact(other.id, { phone_e164: '+919812345678' });

    const found = await contacts.findForManualMatch(campaign.id, '+919812345678');
    expect(found.map((c) => c.id)).toEqual([a.id, b.id]);
    expect(await contacts.findForManualMatch(campaign.id, 'not a number')).toEqual([]);
  });

  it('findForManualMatch is one probe of idx_agency_contacts_campaign_phone_digits (byte-identical spelling)', async () => {
    // The pattern of T-RES-I11 (agency-dnc-resurrection.test.ts): seeded rows, fresh
    // statistics, seq scans discouraged. Asserting a plan on an empty, never-ANALYZEd
    // table asserts whatever stale statistics the earlier files left behind, so the
    // planner's pick among the campaign_id-prefixed indexes changed with the run.
    // `enable_seqscan = off` is not cheating here: the question is whether the index
    // CAN serve the predicate (the expression must match byte for byte), and the
    // proof is the expression sitting in the scan's Index Cond — not a Filter — and
    // moving to a Filter once the index is gone.
    const campaign = await insertAgencyCampaign();
    for (let i = 0; i < 25; i++) {
      await insertAgencyContact(campaign.id, { phone_e164: `+9198123${String(40_000 + i).padStart(5, '0')}`, source_row_number: i + 1 });
    }
    // The method's own predicate, through the same constant it interpolates.
    const sql = `EXPLAIN SELECT * FROM agency_contacts
          WHERE campaign_id = $1 AND ${CONTACT_PHONE_DIGITS_SQL} = $2`;
    const params = [campaign.id, '919812340003'];
    const client = await getTestPool().connect();
    let plan = '';
    let withoutIndex = '';
    try {
      await client.query('BEGIN');
      await client.query('ANALYZE agency_contacts');
      await client.query('SET LOCAL enable_seqscan = off');
      plan = (await client.query<{ 'QUERY PLAN': string }>(sql, params)).rows.map((r) => r['QUERY PLAN']).join('\n');
      // Same transaction, so the EXPLAIN sees the drop; the ROLLBACK restores it.
      await client.query('DROP INDEX idx_agency_contacts_campaign_phone_digits');
      withoutIndex = (await client.query<{ 'QUERY PLAN': string }>(sql, params)).rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      // Always: a pooled client returned mid-transaction poisons every later query.
      await client.query('ROLLBACK');
      client.release();
    }
    const indexConds = (p: string) => p.split('\n').filter((l) => l.includes('Index Cond:')).join('\n');
    expect(plan, plan).toContain('idx_agency_contacts_campaign_phone_digits');
    expect(indexConds(plan), plan).toContain('regexp_replace(');
    // Without it the digits comparison degrades to a Filter over the campaign's rows.
    expect(withoutIndex, withoutIndex).not.toContain('idx_agency_contacts_campaign_phone_digits');
    expect(indexConds(withoutIndex), withoutIndex).not.toContain('regexp_replace(');
    expect(withoutIndex, withoutIndex).toMatch(/Filter: .*regexp_replace\(/);
  });

  // ── the claim ─────────────────────────────────────────────────────────────

  describe('claimForManual', () => {
    it('claims a pending contact: pending → in_flight, prior state pending', async () => {
      const campaign = await insertAgencyCampaign();
      const contact = await insertAgencyContact(campaign.id);
      const result = await contacts.claimForManual(campaign.id, contact.id);
      expect(result).toMatchObject({ outcome: 'claimed', priorState: 'pending' });
      expect((await contactRow(contact.id)).state).toBe('in_flight');
    });

    it('never claims an in_flight contact (a live campaign attempt): linked in_flight, untouched', async () => {
      const campaign = await insertAgencyCampaign();
      const contact = await insertAgencyContact(campaign.id, { state: 'in_flight' });
      await insertAgencyAttempt(campaign.id, contact.id, { state: 'ringing' });
      const before = await contactRow(contact.id);
      const result = await contacts.claimForManual(campaign.id, contact.id);
      expect(result).toMatchObject({ outcome: 'linked', state: 'in_flight' });
      expect((await contactRow(contact.id)).updated_at.getTime()).toBe(before.updated_at.getTime());
    });

    it.each(['connected', 'completed', 'exhausted', 'suppressed'] as const)('links a %s contact without claiming it', async (state) => {
      const campaign = await insertAgencyCampaign();
      const contact = await insertAgencyContact(campaign.id, { state });
      expect(await contacts.claimForManual(campaign.id, contact.id)).toMatchObject({ outcome: 'linked', state });
      expect((await contactRow(contact.id)).state).toBe(state);
    });

    it('links (never claims) a legacy pending + dnc row', async () => {
      const campaign = await insertAgencyCampaign();
      const contact = await insertAgencyContact(campaign.id, { suppressed_reason: 'dnc' });
      expect(await contacts.claimForManual(campaign.id, contact.id)).toMatchObject({ outcome: 'linked', state: 'pending' });
      expect((await contactRow(contact.id)).state).toBe('pending');
    });

    it('answers busy for a row a concurrent claim holds (SKIP LOCKED), not_found for another campaign', async () => {
      const campaign = await insertAgencyCampaign();
      const other = await insertAgencyCampaign();
      const contact = await insertAgencyContact(campaign.id);
      const holder = await getTestPool().connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM agency_contacts WHERE id = $1 FOR UPDATE', [contact.id]);
        expect(await contacts.claimForManual(campaign.id, contact.id)).toEqual({ outcome: 'busy' });
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect(await contacts.claimForManual(other.id, contact.id)).toEqual({ outcome: 'not_found' });
      expect(await contacts.claimForManual(campaign.id, randomUUID())).toEqual({ outcome: 'not_found' });
    });

    it('a claim rolled back with its refused insert leaves the contact pending', async () => {
      const campaign = await insertAgencyCampaign();
      const contact = await insertAgencyContact(campaign.id);
      await expect(withTransaction(async (client) => {
        const claim = await contacts.claimForManual(campaign.id, contact.id, { client });
        expect(claim.outcome).toBe('claimed');
        throw new Error('insert refused');
      }, { pool: getTestPool() })).rejects.toThrow('insert refused');
      expect((await contactRow(contact.id)).state).toBe('pending');
    });

    it('two soft-phone claims racing for one contact: exactly one claims', async () => {
      const campaign = await insertAgencyCampaign();
      const contact = await insertAgencyContact(campaign.id);
      const race = () => withTransaction((client) => contacts.claimForManual(campaign.id, contact.id, { client }), { pool: getTestPool() });
      const results = await Promise.all([race(), race()]);
      expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
      expect(results.map((r) => r.outcome).sort()).toEqual(expect.arrayContaining(['claimed']));
    });
  });

  // ── the release ───────────────────────────────────────────────────────────

  describe('releaseManualClaim', () => {
    it('returns a held claim to its prior state, nothing else changed; a second release is a no-op', async () => {
      const campaign = await insertAgencyCampaign();
      const next = new Date('2026-11-01T00:00:00Z');
      const contact = await insertAgencyContact(campaign.id, { state: 'in_flight', attempt_count: 2, next_attempt_at: next });
      const call = await callOn(campaign.id, contact.id, true);

      expect(await contacts.releaseManualClaim(call.id)).toEqual({ contactId: contact.id, state: 'pending' });
      expect(await contactRow(contact.id)).toMatchObject({ state: 'pending', attempt_count: 2, next_attempt_at: next });
      expect(await contacts.releaseManualClaim(call.id)).toBeNull();
    });

    it('releases nothing for a linked call, or a contact something else moved', async () => {
      const campaign = await insertAgencyCampaign();
      const linked = await insertAgencyContact(campaign.id, { state: 'in_flight' });
      const linkedCall = await callOn(campaign.id, linked.id, false);
      expect(await contacts.releaseManualClaim(linkedCall.id)).toBeNull();
      expect((await contactRow(linked.id)).state).toBe('in_flight');

      const moved = await insertAgencyContact(campaign.id, { state: 'suppressed', suppressed_reason: 'dnc' });
      const movedCall = await callOn(campaign.id, moved.id, true);
      expect(await contacts.releaseManualClaim(movedCall.id)).toBeNull();
      expect((await contactRow(moved.id)).state).toBe('suppressed');
    });

    it('a DNC-reasoned in_flight contact is released to suppressed, never pending', async () => {
      const campaign = await insertAgencyCampaign();
      const contact = await insertAgencyContact(campaign.id, { state: 'in_flight', suppressed_reason: 'dnc' });
      const call = await callOn(campaign.id, contact.id, true);
      expect(await contacts.releaseManualClaim(call.id)).toEqual({ contactId: contact.id, state: 'suppressed' });
    });
  });

  // ── the settlement, row by row ────────────────────────────────────────────

  describe('settleFromManual — claimed (contact was pending at dial)', () => {
    async function claimed(o: Record<string, unknown> = {}) {
      const campaign = await insertAgencyCampaign();
      const contact = await insertAgencyContact(campaign.id, { state: 'in_flight', attempt_count: 1, ...o });
      const call = await callOn(campaign.id, contact.id, true);
      return { contact, call };
    }

    it('suppress → suppressed (dnc), attempt counted', async () => {
      const { contact, call } = await claimed();
      expect(await settle(call.id, SUPPRESS)).toMatchObject({ state: 'suppressed', applied: 'settled' });
      expect(await contactRow(contact.id)).toMatchObject({ state: 'suppressed', suppressed_reason: 'dnc', attempt_count: 2 });
    });

    it('terminal / success → completed', async () => {
      const { contact, call } = await claimed();
      expect(await settle(call.id, TERMINAL)).toMatchObject({ state: 'completed', applied: 'settled' });
      expect(await contactRow(contact.id)).toMatchObject({ state: 'completed', attempt_count: 2, last_disposition: 'code' });
    });

    it('callback → pending at the callback time', async () => {
      const { contact, call } = await claimed();
      const result = await settle(call.id, CALLBACK);
      expect(result).toMatchObject({ state: 'pending', applied: 'settled' });
      expect(result!.nextAttemptAt!.getTime()).toBe(CALLBACK_AT.getTime());
      expect((await contactRow(contact.id)).next_attempt_at.getTime()).toBe(CALLBACK_AT.getTime());
    });

    it('retry → pending after the delay; past max attempts → exhausted', async () => {
      const { contact, call } = await claimed();
      await settle(call.id, RETRY);
      const retried = await contactRow(contact.id);
      expect(retried.state).toBe('pending');
      expect(retried.next_attempt_at.getTime()).toBe(NOW.getTime() + 30 * 60_000);

      const spent = await claimed({ attempt_count: 2 });
      expect(await settle(spent.call.id, RETRY_SPENT)).toMatchObject({ state: 'exhausted' });
      expect((await contactRow(spent.contact.id)).attempt_count).toBe(3);
    });

    it('no decision → back to pending unchanged; attempt counted only when the call was placed', async () => {
      const next = new Date('2026-11-05T00:00:00Z');
      const placed = await claimed({ next_attempt_at: next });
      expect(await settle(placed.call.id, null, true)).toMatchObject({ state: 'pending', applied: 'settled' });
      expect(await contactRow(placed.contact.id)).toMatchObject({ state: 'pending', attempt_count: 2, next_attempt_at: next });

      const notPlaced = await claimed();
      await settle(notPlaced.call.id, null, false);
      expect(await contactRow(notPlaced.contact.id)).toMatchObject({ state: 'pending', attempt_count: 1 });
    });

    it('a claim the contact has since left (DNC mark mid-call) is never reopened', async () => {
      const { contact, call } = await claimed();
      await getTestPool().query(
        "UPDATE agency_contacts SET state = 'suppressed', suppressed_reason = 'dnc' WHERE id = $1", [contact.id],
      );
      expect(await settle(call.id, CALLBACK)).toMatchObject({ state: 'suppressed', applied: 'unchanged' });
      expect(await settle(call.id, SUPPRESS)).toMatchObject({ applied: 'unchanged' });
      expect((await contactRow(contact.id)).attempt_count).toBe(1);
    });
  });

  describe('settleFromManual — linked only (only suppress applies; terminal never reopened)', () => {
    it.each(['connected', 'completed', 'exhausted'] as const)('%s: suppress applies', async (state) => {
      const campaign = await insertAgencyCampaign();
      const contact = await insertAgencyContact(campaign.id, { state, attempt_count: 1 });
      const call = await callOn(campaign.id, contact.id, false);
      expect(await settle(call.id, SUPPRESS)).toMatchObject({ state: 'suppressed', applied: 'suppressed' });
      expect(await contactRow(contact.id)).toMatchObject({ state: 'suppressed', suppressed_reason: 'dnc', attempt_count: 1 });
    });

    it.each([
      ['connected', CALLBACK], ['connected', TERMINAL], ['completed', RETRY], ['completed', CALLBACK],
      ['exhausted', CALLBACK], ['exhausted', null], ['suppressed', CALLBACK], ['suppressed', SUPPRESS],
    ] as const)('%s + a non-applying decision: nothing written', async (state, decision) => {
      const campaign = await insertAgencyCampaign();
      const contact = await insertAgencyContact(campaign.id, {
        state, attempt_count: 1, ...(state === 'suppressed' ? { suppressed_reason: 'dnc' } : {}),
      });
      const call = await callOn(campaign.id, contact.id, false);
      const before = await contactRow(contact.id);
      expect(await settle(call.id, decision)).toMatchObject({ state, applied: 'unchanged' });
      const after = await contactRow(contact.id);
      expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
      expect(after.attempt_count).toBe(1);
    });

    it('an untagged call (no contact) answers null', async () => {
      const call = await insertManualCall(await insertSoftphoneSession());
      expect(await settle(call.id, SUPPRESS)).toBeNull();
    });
  });

  // ── no outcome saved: the campaign path's retry rules (§5, "no outcome") ──────

  describe('a call closed with no outcome (noOutcomeSettlementFor → applyNoOutcomeSettlement)', () => {
    /** A claimed contact behind an ended, settled call with `call` overrides, on a campaign with `policy`. */
    async function closed(call: Record<string, unknown>, policy: Record<string, unknown> = {}, contactOver: Record<string, unknown> = {}) {
      const campaign = await insertAgencyCampaign({ retry_policy: JSON.stringify(policy) });
      const contact = await insertAgencyContact(campaign.id, { state: 'in_flight', attempt_count: 1, ...contactOver });
      const session = await insertSoftphoneSession();
      const row = await insertManualCall(session, {
        campaign_id: campaign.id, contact_id: contact.id, contact_claimed: true, contact_prior_state: 'pending',
        state: 'ended', ended_at: new Date(), settled_at: new Date(), ...call,
      });
      const settlement = await noOutcomeSettlementFor(row as never, NOW);
      return { contact, row, settlement, applied: settlement ? await applyNoOutcomeSettlement(row as never, settlement) : null };
    }

    it('never placed: released to the prior state, nothing charged, next_attempt_at kept', async () => {
      const next = new Date('2026-11-01T00:00:00Z');
      const { contact, settlement, applied } = await closed({ outcome: 'failed', dialed_at: null }, {}, { next_attempt_at: next });
      expect(settlement).toEqual({ kind: 'release' });
      expect(applied).toEqual({ contactId: contact.id, state: 'pending', charge: 'none' });
      expect(await contactRow(contact.id)).toMatchObject({ state: 'pending', attempt_count: 1, our_fault_attempts: 0, next_attempt_at: next });
    });

    it('placed, unanswered: charged, pending after the tag policy\'s delay — not dialable at once', async () => {
      const { contact, applied } = await closed(
        { outcome: 'no_answer', dialed_at: new Date() }, { no_answer: { delay_minutes: 90, max_attempts: 5 } },
      );
      expect(applied).toMatchObject({ state: 'pending', charge: 'attempt' });
      const c = await contactRow(contact.id);
      expect(c).toMatchObject({ state: 'pending', attempt_count: 2, last_outcome: 'no_answer' });
      expect(c.next_attempt_at.getTime()).toBe(NOW.getTime() + 90 * 60_000);
    });

    it('placed, the ring hung up by the agent: the our-fault ledger, the allowance untouched', async () => {
      const { contact, applied } = await closed({ outcome: 'canceled', dialed_at: new Date() });
      expect(applied).toMatchObject({ state: 'pending', charge: 'our_fault' });
      const c = await contactRow(contact.id);
      expect(c).toMatchObject({ attempt_count: 1, our_fault_attempts: 1 });
      expect(c.next_attempt_at.getTime()).toBe(NOW.getTime() + 5 * 60_000);
    });

    it('a lapsed bridged call: charged, connected → completed by default, no_disposition recorded', async () => {
      const { contact, applied } = await closed({
        outcome: 'connected', dialed_at: new Date(), bridged_at: new Date(), disposition_code: 'no_disposition',
        disposition_source: 'campaign',
      });
      expect(applied).toMatchObject({ state: 'completed', charge: 'attempt' });
      expect(await contactRow(contact.id)).toMatchObject({
        state: 'completed', attempt_count: 2, last_outcome: 'connected', last_disposition: 'no_disposition',
      });
    });

    it('a DNC mark mid-call still wins: the claim lands suppressed, never pending', async () => {
      const { contact } = await closed({ outcome: 'no_answer', dialed_at: new Date() }, {}, { suppressed_reason: 'dnc' });
      expect((await contactRow(contact.id)).state).toBe('suppressed');
    });

    it('settleFromManual charge: our_fault bumps our_fault_attempts, none bumps nothing', async () => {
      const campaign = await insertAgencyCampaign();
      const a = await insertAgencyContact(campaign.id, { state: 'in_flight', attempt_count: 1 });
      const callA = await callOn(campaign.id, a.id, true);
      await contacts.settleFromManual({ manualCallId: callA.id, decision: RETRY, charge: 'our_fault', lastOutcome: 'canceled', lastDisposition: null });
      expect(await contactRow(a.id)).toMatchObject({ attempt_count: 1, our_fault_attempts: 1 });
      const b = await insertAgencyContact(campaign.id, { state: 'in_flight', attempt_count: 1 });
      const callB = await callOn(campaign.id, b.id, true);
      await contacts.settleFromManual({ manualCallId: callB.id, decision: RETRY, charge: 'none', lastOutcome: 'failed', lastDisposition: null });
      expect(await contactRow(b.id)).toMatchObject({ attempt_count: 1, our_fault_attempts: 0 });
    });
  });

  it('the outcome and the contact settle in ONE transaction: a failure rolls back both', async () => {
    const campaign = await insertAgencyCampaign();
    const contact = await insertAgencyContact(campaign.id, { state: 'in_flight' });
    const call = await callOn(campaign.id, contact.id, true);

    await expect(withTransaction(async (client) => {
      const saved = await calls.recordDisposition({
        id: call.id, code: 'sold', source: 'campaign', notes: null, callbackAt: null,
        actorUserId: randomUUID(), onBehalf: false,
      }, { client });
      expect(saved.ok).toBe(true);
      await contacts.settleFromManual({
        manualCallId: call.id, decision: TERMINAL, charge: 'attempt', lastOutcome: 'connected', lastDisposition: 'sold',
      }, { client });
      throw new Error('DNC write failed');
    }, { pool: getTestPool() })).rejects.toThrow('DNC write failed');

    expect((await contactRow(contact.id)).state).toBe('in_flight');
    const { rows } = await getTestPool().query('SELECT disposition_code, settled_at FROM agency_manual_calls WHERE id = $1', [call.id]);
    expect(rows[0]).toEqual({ disposition_code: null, settled_at: null });
  });

  // ── the stranded sweep ────────────────────────────────────────────────────

  it('findStrandedInFlight ignores a contact an unsettled manual call holds, not one a settled call held', async () => {
    const campaign = await insertAgencyCampaign();
    // Written at INSERT, which the BEFORE UPDATE `updated_at` trigger leaves alone.
    const stale = new Date(Date.now() - 3_600_000);
    const held = await insertAgencyContact(campaign.id, { state: 'in_flight', updated_at: stale });
    const heldBySettled = await insertAgencyContact(campaign.id, { state: 'in_flight', updated_at: stale });
    const bare = await insertAgencyContact(campaign.id, { state: 'in_flight', updated_at: stale });
    await callOn(campaign.id, held.id, true);                       // ended, awaiting its outcome
    const settled = await callOn(campaign.id, heldBySettled.id, true);
    await getTestPool().query('UPDATE agency_manual_calls SET settled_at = now() WHERE id = $1', [settled.id]);
    const live = await insertAgencyContact(campaign.id, { state: 'in_flight', updated_at: stale });
    await insertManualCall(await insertSoftphoneSession(), {
      campaign_id: campaign.id, contact_id: live.id, contact_claimed: true, contact_prior_state: 'pending', state: 'bridged',
    });

    const found = await contacts.findStrandedInFlight(new Date(Date.now() - 600_000));
    expect(found.map((r) => r.id).sort()).toEqual([heldBySettled.id, bare.id].sort());
  });
});
