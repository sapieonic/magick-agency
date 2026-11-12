import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, insertAccount, insertTenant } from '../setup/factories.js';
import { insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession } from './agency-factories.js';

/**
 * The insights as-of-now reads (`insights-reads.repository.ts`, `insights-sql.ts`) on real
 * Postgres: the roster partition and its reconciliation, the allocation per owner, the pace, the
 * contacts on DNC across the three scopes, the upload history, and the plans of the statements a
 * 1M-contact campaign makes (EXPLAIN on seeded tables).
 *
 * Plans: never a bare ANALYZE (it leaves statistics behind for later files' plan tests, the 0011
 * migration test's rule); a case whose plan depends on its seed's size ANALYZEs inside the plan's
 * rolled-back transaction instead (`plan(…, analyze)`). The plan
 * cases price sequential and bitmap scans out with SET LOCAL inside a rolled-back transaction, so
 * what they show is which index serves the statement and
 * whether it covers it (every column the scan outputs is in the index; `EXPLAIN VERBOSE`). Mutation-checked: dropping `waitingRetrySql`'s callback
 * exclusion reds the partition case (the buckets overlap and no longer sum to the total), and
 * reading a column outside the index (`phone_e164`) in the roster statement reds its plan case.
 */

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const repo = await import('../../../src/db/repositories/agency.repository.js');
const { localDayEnd } = await import('../../../src/agency/calling-hours.js');

const CALLBACK = ['callback'];
const SUCCESS = ['interested'];
const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs);

