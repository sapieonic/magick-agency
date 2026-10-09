import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, uuidFor } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { agencyAgentStatsRepository, agencyAttemptRepository } =
  await import('../../../src/db/repositories/agency.repository.js');
const {
  insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession,
} = await import('./agency-factories.js');
const { decodeKeysetCursor } = await import('@magick-agency/domain/keyset-cursor');

/**
 * ─── ONE PERSON, MANY SESSIONS ──────────────────────────────────────────────
 *
 * Modelled on `test/integration/agency/agency-spine-read.test.ts` (the join-shape
 * suite) — same connection mock, same import order, same seed-then-drive shape.
 *
 * ── The mismatch this file is about ─────────────────────────────────────────
 *
 * `agency_call_attempts.reserved_agent_id` references a **SESSION**, and a session
 * is one shift on one campaign. `agent_user_id` — the PERSON — lives on the
 * session, one hop away. So "what did this person do" is a query over a SET of
 * sessions, and the set grows with every shift they work: an agent with a year of
 * history has hundreds.
 *
 * Two failures follow from that and neither is visible in SQL text:
 *
 *   * **Double counting.** The person is reached through
 *     `JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id`, and the
 *     occupancy read additionally joins `sess` twice (once in each event CTE, once
 *     in `intervals`). Any of those becoming one-to-many multiplies an attempt.
 *     Against a fixture with ONE session per agent — which is what every existing
 *     agency suite seeds — a fan-out is arithmetically invisible.
 *   * **Dropping.** `uq_agency_agent_live_tenant` permits only one LIVE session per (tenant,
 *     agent), so a real agent's history is mostly CLOSED sessions
 *     (`left_at IS NOT NULL`). A predicate that only considered live sessions —
 *     which is what `idx_agency_attempts_agent`'s `WHERE state <> 'ended'` and the
 *     roster's `left_at IS NULL` both encourage by habit — would return a nearly
 *     empty record and look like a quiet agent.
 *
 * The partial index case is called out explicitly below: `/stats` reads almost
 * exclusively `state = 'ended'` rows, which that index excludes **by
 * construction**. `idx_agency_attempts_agent_dialed` exists because of it, and a test that only seeded
 * live attempts would prove nothing about the read anyone actually performs.
 *
 * ── ⚠️ THIS FILE HAS NOT BEEN EXECUTED ──────────────────────────────────────
 *
 * No Docker daemon, so `npm run test:integration` could not be run. It type-checks
 * under `tsconfig.test.json` (gated by `npm run lint`). The numbers are all
 * additions of the seeded rows, stated beside each seed.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const AGENT = uuidFor('u-ravi');

const FROM = new Date('2026-08-10T00:00:00.000Z');
const TO = new Date('2026-08-20T00:00:00.000Z');
const scope = { tenantId: T, accountId: A, agentUserId: AGENT };

/**
 * Close a session, so the next one can be created.
 *
 * `uq_agency_agent_live_tenant (tenant_id, agent_user_id) WHERE
 * left_at IS NULL` refuses a second live session for one person in one tenant. So
 * "an agent with several sessions" is necessarily "several closed ones and at most
 * one open" — which is also what production looks like, and is why every helper
 * here closes as it goes rather than leaving a pile of live rows the index would
 * have rejected anyway.
 */
async function close(sessionId: string, leftAt: Date): Promise<void> {
  await getTestPool().query(
    'UPDATE agency_agent_sessions SET left_at = $2 WHERE id = $1', [sessionId, leftAt],
  );
}

async function dialled(
  campaignId: string,
  sessionId: string,
  dialedAt: Date,
  overrides: Record<string, unknown> = {},
) {
  const contact = await insertAgencyContact(campaignId, { state: 'completed' });
  return insertAgencyAttempt(campaignId, contact.id as string, {
    state: 'ended',
    outcome: 'connected',
    reserved_agent_id: sessionId,
    created_at: dialedAt,
    dialed_at: dialedAt,
    bridged_at: dialedAt,
    ended_at: new Date(dialedAt.getTime() + 120_000),   // 120s of talk
    ...overrides,
  });
}

