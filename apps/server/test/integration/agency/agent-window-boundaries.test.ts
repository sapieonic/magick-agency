import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, uuidFor } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { agencyAgentStatsRepository, agencyAttemptRepository } =
  await import('../../../src/db/repositories/agency.repository.js');
const {
  insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt, insertAgentSession,
} = await import('./agency-factories.js');

/**
 * ─── THE TWO WINDOWS, AT THEIR EXACT BOUNDARIES ─────────────────────────────
 *
 * Modelled on `test/integration/agency/agency-spine-read.test.ts` — same
 * connection mock, same `await import` order, same "seed the shapes a naive query
 * gets wrong, then drive the repository" structure.
 *
 * ── The divergence this file exists to pin ──────────────────────────────────
 *
 * The two agent routes bound different columns with different inclusivity, and
 * both choices are deliberate:
 *
 *   * `/stats` buckets and bounds `dialed_at`, with `to` **EXCLUSIVE**
 *     (`>= from AND < to`). Half-open is the only shape that tiles: `[Mon, Tue)`
 *     and `[Tue, Wed)` cover Tuesday exactly once, which an aggregate anyone might
 *     sum has to guarantee.
 *   * `/attempts` bounds `created_at`, with `to` **INCLUSIVE** (`<= to`). Right for
 *     a "show me up to here" list filter, wrong for an aggregate.
 *
 * The difference is invisible in a URL, both routes sit at adjacent paths, and
 * before this file **neither inclusivity had a test at its boundary**. The unit
 * tier asserts the SQL contains `< $3` and `<= $n`, which is a guard against the
 * operator being rewritten and says nothing about which rows come back — and an
 * off-by-one at a day boundary is exactly the failure that gets noticed as
 * "yesterday's total changed overnight".
 *
 * The third case is the sharpest: an attempt **created but never dialled** must
 * appear in `/attempts` and must NOT appear in `/stats`. That is not a rounding
 * difference, it is two endpoints deliberately disagreeing about whether a row
 * exists, and nothing anywhere demonstrated it.
 *
 * ── ⚠️ THIS FILE HAS NOT BEEN EXECUTED ──────────────────────────────────────
 *
 * No Docker daemon was available, so `npm run test:integration` could not be run.
 * It type-checks under `tsconfig.test.json` (gated by `npm run lint`), and every
 * assertion here is mechanical: each seeded row's timestamp is either exactly a
 * bound or one millisecond off it, and the expectation is which side of the
 * comparison that puts it on.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const AGENT = uuidFor('u-ravi');

/** The window both endpoints are asked about. */
const FROM = new Date('2026-08-17T00:00:00.000Z');
const TO = new Date('2026-08-19T00:00:00.000Z');

const scope = { tenantId: T, accountId: A, agentUserId: AGENT };

async function seedAgent() {
  const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'stopped' });
  const session = await insertAgentSession(campaign.id as string, { agent_user_id: AGENT });
  return { campaign, session };
}

/**
 * An attempt with `created_at` and `dialed_at` set independently.
 *
 * They are separate parameters on purpose: the whole point of this file is that
 * the two endpoints read different columns, so a helper that derived one from the
 * other would make every case agree by construction.
 */
async function attempt(
  campaignId: string,
  sessionId: string,
  times: { createdAt: Date; dialedAt: Date | null },
  overrides: Record<string, unknown> = {},
) {
  const contact = await insertAgencyContact(campaignId, { state: 'completed' });
  return insertAgencyAttempt(campaignId, contact.id as string, {
    state: times.dialedAt ? 'ended' : 'queued',
    ...(times.dialedAt ? { outcome: 'connected' } : {}),
    reserved_agent_id: sessionId,
    created_at: times.createdAt,
    dialed_at: times.dialedAt,
    ...(times.dialedAt
      ? { bridged_at: times.dialedAt, ended_at: new Date(times.dialedAt.getTime() + 30_000) }
      : {}),
    ...overrides,
  });
}

