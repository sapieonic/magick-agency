import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// `GET /agency-agents/:agentUserId/stats` — the two aggregates and the fold.
//
// THE POOL IS MOCKED, so the fixtures supply the column names and no assertion
// here can catch a renamed SQL column. That is the same split
// `supervisor-stats.test.ts` documents, and it means every rule is asserted
// twice, neither half redundant:
//
//   * against the SQL TEXT, for the rules that live in the query — bucketing in
//     the campaign's own zone, on `dialed_at`, formatted in SQL; the interval
//     construction and its three clips; the conversion predicate;
//   * against the MAPPED OUTPUT, for the rules that live in the fold — the
//     null-not-zero rates, and the exact-summation property that the
//     per-campaign-timezone bucketing exists to buy.
//
// ⚠️ **The fixture cannot prove anything about timezones, and does not claim to.**
// `bucket_start` arrives already cut: `date_trunc` and `to_char` run in Postgres,
// and the pool is mocked, so the labels below are hand-written strings and the
// campaign ids are merely NAMED `camp-in`/`camp-us`. No zone is exercised. What
// the fixture does prove is the fold — that a Map keyed on the label adds rows
// from different campaigns into one bucket and rows from different buckets into
// one campaign, and that the two foldings and the totals agree. The zone rule
// itself is asserted where it lives, against the SQL text.
// ---------------------------------------------------------------------------

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@magick-agency/observability', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

const { AgencyAgentStatsRepository } = await import('../../../src/db/repositories/agency.repository.js');

const SCOPE = { tenantId: 't1', accountId: 'a1', agentUserId: 'u-ravi' };
const WINDOW = {
  from: new Date('2026-08-17T00:00:00.000Z'),
  to: new Date('2026-08-19T00:00:00.000Z'),
  bucket: 'day' as const,
};

/** The occupancy read is the one that touches the transition log. */
const isOccupancy = (sql: unknown): boolean => String(sql).includes('agency_agent_session_events');

const attemptsSql = (): string =>
  String(pool.query.mock.calls.find((c) => !isOccupancy(c[0]))?.[0] ?? '');
const attemptsParams = (): unknown[] =>
  (pool.query.mock.calls.find((c) => !isOccupancy(c[0]))?.[1] ?? []) as unknown[];
const occupancySql = (): string =>
  String(pool.query.mock.calls.find((c) => isOccupancy(c[0]))?.[0] ?? '');
const occupancyParams = (): unknown[] =>
  (pool.query.mock.calls.find((c) => isOccupancy(c[0]))?.[1] ?? []) as unknown[];

/**
 * The statement with its `--` comments stripped.
 *
 * Every NEGATIVE assertion runs against this. Both queries are heavily commented
 * and the comments NAME the columns the query deliberately does not read, so
 * `not.toContain('talk_seconds')` against the raw text would fail on the sentence
 * explaining why `talk_seconds` is the wrong column — and would keep failing
 * until someone deleted the explanation. Same helper, same reason, as
 * `supervisor-stats.test.ts`.
 */
const executable = (sql: string): string => sql.replace(/--[^\n]*/g, '');

/**
 * Two campaigns, three (bucket, campaign) rows — the shape the GROUP BY returns.
 *
 * The labels are what Postgres would have emitted; the mock cannot produce them,
 * so they are written by hand and the campaign ids are just two distinct strings.
 * The structural facts they carry are the ones the fold has to get right:
 * `2026-08-17` has a row from EACH campaign and `2026-08-18` from only one, so a
 * bucket is a union across campaigns rather than a per-campaign row, and a
 * campaign spans buckets.
 *
 * Every value distinct, so reading the right count off the wrong key fails.
 */
const ATTEMPT_ROWS = [
  {
    bucket_start: '2026-08-17', campaign_id: 'camp-in',
    attempts: '40', connected: '10', successes: '4',
    talk_seconds: '3000', wrapup_seconds: '400',
  },
  {
    bucket_start: '2026-08-17', campaign_id: 'camp-us',
    attempts: '20', connected: '5', successes: '1',
    talk_seconds: '1500', wrapup_seconds: '200',
  },
  {
    bucket_start: '2026-08-18', campaign_id: 'camp-in',
    attempts: '30', connected: '9', successes: '3',
    talk_seconds: '2700', wrapup_seconds: '300',
  },
];

