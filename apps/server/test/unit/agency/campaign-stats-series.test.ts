import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// `GET /agency-campaigns/:id/stats/series` — the one statement behind it.
//
// THE POOL IS MOCKED, so the fixture supplies the column names and no assertion
// here can catch a renamed SQL column. That is the same split
// `agent-stats-repository.test.ts` and `supervisor-stats.test.ts` both document,
// and it means each rule is asserted where it actually lives:
//
//   * against the SQL TEXT — the calendar spine and the LEFT JOIN that zero-fills
//     it, the half-open bound and its one-microsecond upper clip, bucketing on
//     `dialed_at` in the campaign's RESOLVED zone, the label formatted in SQL, and
//     the metric expressions being the shared frozen string rather than a
//     re-derivation;
//   * against the MAPPED OUTPUT — that a zero-filled row survives as `0` rather
//     than being dropped or read as absent, that the label reaches the wire as a
//     bare `YYYY-MM-DD` with no offset, and that the buckets sum to the totals a
//     reader will add them up to.
//
// ⚠️ **The fixture cannot prove anything about timezones, and does not claim to.**
// `bucket_start` arrives already cut: `date_trunc` and `to_char` run in Postgres.
// The labels below are hand-written strings. The zone rule is asserted against the
// SQL text, where it lives; the integration suite is where it is executed.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

const { AgencyCampaignRepository, AgencyAgentStatsRepository } = await import(
  '../../../src/db/repositories/agency.repository.js'
);

const SCOPE = { tenantId: 't1', accountId: 'a1' };
const CAMPAIGN_ID = '11111111-2222-3333-4444-555555555555';
const WINDOW = {
  from: new Date('2026-08-11T00:00:00.000Z'),
  to: new Date('2026-08-14T00:00:00.000Z'),
  bucket: 'day' as const,
};

const sqlOf = (): string => String(pool.query.mock.calls[0]?.[0] ?? '');
const paramsOf = (): unknown[] => (pool.query.mock.calls[0]?.[1] ?? []) as unknown[];

/**
 * The statement with its `--` comments stripped.
 *
 * Every NEGATIVE assertion runs against this. The query is heavily commented and
 * the comments NAME the columns and spellings it deliberately does NOT use, so
 * `not.toContain('created_at')` against the raw text would fail on the sentence
 * explaining why `created_at` is the wrong column — and would keep failing until
 * someone deleted the explanation. Same helper, same reason, as
 * `agent-stats-repository.test.ts`.
 */
const executable = (sql: string): string => sql.replace(/--[^\n]*/g, '');

/**
 * Three days, and the MIDDLE ONE IS THE POINT.
 *
 * `2026-08-12` is a zero row — the shape the LEFT JOIN produces for a day the
 * campaign dialled nobody, with every counter COALESCE'd to the string `'0'`. It
 * is what a weekend looks like coming out of Postgres, and the reason the fixture
 * is written this way rather than as two busy days: a mapper that dropped
 * zero-valued rows, or that read `'0'` through a truthiness check, would pass a
 * fixture with nothing empty in it.
 *
 * Every other value is distinct, so reading the right count off the wrong key
 * fails.
 */
const SERIES_ROWS = [
  {
    bucket_start: '2026-08-11', timezone: 'Asia/Kolkata',
    attempts: '412', connected: '118', successes: '76',
    talk_seconds: '22910', wrapup_seconds: '4488',
  },
  {
    bucket_start: '2026-08-12', timezone: 'Asia/Kolkata',
    attempts: '0', connected: '0', successes: '0',
    talk_seconds: '0', wrapup_seconds: '0',
  },
  {
    bucket_start: '2026-08-13', timezone: 'Asia/Kolkata',
    attempts: '307', connected: '91', successes: '54',
    talk_seconds: '18120', wrapup_seconds: '3300',
  },
];

beforeEach(() => {
  pool.query.mockReset();
  pool.query.mockResolvedValue({ rows: SERIES_ROWS });
});

const read = () => new AgencyCampaignRepository().statsSeries(SCOPE, CAMPAIGN_ID, WINDOW);

// ─── the statement ──────────────────────────────────────────────────────────

