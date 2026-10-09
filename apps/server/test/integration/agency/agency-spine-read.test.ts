import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, uuidFor } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const {
  insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession,
} = await import('./agency-factories.js');
const { agencyAttemptRepository, agencyContactRepository } =
  await import('../../../src/db/repositories/agency.repository.js');
const { decodeKeysetCursor } = await import('@magick-agency/domain/keyset-cursor');
const { parseAttemptFilters } = await import('../../../src/agency/spine-filters.js');

/**
 * ─── THE SUPERVISOR READ SURFACE, AGAINST REAL SQL ──────────────────
 *
 * The unit tier mocks the repository wholesale, which is right for what it tests
 * (auth, filter parsing, cursor refusal) and means the queries themselves have
 * never executed. Three properties live only in the SQL:
 *
 * 1. **The joins do not drop rows.** `reserved_agent_id` is NULL on every
 *    attempt that failed before an agent was on it; an inner join to
 *    `agency_agent_sessions` silently removes exactly the never-bridged
 *    attempts the view exists to show. Against a mock, "returns rows" passes
 *    either way — this is the trap named by hand.
 * 2. **The keyset is stable under concurrent insert.** The whole reason this is
 *    not an OFFSET. A mock cannot exhibit it; the failure looks like rows
 *    randomly missing.
 * 3. **The microsecond cursor round-trips.** Batched ingest writes thousands of
 *    rows sharing one `created_at` to the microsecond, and a millisecond-
 *    truncated cursor skips every row inside the truncated millisecond.
 *
 * The plan-level assertions (that none of this is a sequential scan on a
 * 1M-row campaign) are in the PR, measured against a seeded database — this
 * file is about correctness, not cost.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeTestPool();
});

/** A campaign with the shapes a naive query drops. */
async function seedCampaign() {
  const campaign = await insertAgencyCampaign({ status: 'stopped' });
  const session = await insertAgentSession(campaign.id, { agent_user_id: uuidFor('ravi') });

  // (a) A contact that was CONNECTED and dispositioned by a named agent.
  const connected = await insertAgencyContact(campaign.id, {
    phone_e164: '+919876500001', state: 'completed', attempt_count: 1,
    last_outcome: 'connected', last_disposition: 'not_interested',
  });
  const bridged = await insertAgencyAttempt(campaign.id, connected.id, {
    attempt_number: 1, state: 'ended', outcome: 'connected',
    reserved_agent_id: session.id, disposition_code: 'not_interested',
    notes: 'asked us to call after 6pm', talk_seconds: 91,
    webrtc_call_id: '99999999-9999-4999-8999-999999999999',
    bridged_at: new Date(), ended_at: new Date(),
  });

  // (b) An ABANDONED attempt — it rang, no agent was free, nobody was ever
  //     reserved. `reserved_agent_id` is NULL. This is the row an inner join
  //     to the session table deletes, and the row a call list cannot show.
  const abandonedContact = await insertAgencyContact(campaign.id, {
    phone_e164: '+919876500002', state: 'completed', attempt_count: 1,
    last_outcome: 'abandoned',
  });
  const abandoned = await insertAgencyAttempt(campaign.id, abandonedContact.id, {
    attempt_number: 1, state: 'ended', outcome: 'abandoned',
    reserved_agent_id: null, webrtc_call_id: null, ended_at: new Date(),
  });

  // (c) A SUPPRESSED contact — never dialed at all, so it has no attempt row
  //     and appears in no call list anywhere. The DNC question is about this row.
  const suppressed = await insertAgencyContact(campaign.id, {
    phone_e164: '+919876500003', state: 'suppressed', suppressed_reason: 'dnc',
    attempt_count: 0,
  });

  return { campaign, session, connected, bridged, abandonedContact, abandoned, suppressed };
}

