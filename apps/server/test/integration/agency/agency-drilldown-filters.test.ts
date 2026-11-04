import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { uuidFor } from '../setup/factories.js';

/*
 * The insights drill-downs (docs/insights.md, WS F): every number on the Insights tab opens a
 * list, and the list's `total` must equal the number clicked. These run the new filters and
 * the opt-in total against real Postgres and check three things for each:
 *
 *  1. the total equals the count computed DIRECTLY in SQL, with the bucket rule spelled out
 *     here independently of `drilldown-sql.ts` (a second spelling on purpose: the test is
 *     the reader's check that the shared one says what the docs say);
 *  2. the total equals the number of rows the keyset pages yield when walked to the end, so
 *     the count and the list cannot be of different sets;
 *  3. the total is the number this seed was built to produce (a literal), so a predicate
 *     that is wrong in the same way in both spellings is still caught.
 *
 * Then the plans: the predicates must be servable by the 0011 read indexes on a large
 * campaign. A seeded table this small would plan a sequential scan whatever the predicate, so
 * the plan cases switch sequential scans off for one transaction and assert the index the
 * planner reaches for. That proves the predicate is index-shaped; the 1M-row timings are in
 * the report. No ANALYZE / VACUUM here (shared test database).
 */

/** Every statement the repositories send, so a plan case can EXPLAIN exactly that SQL. */
const sent: Array<{ sql: string; values: unknown[] }> = [];
/** When set, the repositories' statements run on this client (one open transaction). */
let inTransaction: { query: (sql: string, values: unknown[]) => Promise<unknown> } | null = null;
vi.mock('@magick-agency/db', () => ({
  getPool: () => ({
    query: (sql: string, values: unknown[]) => {
      sent.push({ sql, values });
      return inTransaction ? inTransaction.query(sql, values) : getTestPool().query(sql, values);
    },
  }),
}));

const { insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession } =
  await import('./agency-factories.js');
const { agencyAttemptRepository, agencyContactRepository } =
  await import('../../../src/db/repositories/agency.repository.js');
const { parseAttemptFilters, parseContactFilters } = await import('../../../src/agency/spine-filters.js');
const { callbackCodes } = await import('../../../src/db/repositories/agency/assignment-sql.js');

const CATALOG = [
  { code: 'ptp', label: 'Promise to pay', requires_datetime: false },
  { code: 'call_back', label: 'Call back later', requires_datetime: true },
];
const CODES = callbackCodes(CATALOG as never);

const HOUR = 3_600_000;
const T0 = new Date('2026-10-01T09:00:00Z');
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);
const PAST = () => new Date(Date.now() - 2 * HOUR);
const FUTURE = () => new Date(Date.now() + 2 * HOUR);

const U1 = uuidFor('drill-agent-1');
const U2 = uuidFor('drill-agent-2');

beforeEach(async () => {
  await truncateAll();
  sent.length = 0;
});

afterAll(async () => {
  await closeTestPool();
});

/**
 * One campaign whose contacts land in every bucket, and whose attempts cover every attempt
 * slice, with the expected counts written next to the rows that make them.
 */