const OCCUPANCY_ROWS = [
  { bucket_start: '2026-08-17', state: 'available', seconds: '3600' },
  { bucket_start: '2026-08-17', state: 'on_call', seconds: '4500' },
  { bucket_start: '2026-08-17', state: 'offline', seconds: '70000' },
  { bucket_start: '2026-08-18', state: 'available', seconds: '1800' },
  { bucket_start: '2026-08-18', state: 'break', seconds: '900' },
  // A bucket with occupancy and NO attempts — an agent who was on the floor and
  // never dialled. It must still appear.
  { bucket_start: '2026-08-19', state: 'available', seconds: '600' },
];

function serve(attempts: unknown[], occupancy: unknown[]): void {
  pool.query.mockImplementation((sql: unknown) =>
    Promise.resolve({ rows: isOccupancy(sql) ? occupancy : attempts }));
}

beforeEach(() => {
  pool.query.mockReset();
  warn.mockReset();
  serve(ATTEMPT_ROWS, OCCUPANCY_ROWS);
});

const read = () => new AgencyAgentStatsRepository().stats(SCOPE, WINDOW);

// ─── the attempts aggregate ─────────────────────────────────────────────────

describe('the attempt buckets are cut in each campaign\'s own timezone', () => {
  it('derives the zone from the CAMPAIGN row, per attempt', async () => {
    await read();
    const sql = attemptsSql();
    expect(sql).toContain('AT TIME ZONE');
    expect(sql).toContain('c.default_timezone');
    // There is deliberately no `tz` parameter, so no literal zone can appear in
    // the bucket expression. A literal would be the "one chosen zone" reading the
    // endpoint rejects — it makes the same call move between days depending on
    // who is looking.
    expect(executable(sql)).not.toContain("AT TIME ZONE 'UTC'");
    // ...and no zone can arrive as a BOUND VALUE either. `not.toContain('UTC')` on
    // the params array cannot fail by construction — nothing on this path ever
    // pushes a zone — so the assertion that bites is the exact bound list: a `tz`
    // parameter smuggled in anywhere would lengthen it.
    expect(occupancyParams()).toEqual(['u-ravi', WINDOW.from, WINDOW.to, 't1', 'a1']);
    expect(executable(occupancySql())).not.toContain('AT TIME ZONE $');
  });

  it('resolves the zone through pg_timezone_names so a bad one cannot 500 the read', async () => {
    await read();
    // `default_timezone` is VARCHAR(64) with no constraint and comes from customer
    // config. `AT TIME ZONE 'Mars/Olympus'` raises 22023, which nothing maps to a
    // status — one campaign's typo would take down every other campaign's numbers
    // on the same payload. Same fail-soft shape as `calling-hours.ts`.
    //
    // LATERAL with `LIMIT 1`, not a plain equi-join: both of these sit inside an
    // aggregate, so two matching zone rows for one campaign would double every
    // counter that campaign contributes. Nothing declares `lower(name)` unique in
    // `pg_timezone_names` — it is a view over tzdata — so the LIMIT 1 is what makes
    // the cardinality a property of the statement rather than of the platform's
    // zone files. The COALESCE fallback is unchanged by it.
    const lateralJoin = 'LEFT JOIN LATERAL (SELECT z.name FROM pg_timezone_names z'
      + ' WHERE lower(z.name) = lower(c.default_timezone) LIMIT 1) z ON true';
    expect(attemptsSql()).toContain(lateralJoin);
    expect(attemptsSql()).toContain("COALESCE(z.name, 'UTC')");
    expect(occupancySql()).toContain(lateralJoin);
  });

  it('buckets on dialed_at — never created_at, never ended_at', async () => {
    await read();
    const sql = executable(attemptsSql());
    expect(sql).toContain('a.dialed_at IS NOT NULL');
    expect(sql).toContain('a.dialed_at >= $2');
    expect(sql).toContain('a.dialed_at < $3');
    // `created_at` precedes the dial by a dispatch hop, so it can bucket an
    // attempt into a day nothing was dialled in; `ended_at` pushes a call
    // straddling midnight into the later day and leaves a live one in no day at
    // all. Neither may appear in the bucket expression.
    expect(sql).not.toContain("date_trunc('day', (a.created_at");
    expect(sql).not.toContain("date_trunc('day', (a.ended_at");
  });

  it('bounds the window half-open — `to` is EXCLUSIVE', async () => {
    await read();
    // A half-open window is the only shape that tiles: [Mon,Tue) and [Tue,Wed)
    // cover Tuesday exactly once. Note this differs from the attempt SPINE, whose
    // `to` is inclusive because it is a filter rather than an aggregate.
    expect(executable(attemptsSql())).toContain('a.dialed_at < $3');
    expect(executable(attemptsSql())).not.toContain('a.dialed_at <= $3');
    expect(attemptsParams()[1]).toBe(WINDOW.from);
    expect(attemptsParams()[2]).toBe(WINDOW.to);
  });

  it('formats the label in SQL rather than returning a bare timestamp', async () => {
    await read();
    // node-pg parses a bare `timestamp` into a LOCAL-time Date, which would put
    // the server's zone back on the way out. `hourlyBuckets` states this too.
    expect(attemptsSql()).toContain("'YYYY-MM-DD'");
    expect(attemptsSql()).toContain('to_char(');
  });

  it('scopes on the SESSION\'s tenant and account, not on the agent id alone', async () => {
    await read();
    // `agent_user_id` is master's user id, opaque to core, and there is no
    // campaign in this route's path to own. Without these predicates any tenant
    // could read any other tenant's agent by supplying their user id.
    expect(attemptsSql()).toContain('s.tenant_id = $4');
    expect(attemptsSql()).toContain('s.account_id = $5');
    expect(occupancySql()).toContain('s.tenant_id = $4');
    expect(occupancySql()).toContain('s.account_id = $5');
    expect(attemptsParams()).toEqual(['u-ravi', WINDOW.from, WINDOW.to, 't1', 'a1']);
  });

  it('reaches the person through the SESSION — the two-hop join', async () => {
    await read();
    const sql = attemptsSql();
    expect(sql).toContain('JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id');
    expect(sql).toContain('s.agent_user_id = $1');
  });

  it('counts connects on bridged_at and successes through the shared predicate', async () => {
    await read();
    const sql = executable(attemptsSql());
    expect(sql).toContain('COUNT(*) FILTER (WHERE a.bridged_at IS NOT NULL)');
    expect(sql).toContain("e->'is_success' = 'true'::jsonb");
    expect(sql).toContain('jsonb_array_elements(c.disposition_catalog)');
    // A malformed catalog must not throw: object guard, and no boolean cast.
    expect(sql).toContain("jsonb_typeof(e) = 'object'");
    expect(sql).not.toContain('::boolean');
    // `outcome = 'connected'` is a classification that can be absent, late, or
    // say connected about a call no agent ever heard.
    expect(sql).not.toContain("a.outcome = 'connected'");
  });

  it('measures talk as ended_at - bridged_at, excluding orphans', async () => {
    await read();
    const sql = executable(attemptsSql());
    expect(sql).toContain('SUM(EXTRACT(EPOCH FROM (a.ended_at - a.bridged_at)))');
    expect(sql).toContain("a.outcome IS DISTINCT FROM 'orphaned'");
    // NOT the persisted column: it is anchored on the carrier's answer and is
    // nonzero even when no agent bridged.
    expect(sql).not.toContain('SUM(a.talk_seconds)');
  });

  it('measures wrap-up, and only the three resolutions that are evidence', async () => {
    await read();
    const sql = executable(attemptsSql());
    expect(sql).toContain('SUM(EXTRACT(EPOCH FROM (a.wrapup_ended_at - a.wrapup_started_at)))');
    expect(sql).toContain("a.wrapup_resolution IN ('disposition_submitted','auto_return','agent_returned')");
    // Never the allotment copied from the campaign at wrap-up entry — averaging
    // that hands the operator their own setting back as if it were measurement.
    expect(sql).not.toContain('SUM(a.wrapup_seconds)');
  });

  it('applies an optional campaign filter as a bound parameter', async () => {
    await new AgencyAgentStatsRepository().stats(SCOPE, {
      ...WINDOW, campaignId: '11111111-2222-3333-4444-555555555555',
    });
    expect(attemptsSql()).toContain('a.campaign_id = $6::uuid');
    expect(attemptsParams()[5]).toBe('11111111-2222-3333-4444-555555555555');
    expect(occupancySql()).toContain('s.campaign_id = $6::uuid');
  });
});

