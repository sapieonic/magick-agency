import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
const { agencyContactRepository } = await import(
  '../../../src/db/repositories/agency.repository.js'
);

/**
 * Campaign-scoped DNC — the hole the scoping change would otherwise open.
 *
 * ── The defect this file is the evidence for ───────────────────────────────
 *
 * An agent's mark-DNC used to do two things: suppress ONE contact row by id, and
 * have the public API layer write a TENANT-WIDE `dnc_entries` row that reached a flat
 * `dnc:{tenantId}` set and blocked the number at dial time in every campaign.
 * Making the mark campaign-scoped removes the second half — a campaign-scoped row
 * does not enter the tenant-flat set — which leaves the by-id write as the
 * only in-campaign enforcement there is.
 *
 * And the by-id write has a hole. Migration 073 refuses `UNIQUE (campaign_id,
 * phone_e164)` on purpose ("two people on one household landline, two contacts
 * behind one company switchboard, a shared family mobile"), so one campaign
 * holding the same number twice is supported, ordinary data. Suppress only the
 * dialled row and the duplicate stays `pending` and gets claimed on the next tick:
 * the customer who just said "stop calling me" is rung again, from the same
 * campaign, with a 200 and a green metric behind it.
 *
 * ── Why this claim can only be made HERE ───────────────────────────────────
 *
 * The unit tier asserts what the route ASKS FOR (`dnc-mark-route.test.ts`) and
 * which candidates `normalizeE164` accepts (`agency-repository.test.ts`). Neither
 * can assert the effect: a mocked pool agrees with SQL that matches nothing, and a
 * status-only assertion is satisfied by absence — `contact_state: 'suppressed'` is
 * a CONSTANT in that response, true even if not one row was written. So the
 * assertions below read the ROWS BACK, and the strongest one runs `claimDialable`
 * afterwards and requires it to return nothing at all.
 *
 * ⚠️ Written without a local run: `test-utils.ts` calls `flushdb()`, so check which
 * Redis it points at before running it, and treat it as owed to CI. That is a real cost and it has
 * already been paid back once: on its first CI run T-DNC6 failed and had found a
 * genuine defect in `suppressByPhone` (an inert `COALESCE` relabelling every swept
 * row `dnc`) that 9,342 green unit tests could not see, because the defect was in
 * SQL semantics and the unit tier mocks the pool. Anything asserted here must
 * therefore be assumed unverified until CI says otherwise — including, right now,
 * T-DNC6b.
 */