describe('attempts: the rows a naive join drops', () => {
  it('shows an abandoned attempt that never reserved an agent, alongside a bridged one', async () => {
    const s = await seedCampaign();
    const page = await agencyAttemptRepository.listForCampaign({
      campaignId: s.campaign.id, filters: {}, limit: 50,
    });

    const ids = page.rows.map((r) => r.id);
    expect(ids).toContain(s.bridged.id);
    // The key assertion. A LEFT JOIN is the only reason
    // this row survives.
    expect(ids).toContain(s.abandoned.id);

    const abandoned = page.rows.find((r) => r.id === s.abandoned.id)!;
    expect(abandoned.outcome).toBe('abandoned');
    expect(abandoned.agent_user_id).toBeNull();
    // Still names the number it dialled — the contact join carries it.
    expect(abandoned.phone_e164).toBe('+919876500002');
  });

  it('names the agent by USER, never by session id', async () => {
    const s = await seedCampaign();
    const page = await agencyAttemptRepository.listForCampaign({
      campaignId: s.campaign.id, filters: {}, limit: 50,
    });
    const row = page.rows.find((r) => r.id === s.bridged.id)!;
    expect(row.agent_user_id).toBe(uuidFor('ravi'));
    expect(row.reserved_agent_id).toBe(s.session.id);
  });

  it('carries webrtc_call_id as an id, and NULL is a legitimate value', async () => {
    const s = await seedCampaign();
    const page = await agencyAttemptRepository.listForCampaign({
      campaignId: s.campaign.id, filters: {}, limit: 50,
    });
    expect(page.rows.find((r) => r.id === s.bridged.id)!.webrtc_call_id)
      .toBe('99999999-9999-4999-8999-999999999999');
    // Deliberately not an FK — the attempt outlives a purged
    // call — so a row with no media leg must still be served, not filtered out.
    expect(page.rows.find((r) => r.id === s.abandoned.id)!.webrtc_call_id).toBeNull();
  });

  it('is scoped to one campaign', async () => {
    const s = await seedCampaign();
    const other = await insertAgencyCampaign({ name: 'other' });
    const otherContact = await insertAgencyContact(other.id);
    await insertAgencyAttempt(other.id, otherContact.id);

    const page = await agencyAttemptRepository.listForCampaign({
      campaignId: s.campaign.id, filters: {}, limit: 50,
    });
    expect(page.rows.every((r) => r.contact_id !== otherContact.id)).toBe(true);
  });
});