// ─── the fold: exact summation across zones ─────────────────────────────────

describe('two campaigns in different zones still sum exactly', () => {
  it('emits one bucket per label, unioned across campaigns and ascending', async () => {
    const stats = await read();
    expect(stats.buckets.map((b) => b.bucket_start)).toEqual(['2026-08-17', '2026-08-18', '2026-08-19']);
    // `YYYY-MM-DD` sorts lexicographically = chronologically, which is half the
    // reason the label has that shape.
    expect(stats.bucket).toBe('day');
    expect(stats.agent_user_id).toBe('u-ravi');
    expect(stats.from).toBe('2026-08-17T00:00:00.000Z');
    expect(stats.to).toBe('2026-08-19T00:00:00.000Z');
  });

  it('adds the two campaigns\' rows together within a shared bucket', async () => {
    const stats = await read();
    const first = stats.buckets[0]!;
    expect(first).toMatchObject({
      bucket_start: '2026-08-17',
      attempts: 60, connected: 15, successes: 5,
      talk_seconds: 4500, wrapup_seconds: 600,
    });
  });

  it('TOTALS are the exact sum of the buckets — no double-counting, no gaps', async () => {
    const stats = await read();
    const sum = (pick: (b: typeof stats.buckets[number]) => number): number =>
      stats.buckets.reduce((acc, b) => acc + pick(b), 0);

    expect(stats.totals.attempts).toBe(sum((b) => b.attempts));
    expect(stats.totals.connected).toBe(sum((b) => b.connected));
    expect(stats.totals.successes).toBe(sum((b) => b.successes));
    expect(stats.totals.talk_seconds).toBe(sum((b) => b.talk_seconds));
    expect(stats.totals.wrapup_seconds).toBe(sum((b) => b.wrapup_seconds));
    // And the absolute values, so a fold that summed the right shape from the
    // wrong rows still fails.
    expect(stats.totals).toMatchObject({
      attempts: 90, connected: 24, successes: 8, talk_seconds: 7200, wrapup_seconds: 900,
    });
  });

  it('BY_CAMPAIGN is the same row set folded the other way, and also sums exactly', async () => {
    const stats = await read();
    const byCampaign = [...stats.by_campaign].sort((a, b) => a.campaign_id.localeCompare(b.campaign_id));
    expect(byCampaign).toEqual([
      {
        campaign_id: 'camp-in',
        attempts: 70, connected: 19, successes: 7, talk_seconds: 5700, wrapup_seconds: 700,
      },
      {
        campaign_id: 'camp-us',
        attempts: 20, connected: 5, successes: 1, talk_seconds: 1500, wrapup_seconds: 200,
      },
    ]);
    const total = byCampaign.reduce((acc, c) => acc + c.attempts, 0);
    expect(total).toBe(stats.totals.attempts);
    expect(stats.totals.campaigns).toBe(2);
  });

  it('emits a bucket that has occupancy and no attempts', async () => {
    const stats = await read();
    const last = stats.buckets[2]!;
    expect(last.bucket_start).toBe('2026-08-19');
    expect(last.attempts).toBe(0);
    // An agent who was on the floor and never dialled is one of the more useful
    // rows here; dropping it would make the record look like they were not at work.
    expect(last.occupancy.by_state.available).toBe(600);
    expect(last.occupancy.shift_seconds).toBe(600);
  });
});