async function plan(
  sql: string,
  values: unknown[],
  settings: string[] = ['enable_seqscan = off', 'enable_bitmapscan = off'],
  verbose = false,
  analyze: string[] = [],
): Promise<string> {
  const client: PoolClient = await getTestPool().connect();
  try {
    await client.query('BEGIN');
    for (const s of settings) await client.query(`SET LOCAL ${s}`);
    // ANALYZE inside the transaction: the plan sees statistics of this test's own seed, and the
    // ROLLBACK discards them, so no later file plans on what this one left behind.
    for (const t of analyze) await client.query(`ANALYZE ${t}`);
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN (COSTS OFF${verbose ? ', VERBOSE' : ''}) ${sql}`, values);
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function campaign(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = await insertAgencyCampaign({
    disposition_catalog: JSON.stringify([
      { code: 'interested', label: 'Interested', is_success: true, terminal: true },
      { code: 'callback', label: 'Call back', requires_datetime: true },
    ]),
    ...overrides,
  });
  return row.id as string;
}

const contact = (campaignId: string, o: Record<string, unknown>) =>
  insertAgencyContact(campaignId, o['assigned_user_id'] ? { assigned_at: new Date(), ...o } : o) as Promise<{ id: string }>;

/** One contact in each bucket (and the edge each predicate guards), with the expected bucket. */
async function seedEveryBucket(id: string, owner: string | null = null): Promise<Record<string, number>> {
  const a = { assigned_user_id: owner };
  // Waiting, due now: never dialled; a retry whose time came; a callback whose time came.
  await contact(id, { ...a, next_attempt_at: at(-HOUR) });
  await contact(id, { ...a, next_attempt_at: at(-HOUR), attempt_count: 1, dials_placed: 1, last_outcome: 'no_answer' });
  await contact(id, { ...a, next_attempt_at: at(-60_000), attempt_count: 1, dials_placed: 2, last_outcome: 'connected', last_disposition: 'callback' });
  // Waiting, retry later; a callback code whose later call went unanswered is a retry, not a callback.
  await contact(id, { ...a, next_attempt_at: at(HOUR), attempt_count: 1, dials_placed: 1, last_outcome: 'busy' });
  await contact(id, { ...a, next_attempt_at: at(HOUR), attempt_count: 2, dials_placed: 3, last_outcome: 'no_answer', last_disposition: 'callback' });
  // Waiting on a callback.
  await contact(id, { ...a, next_attempt_at: at(2 * HOUR), attempt_count: 1, dials_placed: 1, last_outcome: 'connected', last_disposition: 'callback' });
  // On a call (first dial ringing: placed, not yet charged), in wrap-up.
  await contact(id, { ...a, state: 'in_flight', dials_placed: 1 });
  await contact(id, { ...a, state: 'connected', attempt_count: 1, dials_placed: 1 });
  // Finished.
  await contact(id, { ...a, state: 'completed', attempt_count: 1, dials_placed: 1, last_outcome: 'connected', last_disposition: 'interested' });
  await contact(id, { ...a, state: 'exhausted', attempt_count: 3, dials_placed: 5, last_outcome: 'no_answer' });
  // Suppressed: DNC, invalid, attempt limit, manual. A pending row frozen DNC (a pre-fix
  // leftover) is still pending: due now, as the contacts list's `state=pending` shows it.
  await contact(id, { ...a, state: 'suppressed', suppressed_reason: 'dnc', attempt_count: 1, dials_placed: 1 });
  await contact(id, { ...a, state: 'pending', suppressed_reason: 'dnc', next_attempt_at: at(-HOUR) });
  await contact(id, { ...a, state: 'suppressed', suppressed_reason: 'invalid' });
  await contact(id, { ...a, state: 'suppressed', suppressed_reason: 'max_attempts', attempt_count: 4, dials_placed: 4 });
  await contact(id, { ...a, state: 'suppressed', suppressed_reason: 'manual' });
  return {
    waiting_due_now: 4, waiting_retry: 2, waiting_callback: 1, on_call: 1, in_wrapup: 1, completed: 1,
    exhausted: 1, suppressed_dnc: 1, suppressed_invalid: 1, suppressed_other: 2,
  };
}

const rosterInput = (campaignId: string, o: Partial<Parameters<typeof repo.rosterStatement>[0]> = {}) => ({
  campaignId, callbackCodes: CALLBACK, successCodes: SUCCESS, pausedAt: null, windowEndAt: null, ...o,
});

/**
 * The large seeds go with TRUNCATE: the shared `truncateAll` deletes row by row (with every FK
 * check), which takes most of a minute for tens of thousands of rows on a loaded host.
 */
async function dropLargeSeed(): Promise<void> {
  await getTestPool().query('TRUNCATE agency_call_attempts, agency_contacts, dnc_entries CASCADE');
}

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await closeTestPool(); });

describe('the roster partition (insights-sql.ts)', () => {
  it('counts every bucket once; the ten buckets sum to the total; attempts per contact by dials placed', async () => {
    const id = await campaign();
    const expected = await seedEveryBucket(id);
    await seedEveryBucket(await campaign()); // another campaign's contacts count for it alone

    const r = await repo.agencyInsightsReadRepository.roster(rosterInput(id));
    expect(r.buckets).toEqual(expected);
    expect(r.total).toBe(15);
    expect(Object.values(r.buckets).reduce((s, n) => s + n, 0)).toBe(r.total);
    // attempted = dials_placed > 0: the ringing first dial (attempt_count 0) counts.
    expect(r.attempted).toBe(11);
    expect(r.attempts).toEqual({ one: 7, two: 1, three: 1, four_plus: 2 });
    expect(r.dials_placed).toBe(1 + 2 + 1 + 3 + 1 + 1 + 1 + 1 + 5 + 1 + 4);
    // The three waiting buckets sum to the pending count (the principal's rule).
    expect(r.pending).toBe(7);
    expect(r.buckets.waiting_due_now + r.buckets.waiting_retry + r.buckets.waiting_callback).toBe(r.pending);
    expect(r.pending_callbacks).toBe(2);
    expect(r.successes).toBe(1);
    expect(r.unassigned_open).toBe(6); // open = pending and not DNC: what the claims dial
  });

  it('callbacks missed while paused and due before the window ends, cut at the given instants', async () => {
    const id = await campaign();
    const cb = { last_outcome: 'connected', last_disposition: 'callback', attempt_count: 1, dials_placed: 1 };
    await contact(id, { ...cb, next_attempt_at: at(-3 * HOUR) }); // before the pause
    await contact(id, { ...cb, next_attempt_at: at(-HOUR) }); // while paused
    await contact(id, { ...cb, next_attempt_at: at(HOUR) }); // before the window ends
    await contact(id, { ...cb, next_attempt_at: at(5 * HOUR) }); // after it
    await contact(id, { next_attempt_at: at(-HOUR), attempt_count: 1, dials_placed: 1, last_outcome: 'no_answer' }); // not a callback

    const r = await repo.agencyInsightsReadRepository.roster(rosterInput(id, { pausedAt: at(-2 * HOUR), windowEndAt: at(2 * HOUR) }));
    expect(r.callbacks_missed_while_paused).toBe(1);
    expect(r.callbacks_due_before_window_end).toBe(1);
    const none = await repo.agencyInsightsReadRepository.roster(rosterInput(id));
    expect(none.callbacks_missed_while_paused).toBe(0);
    expect(none.callbacks_due_before_window_end).toBe(0);
  });

  /**
   * The coverage cases prove the statement reads only columns `idx_agency_contacts_insights`
   * holds, so an Index Only Scan of it is available on a settled production table. They assert
   * it from `EXPLAIN VERBOSE`, not from which scan the planner chose: that depends on the table's
   * visibility map (a VACUUM on a shared host cannot always mark the pages all-visible) and on
   * statistics earlier files left behind, and both name-based versions of these cases flaked in
   * full runs. The contacts scan's `Output:` is the set of columns it reads from the relation;
   * every one must be in the insights index (key or INCLUDE), and the campaign must be an index
   * condition.
   * (`enable_indexscan = off` cannot isolate the Index Only Scan: on Postgres 16 it disables both.)
   */
  async function insightsIndexColumns(): Promise<Set<string>> {
    const { rows } = await getTestPool().query<{ attname: string }>(
      `SELECT a.attname FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indexrelid = 'idx_agency_contacts_insights'::regclass`,
    );
    return new Set(rows.map((r) => r.attname));
  }

  async function expectCoveredByInsightsIndex(p: string): Promise<void> {
    const lines = p.split('\n');
    // Whichever campaign-prefixed index the planner takes on this test DB's statistics (another
    // file can leave them favouring `idx_agency_contacts_phone_suffix`), the claim is the same:
    // the scan reads nothing the covering index does not hold.
    const at = lines.findIndex((l) => /(Index Only Scan|Index Scan) using \w+ on public\.agency_contacts c\b/.test(l));
    expect(at, p).toBeGreaterThanOrEqual(0);
    const output = lines[at + 1]?.match(/^\s*Output: (.*)$/)?.[1];
    expect(output, p).toBeTruthy();
    // An item is a column or a cast of one, e.g. `(assigned_user_id)::text`: keep the column.
    const read = output!.split(',').map((c) => c.replace(/::[a-z_ ]+/g, '').replace(/[()]/g, '').trim().replace(/^c\./, ''));
    const index = await insightsIndexColumns();
    expect(read.filter((c) => !index.has(c)), p).toEqual([]);
    expect(p).toMatch(/Index Cond: \(c\.campaign_id = /);
    expect(p).not.toMatch(/Seq Scan|Bitmap Heap Scan/);
  }

  it('the roster statement reads only columns idx_agency_contacts_insights holds (an Index Only Scan)', async () => {
    const { text, values } = repo.rosterStatement(rosterInput(randomUUID(), { pausedAt: new Date(), windowEndAt: new Date() }));
    await expectCoveredByInsightsIndex(await plan(text, values, undefined, true));
  });

  it('the allocation statement reads only columns idx_agency_contacts_insights holds too', async () => {
    const { text, values } = repo.allocationStatement({
      campaignId: randomUUID(), callbackCodes: CALLBACK, successCodes: SUCCESS, dayEndAt: new Date(),
    });
    await expectCoveredByInsightsIndex(await plan(text, values, undefined, true));
  });
});

describe('the allocation per owner', () => {
  it('groups by owner; the partition per owner sums to the allocation; callbacks due today end at local midnight', async () => {
    const id = await campaign({ default_timezone: 'Asia/Kolkata' });
    const agent = randomUUID();
    await seedEveryBucket(id, agent);
    await seedEveryBucket(id, null);
    // Asia/Kolkata's day ends at 18:30 UTC, not at UTC midnight: one callback half an hour
    // either side of it.
    const dayEnd = localDayEnd('Asia/Kolkata', new Date())!;
    expect(dayEnd.getUTCHours() * 60 + dayEnd.getUTCMinutes()).toBe(18 * 60 + 30);
    const cb = { assigned_user_id: agent, last_outcome: 'connected', last_disposition: 'callback', attempt_count: 1, dials_placed: 1 };
    const today = new Date(Math.max(dayEnd.getTime() - 30 * 60_000, Date.now() + 60_000));
    await contact(id, { ...cb, next_attempt_at: today });
    await contact(id, { ...cb, next_attempt_at: new Date(dayEnd.getTime() + 30 * 60_000) });

    const rows = await repo.agencyInsightsReadRepository.allocation({
      campaignId: id, callbackCodes: CALLBACK, successCodes: SUCCESS, dayEndAt: dayEnd,
    });
    const mine = rows.find((r) => r.uid === agent)!;
    const pool = rows.find((r) => r.uid === null)!;
    expect(rows).toHaveLength(2);
    expect(mine.allocated).toBe(17);
    expect(pool.allocated).toBe(15);
    for (const r of rows) expect(r.partition_sum).toBe(r.allocated);
    // The seeded callback due in the future (2 h out) may fall either side of local midnight;
    // the two placed around it are fixed: one today, one tomorrow.
    const seededToday = Date.now() + 2 * HOUR < dayEnd.getTime() ? 1 : 0;
    expect(mine.callbacks_due_today).toBe(1 + seededToday);
    expect(pool.callbacks_due_today).toBe(seededToday);
    // Overdue: the seeded callback whose time came (open, due before now).
    expect(mine.callbacks_overdue).toBe(1);
    // DNC is the roster's rule (suppressed for DNC): the pending row frozen DNC is waiting, due
    // now, never DNC, so the allocation's dnc and its link (state=suppressed&suppressed_reason=dnc)
    // are one set.
    expect(mine).toMatchObject({ due_now: 4, waiting_retry: 2, reached: 1, exhausted: 1, successes: 1, dnc: 1 });
  });

  it('localDayEnd: the local day across the UTC midnight boundary (Asia/Kolkata)', () => {
    // 23:30 IST on 4 Nov: the day ends half an hour later.
    expect(localDayEnd('Asia/Kolkata', new Date('2026-11-04T18:00:00Z'))!.toISOString()).toBe('2026-11-04T18:30:00.000Z');
    // 00:30 IST on 5 Nov (still 4 Nov in UTC): the day is the 5th, ending 18:30 UTC on the 5th.
    expect(localDayEnd('Asia/Kolkata', new Date('2026-11-04T19:00:00Z'))!.toISOString()).toBe('2026-11-05T18:30:00.000Z');
    // 05:40 IST on 5 Nov, just past UTC midnight: the same day.
    expect(localDayEnd('Asia/Kolkata', new Date('2026-11-05T00:10:00Z'))!.toISOString()).toBe('2026-11-05T18:30:00.000Z');
    expect(localDayEnd('UTC', new Date('2026-11-04T19:00:00Z'))!.toISOString()).toBe('2026-11-05T00:00:00.000Z');
    expect(localDayEnd('Not/AZone', new Date())).toBeNull();
  });

  /** Drain the rollup's dirty marks (the job's batch, run until the backlog is empty). */
  async function drainRollup(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const r = await repo.agencyInsightsRollupRepository.recomputeBatch(200);
      if (r.picked < 200) return;
    }
  }

  /**
   * The counters as E1 read them before the rollup replaced the query (every attempt of the
   * campaign, by the contact's CURRENT owner), kept here as the oracle the rollup's numbers were
   * checked against. Placed-only on every column (the old overrides column counted an unplaced
   * attempt too; no attempt spends an override before it is placed), newest dial as last activity.
   */
  async function oldCounters(campaignId: string) {
    const { rows } = await getTestPool().query<{ uid: string | null; redials: number; reopened: number; manual: number; overrides: number; last: Date | null }>(
      `SELECT c.assigned_user_id::text AS uid,
              (count(*) FILTER (WHERE a.redial_number > 0 AND a.dialed_at IS NOT NULL))::int AS redials,
              (count(*) FILTER (WHERE a.agent_reopened AND a.dialed_at IS NOT NULL))::int AS reopened,
              (count(*) FILTER (WHERE a.agent_manual AND a.dialed_at IS NOT NULL))::int AS manual,
              (count(*) FILTER (WHERE cardinality(a.override_applied) > 0 AND a.dialed_at IS NOT NULL))::int AS overrides,
              max(a.dialed_at) AS last
         FROM agency_call_attempts a
         JOIN agency_contacts c ON c.id = a.contact_id
        WHERE a.campaign_id = $1::uuid
        GROUP BY 1`, [campaignId]);
    return new Map(rows.map((r) => [r.uid, { redials: r.redials, retries_reopened: r.reopened, retries_manual: r.manual, overrides_used: r.overrides, last_activity_at: r.last }]));
  }

  it('attempt counters from the rollup equal the old per-attempt read where owners dial their own contacts', async () => {
    const id = await campaign({ assignment_mode: 'strict' });
    const agents = [randomUUID(), randomUUID(), randomUUID()];
    // Past shifts (one live session per agent per tenant), and a second shift of agent 0: its dials are agent 0's too.
    const shift = (u: string | undefined) => insertAgentSession(id, { agent_user_id: u, state: 'offline', left_at: new Date() });
    const sessions = await Promise.all(agents.map((u) => shift(u)));
    sessions.push(await shift(agents[0]));
    let minute = 0;
    for (let i = 0; i < 30; i++) {
      const owner = i % agents.length;
      const c = await contact(id, { assigned_user_id: agents[owner], state: 'exhausted' });
      const session = i % 7 === 0 && owner === 0 ? sessions[3]! : sessions[owner]!;
      for (let n = 1; n <= 1 + (i % 4); n++) {
        const t = at(-(40 * 60_000) + (minute++) * 17_000);
        await insertAgencyAttempt(id, c.id, {
          attempt_number: n, state: 'ended', outcome: 'no_answer', dialed_at: t, created_at: t, reserved_agent_id: session.id,
          redial_number: n === 2 && i % 2 === 0 ? 1 : 0,
          agent_reopened: n === 3, agent_manual: n === 4 || i % 5 === 0,
          override_applied: i % 3 === 0 && n === 1 ? ['extra_attempts'] : [],
        });
      }
      // A queued attempt never placed: no counter counts it.
      await insertAgencyAttempt(id, c.id, { attempt_number: 9, state: 'queued', redial_number: 1, agent_manual: true, reserved_agent_id: session.id });
    }
    await drainRollup();

    const fresh = await repo.agencyInsightsReadRepository.allocationAttemptCounters(id);
    const old = await oldCounters(id);
    expect([...fresh.keys()].sort()).toEqual([...old.keys()].sort());
    for (const [uid, want] of old) {
      expect(fresh.get(uid), String(uid)).toEqual(want);
    }
    // Not vacuous: every counter is non-zero for someone.
    const sums = [...fresh.values()].reduce((s, c) => ({
      r: s.r + c.redials, o: s.o + c.retries_reopened, m: s.m + c.retries_manual, v: s.v + c.overrides_used,
    }), { r: 0, o: 0, m: 0, v: 0 });
    expect(Math.min(sums.r, sums.o, sums.m, sums.v)).toBeGreaterThan(0);
  });

  it('attempt counters are the DIALLING agent\'s (the attempts list\'s agent filter), the pool row the dials with no session', async () => {
    const id = await campaign();
    const dialler = randomUUID();
    const s = await insertAgentSession(id, { agent_user_id: dialler });
    // A pool contact (no owner) dialled by an agent, and one dialled with no session.
    const c1 = await contact(id, {});
    const c2 = await contact(id, {});
    const t = at(-HOUR);
    const t2 = new Date(t.getTime() + 1000);
    await insertAgencyAttempt(id, c1.id, { attempt_number: 1, state: 'ended', dialed_at: t, reserved_agent_id: s.id, agent_manual: true });
    await insertAgencyAttempt(id, c1.id, { attempt_number: 2, state: 'ended', dialed_at: t2, reserved_agent_id: s.id, redial_number: 1 });
    await insertAgencyAttempt(id, c2.id, { attempt_number: 1, state: 'ended', dialed_at: t, agent_reopened: true });
    await drainRollup();

    const counters = await repo.agencyInsightsReadRepository.allocationAttemptCounters(id);
    expect(counters.get(dialler)).toEqual({ redials: 1, retries_reopened: 0, retries_manual: 1, overrides_used: 0, last_activity_at: t2 });
    expect(counters.get(null)).toEqual({ redials: 0, retries_reopened: 1, retries_manual: 0, overrides_used: 0, last_activity_at: t });
  });

  it('attempt counters\' plan: the rollup\'s agent rows, and one bucket of the dialled index per agent (never the attempt table)', async () => {
    const id = await campaign();
    const { text, values } = repo.allocationCountersStatement(id);
    const shown = await plan(text, values, undefined, false, ['agency_call_attempts', 'agency_insights_rollup_agents']);
    // The agents table has one index; the attempts are read through a campaign-and-dialed_at
    // index, whichever of the two the statistics favour (the billing index leads with dialed_at).
    expect(shown).toMatch(/Index (Only )?Scan using uq_agency_insights_rollup_agents/);
    expect(shown).toMatch(/Index Scan (Backward )?using idx_agency_attempts_(campaign_dialed|billing)/);
    // Both ends of the agent's newest bucket are in the index condition: one bucket is read.
    const cond = shown.split('\n').find((l) => l.includes('Index Cond:') && l.includes('dialed_at')) ?? '';
    expect(cond).toMatch(/dialed_at >= p\.newest/);
    expect(cond).toMatch(/dialed_at < \(p\.newest \+/);
    expect(shown).not.toMatch(/Seq Scan on agency_call_attempts/);
  });
});

describe('the running headline\'s pace', () => {
  it('dials in the last 15 minutes and contacts finished in the last hour; live attempts', async () => {
    const id = await campaign();
    const done = await contact(id, { state: 'completed' });
    const open = await contact(id, {});
    const live = await contact(id, { state: 'in_flight' });
    await insertAgencyAttempt(id, done.id, { attempt_number: 1, state: 'ended', dialed_at: at(-5 * 60_000) });
    await insertAgencyAttempt(id, done.id, { attempt_number: 2, state: 'ended', dialed_at: at(-40 * 60_000) });
    await insertAgencyAttempt(id, open.id, { attempt_number: 1, state: 'ended', dialed_at: at(-10 * 60_000) });
    await insertAgencyAttempt(id, open.id, { attempt_number: 2, state: 'ended', dialed_at: at(-2 * HOUR) });
    await insertAgencyAttempt(id, live.id, { attempt_number: 1, state: 'ringing', dialed_at: at(-30_000) });

    expect(await repo.agencyInsightsReadRepository.dialPace(id)).toEqual({ dials_15m: 3, finished_1h: 1 });
    expect(await repo.agencyInsightsReadRepository.liveAttempts(id)).toBe(1);
  });

  it('the pace reads the last hour by index, not the campaign\'s whole attempt history', async () => {
    // A campaign with a long history: 5,000 dials over the last month, so the one-hour range is
    // what selects (an empty table makes every index the same price).
    const id = await campaign();
    try {
      await getTestPool().query(
        `WITH c AS (
           INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state)
           SELECT $1, $2, $3, '+91' || lpad(g::text, 10, '0'), '{}'::jsonb, 'exhausted' FROM generate_series(1, 5000) g
           RETURNING id, phone_e164)
         INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state, dialed_at)
         SELECT $1, c.id, $2, $3, 1, '+919000000001', 'ended', now() - make_interval(mins => right(c.phone_e164, 4)::int * 8) FROM c`,
        [id, DEFAULTS.tenantId, DEFAULTS.accountId]);
      const { text, values } = repo.dialPaceStatement(id);
      // Both sides of the join analysed on this seed: the contacts side otherwise plans on whatever
      // statistics earlier files left.
      const p = await plan(text, values, undefined, false, ['agency_call_attempts', 'agency_contacts']);
      // The hour is the index condition, beside the campaign: idx_agency_attempts_campaign_dialed
      // (campaign, dialed_at), or idx_agency_attempts_billing (dialed_at, campaign) when this
      // test DB's few campaigns make the cross-campaign range as cheap; never a scan of the
      // campaign's history filtered afterwards.
      expect(p).toMatch(/Index (Only )?Scan using idx_agency_attempts_(campaign_dialed|billing) on agency_call_attempts a/);
      expect(p).toMatch(/Index Cond: \(.*dialed_at > \(now\(\) - .*campaign_id = |Index Cond: \(\(campaign_id = .*\) AND \(dialed_at > /);
    } finally {
      await dropLargeSeed();
    }
  });
});

describe('contacts on DNC (the pre-dial gate\'s scopes)', () => {
  async function dnc(tenantId: string, phone: string, scope: { account_id?: string | null; campaign_id?: string | null }) {
    await getTestPool().query(
      `INSERT INTO dnc_entries (tenant_id, account_id, campaign_id, phone_e164, source) VALUES ($1, $2, $3, $4, 'api')`,
      [tenantId, scope.account_id ?? null, scope.campaign_id ?? null, phone]);
  }

  it('counts pending contacts on a tenant-wide, an account or a campaign entry, once each, and nothing out of scope', async () => {
    await insertTenant({ id: DEFAULTS.tenantId });
    await insertAccount({ id: DEFAULTS.accountId, tenant_id: DEFAULTS.tenantId });
    await insertAccount({ id: OTHER_ACCOUNT, tenant_id: DEFAULTS.tenantId });
    await insertTenant({ id: OTHER_TENANT });
    const id = await campaign();
    const other = await campaign();
    const phones = ['+919800000001', '+919800000002', '+919800000003', '+919800000004', '+919800000005', '+919800000006', '+919800000007'];
    for (const phone of phones) await contact(id, { phone_e164: phone });
    await contact(id, { phone_e164: '+919800000099', state: 'completed' });
    await dnc(DEFAULTS.tenantId, phones[0]!, {}); // tenant-wide
    await dnc(DEFAULTS.tenantId, phones[1]!, { account_id: DEFAULTS.accountId }); // this account
    await dnc(DEFAULTS.tenantId, phones[2]!, { account_id: DEFAULTS.accountId, campaign_id: id }); // this campaign
    await dnc(DEFAULTS.tenantId, phones[3]!, { campaign_id: id }); // this campaign, no account
    await dnc(DEFAULTS.tenantId, phones[0]!, { campaign_id: id }); // a second entry: counted once
    await dnc(DEFAULTS.tenantId, phones[4]!, { account_id: OTHER_ACCOUNT }); // another account
    await dnc(DEFAULTS.tenantId, phones[5]!, { campaign_id: other }); // another campaign
    await dnc(OTHER_TENANT, phones[6]!, {}); // another tenant
    await dnc(DEFAULTS.tenantId, '+919800000099', {}); // a contact no longer pending

    expect(await repo.agencyInsightsReadRepository.contactsOnDnc({
      campaignId: id, tenantId: DEFAULTS.tenantId, accountId: DEFAULTS.accountId,
    })).toBe(4);
  });

  async function seedLarge(table: 'contacts' | 'dnc', n: number, campaignId: string): Promise<void> {
    if (table === 'contacts') {
      await getTestPool().query(
        `INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164, context, state)
         SELECT $1, $2, $3, '+91' || lpad(g::text, 10, '0'), '{}'::jsonb, 'pending' FROM generate_series(1, $4::int) g`,
        [campaignId, DEFAULTS.tenantId, DEFAULTS.accountId, n]);
    } else {
      await getTestPool().query(
        `INSERT INTO dnc_entries (tenant_id, phone_e164, source)
         SELECT $1, '+91' || lpad((g * 7)::text, 10, '0'), 'import' FROM generate_series(1, $2::int) g`,
        [DEFAULTS.tenantId, n]);
    }
  }

  const dncPlan = (campaignId: string) => {
    const { text, values } = repo.contactsOnDncStatement({ campaignId, tenantId: DEFAULTS.tenantId, accountId: DEFAULTS.accountId });
    // Analysed in the rolled-back transaction: the case is about which side is large, so the
    // planner must see this seed's sizes, not the statistics an earlier file left.
    return plan(text, values, undefined, false, ['agency_contacts', 'dnc_entries']);
  };

  it('is index-driven on both tables, with a large DNC list and a small roster, and the other way round', async () => {
    await insertTenant({ id: DEFAULTS.tenantId });
    await insertAccount({ id: DEFAULTS.accountId, tenant_id: DEFAULTS.tenantId });
    const small = await campaign();
    const large = await campaign();
    await seedLarge('dnc', 30_000, small);
    for (let i = 0; i < 20; i++) await contact(small, {});

    const bigList = await dncPlan(small);
    expect(bigList).not.toMatch(/Seq Scan/);
    expect(bigList).toMatch(/on agency_contacts c/);
    expect(bigList).toMatch(/idx_dnc_entries_tenant_phone on dnc_entries d/);

    await getTestPool().query('TRUNCATE dnc_entries');
    await seedLarge('contacts', 30_000, large);
    for (let i = 0; i < 20; i++) await getTestPool().query(
      `INSERT INTO dnc_entries (tenant_id, phone_e164, source) VALUES ($1, $2, 'api')`, [DEFAULTS.tenantId, `+91${String(i * 101).padStart(10, '0')}`]);
    const bigRoster = await dncPlan(large);
    expect(bigRoster).not.toMatch(/Seq Scan/);
    expect(bigRoster).toMatch(/on dnc_entries d/);
    expect(bigRoster).toMatch(/idx_agency_contacts_(phone|dialable|insights|assignee) on agency_contacts c/);
    expect(await repo.agencyInsightsReadRepository.contactsOnDnc({
      campaignId: large, tenantId: DEFAULTS.tenantId, accountId: DEFAULTS.accountId,
    })).toBe(19); // 0 · 101 is +910000000000, not seeded (the series starts at 1)
    await dropLargeSeed();
  }, 60_000);
});

describe('the upload history', () => {
  it('lists committed uploads newest first, without dry runs; the latest completed one', async () => {
    await insertTenant({ id: DEFAULTS.tenantId });
    const id = await campaign();
    const job = (o: Record<string, unknown>) => getTestPool().query(
      `INSERT INTO agency_ingest_jobs (tenant_id, campaign_id, s3_key, file_name, phone_column, dry_run, status, created_at,
                                       rows_read, accepted, rejected, duplicates, rejected_by_reason, dedupe_columns, rejected_s3_key, created_by)
       VALUES ($1, $2, 'k', $3, 'Mobile', $4, $5, $6, 10, 8, 2, 1, '{"invalid_phone": 1, "duplicate": 1}'::jsonb, $7, $8, $9)`,
      [DEFAULTS.tenantId, id, o['file'], o['dry'] ?? false, o['status'] ?? 'completed', o['at'], o['dedupe'] ?? null, o['rej'] ?? null, o['by'] ?? null]);
    await job({ file: 'first.csv', at: at(-3 * HOUR), dedupe: ['Loan No', 'Branch'] });
    await job({ file: 'dry.csv', at: at(-2 * HOUR), dry: true });
    await job({ file: 'failed.csv', at: at(-HOUR), status: 'failed', rej: 's3/rejected' });

    const list = await repo.agencyInsightsReadRepository.listUploads(DEFAULTS.tenantId, id);
    expect(list.map((u) => u.file_name)).toEqual(['failed.csv', 'first.csv']);
    expect(list[0]).toMatchObject({ status: 'failed', has_rejected_export: true, rows_read: 10, accepted: 8, rejected: 2, duplicates: 1, dedupe_columns: [] });
    const latest = await repo.agencyInsightsReadRepository.latestCompletedUpload(DEFAULTS.tenantId, id);
    expect(latest).toMatchObject({ file_name: 'first.csv', dedupe_columns: ['Loan No', 'Branch'], phone_column: 'Mobile' });
    expect(await repo.agencyInsightsReadRepository.listUploads(OTHER_TENANT, id)).toEqual([]);
  });
});
