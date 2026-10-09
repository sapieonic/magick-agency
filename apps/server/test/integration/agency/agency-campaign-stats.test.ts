import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { uuidFor } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { agencyCampaignRepository, agencyAbandonmentRepository } = await import(
  '../../../src/db/repositories/agency.repository.js'
);
const {
  insertAgencyCampaign,
  insertAgencyContact,
  insertAgentSession,
  insertAgencyAttempt,
} = await import('./agency-factories.js');
const { DEFAULT_ABANDONMENT_CEILING_PCT } = await import('../../../src/agency/campaign-config.js');

/**
 * ─── `stats()` and `window24h()`, against a real Postgres ────────────────────
 *
 * Written for the same reason `agency-campaign-create.test.ts` exists, and the
 * gap was identical: **no integration test called `stats()` at all.** Its whole
 * ~13-subquery statement was covered only by the unit tier, where the pool is
 * mocked — so the SQL string was asserted in detail and never once planned by
 * Postgres. A statement the database refuses to plan is indistinguishable, at
 * that tier, from one that works.
 *
 * An earlier column rename had already been through this: a renamed column reddened exactly one
 * test, because the fixture supplies the keys and only the SQL-text assertion
 * notices. That is a guard against drift in a string, not evidence the query
 * runs.
 *
 * Adding a LEFT JOIN to `window24h()`. The
 * abandonment predicate spliced into that statement names its columns
 * **unqualified** (`state`, `answered_at`, `bridged_at`, `outcome`), so the join
 * is one same-named column on `agency_campaigns` away from an `ambiguous column`
 * error that no unit test could ever see — and it would surface as the
 * compliance metric silently failing to refresh.
 */