async function seed() {
  const campaign = await insertAgencyCampaign({
    status: 'running', disposition_catalog: JSON.stringify(CATALOG),
  });
  const s1 = await insertAgentSession(campaign.id, { agent_user_id: U1 });
  const s2 = await insertAgentSession(campaign.id, { agent_user_id: U2 });
  // A second session of U1 on ANOTHER campaign: its attempts must not count as U1's here.
  const other = await insertAgencyCampaign({ name: 'other' });
  // Left (one live session per agent per tenant, `uq_agency_agent_live_tenant`).
  const sOther = await insertAgentSession(other.id, { agent_user_id: U1, state: 'offline', left_at: at(-1) });

  const contact = (o: Record<string, unknown>) => insertAgencyContact(campaign.id, o);
  // waiting=due_now (2): due, never written up; and a callback whose time has come.
  const due = await contact({ state: 'pending', next_attempt_at: PAST() });
  const dueCallback = await contact({
    state: 'pending', next_attempt_at: PAST(), last_disposition: 'call_back', last_outcome: 'connected',
    attempt_count: 1,
  });
  // waiting=callback (1): booked for later, and that call is still the latest outcome.
  const callback = await contact({
    state: 'pending', next_attempt_at: FUTURE(), last_disposition: 'call_back', last_outcome: 'connected',
    attempt_count: 1, assigned_user_id: U1, assigned_at: new Date(),
  });
  // waiting=retry (3): a callback dialled and NOT reached (no longer a callback, isCallbackSql),
  // a retry never written up (last_disposition NULL: the NOT-COALESCE case), and a ptp.
  const callbackNotReached = await contact({
    state: 'pending', next_attempt_at: FUTURE(), last_disposition: 'call_back', last_outcome: 'no_answer',
    attempt_count: 2,
  });
  const retryNull = await contact({
    state: 'pending', next_attempt_at: FUTURE(), last_outcome: 'busy', attempt_count: 1, assigned_user_id: U1, assigned_at: new Date(),
  });
  const retryPtp = await contact({
    state: 'pending', next_attempt_at: FUTURE(), last_disposition: 'ptp', last_outcome: 'connected',
    attempt_count: 1,
  });
  // Not waiting: on a call, finished, suppressed (a past next_attempt_at must not make them due).
  const onCall = await contact({ state: 'in_flight', next_attempt_at: PAST() });
  const completed = await contact({ state: 'completed', next_attempt_at: PAST(), last_outcome: 'connected', attempt_count: 1 });
  const dnc = await contact({ state: 'suppressed', suppressed_reason: 'dnc', next_attempt_at: PAST() });
  // Another campaign's due contact: never in this campaign's counts.
  await insertAgencyContact(other.id, { state: 'pending', next_attempt_at: PAST() });

  const attempt = (contactId: string, o: Record<string, unknown>) =>
    insertAgencyAttempt(campaign.id, contactId, { state: 'ended', ...o });
  // Dials placed (dialed_at set) drive `dials_placed` through 0011's trigger, so `attempted`
  // is exercised the way production writes it. Window under test: [at(0), at(5)).
  const aFrom = await attempt(completed.id, {
    attempt_number: 1, dialed_at: at(0), outcome: 'connected', disposition_code: 'ptp',
    reserved_agent_id: s1.id, caller_id: '+919000000001',
  });
  const aNoAnswer = await attempt(callbackNotReached.id, {
    attempt_number: 1, dialed_at: at(1), outcome: 'no_answer', caller_id: '+919000000002',
  });
  const aRedial = await attempt(completed.id, {
    attempt_number: 2, dialed_at: at(2), outcome: 'connected', redial_number: 1, redial_of_attempt_id: aFrom.id,
    reserved_agent_id: s1.id, caller_id: '+919000000001',
  });
  const aManual = await attempt(retryNull.id, {
    attempt_number: 1, dialed_at: at(3), outcome: 'busy', agent_manual: true, reserved_agent_id: s2.id,
    caller_id: '+919000000001',
  });
  const aReopened = await attempt(retryPtp.id, {
    attempt_number: 1, dialed_at: at(4.5), outcome: 'connected', agent_reopened: true, disposition_code: 'ptp',
    reserved_agent_id: s1.id, caller_id: '+919000000002',
  });
  // Exactly at the exclusive end: outside [at(0), at(5)).
  const aAtTo = await attempt(callback.id, {
    attempt_number: 1, dialed_at: at(5), outcome: 'connected', disposition_code: 'call_back',
    reserved_agent_id: s1.id, caller_id: '+919000000001',
  });
  // Never placed: created in the window, no dialed_at. In no dialled count, and its contact
  // (`dueCallback` has no other attempt) stays NOT attempted despite the attempt row.
  const aNeverPlaced = await attempt(dueCallback.id, {
    attempt_number: 1, outcome: 'orphaned', created_at: at(1),
  });
  // Another campaign's dial in the window, by U1 on their other session.
  const otherContact = await insertAgencyContact(other.id);
  await insertAgencyAttempt(other.id, otherContact.id, {
    state: 'ended', dialed_at: at(1), reserved_agent_id: sOther.id, outcome: 'connected',
  });

  return {
    campaign, s1, s2,
    contacts: { due, dueCallback, callback, callbackNotReached, retryNull, retryPtp, onCall, completed, dnc },
    attempts: { aFrom, aNoAnswer, aRedial, aManual, aReopened, aAtTo, aNeverPlaced },
  };
}

/** Walk every keyset page (small pages, so the cursor is exercised) and collect the ids. */
async function walkContacts(campaignId: string, query: Record<string, unknown>): Promise<string[]> {
  const parsed = parseContactFilters(query);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const ids: string[] = [];
  let after: { at: string; id: string } | undefined;
  const { decodeKeysetCursor } = await import('@magick-agency/domain/keyset-cursor');
  for (;;) {
    const page = await agencyContactRepository.listForCampaign({
      campaignId, filters: parsed.filters, callbackCodes: CODES, limit: 2, ...(after ? { after } : {}),
    });
    ids.push(...page.rows.map((r) => r.id));
    if (!page.next_cursor) return ids;
    after = decodeKeysetCursor(page.next_cursor)!;
  }
}

