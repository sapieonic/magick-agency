import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, uuidFor } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { agencyAgentStatsRepository } =
  await import('../../../src/db/repositories/agency.repository.js');
const {
  insertAgencyCampaign, insertAgentSession, insertAgentShift,
} = await import('./agency-factories.js');

/**
 * ─── OCCUPANCY IS BOUNDED BY THE WINDOW, NOT BY THE AGENT'S TENURE ──────────
 *
 * Modelled on `test/integration/agency/agency-campaign-stats.test.ts` — same
 * connection mock, same `await import` order, same `beforeEach(truncateAll)` /
 * `afterAll(closeTestPool)`, same drive-the-repository-and-assert-the-payload
 * shape.
 *
 * ── The regression this file locks ──────────────────────────────────────────
 *
 * The occupancy read reconstructs durations from instants: an event says "entered
 * `wrapup` at 14:02", and the duration is the gap to the next event on the same
 * session (`lead(at) OVER (PARTITION BY session_id ORDER BY at)`). The state an
 * agent was in AT `from` is set by the last event BEFORE `from`, which is outside
 * the window — so `carried` fetches exactly one such row per session and clips it
 * with `GREATEST(at, from)`.
 *
 * **`carried` is per SESSION, so the read is bounded by the window only if the
 * SESSION SET is.** Left unbounded, every session the agent has ever closed still
 * has a terminal event before `from`, and each one therefore carries in an interval
 * with no successor inside the window — i.e. one that runs the window's ENTIRE
 * width. Sixty past shifts read as sixty full-window intervals: about 42 days of
 * `offline` inside a 24-hour bucket, `by_state.offline` scaling with tenure rather
 * than with the window, and `shift_seconds` inflated by exactly the same
 * construction for any session abandoned in a non-`offline` state.
 *
 * The fix is the overlap predicate on `sess`:
 *
 *     AND s.joined_at < $3 AND (s.left_at IS NULL OR s.left_at > $2)
 *
 * — two half-open intervals overlap iff each starts before the other ends. The
 * unit tier asserts that string is present. Only a query proves the numbers stop
 * growing, and **the failure mode is a number that is merely too large**, which no
 * single-session fixture can exhibit at all: with one session, bounded and
 * unbounded agree exactly.
 *
 * So every case below seeds SEVERAL shifts and asserts the answer does not move
 * when more history is added. That is the shape of the assertion the regression
 * needs — an absolute number pinned once would pass a version that scaled with a
 * count the fixture happened to hold fixed.
 *
 * ── ⚠️ THIS FILE HAS NOT BEEN EXECUTED ──────────────────────────────────────
 *
 * No Docker daemon, so `npm run test:integration` could not be run. It type-checks
 * under `tsconfig.test.json` (gated by `npm run lint`). Every expected duration is
 * the difference between two timestamps written a few lines above it; the
 * invariant assertions (`shift_seconds` monotonic, occupancy ≤ 1) are derived from
 * the payload rather than from a constant, which is what makes them independent of
 * the arithmetic.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const AGENT = uuidFor('u-ravi');
const scope = { tenantId: T, accountId: A, agentUserId: AGENT };

/** The window under test: one UTC day. */
const FROM = new Date('2026-08-18T00:00:00.000Z');
const TO = new Date('2026-08-19T00:00:00.000Z');
const WINDOW_SECONDS = (TO.getTime() - FROM.getTime()) / 1000;   // 86400

async function close(sessionId: string, leftAt: Date): Promise<void> {
  await getTestPool().query(
    'UPDATE agency_agent_sessions SET left_at = $2 WHERE id = $1', [sessionId, leftAt],
  );
}

/**
 * A closed shift, entirely BEFORE the window, that ends `offline`.
 *
 * This is the row that used to poison the read: its terminal `offline` event is
 * before `from`, so an unbounded `carried` hands it an interval with no successor
 * inside the window, running the full 86 400 seconds. One of these is a doubling;
 * `n` of them is `n` × the window.
 */