describe('agency supervisor stats (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('plans and executes — every subquery, against the real schema', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });

    // The assertion that matters is that this resolves at all: a bad column
    // reference, a type mismatch inside a cast, or an ambiguous name after the
    // join all throw here and nowhere else in the suite.
    const stats = await agencyCampaignRepository.stats(campaign.id as string);

    expect(stats.contacts_total).toBe(0);
    expect(stats.attempts_total).toBe(0);
    expect(stats.agents_live).toBe(0);
    // No answered calls in the window ⇒ no rate. Never a reassuring 0%.
    expect(stats.abandonment_rate_24h_pct).toBeNull();
    expect(stats.agents).toEqual([]);
  });

  it('serves the CAMPAIGN ceiling, so the dashboard threshold is the guardrail line', async () => {
    // Deliberately NOT the default: serving the
    // module constant here would pass against a default-3 campaign while the
    // guardrail fired on the column, drawing the supervisor's threshold in a
    // different place from the line that actually pauses their campaign.
    const raised = await insertAgencyCampaign({ status: 'running', abandonment_ceiling_pct: 7.5 });
    const strict = await insertAgencyCampaign({ status: 'draft', abandonment_ceiling_pct: 0.5 });

    expect((await agencyCampaignRepository.stats(raised.id as string)).abandonment_ceiling_pct).toBe(7.5);
    expect((await agencyCampaignRepository.stats(strict.id as string)).abandonment_ceiling_pct).toBe(0.5);
  });

  it('defaults the ceiling from the column, not from application code', async () => {
    // The constant's own doc comment says it should become the column's DEFAULT.
    // This is that claim, checked by inserting a row that never mentions it.
    const campaign = await insertAgencyCampaign({ status: 'draft' });
    const { rows } = await getTestPool().query<{ abandonment_ceiling_pct: number }>(
      'SELECT abandonment_ceiling_pct FROM agency_campaigns WHERE id = $1',
      [campaign.id],
    );
    expect(rows[0]!.abandonment_ceiling_pct).toBe(DEFAULT_ABANDONMENT_CEILING_PCT);
  });

  it('is a number, not a string — the `numeric` trap', async () => {
    // node-pg returns `numeric` as a STRING. The column is `double precision`
    // precisely so `abandonment_ceiling_pct: number` is not a type lie on every
    // campaign row, and so the guardrail's `measured > ceiling` is not silently a
    // string compare where "10" > "3" is false. Nothing in the type system can
    // catch that regression; only the driver can.
    const campaign = await insertAgencyCampaign({ status: 'running', abandonment_ceiling_pct: 10 });
    const stats = await agencyCampaignRepository.stats(campaign.id as string);
    expect(typeof stats.abandonment_ceiling_pct).toBe('number');
    expect(stats.abandonment_ceiling_pct > 3).toBe(true);
  });

  it('healthInputs — all five queries plan and execute against the real schema', async () => {
    // Added for the same reason as the `stats()` case above, immediately after
    // making the same mistake: the health strip introduced five new
    // queries and not one integration test called them. They cover four tables
    // and three different GROUP BYs, and the unit tier mocks the pool.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const health = await agencyCampaignRepository.healthInputs(campaign.id as string);

    expect(health).toEqual({
      pendingByTimezone: [],
      nextRetryAt: null,
      lastDialAt: null,
      recent: { attempts: 0, failed: 0 },
      onBreakByReason: {},
    });
  });

  it('healthInputs groups pending contacts by timezone, including the null group', async () => {
    // The grouping is what keeps the calling-hours rule in TypeScript instead of
    // duplicated into SQL: a roster has a handful of distinct timezones however
    // many contacts it holds. A NULL timezone is its own group and inherits the
    // campaign default — dropping it would silently exclude every contact whose
    // CSV had no timezone column, which is most of them.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const past = new Date(Date.now() - 60_000);
    await insertAgencyContact(campaign.id as string, {
      phone_e164: '+919000000101', state: 'pending', next_attempt_at: past,
      timezone: 'Asia/Kolkata', source_row_number: 1,
    });
    await insertAgencyContact(campaign.id as string, {
      phone_e164: '+919000000102', state: 'pending', next_attempt_at: past,
      timezone: 'Asia/Kolkata', source_row_number: 2,
    });
    await insertAgencyContact(campaign.id as string, {
      phone_e164: '+919000000103', state: 'pending', next_attempt_at: past,
      timezone: null, source_row_number: 3,
    });

    const { pendingByTimezone } = await agencyCampaignRepository.healthInputs(campaign.id as string);
    const byTz = Object.fromEntries(
      pendingByTimezone.map((g) => [g.timezone ?? '__null__', g.count]),
    );
    expect(byTz).toEqual({ 'Asia/Kolkata': 2, __null__: 1 });
  });

  it('counts pending contacts the pre-dial gate has already deferred', async () => {
    // The defect: `pendingByTimezone` filtered to `next_attempt_at <= now()`, but
    // an out-of-hours contact is DEFERRED by the gate — `unclaim(id, deferUntil)`
    // writes the next window-open instant to `next_attempt_at`. So after one pacing
    // pass the due set is empty and the count reads zero, and the strip goes silent
    // in exactly the overnight case it exists to explain.
    //
    // Two future-dated contacts, no due ones at all: the count must still be 2.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const deferred = new Date(Date.now() + 8 * 60 * 60_000);
    await insertAgencyContact(campaign.id as string, {
      phone_e164: '+919000000201', state: 'pending', next_attempt_at: deferred,
      timezone: 'America/New_York', source_row_number: 1,
    });
    await insertAgencyContact(campaign.id as string, {
      phone_e164: '+919000000202', state: 'pending', next_attempt_at: deferred,
      timezone: 'America/New_York', source_row_number: 2,
    });

    const { pendingByTimezone } = await agencyCampaignRepository.healthInputs(campaign.id as string);
    expect(pendingByTimezone).toEqual([{ timezone: 'America/New_York', count: 2 }]);
  });

  it('counts the SAME set as `contacts_pending`, which the assembler compares it against', async () => {
    // Diagnosis 5 fires on `outsideCallingHours >= contacts_pending`. A due-only
    // numerator over an all-pending denominator can never reach it once any retry
    // is scheduled — so the two populations must match, and only Postgres can say
    // whether they do. A mixed roster is the case that separates them.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 30 * 60_000);
    await insertAgencyContact(campaign.id as string, {
      phone_e164: '+919000000301', state: 'pending', next_attempt_at: past,
      timezone: 'Asia/Kolkata', source_row_number: 1,
    });
    await insertAgencyContact(campaign.id as string, {
      phone_e164: '+919000000302', state: 'pending', next_attempt_at: future,
      timezone: 'Asia/Kolkata', source_row_number: 2,
    });
    // Not pending — must appear in neither count.
    await insertAgencyContact(campaign.id as string, {
      phone_e164: '+919000000303', state: 'completed', source_row_number: 3,
    });

    const [{ pendingByTimezone }, stats] = await Promise.all([
      agencyCampaignRepository.healthInputs(campaign.id as string),
      agencyCampaignRepository.stats(campaign.id as string),
    ]);
    const grouped = pendingByTimezone.reduce((n, g) => n + g.count, 0);

    expect(grouped).toBe(stats.contacts_pending);
    expect(grouped).toBe(2);
    // And the denominator genuinely does span the retry, so this is not a
    // vacuous equality between two due-only counts.
    expect(stats.retries_pending).toBe(1);
  });

  it('window24h joins the campaign without making the spliced predicate ambiguous', async () => {
    // The LEFT JOIN added to `window24h()`. Executing it is the whole assertion —
    // `ABANDONED_ATTEMPT_PREDICATE_SQL` is spliced in with unqualified column
    // names, so this is where an `ambiguous column` would surface.
    await insertAgencyCampaign({ status: 'running' });
    await expect(agencyAbandonmentRepository.window24h()).resolves.toEqual([]);
  });

  it('pauseForAbandonment claims only a running campaign, and freezes the rate', async () => {
    const running = await insertAgencyCampaign({ status: 'running' });
    const alreadyPaused = await insertAgencyCampaign({ status: 'paused' });

    const claimed = await agencyCampaignRepository.pauseForAbandonment(running.id as string, 4.25);
    expect(claimed?.status).toBe('paused');
    expect(claimed?.pause_reason).toBe('abandonment_ceiling');
    expect(claimed?.pause_abandonment_rate_pct).toBe(4.25);
    expect(claimed?.paused_at).toBeInstanceOf(Date);

    // The second replica's attempt, and the "don't re-stamp" case in one: a
    // campaign that is no longer `running` yields zero rows, so the frozen
    // evidence from the first pause survives.
    expect(await agencyCampaignRepository.pauseForAbandonment(running.id as string, 99)).toBeNull();
    expect(await agencyCampaignRepository.pauseForAbandonment(alreadyPaused.id as string, 99)).toBeNull();

    const { rows } = await getTestPool().query<{ pause_abandonment_rate_pct: number }>(
      'SELECT pause_abandonment_rate_pct FROM agency_campaigns WHERE id = $1',
      [running.id],
    );
    expect(rows[0]!.pause_abandonment_rate_pct).toBe(4.25);
  });

  it('a supervisor resume clears the pause metadata, so nothing still claims a breach', async () => {
    // The health strip's top-priority diagnosis reads `pause_reason`. A resume
    // that preserved it would leave a RUNNING campaign rendering "auto-paused on
    // the abandonment ceiling" indefinitely.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    await agencyCampaignRepository.pauseForAbandonment(campaign.id as string, 6);

    const resumed = await agencyCampaignRepository.transitionStatus(
      campaign.id as string, ['paused'], 'running',
    );
    expect(resumed?.status).toBe('running');
    expect(resumed?.pause_reason).toBeNull();
    expect(resumed?.paused_at).toBeNull();
    expect(resumed?.pause_abandonment_rate_pct).toBeNull();
  });

  it('a supervisor pause is recorded as such, and carries no abandonment evidence', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const paused = await agencyCampaignRepository.transitionStatus(
      campaign.id as string, ['running'], 'paused',
    );
    expect(paused?.pause_reason).toBe('supervisor');
    expect(paused?.paused_at).toBeInstanceOf(Date);
    // A supervisor pause has no measured rate behind it — inventing one would put
    // a number in front of an auditor that no measurement produced.
    expect(paused?.pause_abandonment_rate_pct).toBeNull();
  });
});

