import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
const { agencyContactRepository } = await import(
  '../../../src/db/repositories/agency.repository.js'
);
const { resolveOurFaultRedial, resolveRetryDecision } = await import(
  '../../../src/agency/retry-policy.js'
);

/**
 * A DNC suppression put back on the roster by an outcome, a retry decision or a
 * reaper — the merge blocker for campaign-scoped marks.
 *
 * ── The defect this file is the evidence for ───────────────────────────────
 *
 *   1. the agent presses mark-DNC mid-call. `suppressByPhone` writes
 *      `state = 'suppressed', suppressed_reason = 'dnc'`;
 *   2. the call ends on an AGENT-SIDE path — the station socket drops after the
 *      bridge, or the replica dies and the reaper writes `orphaned`;
 *   3. that path calls `markState(contactId, decision.contactState, …)`. Both
 *      `resolveRetryDecision` and `resolveOurFaultRedial` answer `'pending'` for
 *      those outcomes under their caps (`DEFAULT_RETRY_POLICY` carries
 *      `agent_disconnected: 5min ×3`, `orphaned: 0min ×3`), and the dialer's own
 *      log line for that branch reads "Contact requeued after an agent-side drop,
 *      with no attempt charged";
 *   4. `claimDialable` used to gate on `state = 'pending' AND next_attempt_at <=
 *      now()` and never look at `suppressed_reason`, so it claims the row;
 *   5. the pre-dial DNC gate is `SISMEMBER dnc:{tenantId}`, and a CAMPAIGN-scoped
 *      `dnc_entries` row never enters that flat set.
 *
 * Net: the customer who said "stop calling me" is dialled again from the same
 * campaign inside five minutes, with `dnc_recorded: true` and every dashboard
 * green.
 *
 * It is THIS change's defect, not an inherited one. A mark used to write a
 * tenant-wide row that reached the flat set, so step 5 caught the resurrected
 * contact at dial time. Scoping the mark removes that backstop by design (§2.3):
 * for the marked contact the blast radius is strictly LARGER afterwards.
 *
 * ── Why the claim can only be made HERE ────────────────────────────────────
 *
 * `test/unit/agency/dnc-resurrection.test.ts` pins the mechanism (the real policy
 * functions really do answer `pending`) and the SHAPE of the statement the guard
 * lives in. It cannot assert the EFFECT: the guard is SQL semantics and the unit
 * tier mocks the pool, which agrees with any statement at all. That gap has
 * already cost this branch once — T-DNC6 found an inert `COALESCE` in
 * `suppressByPhone` that 9,342 green unit tests could not see.
 *
 * So the assertions below read the ROW BACK, and the strongest one runs
 * `claimDialable` afterwards and requires it to return nothing.
 *
 * ⚠️ NOT RUNNABLE LOCALLY. Core's integration stack binds 5433/6380, which are
 * magick-master's DEV Postgres and Redis, and `test-utils.ts` calls `flushdb()`.
 * Written blind and owed to CI; assume unverified until CI says otherwise.
 */