async function pastShift(campaignId: string, day: string) {
  const session = await insertAgentSession(campaignId, {
    agent_user_id: AGENT, joined_at: new Date(`${day}T08:00:00Z`),
  });
  await insertAgentShift(session, [
    ['break', new Date(`${day}T08:00:00Z`)],
    ['available', new Date(`${day}T08:05:00Z`)],
    ['on_call', new Date(`${day}T09:00:00Z`)],
    ['wrapup', new Date(`${day}T09:30:00Z`)],
    ['available', new Date(`${day}T09:35:00Z`)],
    ['offline', new Date(`${day}T17:00:00Z`)],
  ]);
  await close(session.id as string, new Date(`${day}T17:00:00Z`));
  return session;
}

const occupancyOf = async (from = FROM, to = TO) =>
  (await agencyAgentStatsRepository.stats(scope, { from, to, bucket: 'day' })).totals.occupancy;

describe('agent occupancy is bounded by the window (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('reports only the in-window shift, with three closed shifts behind it', async () => {
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });

    // Three shifts, all finished and closed, all before the window.
    await pastShift(campaign.id as string, '2026-08-11');
    await pastShift(campaign.id as string, '2026-08-12');
    await pastShift(campaign.id as string, '2026-08-13');

    // The shift the window is actually about: 09:00→10:00 available, 10:00→11:00
    // on_call, 11:00→11:15 wrapup, 11:15→12:00 break, then logged out.
    const today = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-18T09:00:00Z'),
    });
    await insertAgentShift(today, [
      ['available', new Date('2026-08-18T09:00:00Z')],
      ['on_call', new Date('2026-08-18T10:00:00Z')],
      ['wrapup', new Date('2026-08-18T11:00:00Z')],
      ['break', new Date('2026-08-18T11:15:00Z')],
      ['offline', new Date('2026-08-18T12:00:00Z')],
    ]);
    await close(today.id as string, new Date('2026-08-18T12:00:00Z'));

    const occ = await occupancyOf();

    expect(occ.by_state.available).toBe(3600);      // 09:00 → 10:00
    expect(occ.by_state.on_call).toBe(3600);        // 10:00 → 11:00
    expect(occ.by_state.wrapup).toBe(900);          // 11:00 → 11:15
    expect(occ.by_state.break).toBe(2700);          // 11:15 → 12:00
    // The final `offline` runs from 12:00 to the window edge — measured, and
    // excluded from the shift.
    expect(occ.by_state.offline).toBe(12 * 3600);   // 12:00 → 24:00
    expect(occ.by_state.reserved).toBe(0);

    // Three hours on shift. Under the unbounded `sess`, the three past shifts
    // would each have added a full 86 400 seconds of `offline` — and any of them
    // abandoned mid-state would have added it to `shift_seconds` too.
    expect(occ.shift_seconds).toBe(3 * 3600);
  });

  it('does NOT scale with tenure — ten more past shifts change nothing', async () => {
    // ── The assertion the regression actually needs ──────────────────────────
    //
    // An absolute number pinned once passes a version that scales with a session
    // count the fixture holds fixed. So the same window is read twice, with ten
    // more closed shifts added in between, and the two payloads must be EQUAL.
    // Under the unbounded `carried`, the second read reports ten extra
    // full-window intervals — 864 000 more seconds of `offline` inside a
    // 86 400-second window, which is the shape of the original defect.
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });

    const today = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-18T09:00:00Z'),
    });
    await insertAgentShift(today, [
      ['available', new Date('2026-08-18T09:00:00Z')],
      ['on_call', new Date('2026-08-18T10:00:00Z')],
      ['offline', new Date('2026-08-18T11:00:00Z')],
    ]);
    await close(today.id as string, new Date('2026-08-18T11:00:00Z'));

    const before = await occupancyOf();

    // June and July, ten shifts. Chosen to be entirely before the window and
    // spread across two months so nothing can be coincidentally excluded by a
    // month boundary.
    for (const day of [
      '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05',
      '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07',
    ]) {
      await pastShift(campaign.id as string, day);
    }

    const after = await occupancyOf();

    // Deep-equal, not "roughly the same": the whole point is that history is
    // invisible to this window.
    expect(after).toEqual(before);
    expect(after.by_state.available).toBe(3600);
    expect(after.by_state.on_call).toBe(3600);
    expect(after.shift_seconds).toBe(2 * 3600);
    // And the sanity bound the defect broke: no state can exceed the window.
    for (const [state, seconds] of Object.entries(after.by_state)) {
      expect(seconds, state).toBeLessThanOrEqual(WINDOW_SECONDS);
    }
  });

  it('a session ABANDONED in a non-offline state still cannot inflate the shift', async () => {
    // ── The nastier half of the same defect ──────────────────────────────────
    //
    // A crash, a browser close, or the startup reaper failing to sweep leaves a
    // session whose last event is `available` or `on_call` rather than `offline`.
    // Under the unbounded `carried`, that session's terminal non-offline event
    // carries into EVERY later window and — because `foldOccupancy` counts every
    // non-`offline` second as shift — is added to `shift_seconds` as well as to
    // `by_state`. So the agent appears to have been on shift, on a call, for the
    // full width of a window months after they went home.
    //
    // Two of them here, both left `on_call`, both closed (so migration 093 permits
    // the in-window session), and the window must see neither.
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });

    for (const day of ['2026-07-14', '2026-07-15']) {
      const abandoned = await insertAgentSession(campaign.id as string, {
        agent_user_id: AGENT, joined_at: new Date(`${day}T08:00:00Z`),
      });
      await insertAgentShift(abandoned, [
        ['available', new Date(`${day}T08:00:00Z`)],
        // No `offline`. The shift simply stops being recorded.
        ['on_call', new Date(`${day}T09:00:00Z`)],
      ]);
      await close(abandoned.id as string, new Date(`${day}T09:45:00Z`));
    }

    const today = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-18T14:00:00Z'),
    });
    await insertAgentShift(today, [
      ['available', new Date('2026-08-18T14:00:00Z')],
      ['on_call', new Date('2026-08-18T14:30:00Z')],
      ['offline', new Date('2026-08-18T15:00:00Z')],
    ]);
    await close(today.id as string, new Date('2026-08-18T15:00:00Z'));

    const occ = await occupancyOf();
    expect(occ.by_state.available).toBe(1800);   // 14:00 → 14:30
    expect(occ.by_state.on_call).toBe(1800);     // 14:30 → 15:00
    expect(occ.shift_seconds).toBe(3600);
    // Not 3600 + 2 × 86 400.
    expect(occ.shift_seconds).toBeLessThanOrEqual(WINDOW_SECONDS);
  });

  it('a session still OPEN across the window is included, and only for the window', async () => {
    // The `s.left_at IS NULL` arm of the overlap predicate. An agent who joined
    // before `from` and has not left must be measured — otherwise the state they
    // have been in all day is the one the record does not mention — but only for
    // the part of their session that lies inside the window.
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });
    const open = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-17T08:00:00Z'),
    });
    await insertAgentShift(open, [
      // Both events are BEFORE the window, so the state at `from` comes entirely
      // from `carried` and `GREATEST(at, from)` clips it to midnight.
      ['available', new Date('2026-08-17T08:00:00Z')],
      ['on_call', new Date('2026-08-17T23:00:00Z')],
      // …and one inside it.
      ['wrapup', new Date('2026-08-18T02:00:00Z')],
      ['offline', new Date('2026-08-18T03:00:00Z')],
    ]);

    const occ = await occupancyOf();
    // `on_call` carried in from 23:00 the previous day: 00:00 → 02:00 = 2h. The
    // 23:00→24:00 hour belongs to the 17th and must NOT appear here.
    expect(occ.by_state.on_call).toBe(2 * 3600);
    expect(occ.by_state.wrapup).toBe(3600);      // 02:00 → 03:00
    expect(occ.by_state.available).toBe(0);      // ended before the window opened
    expect(occ.by_state.offline).toBe(21 * 3600); // 03:00 → 24:00
    expect(occ.shift_seconds).toBe(3 * 3600);
  });

  it('two OVERLAPPING sessions keep occupancy at or below 100%', async () => {
    // ── What the overlap predicate does NOT promise, and what must still hold ──
    //
    // Migration 093 refuses two LIVE sessions for one person in one tenant, but two
    // CLOSED sessions may overlap in time — a crashed shift closed late by the
    // reaper while the agent has already rejoined is the ordinary way it happens.
    // Both then contribute intervals over the same wall-clock, so `shift_seconds`
    // CAN exceed the window's width. That is accepted: the read sums per session
    // and there is no honest way to merge two independent state machines.
    //
    // What must never break is the RATIO. `foldOccupancy` counts `on_call` into
    // `shift_seconds` too, so occupancy is `on_call / shift_seconds` and is bounded
    // by 1 by construction — unless a bug counted `on_call` somewhere the shift
    // sum did not see it. That is the invariant worth pinning, and it is pinned
    // from the payload rather than from an expected constant.
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });

    const first = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-18T09:00:00Z'),
    });
    await insertAgentShift(first, [
      ['available', new Date('2026-08-18T09:00:00Z')],
      ['on_call', new Date('2026-08-18T10:00:00Z')],
      ['offline', new Date('2026-08-18T12:00:00Z')],
    ]);
    // Closed LATER than the second session's join — that is the overlap.
    await close(first.id as string, new Date('2026-08-18T12:00:00Z'));

    const second = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-18T11:00:00Z'),
    });
    await insertAgentShift(second, [
      ['available', new Date('2026-08-18T11:00:00Z')],
      ['on_call', new Date('2026-08-18T11:30:00Z')],
      ['offline', new Date('2026-08-18T13:00:00Z')],
    ]);
    await close(second.id as string, new Date('2026-08-18T13:00:00Z'));

    const occ = await occupancyOf();

    // Session 1: available 1h, on_call 2h.  Session 2: available 0.5h, on_call 1.5h.
    expect(occ.by_state.available).toBe(1.5 * 3600);
    expect(occ.by_state.on_call).toBe(3.5 * 3600);
    expect(occ.shift_seconds).toBe(5 * 3600);

    // The overlap is real and acknowledged: five hours of shift inside a
    // four-hour wall-clock span.
    expect(occ.shift_seconds).toBeGreaterThan(4 * 3600);

    // And the invariant that matters anyway.
    const occupancyPct = occ.by_state.on_call / occ.shift_seconds;
    expect(occupancyPct).toBeLessThanOrEqual(1);
    expect(occupancyPct).toBeCloseTo(0.7, 6);
    // `shift_seconds` is exactly the sum of the five non-offline states, so no
    // state can be counted into one and not the other.
    const nonOffline = (Object.entries(occ.by_state) as [string, number][])
      .filter(([state]) => state !== 'offline')
      .reduce((acc, [, seconds]) => acc + seconds, 0);
    expect(occ.shift_seconds).toBe(nonOffline);
  });

  it('the per-bucket blocks sum to the window block, over three days', async () => {
    // `totals.occupancy` is folded from every occupancy row in ONE pass rather than
    // by adding the buckets' `shift_seconds` together — same rows, same answer, and
    // it keeps the unknown-state and negative-interval guards in one place. That
    // makes "the two agree" a real claim rather than a tautology, and a bucket
    // split that lost or duplicated a fragment breaks exactly this equality.
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-18T22:00:00Z'),
    });
    // A shift straddling two midnights, so intervals are split across three buckets.
    await insertAgentShift(session, [
      ['available', new Date('2026-08-18T22:00:00Z')],
      ['on_call', new Date('2026-08-19T01:00:00Z')],
      ['wrapup', new Date('2026-08-20T02:00:00Z')],
      ['offline', new Date('2026-08-20T03:00:00Z')],
    ]);
    await close(session.id as string, new Date('2026-08-20T03:00:00Z'));

    const stats = await agencyAgentStatsRepository.stats(scope, {
      from: new Date('2026-08-18T00:00:00Z'),
      to: new Date('2026-08-21T00:00:00Z'),
      bucket: 'day',
    });

    const sumBuckets = (state: 'available' | 'on_call' | 'wrapup' | 'offline') =>
      stats.buckets.reduce((acc, b) => acc + b.occupancy.by_state[state], 0);

    expect(sumBuckets('available')).toBe(stats.totals.occupancy.by_state.available);
    expect(sumBuckets('on_call')).toBe(stats.totals.occupancy.by_state.on_call);
    expect(sumBuckets('wrapup')).toBe(stats.totals.occupancy.by_state.wrapup);
    expect(sumBuckets('offline')).toBe(stats.totals.occupancy.by_state.offline);
    expect(stats.buckets.reduce((acc, b) => acc + b.occupancy.shift_seconds, 0))
      .toBe(stats.totals.occupancy.shift_seconds);

    // And the absolute values, so the equality above cannot be satisfied by both
    // sides being wrong the same way. available 22:00→01:00 = 3h; on_call
    // 01:00 (19th) → 02:00 (20th) = 25h; wrapup 1h.
    expect(stats.totals.occupancy.by_state.available).toBe(3 * 3600);
    expect(stats.totals.occupancy.by_state.on_call).toBe(25 * 3600);
    expect(stats.totals.occupancy.by_state.wrapup).toBe(3600);
  });

  it('another tenant\'s session with the same agent id contributes nothing', async () => {
    // The scope on `sess` is `s.tenant_id`/`s.account_id`, and `agent_user_id` is
    // master's opaque id — two tenants can legitimately hold the same string. An
    // unscoped `sess` would fold a stranger's shift into this agent's occupancy,
    // and the symptom would be a plausible number rather than an error.
    const mine = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });
    const theirs = await insertAgencyCampaign({
      default_timezone: 'UTC', status: 'stopped', tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT,
    });

    const mineSession = await insertAgentSession(mine.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-18T09:00:00Z'),
    });
    await insertAgentShift(mineSession, [
      ['available', new Date('2026-08-18T09:00:00Z')],
      ['offline', new Date('2026-08-18T10:00:00Z')],
    ]);

    const theirSession = await insertAgentSession(theirs.id as string, {
      agent_user_id: AGENT, tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT,
      joined_at: new Date('2026-08-18T09:00:00Z'),
    });
    await insertAgentShift(theirSession, [
      ['available', new Date('2026-08-18T09:00:00Z')],
      ['on_call', new Date('2026-08-18T10:00:00Z')],
      ['offline', new Date('2026-08-18T18:00:00Z')],
    ]);

    const occ = await occupancyOf();
    expect(occ.by_state.available).toBe(3600);
    // The other tenant's eight hours on call are not here.
    expect(occ.by_state.on_call).toBe(0);
    expect(occ.shift_seconds).toBe(3600);
  });

  it('a session with no events at all reads as zeros, never as an inference', async () => {
    // The pre-migration-105 case. `agency_agent_sessions.state_since` is a snapshot
    // every transition overwrites, so reconstructing from it would attribute the
    // agent's ENTIRE history to whichever state they happen to be in now. Zeros are
    // the honest answer, and they are the same zeros a failed occupancy read
    // degrades to — which is a documented contract limitation, not an accident.
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });
    await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, state: 'on_call',
      joined_at: new Date('2026-08-18T09:00:00Z'),
      state_since: new Date('2026-08-18T09:00:00Z'),
    });

    const occ = await occupancyOf();
    expect(occ).toEqual({
      shift_seconds: 0,
      by_state: { available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0, offline: 0 },
    });
  });
});