describe('the buckets are cut in the CAMPAIGN\'s own timezone', () => {
  it('derives the zone from the campaign row, never from a parameter', async () => {
    await read();
    const sql = sqlOf();
    expect(sql).toContain('AT TIME ZONE');
    expect(sql).toContain('c.default_timezone');
    // There is deliberately no `tz` query parameter, so no literal zone may appear
    // in the bucket expression — a literal would be the "one chosen zone" reading
    // this route rejects, and it would put an Asia/Kolkata campaign's connect peak
    // in the wrong column.
    expect(executable(sql)).not.toContain("AT TIME ZONE 'UTC'");
    // ...and no zone may arrive as a BOUND VALUE either. The assertion that bites
    // is the exact bound list: a `tz` parameter smuggled in anywhere lengthens it.
    expect(paramsOf()).toEqual([CAMPAIGN_ID, WINDOW.from, WINDOW.to, 't1', 'a1']);
    expect(executable(sql)).not.toContain('AT TIME ZONE $');
  });

  it('resolves the zone through pg_timezone_names so a typo cannot 500 the read', async () => {
    await read();
    // `default_timezone` is VARCHAR(64) with no constraint and comes from customer
    // config. `AT TIME ZONE 'Asia/Kolkata_typo'` raises 22023, which nothing maps
    // to a status. LATERAL with LIMIT 1 rather than a plain equi-join: the join
    // sits inside an aggregate, so two matching zone rows would double every
    // counter. Same constants as every other zoned agency read.
    const lateralJoin = 'LEFT JOIN LATERAL (SELECT z.name FROM pg_timezone_names z'
      + ' WHERE lower(z.name) = lower(c.default_timezone) LIMIT 1) z ON true';
    expect(sqlOf()).toContain(lateralJoin);
    expect(sqlOf()).toContain("COALESCE(z.name, 'UTC')");
  });

  it('echoes the RESOLVED zone, not the stored column', async () => {
    const series = await read();
    // The two differ exactly when the stored value is garbage, which is the one
    // campaign where echoing the column would hand a console a broken zone name to
    // print over columns that are in fact UTC.
    expect(sqlOf()).toContain("COALESCE(z.name, 'UTC') AS zone");
    expect(executable(sqlOf())).not.toContain('c.default_timezone AS');
    expect(series?.timezone).toBe('Asia/Kolkata');
  });

  it('resolves the zone in the SAME statement as the buckets — no second snapshot', async () => {
    await read();
    // `groupedStats` needs a REPEATABLE READ transaction for its
    // `resolved_timezone` precisely because it reads the zone in a second
    // statement: two pool connections are two READ COMMITTED snapshots, so a
    // `default_timezone` UPDATE landing between them makes the response report a
    // zone the buckets were never cut in. One statement removes the failure rather
    // than fencing it.
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('the window is half-open, on dialed_at', () => {
  it('bounds `from` inclusive and `to` EXCLUSIVE', async () => {
    await read();
    const sql = executable(sqlOf());
    // A half-open window is the only shape that tiles: [Mon,Tue) and [Tue,Wed)
    // cover Tuesday exactly once. Note this differs from the attempt SPINE, whose
    // `to` is inclusive because it is a filter rather than an aggregate.
    expect(sql).toContain('a.dialed_at >= $2');
    expect(sql).toContain('a.dialed_at < $3');
    expect(sql).not.toContain('a.dialed_at <= $3');
    expect(paramsOf()[1]).toBe(WINDOW.from);
    expect(paramsOf()[2]).toBe(WINDOW.to);
  });

  it('excludes an attempt that was never placed', async () => {
    await read();
    // `dialed_at IS NULL` is an attempt that was created and never dialled. Counting
    // it would put a dial that did not happen in a bucket, and there is no honest
    // bucket for it — `created_at` precedes the dial by a dispatch hop.
    expect(executable(sqlOf())).toContain('a.dialed_at IS NOT NULL');
  });

  it('buckets on dialed_at — never created_at, never ended_at', async () => {
    await read();
    const sql = executable(sqlOf());
    expect(sql).toContain("date_trunc('day', (a.dialed_at AT TIME ZONE");
    // `created_at` can bucket an attempt into a day nothing was dialled in;
    // `ended_at` pushes a call straddling midnight into the later day and leaves a
    // live one in no day at all.
    expect(sql).not.toContain("date_trunc('day', (a.created_at");
    expect(sql).not.toContain("date_trunc('day', (a.ended_at");
  });

  it('clips the spine\'s upper bound by ONE MICROSECOND, not by a whole bucket', async () => {
    await read();
    // The last bucket is the one containing the greatest instant strictly BEFORE
    // `to`. Generating up to date_trunc(unit, to) emits one extra all-zero bucket
    // every time `to` lands on a boundary — which is the ordinary case, because a
    // console asks for whole days — and that bucket renders as a day the campaign
    // did nothing on a chart whose axis has not reached it.
    expect(sqlOf()).toContain("$3::timestamptz - interval '1 microsecond'");
    expect(sqlOf()).toContain('generate_series(');
  });
});

describe('EVERY bucket in the range is present, zeros included', () => {
  it('generates a calendar spine and LEFT JOINs the aggregate onto it', async () => {
    await read();
    const sql = sqlOf();
    // The zero-fill is a property of the STATEMENT. Grouping the attempts alone
    // would emit only the labels that had something in them, and a chart fed a
    // gappy series either draws a straight line through the hole — inventing dials
    // that did not happen — or shifts every later point one column left.
    expect(sql).toContain('generate_series(');
    expect(sql).toContain('LEFT JOIN agg g ON g.bucket_start = sp.bucket_start');
    // Driven FROM the spine, not from the aggregate: the other direction would put
    // the LEFT JOIN on the wrong side and drop the empty days again.
    expect(sql).toContain('FROM spine sp');
    for (const column of ['attempts', 'connected', 'successes', 'talk_seconds', 'wrapup_seconds']) {
      expect(sql).toContain(`COALESCE(g.${column}, '0')`);
    }
  });

  it('steps the spine in CALENDAR units over bare local timestamps', async () => {
    await read();
    // `date_trunc(unit, ts AT TIME ZONE tz)` yields a BARE timestamp, and adding
    // `interval '1 day'` to one is exactly +24h of wall clock with no DST
    // arithmetic — so the boundaries stay at 00:00 local through a transition.
    // Walking the range in JS with a fixed 86_400_000ms step would skip or
    // duplicate a label twice a year.
    expect(sqlOf()).toContain("interval '1 day'");
  });

  it('maps a zero-filled row to 0 rather than dropping it or reading it as absent', async () => {
    const series = await read();
    // The middle day of the fixture. `'0'` is a real zero and must survive the
    // `::text` → `Number()` hop; a truthiness check anywhere in the mapper would
    // swallow it, and a filter on `attempts` would delete the row.
    expect(series?.buckets.map((b) => b.bucket_start))
      .toEqual(['2026-08-11', '2026-08-12', '2026-08-13']);
    expect(series?.buckets[1]).toEqual({
      bucket_start: '2026-08-12',
      attempts: 0, connected: 0, successes: 0, talk_seconds: 0, wrapup_seconds: 0,
    });
  });

  it('orders ascending, and the label sorts chronologically as a string', async () => {
    await read();
    // Lexicographic on `YYYY-MM-DD` IS chronological, which is half the reason the
    // label has that shape. The ORDER BY is still in SQL so a consumer never has to
    // rely on that coincidence.
    expect(sqlOf()).toContain('ORDER BY sp.bucket_start');
  });
});

describe('bucket_start is a DATE — no time, no offset', () => {
  it('formats the label in SQL through the shared helper', async () => {
    await read();
    // node-pg parses a bare `timestamp` into a LOCAL-time Date, which would put the
    // server's zone back on a value the query went to some trouble to remove.
    expect(sqlOf()).toContain("to_char(");
    expect(sqlOf()).toContain("'YYYY-MM-DD'");
    // BOTH labels — the spine's and the aggregate's — come from the same expression,
    // which is what makes the LEFT JOIN's `=` a total match rather than a
    // coincidence of two `to_char` spellings.
    expect(sqlOf().match(/to_char\(/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('reaches the wire as a bare YYYY-MM-DD, and nothing turns it into an instant', async () => {
    const series = await read();
    for (const bucket of series!.buckets) {
      expect(bucket.bucket_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // The failure this pins: an ISO INSTANT here is dated a day early for every
      // reader west of Greenwich, because a date-only string is the one literal
      // `new Date(...)` parses as UTC midnight while `…T00:00:00+05:30` is not.
      expect(bucket.bucket_start).not.toContain('T');
      expect(bucket.bucket_start).not.toMatch(/[Z+]/);
    }
  });
});

describe('the counters are the SHARED metric expressions, not a re-derivation', () => {
  it('counts connects on bridged_at and successes through the shared predicate', async () => {
    await read();
    const sql = executable(sqlOf());
    // The same gate every flow metric on `AgencyCampaignStats` uses, and the same
    // one `disposition.ts` uses to decide whether there was a conversation to write
    // up. `outcome = 'connected'` is a CLASSIFICATION that can be absent, late, or
    // say connected about a call no agent ever heard — so `connected` here sums to
    // `human_connects + machine_connects + unclassified_connects` (every bridged
    // attempt) and deliberately NOT to `attempts_connected`.
    expect(sql).toContain('COUNT(*) FILTER (WHERE a.bridged_at IS NOT NULL)');
    expect(sql).not.toContain("a.outcome = 'connected'");
    // Conversions go through `successDispositionSql`, so this route and the campaign
    // roll-up count the same conversion.
    expect(sql).toContain("e->'is_success' = 'true'::jsonb");
    expect(sql).toContain('jsonb_array_elements(c.disposition_catalog)');
    // A malformed catalog must not throw: object guard, and no boolean cast.
    expect(sql).toContain("jsonb_typeof(e) = 'object'");
    expect(sql).not.toContain('::boolean');
  });

  it('measures talk as ended_at - bridged_at excluding orphans, and MEASURED wrap-up', async () => {
    await read();
    const sql = executable(sqlOf());
    expect(sql).toContain('SUM(EXTRACT(EPOCH FROM (a.ended_at - a.bridged_at)))');
    // The reaper stamps `ended_at` at SWEEP time, so one crashed conversation would
    // contribute its whole time-until-sweep to a bucket.
    expect(sql).toContain("a.outcome IS DISTINCT FROM 'orphaned'");
    // Never the persisted `talk_seconds` (anchored on the carrier's answer, nonzero
    // even when no agent bridged) and never the `wrapup_seconds` ALLOTMENT copied
    // from the campaign at wrap-up entry — averaging that hands the operator their
    // own setting back as if it were measurement.
    expect(sql).not.toContain('SUM(a.talk_seconds)');
    expect(sql).not.toContain('SUM(a.wrapup_seconds)');
    expect(sql).toContain("a.wrapup_resolution IN ('disposition_submitted','auto_return','agent_returned')");
  });

  it('emits BYTE-IDENTICAL metric expressions to the per-agent record\'s', async () => {
    // ── The strongest available form of "the buckets sum to the lifetime totals" ──
    //
    // With a mocked pool, no arithmetic assertion can prove summation — the numbers
    // come from the fixture. What CAN be proved is the property the summation rests
    // on: that this statement and the other three call sites select the SAME
    // `AGENCY_ATTEMPT_METRICS_SQL`, so a supervisor subtracting a campaign's series
    // from an agent's buckets gets zero. The constant's own header says the property
    // being protected is byte-equality of the emitted SQL; this asserts exactly
    // that, across two call sites, rather than spot-checking fragments.
    //
    // Compared against the AGENT read rather than against the constant's definition
    // text, because the constant is not exported and its raw text still contains
    // `${…}` placeholders — reading the file would compare un-interpolated template
    // syntax and pass or fail for the wrong reason.
    await read();
    const seriesSql = sqlOf();

    pool.query.mockReset();
    pool.query.mockResolvedValue({ rows: [] });
    await new AgencyAgentStatsRepository().stats(
      { ...SCOPE, agentUserId: 'u-ravi' },
      { from: WINDOW.from, to: WINDOW.to, bucket: 'day' },
    );
    // The agent read issues two statements; the attempts one is the one that is not
    // over the transition log.
    const agentSql = String(
      pool.query.mock.calls.find((c) => !String(c[0]).includes('agency_agent_session_events'))?.[0] ?? '',
    );

    // From the first metric expression to the last, in each. Collapsed on
    // whitespace only: the constant is interpolated at a fixed column and its
    // continuation lines carry their own indentation, so leading space is the one
    // thing that may legitimately differ between call sites.
    const metrics = (sql: string): string => {
      const start = sql.indexOf('COUNT(*)::text AS attempts');
      const end = sql.indexOf('AS wrapup_seconds');
      expect(start, 'the metric block is not in this statement').toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return sql.slice(start, end).replace(/\s+/g, ' ').trim();
    };

    expect(metrics(seriesSql)).toBe(metrics(agentSql));
    // And it is not vacuous — the block carries all five counters.
    expect(metrics(seriesSql)).toContain('AS connected');
    expect(metrics(seriesSql)).toContain('AS successes');
    expect(metrics(seriesSql)).toContain('AS talk_seconds');
  });
});

describe('the fold', () => {
  it('sums to the totals a reader will add the buckets up to', async () => {
    const series = await read();
    const sum = (pick: (b: NonNullable<typeof series>['buckets'][number]) => number): number =>
      series!.buckets.reduce((acc, b) => acc + pick(b), 0);

    // Absolute values, so a mapper that summed the right shape from the wrong rows
    // still fails.
    expect(sum((b) => b.attempts)).toBe(719);
    expect(sum((b) => b.connected)).toBe(209);
    expect(sum((b) => b.successes)).toBe(130);
    expect(sum((b) => b.talk_seconds)).toBe(41030);
    expect(sum((b) => b.wrapup_seconds)).toBe(7788);
  });

  it('echoes the campaign id and the bucket unit, and carries NO rates', async () => {
    const series = await read();
    expect(series?.campaign_id).toBe(CAMPAIGN_ID);
    expect(series?.bucket).toBe('day');
    // No rates on the wire, deliberately. A chart aggregating several buckets into
    // one column needs `Σnum / Σden`, not the mean of the per-bucket rates, which is
    // a different and wrong number — shipping the rate invites exactly that mistake.
    for (const bucket of series!.buckets) {
      expect(Object.keys(bucket).sort()).toEqual(
        ['attempts', 'bucket_start', 'connected', 'successes', 'talk_seconds', 'wrapup_seconds'],
      );
    }
    // And the envelope is exactly the four documented fields.
    expect(Object.keys(series!).sort()).toEqual(['bucket', 'buckets', 'campaign_id', 'timezone']);
  });

  it('interpolates the validated bucket unit into date_trunc and the interval', async () => {
    await new AgencyCampaignRepository().statsSeries(SCOPE, CAMPAIGN_ID, { ...WINDOW, bucket: 'week' });
    // `date_trunc`'s first argument cannot be a placeholder alongside a GROUP BY on
    // the same expression, so the unit is interpolated — which is safe ONLY because
    // it comes from `AGENT_STATS_BUCKETS` via `parseCampaignSeriesQuery`, never from
    // raw query input. The signature takes the union type so a caller cannot hand it
    // an unvalidated string without the compiler objecting.
    expect(sqlOf()).toContain("date_trunc('week'");
    expect(sqlOf()).toContain("interval '1 week'");
  });
});

describe('scope and the missing campaign', () => {
  it('predicates on tenant AND account in both halves of the statement', async () => {
    await read();
    const sql = executable(sqlOf());
    // Redundant with the route's `requireOwned`, and kept: this WHERE clause is what
    // separates two accounts' campaign data, and a future caller reaching the
    // repository without that check must not get an answer about someone else's
    // campaign. Two occurrences — `camp` and `agg`.
    expect(sql.match(/c\.tenant_id = \$4/g)?.length).toBe(2);
    expect(sql.match(/c\.account_id = \$5/g)?.length).toBe(2);
  });

  it('returns null — never an empty series — when the campaign matches nothing', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    // No spine rows means `camp` matched nothing: the campaign is not in this
    // account, or was deleted since the route's ownership check. It CANNOT mean an
    // empty window, because the parser refuses `from >= to`. An empty `buckets`
    // array here would report "this campaign dialled nobody" about a campaign that
    // does not exist.
    expect(await read()).toBeNull();
  });
});