async function walkAttempts(campaignId: string, query: Record<string, unknown>): Promise<string[]> {
  const parsed = parseAttemptFilters(query);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  const ids: string[] = [];
  let after: { at: string; id: string } | undefined;
  const { decodeKeysetCursor } = await import('@magick-agency/domain/keyset-cursor');
  for (;;) {
    const page = await agencyAttemptRepository.listForCampaign({
      campaignId, filters: parsed.filters, limit: 2, ...(after ? { after } : {}),
    });
    ids.push(...page.rows.map((r) => r.id));
    if (!page.next_cursor) return ids;
    after = decodeKeysetCursor(page.next_cursor)!;
  }
}

async function contactTotal(campaignId: string, query: Record<string, unknown>): Promise<number> {
  const parsed = parseContactFilters(query);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return agencyContactRepository.countListed({ campaignId, filters: parsed.filters, callbackCodes: CODES });
}

async function attemptTotal(campaignId: string, query: Record<string, unknown>): Promise<number> {
  const parsed = parseAttemptFilters(query);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return agencyAttemptRepository.countListed({ campaignId, filters: parsed.filters });
}

async function direct(sql: string, values: unknown[]): Promise<number> {
  const { rows } = await getTestPool().query<{ n: string }>(sql, values);
  return Number(rows[0]!.n);
}

