import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, uuidFor } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { agencyAgentStatsRepository } = await import('../../../src/db/repositories/agency.repository.js');
const {
  insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession,
  insertAgentShift,
} = await import('./agency-factories.js');

/**
 * ─── PER-CAMPAIGN TIMEZONE BUCKETING, BEHAVIOURALLY ─────────────────────────
 *
 * Modelled on `test/integration/agency/agency-campaign-stats.test.ts` — same
 * `vi.mock` of the connection, same `await import` ordering, same
 * `beforeEach(truncateAll)` / `afterAll(closeTestPool)`, same "drive the
 * repository method, assert the returned payload" shape.
 *
 * ── Why this file has to exist, and what the unit tier cannot say ───────────
 *
 * `agent-stats-repository.test.ts` mocks the pool, so every assertion it makes
 * about bucketing is an assertion about a STRING: that the SQL contains
 * `date_trunc('day', (a.dialed_at AT TIME ZONE COALESCE(z.name, 'UTC')))`. That
 * is a good guard against the expression being rewritten, and it is not evidence
 * that Postgres cuts the day where the design says it does. Four separate claims
 * in the design are pure SQL semantics and had no test of any kind:
 *
 *   1. **The zone comes off the ATTEMPT's own campaign, per row.** A cross-campaign
 *      read cuts each attempt in its own zone. The string proves the expression is
 *      there; only a query proves a `+13` campaign and a `-5` campaign put the same
 *      INSTANT in different local days.
 *   2. **`totals`, `buckets[]` and `by_campaign[]` reconcile EXACTLY.** This is the
 *      headline property of the payload — the endpoint's docstring calls it
 *      "structural rather than a claim two queries have to keep agreeing on" —
 *      and nothing anywhere demonstrated it against real rows in two zones.
 *   3. **A DST day is measured as the 23 or 25 hours it actually was.** That
 *      property lives entirely in `(gs AT TIME ZONE zone)` converting a bare local
 *      timestamp back to an instant. It cannot be observed in SQL text at all.
 *   4. **An unresolvable zone falls back to UTC instead of raising `22023`.** One
 *      campaign with a typo would otherwise 500 the whole record — every other
 *      campaign's numbers included. The `LEFT JOIN pg_timezone_names` is the guard
 *      and the test below also pins that the raw expression really does raise, so
 *      the guard is shown to be load-bearing rather than decorative.
 *
 * ── ⚠️ THIS FILE HAS NOT BEEN EXECUTED ──────────────────────────────────────
 *
 * There is no Docker daemon in the environment it was written in, so
 * `npm run test:integration` could not be run. It type-checks under
 * `tsconfig.test.json` (`npm run lint:test:agency`, which `npm run lint` now
 * gates) and it mirrors the file named above statement for statement. The
 * arithmetic in each assertion is derived from the tz database offsets stated
 * inline beside it; nothing is copied from an observed run.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const AGENT = uuidFor('u-ravi');

/**
 * The two zones, and why these two.
 *
 * `Pacific/Auckland` is UTC+13 in January (NZDT) and `America/New_York` is UTC-5
 * in January (EST), so an instant near either side of midnight lands in a
 * DIFFERENT calendar day from UTC in opposite directions. A pair of zones on the
 * same side of UTC would let a bug that used UTC for one of them pass.
 */
const NZ = 'Pacific/Auckland';
const NY = 'America/New_York';

/** A dialled, bridged, ended attempt for one agent — the shape `/stats` counts. */
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
    dialed_at: dialedAt,
    bridged_at: dialedAt,
    ended_at: new Date(dialedAt.getTime() + 60_000),
    ...overrides,
  });
}

const scope = { tenantId: T, accountId: A, agentUserId: AGENT };

