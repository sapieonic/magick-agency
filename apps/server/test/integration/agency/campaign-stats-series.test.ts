import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, uuidFor } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { agencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { insertAgencyCampaign, insertAgencyContact, insertAgencyAttempt } = await import(
  './agency-factories.js'
);

/**
 * ─── THE CAMPAIGN SERIES, BEHAVIOURALLY ─────────────────────────────────────
 *
 * `GET /agency-campaigns/:id/stats/series` (ClickUp 86d45k0bk item 1). Modelled on
 * `agent-stats-timezone-buckets.test.ts` — same `vi.mock` of the connection, same
 * `await import` ordering, same `beforeEach(truncateAll)` / `afterAll(closeTestPool)`,
 * same "drive the repository method, assert the returned payload" shape.
 *
 * ── What the unit tier structurally cannot say ──────────────────────────────
 *
 * `test/unit/agency/campaign-stats-series.test.ts` mocks the pool, so every
 * assertion it makes about bucketing is an assertion about a STRING. That is a good
 * guard against the expression being rewritten and it is not evidence that Postgres
 * does what the design says. Five claims are pure SQL semantics:
 *
 *   1. **Days are cut in the CAMPAIGN's zone, not UTC.** Only a query proves that an
 *      instant which is one calendar day in UTC is the NEXT one in `Asia/Kolkata`.
 *   2. **The window is half-open.** An attempt dialled exactly at `to` must be
 *      absent and one dialled exactly at `from` must be present. `>= $2` / `< $3`
 *      in the text is the intent; the row count is the fact.
 *   3. **Every bucket is present, zeros included.** `generate_series` LEFT JOINed to
 *      the aggregate — the empty day exists only if Postgres emits it.
 *   4. **The spine's upper clip lands on the right bucket.**
 *      `to - interval '1 microsecond'` must include the bucket containing the last
 *      instant of the window and must NOT emit the bucket `to` itself starts. Off by
 *      one in either direction is invisible in SQL text.
 *   5. **The buckets reconcile with the lifetime counters they are PAIRED with,
 *      which are not the obvious ones.** `Σ attempts` = `attempts_total` only while
 *      every attempt's `dialed_at` is inside the window; `Σ connected` =
 *      `human_connects + machine_connects + unclassified_connects` (every BRIDGED
 *      attempt) and NOT `attempts_connected`, which is `outcome = 'connected'`;
 *      `Σ successes` = `attempts_success`. Nothing on the bucket pairs with
 *      `connect_rate_pct`, whose numerator is human connects alone. Two
 *      independently-written statements agreeing about a connect and a conversion is
 *      exactly what cannot be checked by comparing strings.
 *
 * ── ⚠️ THIS FILE HAS NOT BEEN RUN BY `npm run test:integration` ─────────────
 *
 * There is no Docker daemon in the environment it was written in, so the suite's
 * own harness could not be started — the same limitation, and the same disclosure,
 * as `agent-stats-timezone-buckets.test.ts`.
 *
 * It is nonetheless NOT untested SQL. Every statement it drives was executed by
 * hand against a local **PostgreSQL 16.13** during development, over a minimal
 * schema, with fixtures at exactly the boundaries below; the expected values in
 * this file are the values that run produced, and the one-microsecond clip in
 * `statsSeries` fixes a real `AT TIME ZONE` precedence bug that only running it
 * surfaced. What has not been exercised is this file's own harness wiring —
 * `truncateAll`, the factories, and the payload assertions. It type-checks under
 * `tsconfig.test.json` (`npm run lint:test:agency`, which `npm run lint` gates).
 *
 * A later pass ran the SPINE again on 16.13 — `generate_series` between
 * `date_trunc(unit, from AT TIME ZONE 'Asia/Kolkata')` and the same over
 * `to - interval '1 microsecond'`, at all three units — and that run is the source
 * of two facts now written down rather than assumed: a 92-day window that does not
 * begin at local midnight emits **93** day buckets (only a local-midnight `from`
 * gives 92), and `from=2026-05-11&bucket=month` emits a bucket labelled
 * `2026-05-01` holding 21 days of May. Both are documented on
 * `AgencyCampaignStatsSeries.buckets` and in `campaign-series.ts`. Claims 3 and 4
 * above are therefore evidenced for the spine specifically; claims 1, 2 and 5 still
 * rest on the by-hand runs, and the harness itself remains un-run.
 */

const CAMPAIGN_TZ = 'Asia/Kolkata';

/**
 * The window, and why these instants.
 *
 * `Asia/Kolkata` is UTC+05:30 with no DST, so `2026-08-11T00:00:00Z` is 05:30
 * LOCAL on the 11th — which makes the first bucket a partial day and is exactly the
 * documented sharp edge on `AgencyCampaignStatsSeries.buckets`. It also means
 * `2026-08-11T19:00:00Z` is 00:30 local on the **12th**: an instant that is the 11th
 * in UTC and the 12th in the campaign's zone, which is the only kind of fixture that
 * can distinguish the two.
 *
 * A zone EAST of UTC is deliberate. A `to_char` bug that returned an ISO instant
 * instead of a date would be caught west of Greenwich by the label being a day
 * early; east of it, only the zone assertions catch it — so this file pins the
 * label's shape explicitly rather than relying on the offset's sign.
 */
const FROM = new Date('2026-08-11T00:00:00.000Z');
const TO = new Date('2026-08-14T00:00:00.000Z');

/** A dialled, bridged, ended attempt — the shape every counter here counts. */
async function dialled(
  campaignId: string,
  dialedAt: string,
  overrides: Record<string, unknown> = {},
) {
  const contact = await insertAgencyContact(campaignId, { state: 'completed' });
  return insertAgencyAttempt(campaignId, contact.id as string, {
    state: 'ended',
    dialed_at: dialedAt,
    answered_at: dialedAt,
    bridged_at: dialedAt,
    ended_at: new Date(new Date(dialedAt).getTime() + 60_000).toISOString(),
    outcome: 'connected',
    disposition_code: 'sale',
    ...overrides,
  });
}

/** A campaign whose catalog makes `sale` a conversion. */
async function campaign(overrides: Record<string, unknown> = {}) {
  return insertAgencyCampaign({
    default_timezone: CAMPAIGN_TZ,
    disposition_catalog: JSON.stringify([
      { code: 'sale', label: 'Sale', is_success: true },
      { code: 'nope', label: 'Not interested', is_success: false },
    ]),
    ...overrides,
  });
}

const read = (campaignId: string, bucket: 'day' | 'week' | 'month' = 'day') =>
  agencyCampaignRepository.statsSeries(
    { tenantId: DEFAULTS.tenantId, accountId: DEFAULTS.accountId },
    campaignId,
    { from: FROM, to: TO, bucket },
  );

beforeEach(truncateAll);
afterAll(closeTestPool);

describe('the days are cut in the campaign\'s own timezone', () => {
  it('puts an instant that is the 11th in UTC into the 12th when it is 00:30 local', async () => {
    const c = await campaign();
    // 19:00 UTC = 00:30 IST on the NEXT day. In UTC this is the 11th; the campaign's
    // calling window is enforced in IST, so the honest bucket is the 12th.
    await dialled(c.id as string, '2026-08-11T19:00:00.000Z');

    const series = await read(c.id as string);
    const labelled = Object.fromEntries(series!.buckets.map((b) => [b.bucket_start, b.attempts]));
    expect(labelled['2026-08-12']).toBe(1);
    expect(labelled['2026-08-11']).toBe(0);
  });

  it('echoes the RESOLVED zone', async () => {
    const c = await campaign();
    expect((await read(c.id as string))?.timezone).toBe(CAMPAIGN_TZ);
  });

  it('falls back to UTC — and does NOT raise 22023 — for an unresolvable zone', async () => {
    // `default_timezone` is VARCHAR(64) with no constraint and comes from
    // customer-facing config. Without the `pg_timezone_names` LEFT JOIN this read
    // raises `22023 invalid_parameter_value`, which nothing maps to a status.
    const c = await campaign({ default_timezone: 'Asia/Kolkata_typo' });
    await dialled(c.id as string, '2026-08-11T19:00:00.000Z');

    const series = await read(c.id as string);
    expect(series?.timezone).toBe('UTC');
    // Cut in UTC, so the same instant is now the 11th — which is why the ECHOED zone
    // has to be the resolved one: a console printing `Asia/Kolkata_typo` over these
    // columns would be describing a cut that did not happen.
    const labelled = Object.fromEntries(series!.buckets.map((b) => [b.bucket_start, b.attempts]));
    expect(labelled['2026-08-11']).toBe(1);
  });

  it('the raw expression really does raise, so the guard is load-bearing', async () => {
    // Pins that the LEFT JOIN is doing work rather than being decoration.
    await expect(
      getTestPool().query("SELECT now() AT TIME ZONE 'Asia/Kolkata_typo'"),
    ).rejects.toMatchObject({ code: '22023' });
  });
});

describe('the window is HALF-OPEN on dialed_at', () => {
  it('includes an attempt exactly at `from` and EXCLUDES one exactly at `to`', async () => {
    const c = await campaign();
    await dialled(c.id as string, FROM.toISOString());
    await dialled(c.id as string, TO.toISOString());

    const series = await read(c.id as string);
    const total = series!.buckets.reduce((n, b) => n + b.attempts, 0);
    // One, not two. A half-open window is the only shape that tiles: consecutive
    // requests `[Mon, Tue)` and `[Tue, Wed)` must cover Tuesday exactly once, and an
    // inclusive `to` would double-count every boundary attempt for anyone paging.
    expect(total).toBe(1);
    // And it is the `from` one that survived — 05:30 IST on the 11th.
    expect(series!.buckets.find((b) => b.attempts === 1)?.bucket_start).toBe('2026-08-11');
  });

  it('reaches the bucket containing the last instant of the window, and no further', async () => {
    const c = await campaign();
    // One microsecond before `to` — 05:29:59.999999 IST on the 14th.
    await dialled(c.id as string, '2026-08-13T23:59:59.999999Z');

    const series = await read(c.id as string);
    const labels = series!.buckets.map((b) => b.bucket_start);
    // The 14th must be there (the last instant of the window falls in it)...
    expect(labels).toContain('2026-08-14');
    // ...and the 15th must not, which is what the one-microsecond clip buys: without
    // it, `date_trunc(unit, to)` would emit an extra all-zero bucket every time `to`
    // lands on a boundary — the ordinary case, since a console asks for whole days.
    expect(labels).not.toContain('2026-08-15');
    expect(labels).toEqual(['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']);
  });

  it('counts no attempt that was never placed', async () => {
    const c = await campaign();
    const contact = await insertAgencyContact(c.id as string, { state: 'pending' });
    // Created, never dialled: `dialed_at IS NULL`. There is no honest bucket for it —
    // `created_at` precedes the dial by a dispatch hop — and a dial that did not
    // happen is not a dial.
    await insertAgencyAttempt(c.id as string, contact.id as string, { state: 'queued' });

    const series = await read(c.id as string);
    expect(series!.buckets.reduce((n, b) => n + b.attempts, 0)).toBe(0);
    // The buckets are still all there. "Nothing dialled" is a series of zeros, not
    // an empty array.
    expect(series!.buckets).toHaveLength(4);
  });
});

describe('EVERY bucket in the range is present, zeros included', () => {
  it('emits the empty day between two busy ones', async () => {
    const c = await campaign();
    // 12th and 14th local; nothing on the 13th.
    await dialled(c.id as string, '2026-08-11T19:00:00.000Z');
    await dialled(c.id as string, '2026-08-13T19:00:00.000Z');

    const series = await read(c.id as string);
    expect(series!.buckets.map((b) => b.bucket_start))
      .toEqual(['2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']);
    // "We dialled nobody that day" and "that day was not in the response" are
    // different facts and only the first can be drawn: fed a gappy series, a chart
    // either draws a straight line through the hole — inventing dials — or shifts
    // every later point one column left.
    expect(series!.buckets[2]).toEqual({
      bucket_start: '2026-08-13',
      attempts: 0, connected: 0, successes: 0, talk_seconds: 0, wrapup_seconds: 0,
    });
  });

  it('emits the whole spine for a campaign that has never dialled at all', async () => {
    const c = await campaign();
    const series = await read(c.id as string);
    expect(series!.buckets).toHaveLength(4);
    expect(series!.buckets.every((b) => b.attempts === 0)).toBe(true);
  });

  it('every bucket_start is a bare YYYY-MM-DD — no time, no offset', async () => {
    const c = await campaign();
    for (const bucket of labels(await read(c.id as string))) {
      expect(bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The failure this pins: an ISO INSTANT here is dated a day early for every
      // reader west of Greenwich, because a date-only string is the one literal
      // `new Date(...)` parses as UTC midnight while `…T00:00:00+05:30` is not.
      expect(bucket).not.toContain('T');
    }
  });
});

/**
 * Just the labels, so the assertions above read as one line.
 *
 * Named `labels` rather than `series` on purpose: two describes below bind a local
 * `const series`, and a helper sharing that name would be shadowed in some scopes
 * and not others — which compiles and reads as though it were the same thing.
 */
function labels(page: Awaited<ReturnType<typeof read>>): string[] {
  return page!.buckets.map((b) => b.bucket_start);
}

describe('week and month buckets fall on the right boundaries', () => {
  it('labels a week bucket with its Monday and a month bucket with the 1st', async () => {
    const c = await campaign();
    await dialled(c.id as string, '2026-08-11T19:00:00.000Z');

    // 2026-08-12 is a Wednesday; `date_trunc('week', …)` is the ISO Monday, which is
    // the reading `calling_days` already pins (1=Mon…7=Sun).
    expect(labels(await read(c.id as string, 'week'))).toEqual(['2026-08-10']);
    expect(labels(await read(c.id as string, 'month'))).toEqual(['2026-08-01']);
  });

  it('a coarser bucket is the exact sum of the finer ones', async () => {
    const c = await campaign();
    await dialled(c.id as string, '2026-08-11T19:00:00.000Z');
    await dialled(c.id as string, '2026-08-12T19:00:00.000Z');
    await dialled(c.id as string, '2026-08-13T10:00:00.000Z');

    const days = await read(c.id as string, 'day');
    const month = await read(c.id as string, 'month');
    // Every attempt lands in exactly one bucket at every granularity — one campaign,
    // one zone — so the two foldings reconcile by construction rather than by two
    // queries agreeing.
    expect(month!.buckets[0]!.attempts).toBe(days!.buckets.reduce((n, b) => n + b.attempts, 0));
    expect(month!.buckets[0]!.connected).toBe(days!.buckets.reduce((n, b) => n + b.connected, 0));
    expect(month!.buckets[0]!.successes).toBe(days!.buckets.reduce((n, b) => n + b.successes, 0));
  });
});

describe('the buckets sum to the LIFETIME totals over the same window', () => {
  it('reconciles attempts, connected and successes with `stats()`', async () => {
    const c = await campaign({ status: 'running' });
    // Three inside the window: one bridged+converted, one bridged and not, one
    // dialled but never bridged.
    await dialled(c.id as string, '2026-08-11T19:00:00.000Z');
    await dialled(c.id as string, '2026-08-12T19:00:00.000Z', { disposition_code: 'nope' });
    const notBridged = await insertAgencyContact(c.id as string, { state: 'completed' });
    await insertAgencyAttempt(c.id as string, notBridged.id as string, {
      state: 'ended', dialed_at: '2026-08-13T10:00:00.000Z', outcome: 'no_answer',
    });

    const series = await read(c.id as string);
    const stats = await agencyCampaignRepository.stats(c.id as string);
    const sum = (pick: (b: NonNullable<typeof series>['buckets'][number]) => number): number =>
      series!.buckets.reduce((n, b) => n + pick(b), 0);

    // `attempts` — every attempt on this campaign has a `dialed_at` inside the
    // window, so the restriction is a no-op here and the two are equal. (With a row
    // outside the window they would not be, deliberately: `attempts_total` is a bare
    // COUNT(*) with no date filter.)
    expect(sum((b) => b.attempts)).toBe(stats.attempts_total);

    // `connected` sums to every BRIDGED attempt — `human_connects +
    // machine_connects + unclassified_connects`, which is how that payload defines
    // its bridged denominator — and NOT to `attempts_connected`, which is
    // `outcome = 'connected'`, a classification that can be absent, late, or say
    // connected about a call no agent ever heard.
    expect(sum((b) => b.connected)).toBe(
      stats.human_connects + stats.machine_connects + stats.unclassified_connects,
    );

    // `successes` sums to `attempts_success` — the same `successDispositionSql`
    // predicate behind the same `bridged_at` gate.
    expect(sum((b) => b.successes)).toBe(stats.attempts_success);
    expect(sum((b) => b.successes)).toBe(1);
  });

  it('excludes a row outside the window from the series but not from the lifetime total', async () => {
    const c = await campaign({ status: 'running' });
    await dialled(c.id as string, '2026-08-11T19:00:00.000Z');
    // A week before `from`.
    await dialled(c.id as string, '2026-08-04T19:00:00.000Z');

    const series = await read(c.id as string);
    const stats = await agencyCampaignRepository.stats(c.id as string);
    // The divergence is the POINT of a windowed read, and it is the one pairing a
    // reviewer is most likely to expect to be equal.
    expect(series!.buckets.reduce((n, b) => n + b.attempts, 0)).toBe(1);
    expect(stats.attempts_total).toBe(2);
  });
});

describe('scope', () => {
  it('answers null for a campaign in another account', async () => {
    const c = await campaign({ account_id: uuidFor('someone-else') });
    // Not an empty series: an empty `buckets` array would report "this campaign
    // dialled nobody" about a campaign this caller may not see at all.
    expect(await read(c.id as string)).toBeNull();
  });

  it('answers null for a campaign id that names nothing', async () => {
    expect(await read('11111111-2222-3333-4444-555555555555')).toBeNull();
  });
});