describe('contacts: waiting and attempted, total = direct SQL = rows listed', () => {
  it('waiting=due_now: pending and next_attempt_at <= now, a due callback included', async () => {
    const s = await seed();
    const expected = await direct(
      `SELECT count(*) AS n FROM agency_contacts
        WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at <= now()`,
      [s.campaign.id],
    );
    const total = await contactTotal(s.campaign.id, { waiting: 'due_now' });
    const listed = await walkContacts(s.campaign.id, { waiting: 'due_now' });
    expect(expected).toBe(2);
    expect(total).toBe(expected);
    expect(listed.sort()).toEqual([s.contacts.due.id, s.contacts.dueCallback.id].sort());
  });

  it('waiting=callback: pending, booked for later, the callback call still the latest outcome', async () => {
    const s = await seed();
    const expected = await direct(
      `SELECT count(*) AS n FROM agency_contacts
        WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at > now()
          AND last_disposition = ANY($2::text[]) AND last_outcome = 'connected'`,
      [s.campaign.id, CODES],
    );
    const total = await contactTotal(s.campaign.id, { waiting: 'callback' });
    const listed = await walkContacts(s.campaign.id, { waiting: 'callback' });
    expect(expected).toBe(1);
    expect(total).toBe(expected);
    expect(listed).toEqual([s.contacts.callback.id]);
  });

  it('waiting=retry: pending, later, and not a callback — a never-written-up contact included', async () => {
    const s = await seed();
    const expected = await direct(
      `SELECT count(*) AS n FROM agency_contacts
        WHERE campaign_id = $1 AND state = 'pending' AND next_attempt_at > now()
          AND NOT (last_disposition IS NOT NULL AND last_disposition = ANY($2::text[])
                   AND last_outcome IS NOT DISTINCT FROM 'connected')`,
      [s.campaign.id, CODES],
    );
    const total = await contactTotal(s.campaign.id, { waiting: 'retry' });
    const listed = await walkContacts(s.campaign.id, { waiting: 'retry' });
    expect(expected).toBe(3);
    expect(total).toBe(expected);
    expect(listed.sort()).toEqual(
      [s.contacts.callbackNotReached.id, s.contacts.retryNull.id, s.contacts.retryPtp.id].sort(),
    );
  });

  it('due now includes a contact due at exactly now(): `<=`, not `<`', async () => {
    // One transaction, so the seed's now() and the count's now() are the same instant.
    const campaign = await insertAgencyCampaign({ status: 'running', disposition_catalog: JSON.stringify(CATALOG) });
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      inTransaction = client as never;
      await client.query(
        `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, state, next_attempt_at)
         VALUES ($1, $2, $3, '+919800000001', 'pending', now())`,
        [campaign.id, campaign.tenant_id, campaign.account_id],
      );
      expect(await contactTotal(campaign.id, { waiting: 'due_now' })).toBe(1);
      expect(await contactTotal(campaign.id, { waiting: 'retry' })).toBe(0);
    } finally {
      inTransaction = null;
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('the three waiting buckets partition the pending contacts', async () => {
    const s = await seed();
    const pending = await direct(
      `SELECT count(*) AS n FROM agency_contacts WHERE campaign_id = $1 AND state = 'pending'`,
      [s.campaign.id],
    );
    const sum = (await contactTotal(s.campaign.id, { waiting: 'due_now' }))
      + (await contactTotal(s.campaign.id, { waiting: 'retry' }))
      + (await contactTotal(s.campaign.id, { waiting: 'callback' }));
    expect(sum).toBe(pending);
    expect(pending).toBe(6);
  });

  it('attempted=1|0 is dials_placed > 0 | = 0, kept by the 0011 trigger from placed dials', async () => {
    const s = await seed();
    const attempted = await direct(
      `SELECT count(*) AS n FROM agency_contacts c
        WHERE c.campaign_id = $1
          AND EXISTS (SELECT 1 FROM agency_call_attempts a WHERE a.contact_id = c.id AND a.dialed_at IS NOT NULL)`,
      [s.campaign.id],
    );
    const all = await direct(`SELECT count(*) AS n FROM agency_contacts WHERE campaign_id = $1`, [s.campaign.id]);
    expect(attempted).toBe(5);
    expect(await contactTotal(s.campaign.id, { attempted: '1' })).toBe(attempted);
    expect(await contactTotal(s.campaign.id, { attempted: '0' })).toBe(all - attempted);
    const listed = await walkContacts(s.campaign.id, { attempted: '1' });
    expect(listed.length).toBe(attempted);
    // An attempt row that was never placed does not make its contact attempted.
    const never = await walkContacts(s.campaign.id, { attempted: '0' });
    expect(never).toContain(s.contacts.dueCallback.id);
  });

  it('combines with the existing filters, and the total follows them', async () => {
    const s = await seed();
    // Callbacks and retries held by U1: the allocation table's per-agent drill-down.
    expect(await contactTotal(s.campaign.id, { state: 'pending', waiting: 'callback', assigned_to: U1 })).toBe(1);
    expect(await contactTotal(s.campaign.id, { waiting: 'retry', assigned_to: U1 })).toBe(1);
    expect(await contactTotal(s.campaign.id, { state: 'pending', attempted: '0' })).toBe(
      await direct(
        `SELECT count(*) AS n FROM agency_contacts WHERE campaign_id = $1 AND state = 'pending' AND dials_placed = 0`,
        [s.campaign.id],
      ),
    );
    // No filter: the whole roster, this campaign only.
    expect(await contactTotal(s.campaign.id, {})).toBe(9);
  });
});

describe('attempts: the drill-down slices, total = direct SQL = rows listed', () => {
  const WINDOW = { dialed_from: '2026-10-01T09:00:00Z', dialed_to: '2026-10-01T14:00:00Z' };

  it('dialed_from/dialed_to are half-open on dialed_at and count placed dials only', async () => {
    const s = await seed();
    const expected = await direct(
      `SELECT count(*) AS n FROM agency_call_attempts
        WHERE campaign_id = $1 AND dialed_at >= $2 AND dialed_at < $3`,
      [s.campaign.id, WINDOW.dialed_from, WINDOW.dialed_to],
    );
    const total = await attemptTotal(s.campaign.id, WINDOW);
    const listed = await walkAttempts(s.campaign.id, WINDOW);
    expect(expected).toBe(5);
    expect(total).toBe(expected);
    expect(listed).toHaveLength(expected);
    // The inclusive start is in, the exclusive end and the never-placed attempt are not.
    expect(listed).toContain(s.attempts.aFrom.id);
    expect(listed).not.toContain(s.attempts.aAtTo.id);
    expect(listed).not.toContain(s.attempts.aNeverPlaced.id);
  });

  it('the existing from/to keep their meaning: inclusive, on created_at, unplaced attempts included', async () => {
    const s = await seed();
    // aNeverPlaced was created at at(1); every other attempt was created now().
    const total = await attemptTotal(s.campaign.id, { from: '2026-10-01T10:00:00Z', to: '2026-10-01T10:00:00Z' });
    expect(total).toBe(1);
  });

  it('placed=1 with no window: every placed dial of the campaign (the lifetime count)', async () => {
    const s = await seed();
    const expected = await direct(
      `SELECT count(*) AS n FROM agency_call_attempts WHERE campaign_id = $1 AND dialed_at IS NOT NULL`,
      [s.campaign.id],
    );
    expect(expected).toBe(6);
    expect(await attemptTotal(s.campaign.id, { placed: '1' })).toBe(expected);
    expect(await attemptTotal(s.campaign.id, { placed: '0' })).toBe(1);
  });

  it.each([
    ['redial', { redial: '1' }, `redial_number > 0`, 1],
    ['agent_manual', { agent_manual: '1' }, `agent_manual`, 1],
    ['agent_reopened', { agent_reopened: '1' }, `agent_reopened`, 1],
    ['caller_id', { caller_id: '+919000000001' }, `caller_id = '+919000000001'`, 3],
    ['outcome', { outcome: 'connected' }, `outcome = 'connected'`, 3],
    ['disposition_code', { disposition_code: 'ptp' }, `disposition_code = 'ptp'`, 2],
  ] as const)('%s within the window', async (_name, filter, sqlRule, literal) => {
    const s = await seed();
    const query = { ...WINDOW, ...filter };
    const expected = await direct(
      `SELECT count(*) AS n FROM agency_call_attempts
        WHERE campaign_id = $1 AND dialed_at >= $2 AND dialed_at < $3 AND ${sqlRule}`,
      [s.campaign.id, WINDOW.dialed_from, WINDOW.dialed_to],
    );
    expect(expected).toBe(literal);
    expect(await attemptTotal(s.campaign.id, query)).toBe(expected);
    expect(await walkAttempts(s.campaign.id, query)).toHaveLength(expected);
  });

  it('agent_user_id resolves through reserved_agent_id → the session user, on this campaign only', async () => {
    const s = await seed();
    const query = { ...WINDOW, agent_user_id: U1 };
    const expected = await direct(
      `SELECT count(*) AS n FROM agency_call_attempts a
         JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
        WHERE a.campaign_id = $1 AND s.agent_user_id = $2 AND a.dialed_at >= $3 AND a.dialed_at < $4`,
      [s.campaign.id, U1, WINDOW.dialed_from, WINDOW.dialed_to],
    );
    expect(expected).toBe(3);
    expect(await attemptTotal(s.campaign.id, query)).toBe(expected);
    expect(await walkAttempts(s.campaign.id, query)).toHaveLength(expected);
    // U1's dial on their other campaign's session is not this campaign's.
    expect(await attemptTotal(s.campaign.id, { placed: '1', agent_user_id: U1 })).toBe(4);
  });

  it('the total is the whole filtered list, not what is left after a cursor', async () => {
    const s = await seed();
    const parsed = parseAttemptFilters(WINDOW);
    if (!parsed.ok) throw new Error('parse');
    const first = await agencyAttemptRepository.listForCampaign({ campaignId: s.campaign.id, filters: parsed.filters, limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(await attemptTotal(s.campaign.id, WINDOW)).toBe(5);
  });
});

describe('plans: index-shaped predicates (sequential scans off for one transaction)', () => {
  async function planOf(sql: string, values: unknown[]): Promise<string> {
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, values);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  /** The last statement the repository sent, EXPLAINed. */
  async function planOfLast(): Promise<string> {
    const last = sent[sent.length - 1]!;
    return planOf(last.sql, last.values);
  }

  it.each(['due_now', 'retry', 'callback'] as const)(
    'contacts total, waiting=%s: idx_agency_contacts_insights on (campaign_id, state)',
    async (waiting) => {
      const s = await seed();
      await contactTotal(s.campaign.id, { waiting });
      const plan = await planOfLast();
      expect(plan).toContain('idx_agency_contacts_insights');
      // The bucket's `state = 'pending'` is an index condition, not a filter over the campaign.
      expect(plan).toMatch(/Index Cond: \(\(campaign_id = [^\n]*\) AND \(\(?state\)?(::text)? = 'pending'/);
    },
  );

  it('contacts total, attempted=1: idx_agency_contacts_insights on the campaign prefix', async () => {
    const s = await seed();
    await contactTotal(s.campaign.id, { attempted: '1' });
    expect(await planOfLast()).toContain('idx_agency_contacts_insights');
  });

  it('attempts total, dialed window: idx_agency_attempts_campaign_dialed range scan', async () => {
    const s = await seed();
    await attemptTotal(s.campaign.id, { dialed_from: '2026-10-01T09:00:00Z', dialed_to: '2026-10-01T14:00:00Z', redial: '1' });
    const plan = await planOfLast();
    expect(plan).toContain('idx_agency_attempts_campaign_dialed');
    expect(plan).toMatch(/Index Cond: \(\(campaign_id = .*\) AND \(dialed_at >= .*\) AND \(dialed_at < /);
  });
});