describe('a DNC suppression is never resurrected (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  const PHONE = '+14155550142';

  async function readContact(id: string) {
    const { rows } = await getTestPool().query(
      `SELECT id, state, suppressed_reason, last_outcome, last_disposition,
              attempt_count, next_attempt_at
         FROM agency_contacts WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  /** A contact the agent has just marked DNC mid-call. */
  async function markedContact(overrides: Record<string, unknown> = {}) {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const contact = await insertAgencyContact(campaign.id, {
      phone_e164: PHONE, state: 'connected', attempt_count: 1, source_row_number: 1, ...overrides,
    });
    await agencyContactRepository.suppressByPhone(campaign.id, PHONE, 'dnc', {
      alwaysContactId: contact.id,
    });
    expect(await readContact(contact.id), 'precondition: the mark landed').toMatchObject({
      state: 'suppressed', suppressed_reason: 'dnc',
    });
    return { campaign, contact };
  }

  // ── THE reproduction ─────────────────────────────────────────────────────

  it('T-RES-I1: an agent_disconnected outcome does NOT put it back to pending', async () => {
    const { campaign, contact } = await markedContact();

    // Exactly what `agency-dialer.ts`'s our-fault branch does after the station
    // socket drops: charge the separate ledger, ask the policy, write the answer.
    const ourFaultUsed = await agencyContactRepository
      .chargeOurFaultAttempt(contact.id, 'agent_disconnected');
    const decision = resolveOurFaultRedial(
      campaign.retry_policy ?? null, 'agent_disconnected', new Date(), ourFaultUsed,
    );
    expect(decision.contactState, 'the policy really does want it back on the roster').toBe('pending');

    await agencyContactRepository.markState(contact.id, decision.contactState, {
      ...(decision.nextAttemptAt ? { next_attempt_at: decision.nextAttemptAt } : {}),
    });

    const row = await readContact(contact.id);
    expect(row, 'the write must refuse — property 1').toMatchObject({
      state: 'suppressed', suppressed_reason: 'dnc',
    });
    // Property 2, independently: even had the state moved, nothing may dial it.
    expect(await agencyContactRepository.claimDialable(campaign.id, 10)).toHaveLength(0);
  });

  it('T-RES-I2: an orphaned reap does NOT put it back to pending', async () => {
    const { campaign, contact } = await markedContact();

    // `reaper.ts`'s `requeueOrphanedContact` hardcodes `'pending'` rather than
    // taking a decision, which is why the guard lives in the repository.
    const ourFaultUsed = await agencyContactRepository
      .chargeOurFaultAttempt(contact.id, 'orphaned');
    expect(resolveOurFaultRedial(null, 'orphaned', new Date(), ourFaultUsed).contactState)
      .toBe('pending');

    await agencyContactRepository.markState(contact.id, 'pending', {
      last_outcome: 'orphaned', next_attempt_at: new Date(),
    });

    expect(await readContact(contact.id)).toMatchObject({
      state: 'suppressed', suppressed_reason: 'dnc',
    });
    expect(await agencyContactRepository.claimDialable(campaign.id, 10)).toHaveLength(0);
  });

  it('T-RES-I3: nor does the ordinary outcome retry path', async () => {
    const { campaign, contact } = await markedContact();

    const attemptsUsed = await agencyContactRepository.chargeAttempt(contact.id, 'no_answer');
    const decision = resolveRetryDecision(null, 'no_answer', new Date(), attemptsUsed);
    expect(decision.contactState).toBe('pending');

    await agencyContactRepository.markState(contact.id, decision.contactState, {
      ...(decision.nextAttemptAt ? { next_attempt_at: decision.nextAttemptAt } : {}),
    });

    expect(await readContact(contact.id)).toMatchObject({ state: 'suppressed' });
    expect(await agencyContactRepository.claimDialable(campaign.id, 10)).toHaveLength(0);
  });

  it('T-RES-I4: the `connected` laundering path is refused as well', async () => {
    // This is why the guard is NOT keyed on the target state being `pending`.
    // `agency-dialer.ts`'s `bridged` handler writes `'connected'`, and its own
    // comment records that that write can land AFTER the `ended` handler's,
    // because lifecycle listeners are fire-and-forget. A target-keyed guard would
    // let this write take the row out of `suppressed`, after which the NEXT write
    // — the outcome policy's `pending` — sees an unguarded row and lands.
    const { campaign, contact } = await markedContact();

    await agencyContactRepository.markState(contact.id, 'connected', { last_outcome: 'connected' });
    expect(await readContact(contact.id), 'still suppressed').toMatchObject({ state: 'suppressed' });

    await agencyContactRepository.markState(contact.id, 'pending', { next_attempt_at: new Date() });
    expect(await readContact(contact.id), 'and the second write finds it still guarded')
      .toMatchObject({ state: 'suppressed', suppressed_reason: 'dnc' });
    expect(await agencyContactRepository.claimDialable(campaign.id, 10)).toHaveLength(0);
  });

  it('T-RES-I5: the retry INSTANT is frozen too, so the row does not contradict itself', async () => {
    const { contact } = await markedContact();
    const before = await readContact(contact.id);

    const wednesday = new Date(Date.now() + 5 * 24 * 3600_000);
    await agencyContactRepository.markState(contact.id, 'pending', { next_attempt_at: wednesday });

    // Inert for dialing — the claim gates on state — but `next_attempt_at` is what
    // a console and a compliance export read, and "suppressed, next call
    // Wednesday" is the precedence contradicting itself in front of a human.
    expect((await readContact(contact.id)).next_attempt_at).toEqual(before.next_attempt_at);
  });

  // ── the deliberate NON-freezes ───────────────────────────────────────────

  it('T-RES-I6: the record-keeping columns still land on a frozen row', async () => {
    // Mark-DNC on a live call is supported and the agent's write-up arrives
    // AFTERWARDS through the disposition route, which reaches `markState` with
    // `last_disposition`. A guard written as `WHERE … AND suppressed_reason IS
    // DISTINCT FROM 'dnc'` would refuse the whole row and silently drop the
    // record of what was said — the reason the guard rewrites two columns
    // instead of refusing the statement.
    const { contact } = await markedContact();

    await agencyContactRepository.markState(contact.id, 'completed', {
      last_outcome: 'agent_disconnected',
      last_disposition: 'do_not_call',
      bump_attempt: true,
    });

    expect(await readContact(contact.id)).toMatchObject({
      state: 'suppressed',
      suppressed_reason: 'dnc',
      last_outcome: 'agent_disconnected',
      last_disposition: 'do_not_call',
      attempt_count: 2,
    });
  });

  it('T-RES-I7: an `invalid` suppression is NOT frozen — the guard is compliance-only', async () => {
    // The restrictive direction has a real failure mode of its own. Freeze every
    // suppressed row and a contact the pre-dial gate parked for a data-quality
    // reason can never be moved by anything again. The guard keys on the REASON
    // so `invalid`, `max_attempts` and `manual` keep whatever handling they have.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const contact = await insertAgencyContact(campaign.id, {
      phone_e164: PHONE, state: 'suppressed', suppressed_reason: 'invalid', source_row_number: 1,
    });

    await agencyContactRepository.markState(contact.id, 'pending', { next_attempt_at: new Date() });

    expect(await readContact(contact.id)).toMatchObject({ state: 'pending' });
    expect(await agencyContactRepository.claimDialable(campaign.id, 10)).toHaveLength(1);
  });

  it('T-RES-I8: the DNC write itself is not refused by its own guard', async () => {
    // The CASE reads the row's PRE-update reason, which is what lets the
    // `do_not_call` disposition (`suppressedReason: 'dnc'` from
    // `disposition-policy.ts`) land on a row that has no reason yet. If this
    // failed, marking DNC through the disposition route would silently no-op.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const contact = await insertAgencyContact(campaign.id, {
      phone_e164: PHONE, state: 'connected', source_row_number: 1,
    });

    await agencyContactRepository.markState(contact.id, 'suppressed', {
      suppressed_reason: 'dnc', last_disposition: 'do_not_call',
    });

    expect(await readContact(contact.id)).toMatchObject({
      state: 'suppressed', suppressed_reason: 'dnc', last_disposition: 'do_not_call',
    });
  });

  // ── property 2 alone, on data the guard cannot have prevented ────────────

  it('T-RES-I9: claimDialable refuses a pending+dnc row the PRE-FIX build wrote', async () => {
    // Not hypothetical insurance. Every build before this fix could leave a row
    // `pending` with `suppressed_reason = 'dnc'` — that is the defect — so these
    // rows exist in production right now. The claim predicate takes them off the
    // roster the moment it deploys, with no backfill and no migration.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const resurrected = await insertAgencyContact(campaign.id, {
      phone_e164: PHONE, state: 'pending', suppressed_reason: 'dnc', source_row_number: 1,
    });
    const ordinary = await insertAgencyContact(campaign.id, {
      state: 'pending', source_row_number: 2,
    });

    const claimed = await agencyContactRepository.claimDialable(campaign.id, 10);
    expect(claimed.map((c) => c.id)).toEqual([ordinary.id]);
    expect((await readContact(resurrected.id)).state, 'left untouched, not claimed').toBe('pending');
  });

  it('T-RES-I10: and the next markState on such a row self-heals it', async () => {
    // `THEN 'suppressed'` rather than `THEN state`. A legacy row is not merely
    // frozen where it was left — it is returned to the state the mark asked for,
    // so the roster converges without anyone running a backfill over a
    // compliance column.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const resurrected = await insertAgencyContact(campaign.id, {
      phone_e164: PHONE, state: 'pending', suppressed_reason: 'dnc', source_row_number: 1,
    });

    await agencyContactRepository.markState(resurrected.id, 'pending', { last_outcome: 'no_answer' });

    expect(await readContact(resurrected.id)).toMatchObject({
      state: 'suppressed', suppressed_reason: 'dnc', last_outcome: 'no_answer',
    });
  });

  it('T-RES-I12: an invalid outcome cannot strip the dnc reason and un-freeze the row', async () => {
    // The hole T-RES4b pins the shape of. `resolveRetryDecision('invalid')`
    // returns `suppressedReason: 'invalid'` and the dialer forwards it. A plain
    // `COALESCE($7, suppressed_reason)` overwrites `dnc`; the next `pending`
    // write then sees an unguarded row and the claim predicate no longer
    // excludes it. The CASE freeze on the reason is what keeps both guards
    // keyed after that path has run.
    const { campaign, contact } = await markedContact();
    const decision = resolveRetryDecision(null, 'invalid', new Date(), 1);
    expect(decision.suppressedReason).toBe('invalid');
    expect(decision.contactState).toBe('suppressed');

    await agencyContactRepository.markState(contact.id, decision.contactState, {
      suppressed_reason: decision.suppressedReason,
    });
    expect(await readContact(contact.id)).toMatchObject({
      state: 'suppressed', suppressed_reason: 'dnc',
    });

    await agencyContactRepository.markState(contact.id, 'pending', { next_attempt_at: new Date() });
    expect(await readContact(contact.id)).toMatchObject({
      state: 'suppressed', suppressed_reason: 'dnc',
    });
    expect(await agencyContactRepository.claimDialable(campaign.id, 10)).toHaveLength(0);
  });

  // ── the index question, asserted rather than assumed ─────────────────────

  it('T-RES-I11: the dialable index still serves the widened claim predicate', async () => {
    // The added `suppressed_reason IS DISTINCT FROM 'dnc'` term is deliberately
    // NOT in `idx_agency_contacts_dialable`'s own predicate — narrowing it would
    // mean DROP + CREATE under ACCESS EXCLUSIVE inside the startup migration
    // transaction, blocking THE hot dialing query on up to 1M rows to remove a
    // handful of them from an index (087 records why CONCURRENTLY is unavailable).
    //
    // That decision is only safe if the extra conjunct does not make the index
    // UNUSABLE, so it is checked against the planner rather than argued.
    //
    // `enable_seqscan = off` is on purpose and is not cheating: on a test table of
    // a few rows the planner correctly prefers a seq scan whatever the index says,
    // so a plain EXPLAIN here would assert the table size, not the predicate. The
    // question that actually matters is "CAN the partial index serve this
    // predicate at all" — if the extra conjunct disqualified it, the plan below
    // would still be a scan even with seq scans discouraged. Cost is a production
    // statistics question; usability is the one a test can settle.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    for (let i = 0; i < 20; i++) {
      await insertAgencyContact(campaign.id, { state: 'pending', source_row_number: i + 1 });
    }

    const client = await getTestPool().connect();
    let plan: string;
    try {
      await client.query('BEGIN');
      await client.query('ANALYZE agency_contacts');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query(
        `EXPLAIN
         SELECT id FROM agency_contacts
          WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at <= now()
            AND suppressed_reason IS DISTINCT FROM 'dnc'
          ORDER BY next_attempt_at
          LIMIT 10`,
        [campaign.id],
      );
      plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(plan, plan).toContain('idx_agency_contacts_dialable');
  });
});