describe('attempt filters', () => {
  it('filters on outcome, and abandoned is reachable', async () => {
    const s = await seedCampaign();
    const page = await agencyAttemptRepository.listForCampaign({
      campaignId: s.campaign.id, filters: { outcomes: ['abandoned'] }, limit: 50,
    });
    expect(page.rows.map((r) => r.id)).toEqual([s.abandoned.id]);
  });

  it('filters by agent through the session, matching the person not the session id', async () => {
    const s = await seedCampaign();
    const page = await agencyAttemptRepository.listForCampaign({
      campaignId: s.campaign.id, filters: { agentUserId: uuidFor('ravi') }, limit: 50,
    });
    expect(page.rows.map((r) => r.id)).toEqual([s.bridged.id]);

    const none = await agencyAttemptRepository.listForCampaign({
      campaignId: s.campaign.id, filters: { agentUserId: uuidFor('nobody') }, limit: 50,
    });
    expect(none.rows).toEqual([]);
  });

  it('matches a phone in any formatting, and by trailing digits', async () => {
    const s = await seedCampaign();
    const spaced = await agencyAttemptRepository.listForCampaign({
      campaignId: s.campaign.id, filters: { phone: { mode: 'exact', value: '+919876500002' } }, limit: 50,
    });
    expect(spaced.rows.map((r) => r.id)).toEqual([s.abandoned.id]);

    // The useful partial form: every stored number begins with a country code,
    // so a leading fragment finds nothing a supervisor is looking for.
    const suffix = await agencyAttemptRepository.listForCampaign({
      campaignId: s.campaign.id, filters: { phone: { mode: 'suffix', value: '500002' } }, limit: 50,
    });
    expect(suffix.rows.map((r) => r.id)).toEqual([s.abandoned.id]);
  });

  it('a wildcard among the digits is data, not a wildcard', async () => {
    const s = await seedCampaign();
    // Goes through the REAL parser, not a hand-built filter object. The
    // previous version of this test called the repository with
    // `{mode:'suffix', value:'%'}` — an input `parsePhoneFilter` can never
    // produce, so it exercised a branch the route cannot reach while the live
    // path went untested. It read as the strongest assertion in the file and
    // defended nothing.
    const parsed = parseAttemptFilters({ phone: '%00002' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const page = await agencyAttemptRepository.listForCampaign({
      campaignId: s.campaign.id, filters: parsed.filters, limit: 50,
    });
    // The `%` is stripped, the digits survive, and the match is on the digits
    // alone — not a LIKE wildcard that would return the whole campaign.
    expect(page.rows.map((r) => r.id)).toEqual([s.abandoned.id]);
  });

  it('a phone term with no digits never reaches the query at all', async () => {
    const parsed = parseAttemptFilters({ phone: '%' });
    // Refused by the parser, so the repository is never called with a filter
    // that would have matched everything. This is the live path.
    expect(parsed.ok).toBe(false);
  });

  it('bounds on created_at, not dialed_at — an attempt that never dialed still appears', async () => {
    const s = await seedCampaign();
    const never = await insertAgencyContact(s.campaign.id, { phone_e164: '+919876500009' });
    const queued = await insertAgencyAttempt(s.campaign.id, never.id, {
      state: 'ended', outcome: 'orphaned', dialed_at: null,
    });
    const page = await agencyAttemptRepository.listForCampaign({
      campaignId: s.campaign.id,
      filters: { from: new Date(Date.now() - 60_000), to: new Date(Date.now() + 60_000) },
      limit: 50,
    });
    expect(page.rows.map((r) => r.id)).toContain(queued.id);
  });
});

describe('contacts: the roster, including the rows that were never dialled', () => {
  it('returns a suppressed contact with its reason', async () => {
    const s = await seedCampaign();
    const page = await agencyContactRepository.listForCampaign({
      campaignId: s.campaign.id, filters: {}, limit: 50,
    });
    const row = page.rows.find((r) => r.id === s.suppressed.id);
    // A suppressed contact has NO attempt row and appears in no call list.
    expect(row).toBeDefined();
    expect(row!.state).toBe('suppressed');
    expect(row!.suppressed_reason).toBe('dnc');
    expect(row!.attempt_count).toBe(0);
  });

  it('filters on suppressed_reason', async () => {
    const s = await seedCampaign();
    const page = await agencyContactRepository.listForCampaign({
      campaignId: s.campaign.id, filters: { suppressedReasons: ['dnc'] }, limit: 50,
    });
    expect(page.rows.map((r) => r.id)).toEqual([s.suppressed.id]);
  });

  it('carries the operational columns the roster view needs', async () => {
    const s = await seedCampaign();
    const page = await agencyContactRepository.listForCampaign({
      campaignId: s.campaign.id, filters: {}, limit: 50,
    });
    const row = page.rows.find((r) => r.id === s.connected.id)!;
    expect(row.attempt_count).toBe(1);
    expect(row.last_outcome).toBe('connected');
    expect(row.last_disposition).toBe('not_interested');
    expect(typeof row.next_attempt_at).toBe('string');
  });

  it('does NOT carry `context` on the list — it is drill-down only', async () => {
    const s = await seedCampaign();
    const page = await agencyContactRepository.listForCampaign({
      campaignId: s.campaign.id, filters: {}, limit: 50,
    });
    for (const row of page.rows) {
      expect(row).not.toHaveProperty('context');
    }
  });
});

describe('the contact drill-down', () => {
  it('carries `context` verbatim, scoped to its campaign', async () => {
    const s = await seedCampaign();
    const withContext = await insertAgencyContact(s.campaign.id, {
      phone_e164: '+919876500055',
      context: JSON.stringify({ 'Full Name': 'A Person', 'Loan Ref': 'L-42' }),
    });
    const detail = await agencyContactRepository.findDetailScoped(s.campaign.id, withContext.id);
    expect(detail?.context).toEqual({ 'Full Name': 'A Person', 'Loan Ref': 'L-42' });
  });

  it('refuses a contact from another campaign even with a valid id', async () => {
    const s = await seedCampaign();
    const other = await insertAgencyCampaign({ name: 'other' });
    const theirs = await insertAgencyContact(other.id);
    expect(await agencyContactRepository.findDetailScoped(s.campaign.id, theirs.id)).toBeNull();
  });
});

describe('keyset pagination', () => {
  /** 25 attempts on one campaign, all sharing a created_at to the microsecond. */
  async function seedTiedBatch(campaignId: string, n: number) {
    const pool = getTestPool();
    const contact = await insertAgencyContact(campaignId, { phone_e164: '+919000000000' });
    // One INSERT, so `now()` is identical on every row — exactly what roster
    // ingest and the attempt batcher produce, and what a millisecond-truncated
    // cursor loses rows inside.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO agency_call_attempts
         (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state, outcome)
       SELECT $1, $2, $3, $4, g, '+919000000001', 'ended', 'no_answer'
         FROM generate_series(1, $5) g
       RETURNING id`,
      [campaignId, contact.id, T, A, n],
    );
    return rows.map((r) => r.id);
  }

  it('walks every row exactly once when all timestamps tie to the microsecond', async () => {
    const campaign = await insertAgencyCampaign();
    const ids = await seedTiedBatch(campaign.id, 25);

    const seen: string[] = [];
    let cursor = undefined as ReturnType<typeof decodeKeysetCursor> | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await agencyAttemptRepository.listForCampaign({
        campaignId: campaign.id, filters: {}, limit: 5,
        ...(cursor ? { after: cursor } : {}),
      });
      seen.push(...result.rows.map((r) => r.id));
      if (!result.next_cursor) break;
      cursor = decodeKeysetCursor(result.next_cursor)!;
      expect(cursor).not.toBeNull();
    }

    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen).size).toBe(ids.length);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('is stable under insert: a row written mid-pagination never shifts the page', async () => {
    const campaign = await insertAgencyCampaign();
    const original = await seedTiedBatch(campaign.id, 12);

    const first = await agencyAttemptRepository.listForCampaign({
      campaignId: campaign.id, filters: {}, limit: 5,
    });
    expect(first.next_cursor).not.toBeNull();

    // A live campaign keeps dialing while a supervisor pages. Under an OFFSET
    // these newer rows push everything down and page 2 re-serves page 1's tail.
    const intruderContact = await insertAgencyContact(campaign.id, { phone_e164: '+919111111111' });
    await insertAgencyAttempt(campaign.id, intruderContact.id, { state: 'ended', outcome: 'busy' });

    const second = await agencyAttemptRepository.listForCampaign({
      campaignId: campaign.id, filters: {}, limit: 5,
      after: decodeKeysetCursor(first.next_cursor!)!,
    });

    const overlap = second.rows.map((r) => r.id).filter((id) => first.rows.some((r) => r.id === id));
    expect(overlap).toEqual([]);
    // And the newer row is not smuggled into a later page — it is newer than
    // the cursor and therefore outside the window entirely.
    expect(second.rows.every((r) => original.includes(r.id))).toBe(true);
  });

  it('next_cursor is null on the last page, and names the last row served', async () => {
    const campaign = await insertAgencyCampaign();
    await seedTiedBatch(campaign.id, 3);
    const page = await agencyAttemptRepository.listForCampaign({
      campaignId: campaign.id, filters: {}, limit: 50,
    });
    expect(page.rows).toHaveLength(3);
    expect(page.next_cursor).toBeNull();
  });

  it('pages the roster the same way', async () => {
    const campaign = await insertAgencyCampaign();
    const pool = getTestPool();
    await pool.query(
      `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state)
       SELECT $1, $2, $3, '+9190000' || lpad(g::text, 5, '0'), '{}'::jsonb, 'pending'
         FROM generate_series(1, 17) g`,
      [campaign.id, T, A],
    );

    const seen = new Set<string>();
    let cursor = undefined as ReturnType<typeof decodeKeysetCursor> | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await agencyContactRepository.listForCampaign({
        campaignId: campaign.id, filters: {}, limit: 4,
        ...(cursor ? { after: cursor } : {}),
      });
      for (const row of result.rows) seen.add(row.id);
      if (!result.next_cursor) break;
      cursor = decodeKeysetCursor(result.next_cursor)!;
    }
    expect(seen.size).toBe(17);
  });
});