/**
 * ─── The agent floor, against a real Postgres ─────────────────────────
 *
 * The floor already ships inside `stats()` — `supervisorAgents` is the
 * `LEFT JOIN … GROUP BY` behind `agents[]` — but its only coverage was the unit
 * tier, where the pool is mocked, plus one integration assertion that the floor is
 * `[]` on an empty campaign. An empty result is exactly the answer a broken join
 * gives, so that assertion cannot tell a working query from a silent one.
 *
 * `calls_handled` is the part that most needs real SQL. It is a `COUNT` over a
 * LEFT JOIN with a predicate on the joined side, and every way of getting it wrong
 * — moving `bridged_at IS NOT NULL` into the `WHERE`, counting `a.*` instead of
 * `a.id`, joining on the user id — still returns plausible integers. The fixture
 * supplies the keys at the unit tier, so none of those reddens anything there.
 */
describe('agency supervisor stats — the agent floor (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  /** An attempt needs its own contact: `uq_agency_attempt_number` is per contact. */
  async function bridgedAttempt(
    campaignId: string,
    sessionId: string | null,
    overrides: Record<string, unknown> = {},
  ) {
    const contact = await insertAgencyContact(campaignId, { state: 'completed' });
    return insertAgencyAttempt(campaignId, contact.id as string, {
      reserved_agent_id: sessionId,
      state: 'ended',
      bridged_at: new Date(),
      ended_at: new Date(),
      ...overrides,
    });
  }

  it('an agent who has handled nothing is still on the floor', async () => {
    // The LEFT JOIN, which is the whole reason the query is not an inner one: an
    // inner join hides precisely the agent a supervisor is hunting for — the one
    // sitting idle having taken no calls.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    await insertAgentSession(campaign.id as string, { agent_user_id: uuidFor('idle-agent') });

    const { agents } = await agencyCampaignRepository.stats(campaign.id as string);

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ agent_user_id: uuidFor('idle-agent'), calls_handled: 0 });
    // Not `'0'`. `COUNT` comes back from node-pg as a string and the projection
    // casts it to `::text` before `Number()` — a regression to the raw value would
    // make `calls_handled: number` a type lie that only the driver can catch.
    expect(typeof agents[0]!.calls_handled).toBe('number');
  });

  it('counts only BRIDGED attempts, and only this session’s', async () => {
    // Three ways this can be wrong and still look right, all covered here:
    // an unbridged attempt counted, another agent's attempt counted, another
    // campaign's attempt counted.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    // `paused`, not a second `running` — `uq_agency_campaign_running` allows only
    // one running campaign per (tenant, account). Status is irrelevant to the
    // isolation being tested, which is by campaign id.
    const other = await insertAgencyCampaign({ status: 'paused' });

    const busy = await insertAgentSession(campaign.id as string, { agent_user_id: uuidFor('busy') });
    const quiet = await insertAgentSession(campaign.id as string, { agent_user_id: uuidFor('quiet') });
    const elsewhere = await insertAgentSession(other.id as string, { agent_user_id: uuidFor('elsewhere') });

    await bridgedAttempt(campaign.id as string, busy.id as string);
    await bridgedAttempt(campaign.id as string, busy.id as string);
    // Dialed but never bridged — nobody handled this one. `bridged_at` lives on the
    // JOIN condition, not the WHERE; moving it would drop `quiet` off the floor
    // entirely rather than merely miscount, which is the tell.
    await bridgedAttempt(campaign.id as string, busy.id as string, { bridged_at: null });
    // Reserved to nobody (abandoned before a bridge existed).
    await bridgedAttempt(campaign.id as string, null);
    await bridgedAttempt(campaign.id as string, quiet.id as string);
    await bridgedAttempt(other.id as string, elsewhere.id as string);

    const { agents } = await agencyCampaignRepository.stats(campaign.id as string);
    const handled = Object.fromEntries(agents.map((a) => [a.agent_user_id, a.calls_handled]));

    expect(handled).toEqual({ [uuidFor('busy')]: 2, [uuidFor('quiet')]: 1 });
    // The other campaign's floor is untouched — the campaign filter is on the
    // SESSION, so an attempt can only reach a floor through its own agent.
    const otherFloor = await agencyCampaignRepository.stats(other.id as string);
    expect(otherFloor.agents.map((a) => a.calls_handled)).toEqual([1]);
  });

  it('attributes by SESSION, so a rejoining agent starts this shift at zero', async () => {
    // The "this shift" semantic, and it is structural rather than a filter:
    // `agency_call_attempts.reserved_agent_id` is a FK to `agency_agent_sessions`
    // not to a user, so a session id cannot exist before its own
    // `joined_at`. There is no date bound to get wrong — but there IS a way to lose
    // the property, by joining on `agent_user_id` instead, and that is what this
    // pins. The same human, yesterday's session left and today's live.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const yesterday = await insertAgentSession(campaign.id as string, {
      agent_user_id: uuidFor('ravi'), left_at: new Date(Date.now() - 12 * 60 * 60_000),
    });
    const today = await insertAgentSession(campaign.id as string, { agent_user_id: uuidFor('ravi') });

    await bridgedAttempt(campaign.id as string, yesterday.id as string);
    await bridgedAttempt(campaign.id as string, yesterday.id as string);
    await bridgedAttempt(campaign.id as string, yesterday.id as string);
    await bridgedAttempt(campaign.id as string, today.id as string);

    const { agents } = await agencyCampaignRepository.stats(campaign.id as string);

    // One row, not two: `left_at IS NULL` keeps the finished shift off the floor.
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ session_id: today.id, agent_user_id: uuidFor('ravi') });
    // 1, not 4. Joining on the user id would inherit yesterday's three.
    expect(agents[0]!.calls_handled).toBe(1);
  });

  it('serves break_reason only while actually on a break', async () => {
    // The column keeps the last reason after an agent returns, so projecting it
    // raw puts a stale "lunch" beside an available agent — which reads as a live
    // fact to anyone scanning the floor. The CASE is what prevents that.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    await insertAgentSession(campaign.id as string, {
      agent_user_id: uuidFor('on-break'), state: 'break', break_reason: 'lunch',
    });
    await insertAgentSession(campaign.id as string, {
      agent_user_id: uuidFor('returned'), state: 'available', break_reason: 'lunch',
    });

    const { agents } = await agencyCampaignRepository.stats(campaign.id as string);
    const byUser = Object.fromEntries(agents.map((a) => [a.agent_user_id, a]));

    expect(byUser[uuidFor('on-break')]).toMatchObject({ state: 'break', break_reason: 'lunch' });
    expect(byUser[uuidFor('returned')]).toMatchObject({ state: 'available', break_reason: null });
  });

  it('an agent who left is off the floor, and out of every count beside it', async () => {
    // `left_at IS NULL` in one place feeding two numbers. `agents_by_state` is
    // tallied from the same rows precisely so the floor and the breakdown cannot
    // disagree; this is that invariant against real rows rather than a fixture.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    await insertAgentSession(campaign.id as string, { agent_user_id: uuidFor('here'), state: 'on_call' });
    await insertAgentSession(campaign.id as string, {
      agent_user_id: uuidFor('gone'), state: 'offline', left_at: new Date(),
    });

    const stats = await agencyCampaignRepository.stats(campaign.id as string);

    expect(stats.agents.map((a) => a.agent_user_id)).toEqual([uuidFor('here')]);
    expect(stats.agents_live).toBe(1);
    expect(stats.agents_by_state).toMatchObject({ on_call: 1, offline: 0 });
    const tallied = Object.values(stats.agents_by_state).reduce((a, b) => a + b, 0);
    expect(tallied).toBe(stats.agents.length);
    expect(tallied).toBe(stats.agents_live);
  });

  it('serves state_since as an ISO instant the console can subtract', async () => {
    // Served raw rather than as a computed duration: a tile ticks live, so a
    // server-rendered "8m 41s" is wrong the moment it arrives. `isoOrEpoch` is what
    // turns node-pg's `Date` into that string, and only a real driver returns one.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const since = new Date(Date.now() - 5 * 60_000);
    await insertAgentSession(campaign.id as string, { state: 'wrapup', state_since: since });

    const { agents } = await agencyCampaignRepository.stats(campaign.id as string);

    expect(typeof agents[0]!.state_since).toBe('string');
    expect(agents[0]!.state_since).toBe(since.toISOString());
  });
});