describe('campaign-scoped DNC — every roster row with that number (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  /** The same number, as two roster rows that a CSV really would produce. */
  const DIALLED = '+14155550100';
  const DUPLICATE = '+1 (415) 555-0100';

  async function readContact(id: string) {
    const { rows } = await getTestPool().query(
      'SELECT id, state, suppressed_reason, last_disposition, next_attempt_at FROM agency_contacts WHERE id = $1',
      [id],
    );
    return rows[0];
  }

  // ── THE test ─────────────────────────────────────────────────────────────

  it('T-DNC1: suppresses BOTH rows — the dialled one and the one never claimed', async () => {
    const campaign = await insertAgencyCampaign();
    // The row the agent is on: claimed, dialled, mid-conversation.
    const dialled = await insertAgencyContact(campaign.id, {
      phone_e164: DIALLED, state: 'connected', attempt_count: 1, source_row_number: 1,
    });
    // The same number, further down the same CSV, never claimed by anything —
    // stored in the shape the file happened to hold it in.
    const duplicate = await insertAgencyContact(campaign.id, {
      phone_e164: DUPLICATE, state: 'pending', source_row_number: 2,
    });

    await agencyContactRepository.suppressByPhone(campaign.id, DIALLED, 'dnc', {
      alwaysContactId: dialled.id,
    });

    // Asserted against the ROWS. Not against a return value, not against a count,
    // and not against a response field that is a constant.
    expect(await readContact(dialled.id)).toMatchObject({
      state: 'suppressed', suppressed_reason: 'dnc',
    });
    expect(await readContact(duplicate.id)).toMatchObject({
      state: 'suppressed', suppressed_reason: 'dnc',
    });
  });

  it('T-DNC2: and the campaign has nothing left to dial — the effect, not the write', async () => {
    // The assertion that would have caught the defect even if `state` were spelled
    // some other way: `claimDialable` is the predicate the dialer actually
    // runs, and after the mark it must find nothing. Against a by-contact-id
    // suppression this returns the duplicate and the customer is dialled again.
    const campaign = await insertAgencyCampaign();
    const dialled = await insertAgencyContact(campaign.id, {
      phone_e164: DIALLED, state: 'connected', source_row_number: 1,
    });
    await insertAgencyContact(campaign.id, {
      phone_e164: DUPLICATE, state: 'pending', source_row_number: 2,
    });

    // Proof the fixture is real: the duplicate IS claimable before the mark.
    const before = await agencyContactRepository.claimDialable(campaign.id, 10);
    expect(before).toHaveLength(1);
    // Put it back, so the mark faces the state it faces in production.
    await getTestPool().query(
      "UPDATE agency_contacts SET state = 'pending' WHERE id = $1", [before[0]!.id],
    );

    await agencyContactRepository.suppressByPhone(campaign.id, DIALLED, 'dnc', {
      alwaysContactId: dialled.id,
    });

    expect(await agencyContactRepository.claimDialable(campaign.id, 10)).toEqual([]);
  });

  // ── The boundaries of the sweep ──────────────────────────────────────────

  it('T-DNC3: leaves a DIFFERENT number in the same campaign alone', async () => {
    // The mirror of T-DNC1. A sweep that matched too much would pass T-DNC1
    // perfectly while emptying the roster, and "the campaign stopped dialing
    // anyone" is a worse outage than the bug.
    const campaign = await insertAgencyCampaign();
    const dialled = await insertAgencyContact(campaign.id, {
      phone_e164: DIALLED, state: 'connected', source_row_number: 1,
    });
    const other = await insertAgencyContact(campaign.id, {
      phone_e164: '+14155550199', state: 'pending', source_row_number: 2,
    });
    // Same digits with a junk character: it survives the SQL prefilter and must be
    // refused by `normalizeE164`, which is the only place that decision is made.
    const junk = await insertAgencyContact(campaign.id, {
      phone_e164: '1a4155550100', state: 'pending', source_row_number: 3,
    });

    await agencyContactRepository.suppressByPhone(campaign.id, DIALLED, 'dnc', {
      alwaysContactId: dialled.id,
    });

    expect(await readContact(other.id)).toMatchObject({ state: 'pending' });
    expect(await readContact(junk.id)).toMatchObject({ state: 'pending' });
  });

  it('T-DNC4: leaves the SAME number in another campaign alone — this is what "scoped" means', async () => {
    // The whole point of the change. The other campaign belongs to the same
    // tenant, and under the old tenant-wide mark its row stopped being dialable
    // too; a customer asking one campaign to stop is not asking to be removed from
    // campaigns they have never heard from.
    const campaign = await insertAgencyCampaign();
    const otherCampaign = await insertAgencyCampaign();
    const dialled = await insertAgencyContact(campaign.id, {
      phone_e164: DIALLED, state: 'connected', source_row_number: 1,
    });
    const elsewhere = await insertAgencyContact(otherCampaign.id, {
      phone_e164: DIALLED, state: 'pending', source_row_number: 1,
    });

    await agencyContactRepository.suppressByPhone(campaign.id, DIALLED, 'dnc', {
      alwaysContactId: dialled.id,
    });

    expect(await readContact(elsewhere.id)).toMatchObject({ state: 'pending' });
    expect(await agencyContactRepository.claimDialable(otherCampaign.id, 10)).toHaveLength(1);
  });

  it('T-DNC5: keeps next_attempt_at, and writes the disposition to the marked row only', async () => {
    // Two invariants that are easy to break together. `markState` COALESCEs
    // `next_attempt_at` and this method preserves that by omitting the column —
    // the STATE is what takes a contact off the roster, and a compliance route
    // quietly nulling a column an export reads is an untracked change
    // (clearing it belongs to a separate change). And a disposition is a statement about ONE
    // call with ONE person: stamping it on the housemate's row because they share
    // a landline invents a conversation.
    const campaign = await insertAgencyCampaign();
    const retryAt = new Date(Date.now() + 5 * 60_000);
    const dialled = await insertAgencyContact(campaign.id, {
      phone_e164: DIALLED, state: 'connected', next_attempt_at: retryAt, source_row_number: 1,
    });
    const duplicate = await insertAgencyContact(campaign.id, {
      phone_e164: DUPLICATE, state: 'pending', next_attempt_at: retryAt, source_row_number: 2,
    });

    await agencyContactRepository.suppressByPhone(campaign.id, DIALLED, 'dnc', {
      alwaysContactId: dialled.id,
      lastDisposition: 'do_not_call',
    });

    const marked = await readContact(dialled.id);
    const other = await readContact(duplicate.id);
    expect(new Date(marked.next_attempt_at).getTime()).toBe(retryAt.getTime());
    expect(new Date(other.next_attempt_at).getTime()).toBe(retryAt.getTime());
    expect(marked.last_disposition).toBe('do_not_call');
    expect(other.last_disposition).toBeNull();
  });

  it('T-DNC6: an already-suppressed row keeps the reason it had', async () => {
    // A row suppressed `invalid` by the pre-dial gate did not become a do-not-call
    // request, and rewriting the reason would put a compliance claim on a
    // data-quality row.
    //
    // This is the assertion that CAUGHT the shipped bug. The write was
    // `suppressed_reason = COALESCE($3, suppressed_reason)`, copied from
    // `markState` — but `reason` is a REQUIRED argument here and so is never NULL,
    // making the guard inert and relabelling every swept row `dnc`. A mocked pool
    // cannot see that; it is SQL semantics, and only this tier evaluates them.
    // See T-DNC6b for the other half, and the argument-order note on the UPDATE.
    const campaign = await insertAgencyCampaign();
    const dialled = await insertAgencyContact(campaign.id, {
      phone_e164: DIALLED, state: 'connected', source_row_number: 1,
    });
    const already = await insertAgencyContact(campaign.id, {
      phone_e164: DUPLICATE, state: 'suppressed', suppressed_reason: 'invalid', source_row_number: 2,
    });

    await agencyContactRepository.suppressByPhone(campaign.id, DIALLED, 'dnc', {
      alwaysContactId: dialled.id,
    });

    expect(await readContact(already.id)).toMatchObject({
      state: 'suppressed', suppressed_reason: 'invalid',
    });
  });

  it('T-DNC6b: but the MARKED row records dnc even if it already had a reason', async () => {
    // The other half of T-DNC6, and the case that decides between the two possible
    // fixes. A plain `COALESCE(suppressed_reason, $3)` — keep any existing reason,
    // for every row — also passes T-DNC6, so T-DNC6 alone does not pin the
    // behaviour. This does.
    //
    // The row is reachable, not hypothetical: the DISPOSITION route writes
    // `suppressed_reason` on this same contact via `markState` when the catalog
    // entry suppresses, and `POST /attempts/:id/dnc` explicitly supports being
    // called on an already-dispositioned attempt. So an agent can disposition, then
    // press DNC, and under a blanket COALESCE the explicit do-not-call mark would
    // never be recorded — the mirror of the bug T-DNC6 catches, and the worse
    // direction of the two: a compliance request silently not written down.
    const campaign = await insertAgencyCampaign();
    const dialled = await insertAgencyContact(campaign.id, {
      phone_e164: DIALLED, state: 'suppressed', suppressed_reason: 'manual',
      source_row_number: 1,
    });
    const duplicate = await insertAgencyContact(campaign.id, {
      phone_e164: DUPLICATE, state: 'suppressed', suppressed_reason: 'invalid',
      source_row_number: 2,
    });

    await agencyContactRepository.suppressByPhone(campaign.id, DIALLED, 'dnc', {
      alwaysContactId: dialled.id,
    });

    // The agent acted on this row: their mark outranks the earlier reason.
    expect(await readContact(dialled.id)).toMatchObject({ suppressed_reason: 'dnc' });
    // The housemate's row is untouched — nobody at that row asked for anything.
    expect(await readContact(duplicate.id)).toMatchObject({ suppressed_reason: 'invalid' });
  });

  it('T-DNC7: an unusable number still suppresses the marked row', async () => {
    // `not-a-number` matches nothing and normalizes to null, so the by-phone sweep
    // has nothing to do — but the customer in front of the agent must still leave
    // the roster. This is the guarantee the route has always made and the one a
    // by-phone rewrite drops silently.
    const campaign = await insertAgencyCampaign();
    const dialled = await insertAgencyContact(campaign.id, {
      phone_e164: 'not-a-number', state: 'connected', source_row_number: 1,
    });

    await agencyContactRepository.suppressByPhone(campaign.id, 'not-a-number', 'dnc', {
      alwaysContactId: dialled.id,
    });

    expect(await readContact(dialled.id)).toMatchObject({
      state: 'suppressed', suppressed_reason: 'dnc',
    });
  });

  it('T-DNC9: a held FOR UPDATE on the duplicate makes claimDialable skip it', async () => {
    // The race the unlocked SELECT opened: claimDialable takes the duplicate
    // BETWEEN the sweep's two statements, the tick already has it in memory,
    // and the campaign-scoped mark never enters the tenant-flat Redis set, so
    // that press still places the call. The sweep now SELECT … FOR UPDATE in
    // the same transaction as the UPDATE. claimDialable uses SKIP LOCKED, so
    // a row the sweep holds cannot be taken. This is that interaction, against
    // real locks — the unit tier can only pin that FOR UPDATE is in the SQL.
    const campaign = await insertAgencyCampaign();
    const dialled = await insertAgencyContact(campaign.id, {
      phone_e164: DIALLED, state: 'connected', source_row_number: 1,
    });
    const duplicate = await insertAgencyContact(campaign.id, {
      phone_e164: DUPLICATE, state: 'pending', source_row_number: 2,
    });

    const locker = await getTestPool().connect();
    try {
      await locker.query('BEGIN');
      await locker.query(
        'SELECT id FROM agency_contacts WHERE id = $1 FOR UPDATE',
        [duplicate.id],
      );

      expect(await agencyContactRepository.claimDialable(campaign.id, 10)).toEqual([]);

      await locker.query('ROLLBACK');
    } finally {
      locker.release();
    }

    // And once the lock is gone the duplicate is still pending — this test
    // holds, it does not suppress — so a later mark still has something to do.
    expect(await readContact(duplicate.id)).toMatchObject({ state: 'pending' });
    await agencyContactRepository.suppressByPhone(campaign.id, DIALLED, 'dnc', {
      alwaysContactId: dialled.id,
    });
    expect(await readContact(duplicate.id)).toMatchObject({ state: 'suppressed' });
  });

  // ── Migration 087 ────────────────────────────────────────────────────────

  it('T-DNC8: migration 087 shipped the column and the index the sweep depends on', async () => {
    // The index is not a performance nicety here: without it this query is a scan
    // of every contact row in the database, on a path an agent triggers mid-call.
    // Asserted by NAME and by EXPRESSION — a renamed or re-spelled expression index
    // is not used by the query and nothing else would notice.
    const { rows: cols } = await getTestPool().query(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'agency_dnc_outbox' AND column_name = 'campaign_id'`,
    );
    expect(cols).toHaveLength(1);
    // NULLABLE on purpose, and NULL is the tenant-wide SCOPE rather than a missing
    // value: it is what `scope: 'tenant'` writes, and what rows enqueued before this
    // shipped carry — those were created as tenant-wide records too. Forwarded as
    // such, never backfilled.
    expect(cols[0]!.is_nullable).toBe('YES');

    const { rows: idx } = await getTestPool().query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'agency_contacts'
          AND indexname = 'idx_agency_contacts_campaign_phone_digits'`,
    );
    expect(idx).toHaveLength(1);
    expect(idx[0]!.indexdef).toContain('campaign_id');
    expect(idx[0]!.indexdef).toContain('regexp_replace');
  });
});