describe('agent stats across many sessions (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('sums across three sessions with no double count and no dropped attempt', async () => {
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });

    // Three shifts on three different days: two closed, one still open.
    const shiftA = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-11T08:00:00Z'),
    });
    await dialled(campaign.id as string, shiftA.id as string, new Date('2026-08-11T09:00:00Z'));
    await dialled(campaign.id as string, shiftA.id as string, new Date('2026-08-11T10:00:00Z'));
    await close(shiftA.id as string, new Date('2026-08-11T17:00:00Z'));

    const shiftB = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-12T08:00:00Z'),
    });
    await dialled(campaign.id as string, shiftB.id as string, new Date('2026-08-12T09:00:00Z'));
    await close(shiftB.id as string, new Date('2026-08-12T17:00:00Z'));

    const shiftC = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-13T08:00:00Z'),
    });
    await dialled(campaign.id as string, shiftC.id as string, new Date('2026-08-13T09:00:00Z'));
    await dialled(campaign.id as string, shiftC.id as string, new Date('2026-08-13T11:00:00Z'));
    await dialled(campaign.id as string, shiftC.id as string, new Date('2026-08-13T13:00:00Z'));
    // shiftC stays OPEN — the live session.

    const stats = await agencyAgentStatsRepository.stats(scope, { from: FROM, to: TO, bucket: 'day' });

    // 2 + 1 + 3, and each exactly once. Six is also what a fan-out of two would
    // report as twelve and what a live-sessions-only predicate would report as
    // three, so the single number distinguishes both failures.
    expect(stats.totals.attempts).toBe(6);
    expect(stats.totals.connected).toBe(6);
    expect(stats.totals.talk_seconds).toBe(6 * 120);

    // One bucket per shift day, with the shift's own count.
    expect(stats.buckets.map((b) => ({ d: b.bucket_start, n: b.attempts }))).toEqual([
      { d: '2026-08-11', n: 2 },
      { d: '2026-08-12', n: 1 },
      { d: '2026-08-13', n: 3 },
    ]);

    // ONE campaign row, not one per session. `by_campaign` is keyed on the
    // campaign, and three sessions on one campaign collapsing to three rows would
    // be the same fan-out wearing a different hat.
    expect(stats.by_campaign).toHaveLength(1);
    expect(stats.by_campaign[0]?.attempts).toBe(6);
    expect(stats.totals.campaigns).toBe(1);
  });

  it('spans campaigns as well as shifts, and by_campaign still partitions the total', async () => {
    // The cross-campaign case is the whole reason this route exists —
    // `/agency-campaigns/:id/attempts` structurally cannot answer it. Sessions are
    // per campaign, so an agent working two campaigns has at least two sessions
    // and the union is the record.
    const one = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped', name: 'c-one' });
    const two = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped', name: 'c-two' });

    const onOne = await insertAgentSession(one.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-11T08:00:00Z'),
    });
    await dialled(one.id as string, onOne.id as string, new Date('2026-08-11T09:00:00Z'));
    await dialled(one.id as string, onOne.id as string, new Date('2026-08-11T10:00:00Z'));
    await close(onOne.id as string, new Date('2026-08-11T12:00:00Z'));

    const onTwo = await insertAgentSession(two.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-11T13:00:00Z'),
    });
    await dialled(two.id as string, onTwo.id as string, new Date('2026-08-11T14:00:00Z'));

    const stats = await agencyAgentStatsRepository.stats(scope, { from: FROM, to: TO, bucket: 'day' });

    expect(stats.totals.attempts).toBe(3);
    expect(stats.totals.campaigns).toBe(2);
    // One bucket (same UTC day), two campaign rows, and they partition it.
    expect(stats.buckets).toHaveLength(1);
    expect(stats.buckets[0]?.attempts).toBe(3);
    expect(stats.by_campaign.reduce((a, r) => a + r.attempts, 0)).toBe(3);
    const byCampaign = new Map(stats.by_campaign.map((r) => [r.campaign_id, r.attempts]));
    expect(byCampaign.get(one.id as string)).toBe(2);
    expect(byCampaign.get(two.id as string)).toBe(1);
  });

  it('counts an attempt whose state the live-only partial index EXCLUDES', async () => {
    // ── The index that must not be the driver ────────────────────────────────
    //
    // `idx_agency_attempts_agent` is
    // `(reserved_agent_id) WHERE state <> 'ended'` — built for "what is this agent
    // on RIGHT NOW". `ended` is terminal, so an agent's RECORD is made almost
    // entirely of rows that index cannot see; `idx_agency_attempts_agent_dialed` exists precisely
    // because widening it was the wrong answer.
    //
    // So the fixture is deliberately lopsided: four `ended` attempts (invisible to
    // it) and one `bridged` one (visible to it). A read that had somehow become
    // dependent on its predicate would return 1; the honest answer is 5.
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-12T08:00:00Z'),
    });

    for (const hour of [9, 10, 11, 12]) {
      await dialled(campaign.id as string, session.id as string,
        new Date(`2026-08-12T${String(hour).padStart(2, '0')}:00:00Z`));
    }
    // Still in progress: dialled and bridged, no `ended_at`, state `bridged`.
    const live = await dialled(campaign.id as string, session.id as string,
      new Date('2026-08-12T13:00:00Z'), { state: 'bridged', outcome: null, ended_at: null });

    const stats = await agencyAgentStatsRepository.stats(scope, { from: FROM, to: TO, bucket: 'day' });

    expect(stats.totals.attempts).toBe(5);
    // `connected` gates on `bridged_at IS NOT NULL`, which the live call has —
    // it is a connect in progress, not a connect that finished.
    expect(stats.totals.connected).toBe(5);
    // Talk is `ended_at - bridged_at`, so the live call contributes nothing to it.
    // Four finished calls at 120s each; a live call counted at its bridge instant
    // would show up as an extra 0 and a live call counted to `now()` would blow
    // this number up by hours.
    expect(stats.totals.talk_seconds).toBe(4 * 120);

    // And it is on the LIST too — the spine has no state filter of its own.
    const page = await agencyAttemptRepository.listForAgent({
      tenantId: T, accountId: A, agentUserId: AGENT, filters: {}, limit: 50,
    });
    expect(page.rows).toHaveLength(5);
    expect(page.rows.map((r) => r.id)).toContain(live.id);
  });

  it('a session with no attempts contributes nothing rather than a phantom row', async () => {
    // A shift the roster never dialled into — retry backoff, an empty list, a
    // paused campaign. It must not create a `by_campaign` row with zeros, because
    // that row would claim the agent worked a campaign they made no calls on, and
    // the INNER join from attempts to sessions is what keeps it out.
    const worked = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped', name: 'worked' });
    const idle = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped', name: 'idle' });

    const onWorked = await insertAgentSession(worked.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-11T08:00:00Z'),
    });
    await dialled(worked.id as string, onWorked.id as string, new Date('2026-08-11T09:00:00Z'));
    await close(onWorked.id as string, new Date('2026-08-11T12:00:00Z'));

    await insertAgentSession(idle.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-11T13:00:00Z'),
    });

    const stats = await agencyAgentStatsRepository.stats(scope, { from: FROM, to: TO, bucket: 'day' });
    expect(stats.totals.attempts).toBe(1);
    expect(stats.by_campaign.map((r) => r.campaign_id)).toEqual([worked.id]);
    expect(stats.totals.campaigns).toBe(1);
  });

  it('another agent\'s sessions on the same campaign are not folded in', async () => {
    // The join is on `s.agent_user_id = $1`, and two agents on one campaign is the
    // normal case. A predicate that had drifted onto the campaign — or a `sess`
    // CTE that lost its agent filter — would report the whole floor's work as one
    // person's, which on a record someone's performance is discussed against is
    // the worst available failure.
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });

    const mine = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-11T08:00:00Z'),
    });
    await dialled(campaign.id as string, mine.id as string, new Date('2026-08-11T09:00:00Z'));

    const theirs = await insertAgentSession(campaign.id as string, {
      agent_user_id: uuidFor('u-priya'), joined_at: new Date('2026-08-11T08:00:00Z'),
    });
    await dialled(campaign.id as string, theirs.id as string, new Date('2026-08-11T09:30:00Z'));
    await dialled(campaign.id as string, theirs.id as string, new Date('2026-08-11T10:30:00Z'));

    expect((await agencyAgentStatsRepository.stats(scope, { from: FROM, to: TO, bucket: 'day' }))
      .totals.attempts).toBe(1);
    expect((await agencyAgentStatsRepository.stats(
      { ...scope, agentUserId: uuidFor('u-priya') }, { from: FROM, to: TO, bucket: 'day' },
    )).totals.attempts).toBe(2);
  });

  it('an attempt with NO reserved session is not the agent\'s — abandoned calls stay out', async () => {
    // `reserved_agent_id` is NULL on every attempt that failed before an agent was
    // on it (the abandoned case `agency-spine-read.test.ts` names). The agent
    // routes join INNER to the session on purpose: an abandoned dial is the
    // campaign's fact, not any person's, and attributing it to whoever happened to
    // be on shift would put calls the agent never heard on their record.
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-11T08:00:00Z'),
    });
    await dialled(campaign.id as string, session.id as string, new Date('2026-08-11T09:00:00Z'));

    const orphanContact = await insertAgencyContact(campaign.id as string, { state: 'completed' });
    await insertAgencyAttempt(campaign.id as string, orphanContact.id as string, {
      state: 'ended', outcome: 'abandoned', reserved_agent_id: null,
      created_at: new Date('2026-08-11T09:30:00Z'),
      dialed_at: new Date('2026-08-11T09:30:00Z'),
      ended_at: new Date('2026-08-11T09:30:20Z'),
    });

    const stats = await agencyAgentStatsRepository.stats(scope, { from: FROM, to: TO, bucket: 'day' });
    expect(stats.totals.attempts).toBe(1);

    const page = await agencyAttemptRepository.listForAgent({
      tenantId: T, accountId: A, agentUserId: AGENT, filters: {}, limit: 50,
    });
    expect(page.rows).toHaveLength(1);
  });

  it('/attempts pages the whole cross-session history in keyset order', async () => {
    // The spine has no driving index (accepted deliberately), so the ordering is a sort the planner performs. Worth one behavioural
    // check that it is `created_at DESC, id DESC` across sessions rather than
    // within each one — a per-session ordering would interleave shifts wrongly and
    // the cursor would then skip rows.
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });
    const older = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-11T08:00:00Z'),
    });
    const a1 = await dialled(campaign.id as string, older.id as string, new Date('2026-08-11T09:00:00Z'));
    const a2 = await dialled(campaign.id as string, older.id as string, new Date('2026-08-11T10:00:00Z'));
    await close(older.id as string, new Date('2026-08-11T12:00:00Z'));

    const newer = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-12T08:00:00Z'),
    });
    const a3 = await dialled(campaign.id as string, newer.id as string, new Date('2026-08-12T09:00:00Z'));

    const first = await agencyAttemptRepository.listForAgent({
      tenantId: T, accountId: A, agentUserId: AGENT, filters: {}, limit: 2,
    });
    expect(first.rows.map((r) => r.id)).toEqual([a3.id, a2.id]);
    expect(first.next_cursor).toBeTruthy();

    // The cursor is opaque and decoded with the same `keyset-cursor.ts` the routes
    // use — never rebuilt from the row, which would test a different cursor from
    // the one the API issues.
    const second = await agencyAttemptRepository.listForAgent({
      tenantId: T, accountId: A, agentUserId: AGENT, filters: {}, limit: 2,
      after: decodeKeysetCursor(first.next_cursor!)!,
    });
    expect(second.rows.map((r) => r.id)).toEqual([a1.id]);
    expect(second.next_cursor).toBeNull();
  });
});