// ─── the rates ──────────────────────────────────────────────────────────────

describe('every rate is null — never 0 — on a zero denominator', () => {
  it('computes the rates from the folded counters', async () => {
    const stats = await read();
    expect(stats.totals.connect_rate_pct).toBeCloseTo((24 / 90) * 100);
    // The success denominator is CONNECTED, not attempts: a call that never
    // bridged had no conversation to convert.
    expect(stats.totals.success_rate_pct).toBeCloseTo((8 / 24) * 100);
    expect(stats.totals.success_rate_pct).not.toBeCloseTo((8 / 90) * 100);
    // Talk PLUS wrap-up over connected — deliberately a different definition from
    // the campaign payload's talk-only `aht_seconds`, and always reproducible from
    // the fields beside it.
    expect(stats.totals.aht_seconds).toBeCloseTo((7200 + 900) / 24);
  });

  it('is null when nothing was dialled at all', async () => {
    serve([], []);
    const stats = await read();
    expect(stats.totals.attempts).toBe(0);
    expect(stats.totals.connect_rate_pct).toBeNull();
    expect(stats.totals.success_rate_pct).toBeNull();
    expect(stats.totals.aht_seconds).toBeNull();
    expect(stats.buckets).toEqual([]);
    expect(stats.by_campaign).toEqual([]);
    expect(stats.totals.campaigns).toBe(0);
  });

  it('is null for the conversion rate when attempts were dialled and none connected', async () => {
    // The distinction the whole rule exists for: this agent worked. Reporting 0%
    // would say their conversations do not convert; they had none.
    serve([{
      bucket_start: '2026-08-17', campaign_id: 'camp-in',
      attempts: '25', connected: '0', successes: '0',
      talk_seconds: '0', wrapup_seconds: '0',
    }], []);
    const stats = await read();
    expect(stats.totals.connect_rate_pct).toBe(0);        // 0 of 25 IS zero percent
    expect(stats.totals.success_rate_pct).toBeNull();     // 0 of nothing is not
    expect(stats.totals.aht_seconds).toBeNull();
  });

  it('reports a genuine zero conversion rate when calls DID connect', async () => {
    serve([{
      bucket_start: '2026-08-17', campaign_id: 'camp-in',
      attempts: '25', connected: '10', successes: '0',
      talk_seconds: '600', wrapup_seconds: '0',
    }], []);
    const stats = await read();
    expect(stats.totals.success_rate_pct).toBe(0);
  });
});