describe('agent stats — bucketing in each campaign\'s own timezone (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  // ── 1. The zone comes off the row's own campaign ──────────────────────────

  it('puts 00:30 local on a UTC+13 campaign in the LOCAL day, not the UTC one', async () => {
    // 2026-01-15T11:30:00Z is 2026-01-16 00:30 NZDT (UTC+13 in January). The UTC
    // day is the 15th and the campaign's day is the 16th, so the two answers are
    // distinguishable — which is the whole reason this instant was chosen rather
    // than a mid-afternoon one.
    const campaign = await insertAgencyCampaign({ default_timezone: NZ, status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, { agent_user_id: AGENT });
    await dialled(campaign.id as string, session.id as string, new Date('2026-01-15T11:30:00Z'));

    const stats = await agencyAgentStatsRepository.stats(scope, {
      from: new Date('2026-01-10T00:00:00Z'),
      to: new Date('2026-01-20T00:00:00Z'),
      bucket: 'day',
    });

    expect(stats.buckets.map((b) => b.bucket_start)).toEqual(['2026-01-16']);
    expect(stats.totals.attempts).toBe(1);
  });

  it('puts 23:30 local on a UTC-5 campaign in the LOCAL day, not the UTC one', async () => {
    // 2026-01-16T04:30:00Z is 2026-01-15 23:30 EST (UTC-5). The UTC day is the
    // 16th and the campaign's day is the 15th — the mirror image of the case
    // above, so a bug that hard-coded ONE non-UTC zone cannot pass both.
    const campaign = await insertAgencyCampaign({ default_timezone: NY, status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, { agent_user_id: AGENT });
    await dialled(campaign.id as string, session.id as string, new Date('2026-01-16T04:30:00Z'));

    const stats = await agencyAgentStatsRepository.stats(scope, {
      from: new Date('2026-01-10T00:00:00Z'),
      to: new Date('2026-01-20T00:00:00Z'),
      bucket: 'day',
    });

    expect(stats.buckets.map((b) => b.bucket_start)).toEqual(['2026-01-15']);
  });

  it('cuts each campaign in ITS OWN zone within one query', async () => {
    // The same instant, two campaigns, two different local days. This is the
    // claim "the zone comes off the attempt's own campaign, PER ROW" — a query
    // that resolved one zone for the whole statement would put both attempts in
    // the same bucket and still look plausible.
    const nz = await insertAgencyCampaign({ default_timezone: NZ, status: 'stopped' });
    const ny = await insertAgencyCampaign({ default_timezone: NY, status: 'stopped' });
    const nzSession = await insertAgentSession(nz.id as string, { agent_user_id: AGENT });
    // The NZ session is closed so the one-live-session-per-(tenant,
    // agent) unique index permits the second one.
    await getTestPool().query('UPDATE agency_agent_sessions SET left_at = now() WHERE id = $1',
      [nzSession.id]);
    const nySession = await insertAgentSession(ny.id as string, { agent_user_id: AGENT });

    const instant = new Date('2026-01-15T11:30:00Z'); // 01-16 00:30 NZDT / 01-15 06:30 EST
    await dialled(nz.id as string, nzSession.id as string, instant);
    await dialled(ny.id as string, nySession.id as string, instant);

    const stats = await agencyAgentStatsRepository.stats(scope, {
      from: new Date('2026-01-10T00:00:00Z'),
      to: new Date('2026-01-20T00:00:00Z'),
      bucket: 'day',
    });

    expect(stats.buckets.map((b) => b.bucket_start)).toEqual(['2026-01-15', '2026-01-16']);
    const byLabel = new Map(stats.buckets.map((b) => [b.bucket_start, b]));
    expect(byLabel.get('2026-01-15')?.attempts).toBe(1); // the New York one
    expect(byLabel.get('2026-01-16')?.attempts).toBe(1); // the Auckland one
  });

  // ── 2. The reconciliation property ────────────────────────────────────────

  it('TOTALS, BUCKETS and BY_CAMPAIGN reconcile exactly across two zones', async () => {
    // ── The payload's headline property, and nothing proved it ───────────────
    //
    // Because the zone comes off the row's own campaign, every attempt lands in
    // exactly ONE bucket — so the three views of the same rows must agree to the
    // unit. The failure this catches is not a rounding error: a bucket expression
    // that put a row in two buckets (a join fan-out, a series off by one stride)
    // would make `buckets[]` sum HIGHER than `by_campaign[]`, and a row that fell
    // through every bucket would make it lower. Both look like plausible payloads.
    const nz = await insertAgencyCampaign({ default_timezone: NZ, status: 'stopped' });
    const ny = await insertAgencyCampaign({ default_timezone: NY, status: 'stopped' });
    const nzSession = await insertAgentSession(nz.id as string, { agent_user_id: AGENT });
    await getTestPool().query('UPDATE agency_agent_sessions SET left_at = now() WHERE id = $1',
      [nzSession.id]);
    const nySession = await insertAgentSession(ny.id as string, { agent_user_id: AGENT });

    // Nine attempts spread over three UTC days, deliberately including instants
    // near local midnight in both zones so the two campaigns' day boundaries fall
    // in different places.
    const instants = [
      '2026-01-14T11:00:00Z', '2026-01-14T11:30:00Z', '2026-01-14T23:00:00Z',
      '2026-01-15T04:30:00Z', '2026-01-15T11:30:00Z', '2026-01-15T12:00:00Z',
      '2026-01-16T00:30:00Z', '2026-01-16T11:30:00Z', '2026-01-16T18:00:00Z',
    ];
    for (const [i, iso] of instants.entries()) {
      const onNz = i % 2 === 0;
      await dialled(
        (onNz ? nz.id : ny.id) as string,
        (onNz ? nzSession.id : nySession.id) as string,
        new Date(iso),
      );
    }

    const stats = await agencyAgentStatsRepository.stats(scope, {
      from: new Date('2026-01-10T00:00:00Z'),
      to: new Date('2026-01-20T00:00:00Z'),
      bucket: 'day',
    });

    const sum = (rows: readonly { attempts: number }[]) =>
      rows.reduce((acc, r) => acc + r.attempts, 0);

    expect(stats.totals.attempts).toBe(9);
    // Exactly, not approximately, and in both directions at once.
    expect(sum(stats.buckets)).toBe(9);
    expect(sum(stats.by_campaign)).toBe(9);
    expect(sum(stats.buckets)).toBe(sum(stats.by_campaign));
    // Two campaigns, and `campaigns` counts them rather than the rows.
    expect(stats.totals.campaigns).toBe(2);
    expect(stats.by_campaign).toHaveLength(2);

    // The same reconciliation on every additive field, because a fan-out would
    // multiply the DURATIONS as visibly as the counts and each is summed
    // independently in the fold.
    for (const field of ['connected', 'successes', 'talk_seconds', 'wrapup_seconds'] as const) {
      const fromBuckets = stats.buckets.reduce((a, b) => a + b[field], 0);
      const fromCampaigns = stats.by_campaign.reduce((a, b) => a + b[field], 0);
      expect(fromBuckets, field).toBe(stats.totals[field]);
      expect(fromCampaigns, field).toBe(stats.totals[field]);
    }

    // Bucket labels are unique and ascending — the fold keys a Map on the label
    // and sorts lexicographically, which IS chronological for `YYYY-MM-DD`.
    const labels = stats.buckets.map((b) => b.bucket_start);
    expect(new Set(labels).size).toBe(labels.length);
    expect([...labels]).toEqual([...labels].sort());
  });

  // ── 3. DST: a day that is not 24 hours ────────────────────────────────────

  it('measures a spring-forward day as 23 hours, not 24', async () => {
    // ── Why this can only be an integration test ────────────────────────────
    //
    // The occupancy read walks the buckets an interval spans with
    // `generate_series(trunc(started), trunc(ended), interval '1 day')` over BARE
    // LOCAL timestamps, then converts each boundary back with
    // `(gs AT TIME ZONE zone)`. That round trip is the only thing that makes a DST
    // day the length it really was, and it is invisible in SQL text: an
    // implementation that formatted the boundary as an instant, or that added
    // `interval '24 hours'` instead of `interval '1 day'`, produces the same
    // string shape and a 24-hour answer.
    //
    // US DST 2025 began on Sunday 9 March. In America/New_York:
    //   local midnight 2025-03-09 = 2025-03-09T05:00:00Z  (EST, UTC-5)
    //   local midnight 2025-03-10 = 2025-03-10T04:00:00Z  (EDT, UTC-4)
    // — 23 hours apart. The clocks skipped 02:00→03:00 local.
    const campaign = await insertAgencyCampaign({ default_timezone: NY, status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT,
      joined_at: new Date('2025-03-09T05:00:00Z'),
    });

    // `available` for the whole local day, then `offline`. The closing event is
    // seeded rather than left to `lead()` returning NULL, so the measured length
    // does not depend on `now()`.
    await insertAgentShift(session, [
      ['available', new Date('2025-03-09T05:00:00Z')],
      ['offline', new Date('2025-03-10T04:00:00Z')],
    ]);

    const stats = await agencyAgentStatsRepository.stats(scope, {
      // The window closes an hour AFTER the last event so that event is inside it
      // (`in_window` is `at >= from AND at < to`) and the `available` interval is
      // bounded by its successor rather than by the window edge.
      from: new Date('2025-03-09T05:00:00Z'),
      to: new Date('2025-03-10T05:00:00Z'),
      bucket: 'day',
    });

    const march9 = stats.buckets.find((b) => b.bucket_start === '2025-03-09');
    expect(march9).toBeDefined();
    // 23 hours. A 24-hour answer here is the bug; so is 82_800 appearing on the
    // 10th instead of the 9th.
    expect(march9?.occupancy.by_state.available).toBe(23 * 3600);
    expect(march9?.occupancy.shift_seconds).toBe(23 * 3600);
  });

  it('measures a fall-back day as 25 hours, not 24', async () => {
    // US DST 2025 ended on Sunday 2 November. In America/New_York:
    //   local midnight 2025-11-02 = 2025-11-02T04:00:00Z  (EDT, UTC-4)
    //   local midnight 2025-11-03 = 2025-11-03T05:00:00Z  (EST, UTC-5)
    // — 25 hours apart. The local hour 01:00–02:00 happened twice.
    const campaign = await insertAgencyCampaign({ default_timezone: NY, status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT,
      joined_at: new Date('2025-11-02T04:00:00Z'),
    });
    await insertAgentShift(session, [
      ['available', new Date('2025-11-02T04:00:00Z')],
      ['offline', new Date('2025-11-03T05:00:00Z')],
    ]);

    const stats = await agencyAgentStatsRepository.stats(scope, {
      from: new Date('2025-11-02T04:00:00Z'),
      to: new Date('2025-11-03T06:00:00Z'),
      bucket: 'day',
    });

    const nov2 = stats.buckets.find((b) => b.bucket_start === '2025-11-02');
    expect(nov2?.occupancy.by_state.available).toBe(25 * 3600);
    expect(nov2?.occupancy.shift_seconds).toBe(25 * 3600);
  });

  // ── 4. An unresolvable zone must not 500 the record ───────────────────────

  it('the RAW expression really does raise 22023 — so the guard is load-bearing', async () => {
    // Asserted first, and directly, because every fallback test below is only
    // interesting if this is true. If a future Postgres started accepting an
    // unknown zone, these tests would all pass for the wrong reason and the
    // `LEFT JOIN pg_timezone_names` would look like dead weight.
    await expect(
      getTestPool().query(`SELECT now() AT TIME ZONE 'Mars/Olympus'`),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it.each([
    ['Mars/Olympus', 'a zone that does not exist'],
    ['Asia/Kolkatta', 'a plausible typo of a real zone'],
    ['', 'an empty string, which the NOT NULL column permits'],
    ['utc', 'the right zone in the wrong case — matched case-insensitively, so NOT a fallback'],
  ])('resolves default_timezone=%s (%s) without raising', async (zone) => {
    // The `LEFT JOIN pg_timezone_names z ON lower(z.name) = lower(c.default_timezone)`
    // plus `COALESCE(z.name, 'UTC')` is what turns each of these into an answer
    // instead of a 500 carrying the database's error text. One campaign with a
    // typo would otherwise take down every OTHER campaign's numbers in the same
    // payload — the record is cross-campaign by construction.
    const campaign = await insertAgencyCampaign({ default_timezone: zone, status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, { agent_user_id: AGENT });
    // 06:30Z — the same calendar day in UTC and in every zone within ±6 hours, so
    // the label below is the UTC one whether the fallback fired or the lowercase
    // `utc` matched.
    await dialled(campaign.id as string, session.id as string, new Date('2026-01-15T06:30:00Z'));

    const stats = await agencyAgentStatsRepository.stats(scope, {
      from: new Date('2026-01-10T00:00:00Z'),
      to: new Date('2026-01-20T00:00:00Z'),
      bucket: 'day',
    });
    expect(stats.totals.attempts).toBe(1);
    expect(stats.buckets.map((b) => b.bucket_start)).toEqual(['2026-01-15']);
  });

  it('a garbage zone falls back to UTC while a REAL zone beside it still shifts', async () => {
    // The fallback must be per-row, like the resolution it replaces. A statement
    // that resolved one zone for all rows — or that failed closed to UTC for
    // every row once one lookup missed — would put both attempts in the UTC day
    // and read as correct on a single-campaign fixture.
    const broken = await insertAgencyCampaign({ default_timezone: 'Mars/Olympus', status: 'stopped' });
    const real = await insertAgencyCampaign({ default_timezone: NZ, status: 'stopped' });
    const brokenSession = await insertAgentSession(broken.id as string, { agent_user_id: AGENT });
    await getTestPool().query('UPDATE agency_agent_sessions SET left_at = now() WHERE id = $1',
      [brokenSession.id]);
    const realSession = await insertAgentSession(real.id as string, { agent_user_id: AGENT });

    const instant = new Date('2026-01-15T11:30:00Z'); // UTC: 01-15 · NZDT: 01-16 00:30
    await dialled(broken.id as string, brokenSession.id as string, instant);
    await dialled(real.id as string, realSession.id as string, instant);

    const stats = await agencyAgentStatsRepository.stats(scope, {
      from: new Date('2026-01-10T00:00:00Z'),
      to: new Date('2026-01-20T00:00:00Z'),
      bucket: 'day',
    });
    expect(stats.buckets.map((b) => b.bucket_start)).toEqual(['2026-01-15', '2026-01-16']);
    expect(stats.totals.attempts).toBe(2);
  });

  // ── 5. Week and month boundaries, not just day ────────────────────────────

  it('bucket=week cuts on MONDAY, in the campaign\'s zone', async () => {
    // `date_trunc('week', ...)` is ISO — Monday-based — and that is a Postgres
    // property, not something the SQL text can state. The unit tier pins that the
    // statement says `'week'`; only a query says Monday rather than Sunday, and
    // the difference is one whole day of attempts moving between weeks on the
    // screen an agent's performance is discussed against.
    //
    // 2026-01-14 is a Wednesday; its ISO week begins Monday 2026-01-12.
    // 2026-01-19 is the following Monday and begins its own week.
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, { agent_user_id: AGENT });
    await dialled(campaign.id as string, session.id as string, new Date('2026-01-14T09:00:00Z'));
    // Sunday 2026-01-18 — the LAST day of the 01-12 week under an ISO cut and the
    // FIRST day of the next one under a Sunday cut. This is the row that tells
    // the two apart.
    await dialled(campaign.id as string, session.id as string, new Date('2026-01-18T09:00:00Z'));
    await dialled(campaign.id as string, session.id as string, new Date('2026-01-19T09:00:00Z'));

    const stats = await agencyAgentStatsRepository.stats(scope, {
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-02-01T00:00:00Z'),
      bucket: 'week',
    });

    expect(stats.buckets.map((b) => b.bucket_start)).toEqual(['2026-01-12', '2026-01-19']);
    const byLabel = new Map(stats.buckets.map((b) => [b.bucket_start, b.attempts]));
    // Wednesday AND Sunday in the Monday-anchored week.
    expect(byLabel.get('2026-01-12')).toBe(2);
    expect(byLabel.get('2026-01-19')).toBe(1);
    expect(stats.totals.attempts).toBe(3);
  });

  it('bucket=month cuts on the 1st, in the campaign\'s zone', async () => {
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, { agent_user_id: AGENT });
    await dialled(campaign.id as string, session.id as string, new Date('2026-01-31T23:00:00Z'));
    await dialled(campaign.id as string, session.id as string, new Date('2026-02-01T00:30:00Z'));
    await dialled(campaign.id as string, session.id as string, new Date('2026-02-28T12:00:00Z'));

    const stats = await agencyAgentStatsRepository.stats(scope, {
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-03-01T00:00:00Z'),
      bucket: 'month',
    });

    // The label is the month's FIRST day, formatted `YYYY-MM-DD` for all three
    // units — a bucket start is a date, and a `month` label carrying a time would
    // invite a reader to treat it as an instant.
    expect(stats.buckets.map((b) => b.bucket_start)).toEqual(['2026-01-01', '2026-02-01']);
    const byLabel = new Map(stats.buckets.map((b) => [b.bucket_start, b.attempts]));
    expect(byLabel.get('2026-01-01')).toBe(1);
    expect(byLabel.get('2026-02-01')).toBe(2);
  });

  it('a month boundary moves with the CAMPAIGN\'s zone, not with UTC', async () => {
    // 2026-02-01T11:30:00Z is 2026-02-02 00:30 NZDT, and also 2026-01-31 22:30
    // NZDT would be 2026-02-01T09:30:00Z... so the interesting instant is the one
    // just BEFORE UTC month end: 2026-01-31T12:00:00Z is 2026-02-01 01:00 NZDT.
    // UTC says January; the campaign says February.
    const campaign = await insertAgencyCampaign({ default_timezone: NZ, status: 'stopped' });
    const session = await insertAgentSession(campaign.id as string, { agent_user_id: AGENT });
    await dialled(campaign.id as string, session.id as string, new Date('2026-01-31T12:00:00Z'));

    const stats = await agencyAgentStatsRepository.stats(scope, {
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-03-01T00:00:00Z'),
      bucket: 'month',
    });
    expect(stats.buckets.map((b) => b.bucket_start)).toEqual(['2026-02-01']);
  });

  it('echoes the bucket unit and the window it was given', async () => {
    // Cheap, and it is what makes every assertion above legible: the payload says
    // which grouping produced it, so a reader of a failing diff can tell a wrong
    // bucket from a wrong window.
    const from = new Date('2026-01-10T00:00:00Z');
    const to = new Date('2026-01-20T00:00:00Z');
    const stats = await agencyAgentStatsRepository.stats(scope, { from, to, bucket: 'week' });
    expect(stats.bucket).toBe('week');
    expect(stats.from).toBe(from.toISOString());
    expect(stats.to).toBe(to.toISOString());
    expect(stats.agent_user_id).toBe(AGENT);
  });
});