describe('agent window boundaries — /stats is half-open, /attempts is closed (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestPool();
  });

  // ── /stats: `to` is EXCLUSIVE on dialed_at ────────────────────────────────

  it('/stats INCLUDES an attempt dialled exactly at `from`', async () => {
    const { campaign, session } = await seedAgent();
    await attempt(campaign.id as string, session.id as string, { createdAt: FROM, dialedAt: FROM });

    const stats = await agencyAgentStatsRepository.stats(scope, { from: FROM, to: TO, bucket: 'day' });
    expect(stats.totals.attempts).toBe(1);
    expect(stats.buckets.map((b) => b.bucket_start)).toEqual(['2026-08-17']);
  });

  it('/stats EXCLUDES an attempt dialled exactly at `to`', async () => {
    // The half-open guarantee, at the one instant where it is decidable. A `<=`
    // here would make `[Mon, Tue)` and `[Tue, Wed)` both contain Tuesday's first
    // dial — so two adjacent requests would sum to more attempts than the agent
    // made, and the duplicate would be one row at midnight that nobody looks at.
    const { campaign, session } = await seedAgent();
    await attempt(campaign.id as string, session.id as string, { createdAt: TO, dialedAt: TO });

    const stats = await agencyAgentStatsRepository.stats(scope, { from: FROM, to: TO, bucket: 'day' });
    expect(stats.totals.attempts).toBe(0);
    expect(stats.buckets).toEqual([]);
    expect(stats.by_campaign).toEqual([]);
  });

  it('/stats includes an attempt dialled one millisecond before `to`', async () => {
    // The other side of the same comparison, so "excluded at `to`" cannot be
    // passing because the window is simply too narrow.
    const { campaign, session } = await seedAgent();
    const justInside = new Date(TO.getTime() - 1);
    await attempt(campaign.id as string, session.id as string,
      { createdAt: justInside, dialedAt: justInside });

    const stats = await agencyAgentStatsRepository.stats(scope, { from: FROM, to: TO, bucket: 'day' });
    expect(stats.totals.attempts).toBe(1);
    // 2026-08-18T23:59:59.999Z — the 18th, not the 19th.
    expect(stats.buckets.map((b) => b.bucket_start)).toEqual(['2026-08-18']);
  });

  it('/stats excludes an attempt dialled one millisecond before `from`', async () => {
    const { campaign, session } = await seedAgent();
    const justOutside = new Date(FROM.getTime() - 1);
    await attempt(campaign.id as string, session.id as string,
      { createdAt: justOutside, dialedAt: justOutside });

    const stats = await agencyAgentStatsRepository.stats(scope, { from: FROM, to: TO, bucket: 'day' });
    expect(stats.totals.attempts).toBe(0);
  });

  it('/stats tiles: two adjacent windows count each attempt exactly once', async () => {
    // The property the half-open shape exists for, stated as the sum a caller
    // would actually take. Three attempts, one exactly on the shared boundary.
    const { campaign, session } = await seedAgent();
    const mid = new Date('2026-08-18T00:00:00.000Z');
    for (const dialedAt of [
      new Date('2026-08-17T09:00:00.000Z'),
      mid,                                        // exactly the shared bound
      new Date('2026-08-18T09:00:00.000Z'),
    ]) {
      await attempt(campaign.id as string, session.id as string, { createdAt: dialedAt, dialedAt });
    }

    const first = await agencyAgentStatsRepository.stats(scope, { from: FROM, to: mid, bucket: 'day' });
    const second = await agencyAgentStatsRepository.stats(scope, { from: mid, to: TO, bucket: 'day' });
    const whole = await agencyAgentStatsRepository.stats(scope, { from: FROM, to: TO, bucket: 'day' });

    expect(first.totals.attempts).toBe(1);
    expect(second.totals.attempts).toBe(2);   // the boundary row belongs to the LATER window
    expect(first.totals.attempts + second.totals.attempts).toBe(whole.totals.attempts);
    expect(whole.totals.attempts).toBe(3);
  });

  // ── /attempts: `to` is INCLUSIVE on created_at ─────────────────────────────

  const listFor = (from?: Date, to?: Date) =>
    agencyAttemptRepository.listForAgent({
      tenantId: T, accountId: A, agentUserId: AGENT,
      filters: { ...(from ? { from } : {}), ...(to ? { to } : {}) },
      limit: 50,
    });

  it('/attempts INCLUDES an attempt created exactly at `to`', async () => {
    // Inclusive, and deliberately the opposite of `/stats`. A supervisor filtering
    // "up to the 19th" means the 19th, and this is a list rather than something
    // anyone sums across adjacent pages.
    const { campaign, session } = await seedAgent();
    const row = await attempt(campaign.id as string, session.id as string,
      { createdAt: TO, dialedAt: TO });

    const page = await listFor(FROM, TO);
    expect(page.rows.map((r) => r.id)).toEqual([row.id]);
  });

  it('/attempts INCLUDES an attempt created exactly at `from`', async () => {
    const { campaign, session } = await seedAgent();
    const row = await attempt(campaign.id as string, session.id as string,
      { createdAt: FROM, dialedAt: FROM });

    const page = await listFor(FROM, TO);
    expect(page.rows.map((r) => r.id)).toEqual([row.id]);
  });

  it('/attempts excludes an attempt one millisecond outside either bound', async () => {
    const { campaign, session } = await seedAgent();
    const before = new Date(FROM.getTime() - 1);
    const after = new Date(TO.getTime() + 1);
    await attempt(campaign.id as string, session.id as string, { createdAt: before, dialedAt: before });
    await attempt(campaign.id as string, session.id as string, { createdAt: after, dialedAt: after });

    expect((await listFor(FROM, TO)).rows).toEqual([]);
    // Both rows exist — the filter excluded them, the seed did not fail.
    expect((await listFor()).rows).toHaveLength(2);
  });

  it('/attempts bounds `created_at`, NOT `dialed_at`', async () => {
    // The columns are chosen independently here, which is the only way to tell the
    // two apart. A row created inside the window and dialled outside it must be
    // returned; a row created outside and dialled inside must not.
    const { campaign, session } = await seedAgent();
    const inside = await attempt(campaign.id as string, session.id as string, {
      createdAt: new Date('2026-08-18T09:00:00.000Z'),
      dialedAt: new Date('2026-08-25T09:00:00.000Z'),   // long after `to`
    });
    await attempt(campaign.id as string, session.id as string, {
      createdAt: new Date('2026-08-10T09:00:00.000Z'),  // long before `from`
      dialedAt: new Date('2026-08-18T09:00:00.000Z'),
    });

    const page = await listFor(FROM, TO);
    expect(page.rows.map((r) => r.id)).toEqual([inside.id]);
  });

  // ── The deliberate divergence: created but never dialled ──────────────────

  it('an attempt that was NEVER DIALLED appears in /attempts and not in /stats', async () => {
    // ── The one case where the two endpoints must disagree about a row ───────
    //
    // `dialed_at` is NULL on an attempt that never left the building — a dispatch
    // the engine dropped, a row the reaper swept pre-dial. Those are exactly the
    // failures a complaint is about, so a date-filtered LIST that silently omitted
    // them would hide the evidence; `/stats` is aggregating DIALS, so counting a
    // row that was never dialled would put a phantom in the denominator of
    // `connect_rate_pct`.
    //
    // Both endpoints are asked the same question over the same window here, so the
    // divergence is the assertion rather than a side effect of two fixtures.
    const { campaign, session } = await seedAgent();
    const createdAt = new Date('2026-08-18T09:00:00.000Z');
    const neverDialled = await attempt(campaign.id as string, session.id as string,
      { createdAt, dialedAt: null });
    const dialledRow = await attempt(campaign.id as string, session.id as string,
      { createdAt, dialedAt: createdAt });

    const page = await listFor(FROM, TO);
    const ids = page.rows.map((r) => r.id);
    expect(ids).toContain(neverDialled.id);
    expect(ids).toContain(dialledRow.id);
    // And it really is NULL on the way out — the projection does not invent one.
    expect(page.rows.find((r) => r.id === neverDialled.id)?.dialed_at).toBeNull();

    const stats = await agencyAgentStatsRepository.stats(scope, { from: FROM, to: TO, bucket: 'day' });
    // One, not two. `a.dialed_at IS NOT NULL` is what makes this the right number,
    // and it is also what makes the partial index `idx_agency_attempts_agent_dialed` unusable by the
    // sibling route.
    expect(stats.totals.attempts).toBe(1);
    expect(stats.buckets).toHaveLength(1);
    expect(stats.buckets[0]?.attempts).toBe(1);
  });

  it('an unbounded /stats window is impossible, so the NULL row can never sneak in', async () => {
    // `parseAgentStatsQuery` makes both bounds required, so there is no "no filter"
    // path on the aggregate for a NULL `dialed_at` to fall through. Asserted here
    // by driving the repository with the widest window the cap allows and showing
    // the row is still absent — i.e. the exclusion is the predicate, not the range.
    const { campaign, session } = await seedAgent();
    await attempt(campaign.id as string, session.id as string,
      { createdAt: new Date('2026-08-18T09:00:00.000Z'), dialedAt: null });

    const stats = await agencyAgentStatsRepository.stats(scope, {
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-12-01T00:00:00Z'),
      bucket: 'month',
    });
    expect(stats.totals.attempts).toBe(0);
    expect(stats.buckets).toEqual([]);
  });
});