// ─── occupancy ──────────────────────────────────────────────────────────────

describe('occupancy is derived from the transition log', () => {
  it('differences consecutive events per session with lead(), tie-broken on id', async () => {
    await read();
    const sql = occupancySql();
    // ⚠️ CHANGED: the ORDER BY carried `ev.at` alone until the roster review, and
    // the tiebreak was added afterwards. `at` is not unique — `markAllOffline`
    // batch-inserts a whole floor inside one transaction and every row takes the
    // same transaction timestamp, which is the identical tie `carried`'s
    // `ORDER BY … e.id DESC` twelve lines above was already written to break.
    // Where two tied events are followed by a third, `lead()` without the tiebreak
    // leaves it undefined WHICH of the tied states keeps the surviving interval, so
    // two reads of one window can attribute the same seconds to different states.
    expect(sql).toContain('lead(ev.at) OVER (PARTITION BY ev.session_id ORDER BY ev.at, ev.id)');
    expect(sql).toContain('FROM agency_agent_session_events e');
    // `ev.id` only exists in `intervals` because both halves of `events` carry it
    // through — a `UNION ALL` of two `SELECT *`, so the column must be on both.
    expect(sql).toContain('SELECT e.session_id, e.to_state, e.at, e.id');
    expect(sql).toContain('SELECT DISTINCT ON (e.session_id) e.session_id, e.to_state, e.at, e.id');
  });

  it('closes an OPEN final interval at min(now, window end, the session\'s own end)', async () => {
    await read();
    // The newest event of a session is the agent's current state and has no end.
    // Without this clip, the state an agent has been in all afternoon is the one
    // the record does not mention.
    expect(occupancySql()).toContain('COALESCE(lead(ev.at) OVER (PARTITION BY ev.session_id ORDER BY ev.at, ev.id), now())');
    expect(occupancySql()).toContain('$3::timestamptz');
    expect(occupancySql()).toContain('LEAST(');
  });

  it('also clips the final interval to `sess.left_at` — the log is best-effort', async () => {
    // ⚠️ ADDED by the roster review. `now()` and `$3` clip a still-open interval;
    // neither notices a session that ENDED inside the window. `leave()` sets
    // `left_at` AND writes the closing `offline` event, but that write is the
    // best-effort one `recordTransitions` swallows with a `log.warn` and no
    // rethrow — so a session closed at 11:30 in state `available` with a dropped
    // event credited every remaining second of the window to `available`,
    // inflating `shift_seconds`.
    //
    // `left_at` is the one clip whose source is the sessions table rather than the
    // transition log, which is exactly why it survives that failure. It must be
    // SELECTed on `sess` to be in scope here.
    await read();
    const sql = occupancySql();
    expect(sql).toContain('SELECT s.id, s.left_at,');
    expect(sql).toContain("COALESCE(sess.left_at, 'infinity'::timestamptz)");
    // `LEAST` already ignores NULLs, so the COALESCE is for the reader: a LIVE
    // session has no `left_at` and must not be clipped at all, and `'infinity'`
    // says so rather than leaving it to a function's null semantics.
    expect(executable(sql)).toContain('(s.left_at IS NULL OR s.left_at > $2)');
  });

  it('carries in the last event BEFORE the window, one row per session', async () => {
    await read();
    const sql = executable(occupancySql());
    // Without this, an agent who went available at 08:55 shows 35 minutes of
    // nothing in a window starting at 09:00 — every occupancy figure low by
    // however long they had already been in their state.
    expect(sql).toContain('DISTINCT ON (e.session_id)');
    expect(sql).toContain('e.at < $2');
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('GREATEST(ev.at, $2::timestamptz)');
  });

  it('breaks a DISTINCT ON tie reproducibly, on e.id', async () => {
    await read();
    // Rows equal on the ORDER BY leave DISTINCT ON free to return either one, so
    // without a tie-break the state carried into the window is not reproducible
    // between two runs of the same query. Ties exist in rows already written: the
    // batch insert used to take migration 105's `DEFAULT now()`, which is the
    // TRANSACTION timestamp and therefore identical across a whole `markAllOffline`
    // sweep.
    expect(executable(occupancySql())).toContain('ORDER BY e.session_id, e.at DESC, e.id DESC');
  });

  it('bounds `sess` to the sessions that OVERLAP the window', async () => {
    await read();
    const sql = executable(occupancySql());
    // ── The one that makes "bounded by the window" true ─────────────────────
    //
    // `carried` fetches one row per session, so the read is bounded by the window
    // only if the SESSION SET is. Unbounded, every session the agent has ever
    // closed still has a terminal event before `from` — and each one therefore
    // carries in an interval with no successor inside the window, i.e. one that
    // runs the window's FULL WIDTH. Sixty past shifts read as sixty full-window
    // intervals: `by_state.offline` scaling with tenure rather than with the
    // window (~42 days of "offline" inside a 24-hour bucket), and `shift_seconds`
    // inflated too for any session abandoned in a non-`offline` state.
    //
    // Two half-open intervals overlap iff each starts before the other ends.
    expect(sql).toContain('s.joined_at < $3');
    expect(sql).toContain('(s.left_at IS NULL OR s.left_at > $2)');
    // The `IS NULL` half is not decoration: a live session has no `left_at`, so a
    // bare `s.left_at > $2` would drop exactly the session the agent is sitting in
    // — which is the one whose interval is still open.
    expect(sql).toContain('s.left_at IS NULL OR');
  });

  it('predicates the event reads on agent_user_id, which is the only way the index is reachable', async () => {
    await read();
    const sql = executable(occupancySql());
    // `idx_agency_session_events_agent` is `(agent_user_id, at)`. The join is on
    // `session_id` and the range is on `at`; neither touches the leading column,
    // so without this predicate the shipped index cannot drive either read and the
    // denormalised column migration 105 exists to carry is never read at all.
    // One fragment per `FROM agency_agent_session_events e`, each running up to the
    // next one, so an assertion cannot be satisfied twice by the same predicate.
    const eventReads = sql.split('agency_agent_session_events e').slice(1);
    expect(eventReads).toHaveLength(2);            // in_window and carried
    expect(eventReads[0]).toContain('e.agent_user_id = $1');
    expect(eventReads[0]).toContain('e.at >= $2 AND e.at < $3');
    expect(eventReads[1]).toContain('e.agent_user_id = $1');
    expect(eventReads[1]).toContain('e.at < $2');
    // ...and the session join STAYS: it is what carries the campaign's zone into
    // the interval rows and what applies the tenant/account scope.
    expect(sql).toContain('JOIN sess ON sess.id = e.session_id');
  });

  it('splits an interval across every bucket it spans, clipped to each', async () => {
    await read();
    const sql = occupancySql();
    // Attributing a whole interval to the bucket its START falls in would be the
    // easy version and would put a night shift's occupancy on the first day.
    expect(sql).toContain('generate_series(');
    expect(sql).toContain("interval '1 day'");
    expect(sql).toContain('LEAST(i.ended, b.bucket_end) - GREATEST(i.started, b.bucket_start)');
    // The series is inclusive of the bucket containing `ended`, so a zero-width
    // tail bucket is dropped rather than emitted as an empty row.
    expect(sql).toContain('HAVING SUM(');
  });

  it('folds per bucket AND for the window, with offline out of the shift', async () => {
    const stats = await read();
    expect(stats.buckets[0]!.occupancy).toEqual({
      shift_seconds: 8100,
      // The break is in the NEXT bucket's fixture, so it must be 0 in this one.
      by_state: { available: 3600, reserved: 0, on_call: 4500, wrapup: 0, break: 0, offline: 70_000 },
    });
    expect(stats.totals.occupancy.by_state).toEqual({
      available: 6000, reserved: 0, on_call: 4500, wrapup: 0, break: 900, offline: 70_000,
    });
    // The window total is the sum of the buckets here too.
    const shiftFromBuckets = stats.buckets.reduce((acc, b) => acc + b.occupancy.shift_seconds, 0);
    expect(stats.totals.occupancy.shift_seconds).toBe(shiftFromBuckets);
  });

  it('reads as zeros for a session with no events at all', async () => {
    // Sessions predating migration 105 have no rows in the log. Zeros are the
    // honest answer — the alternative is reconstructing time-in-state from
    // `state_since`, a snapshot every transition overwrites.
    serve(ATTEMPT_ROWS, []);
    const stats = await read();
    expect(stats.totals.occupancy).toEqual({
      shift_seconds: 0,
      by_state: { available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0, offline: 0 },
    });
    for (const bucket of stats.buckets) {
      expect(bucket.occupancy.shift_seconds).toBe(0);
    }
    // And the attempt numbers are unaffected — occupancy being silent must not
    // make the rest of the record silent.
    expect(stats.totals.attempts).toBe(90);
  });

  it('never invents a `reserved` interval, because that state is not mirrored', async () => {
    const stats = await read();
    // `reserved` is deliberately not written to `agency_agent_sessions` (see
    // `dialUpTo`), so no transition into it is logged and its sub-second-to-15s
    // time folds into the preceding `available` interval. The key is present
    // because the state is part of the union and consumers switch on it.
    expect(stats.totals.occupancy.by_state.reserved).toBe(0);
    expect(Object.keys(stats.totals.occupancy.by_state)).toContain('reserved');
  });
});

// ─── occupancy degrades alone ───────────────────────────────────────────────

describe('an occupancy failure never takes the rest of the record with it', () => {
  /** Only the statement that reads the transition log rejects. */
  const failOccupancy = (): void => {
    pool.query.mockImplementation((sql: unknown) => (isOccupancy(sql)
      // The realistic shape: migration 105 has not run on this database yet. It is
      // the same failure the WRITE path already swallows in `recordTransitions`.
      ? Promise.reject(new Error('relation "agency_agent_session_events" does not exist'))
      : Promise.resolve({ rows: ATTEMPT_ROWS })));
  };

  it('still serves every attempt number that WAS read', async () => {
    failOccupancy();
    const stats = await read();
    // The caller asked what they did. Answering with a 500 because a second
    // statement about where their time went could not run discards numbers that
    // were already in hand.
    expect(stats.totals).toMatchObject({
      attempts: 90, connected: 24, successes: 8, talk_seconds: 7200, wrapup_seconds: 900,
    });
    expect(stats.totals.connect_rate_pct).toBeCloseTo((24 / 90) * 100);
    expect(stats.buckets.map((b) => b.bucket_start)).toEqual(['2026-08-17', '2026-08-18']);
    expect(stats.by_campaign).toHaveLength(2);
  });

  it('degrades occupancy to zeros — the only shape the contract allows', async () => {
    failOccupancy();
    const stats = await read();
    // `AgencyAgentOccupancy.by_state` is documented as "all six states, always
    // present", so ABSENT is not representable and the degraded record is
    // indistinguishable from an agent with no events at all. That is a contract
    // limitation, recorded here rather than worked around by changing the shape.
    expect(stats.totals.occupancy).toEqual({
      shift_seconds: 0,
      by_state: { available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0, offline: 0 },
    });
    for (const bucket of stats.buckets) {
      expect(bucket.occupancy.shift_seconds).toBe(0);
    }
  });

  it('says so at warn — the only symptom the degrade produces', async () => {
    failOccupancy();
    await read();
    expect(warn).toHaveBeenCalledTimes(1);
    const [context, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toContain('occupancy');
    expect(context['err']).toBeInstanceOf(Error);
    // The window is on the line, because zeros on this payload have two causes and
    // the log is the only place they are told apart.
    expect(context['agentUserId']).toBe('u-ravi');
    expect(context['from']).toBe('2026-08-17T00:00:00.000Z');
    expect(context['to']).toBe('2026-08-19T00:00:00.000Z');
  });

  it('does NOT degrade when the attempts read is the one that fails', async () => {
    // The mirror case, asserted so the catch cannot quietly widen: attempts are
    // the record. There is nothing left to serve, so this one propagates.
    pool.query.mockImplementation((sql: unknown) => (isOccupancy(sql)
      ? Promise.resolve({ rows: OCCUPANCY_ROWS })
      : Promise.reject(new Error('deadlock detected'))));
    await expect(read()).rejects.toThrow('deadlock detected');
  });
});

// ─── the bucket unit reaches the SQL, for all three units ───────────────────

describe('bucket=week and bucket=month cut the SQL differently, not just the label', () => {
  // The unit is interpolated into FOUR places across the two statements, and the
  // occupancy read is the one where getting it wrong is silent: the LATERAL steps
  // `generate_series` by `interval '1 <unit>'` while truncating by `<unit>`. Pin
  // both. A stride of `1 day` under `bucket=week` makes every bucket one day wide
  // while the series steps seven — six days of every week attributed to nothing —
  // and every assertion written only against `bucket=day` survives it.
  const UNITS = [
    { bucket: 'day' as const, stride: "interval '1 day'" },
    { bucket: 'week' as const, stride: "interval '1 week'" },
    { bucket: 'month' as const, stride: "interval '1 month'" },
  ];

  for (const { bucket, stride } of UNITS) {
    it(`bucket=${bucket}: the same unit truncates and strides`, async () => {
      await new AgencyAgentStatsRepository().stats(SCOPE, { ...WINDOW, bucket });

      // The attempts aggregate: truncation only, on `dialed_at`.
      expect(executable(attemptsSql())).toContain(`date_trunc('${bucket}', (a.dialed_at`);

      // The occupancy aggregate: the label, both series bounds, and the stride.
      const occupancy = executable(occupancySql());
      expect(occupancy).toContain(`date_trunc('${bucket}', (b.bucket_start`);
      expect(occupancy).toContain(`date_trunc('${bucket}', (i.started`);
      expect(occupancy).toContain(`date_trunc('${bucket}', (i.ended`);
      expect(occupancy).toContain(`(gs + ${stride})`);
      expect(occupancy).toContain(`${stride}) gs`);

      // ...and no OTHER unit leaks in beside it, which is what a hard-coded stride
      // or a half-applied change looks like.
      for (const other of UNITS) {
        if (other.bucket === bucket) continue;
        expect(occupancy).not.toContain(other.stride);
        expect(occupancy).not.toContain(`date_trunc('${other.bucket}'`);
        expect(executable(attemptsSql())).not.toContain(`date_trunc('${other.bucket}'`);
      }

      // The unit is echoed on the payload, so a caller can always tell what they got.
      const stats = await new AgencyAgentStatsRepository().stats(SCOPE, { ...WINDOW, bucket });
      expect(stats.bucket).toBe(bucket);
    });
  }
});
