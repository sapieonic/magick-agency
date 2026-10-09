import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// `GET /agency-agents/grouped-stats` — one statement, one merge, no benchmark.
//
// THE POOL IS MOCKED, so the fixtures supply the column names and no assertion
// here can catch a renamed SQL column. Same split as
// `agent-roster-repository.test.ts`, and it means every rule is asserted on
// whichever side it actually lives:
//
//   * against the SQL TEXT — the tenant/account predicate, the shared metric
//     expressions being BYTE-IDENTICAL to the other two aggregates, the LIMIT
//     being pushed DOWN (the opposite of the roster, deliberately), the ORDER BY
//     being total, `NULLS LAST` in both directions, and the fact that `group_by`,
//     `sort`, `order` and `limit` contribute no caller-supplied character;
//   * against the MAPPED OUTPUT — the key's members tracking `group_by`, the
//     null disposition being a REAL group, the null-not-zero rates, and
//     `total_groups` being the pre-limit count.
//
// ⚠️ **What the mocked pool cannot prove, stated so nothing here reads as
// stronger than it is:** that Postgres's WHERE clause excludes another account's
// sessions, that `GROUP BY` folds NULL dispositions into one group, that
// `COUNT(*) OVER ()` is evaluated before `LIMIT`, or that the ORDER BY sorts the
// way the text says. Postgres evaluates those, not this file. What is ours — and
// what is asserted — is that the caller's scope is BOUND into the positions the
// literal predicate reads, that the fragments are the static ones, and that the
// row mapper does what the payload contract says. The rest needs an integration
// pass with a real database.
//
// ── The threshold in this file ───────────────────────────────────────────────
//
// One CONSTANT, `AGENCY_ROSTER_MIN_RATE_DENOMINATOR` — the ROSTER's, reused rather
// than copied — and TWO comparisons against it, because the row serves rates over
// two different denominators. `rates_reportable` floors `attempts` (which is
// `connect_rate_pct`'s denominator) and `success_rate_reportable` floors
// `connected` (which is `success_rate_pct`'s and `aht_seconds`'). This read still
// has no percentile pools and no benchmark to gate a row OUT of (contract D4); the
// flags only say whether the rates it serves may be quoted as numbers.
//
// Both comparisons are `>=`, so each needs a fixture row sitting EXACTLY on its own
// bound or the operator is untested however much this header claims otherwise:
// `u-esi` is on the `attempts` bound (20 dials) and `u-bala` on the `connected` one
// (20 connects). `u-farah`, one dial under, is the other half of the first pair; the
// other half of the second is served as a one-row fixture variant so the group
// counts the rest of the file asserts stay put.
//
// The other two thresholds stay where they live: the parser's
// (`agent-record.test.ts`) and the roster benchmark's
// (`agent-roster-repository.test.ts`), each pinned there on its own bound.
// ---------------------------------------------------------------------------

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@magick-agency/observability', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/**
 * The pool, plus a REGISTRY of the clients it has handed out.
 *
 * The zone lookup shares a transaction with the grouped statement (02b E3 +
 * review C2), so "which connection did this statement go out on" is now a
 * property worth asserting rather than an implementation detail: on two
 * connections the two reads are two READ COMMITTED snapshots and the page can
 * report a zone its buckets were never cut in.
 *
 * Each client's `query` DELEGATES to `pool.query`, so every existing assertion
 * over `pool.query.mock.calls` still sees the statement whichever path issued it
 * — and `clients` additionally records who issued it, which is what the
 * transaction test reads. A statement that went out on the pool instead of the
 * client is therefore visible as a count MISMATCH between the two mocks, not
 * merely absent.
 */
const { pool, clients } = vi.hoisted(() => {
  const query = vi.fn();
  const clients: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }[] = [];
  const connect = vi.fn(async () => {
    const client = {
      query: vi.fn((...args: unknown[]) => query(...args)),
      release: vi.fn(),
    };
    clients.push(client);
    return client;
  });
  return { pool: { query, connect }, clients };
});
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

const { AgencyAgentStatsRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { AGENCY_GROUP_DIMENSIONS, GROUP_SORTS } = await import('../../../src/agency/agent-record.js');
// The ROSTER's constant, imported rather than restated: the boundary cases below
// are written as `constant` and `constant - 1`, so tuning the threshold moves the
// two fixture rows and this file keeps testing the same bound.
const { AGENCY_ROSTER_MIN_RATE_DENOMINATOR } = await import('@magick-agency/contracts/agency');
type AgentGroupedParams = import('../../../src/agency/agent-record.js').AgentGroupedParams;

const SCOPE = { tenantId: 't1', accountId: 'a1' };
/**
 * Annotated rather than inferred, for the reason the roster fixture states: without
 * it TypeScript narrows `sort` to the literal `'key'` and every override below
 * becomes a type error against a `Partial` of the narrowed shape.
 */
const WINDOW: AgentGroupedParams = {
  from: new Date('2026-08-17T00:00:00.000Z'),
  to: new Date('2026-08-24T00:00:00.000Z'),
  groupBy: ['agent'],
  sort: 'key',
  order: 'asc',
  limit: 200,
};
const ONE_CAMPAIGN = '11111111-2222-3333-4444-555555555555';

/**
 * Every call that carried a STATEMENT, in order — transaction control excluded.
 *
 * `BEGIN` / `COMMIT` / `ROLLBACK` are round trips, not statements about rows, and
 * the zone read now issues them (see the transaction test). Filtering here rather
 * than at each call site keeps `sql()` meaning "the grouped statement" — which is
 * what the ~forty assertions below are about — and keeps the transaction itself
 * asserted in exactly one place.
 */
const isControl = (statement: unknown): boolean =>
  /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(String(statement));
const statements = (): unknown[][] => pool.query.mock.calls
  .filter((call) => !isControl(call[0]));
const sql = (): string => String(statements()[0]?.[0] ?? '');
const params = (): unknown[] => (statements()[0]?.[1] ?? []) as unknown[];

/**
 * The statement with its `--` comments stripped.
 *
 * Every NEGATIVE assertion runs against this, for the reason
 * `agent-roster-repository.test.ts` states: the statement's comments NAME the
 * things it deliberately does not do, so `not.toContain(...)` against the raw text
 * would fail on the sentence explaining the absence and keep failing until someone
 * deleted the explanation.
 */
const executable = (text: string): string => text.replace(/--[^\n]*/g, '');

// ─── the fixture ────────────────────────────────────────────────────────────
//
// Numerics as STRINGS, because that is what node-pg returns for `bigint` and for
// the `::text` casts the statement makes explicit — and it is the only way the
// `::text` -> `Number()` hop is actually exercised. Every value distinct, so
// reading the right number off the wrong key fails.
//
// Four groups, chosen so each decides a different rule:
//
//   u-anita  everything measurable.
//   u-bala   mid-volume.
//   u-chen   dialled 40 and connected NOBODY, so `success_rate_pct` and
//            `aht_seconds` are the zero-denominator nulls while
//            `connect_rate_pct` is a MEASURED 0.
//   u-dev    one single attempt — the minimum a group can hold (see the
//            reachability note on the `attempts >= 1` test). Also the far side of
//            the reportability bound, with a 100% success rate off ONE connect —
//            the exact number the flag exists to stop a console printing.
//   u-esi    attempts EXACTLY on AGENCY_ROSTER_MIN_RATE_DENOMINATOR.
//   u-farah  one attempt BELOW it. The pair either side of the bound is the only
//            thing that separates `>=` from `>`.

const GROUPED_ROWS = [
  {
    agent_user_id: 'u-anita', attempts: '400', connected: '200', successes: '60',
    talk_seconds: '40000', wrapup_seconds: '4000', total_groups: '6',
  },
  {
    agent_user_id: 'u-bala', attempts: '100', connected: '20', successes: '4',
    talk_seconds: '4000', wrapup_seconds: '400', total_groups: '6',
  },
  {
    agent_user_id: 'u-chen', attempts: '40', connected: '0', successes: '0',
    talk_seconds: '0', wrapup_seconds: '0', total_groups: '6',
  },
  {
    agent_user_id: 'u-dev', attempts: '1', connected: '1', successes: '1',
    talk_seconds: '90', wrapup_seconds: '30', total_groups: '6',
  },
  // The two boundary rows. Their `attempts` are written as the constant +/- 0 and
  // -1 in the assertions rather than as bare literals, so a tuned threshold moves
  // these two fixtures and nothing else — but the fixture values themselves have
  // to be literal strings, because node-pg hands back text.
  {
    agent_user_id: 'u-esi', attempts: '20', connected: '10', successes: '3',
    talk_seconds: '2000', wrapup_seconds: '200', total_groups: '6',
  },
  {
    agent_user_id: 'u-farah', attempts: '19', connected: '9', successes: '2',
    talk_seconds: '1800', wrapup_seconds: '180', total_groups: '6',
  },
];

function serve(rows: unknown[]): void {
  pool.query.mockImplementation(() => Promise.resolve({ rows }));
}

/**
 * The zone lookup is a SECOND statement, so the fixtures have to be dispatched.
 *
 * `serve()` answers every query with the same rows, which would hand the zone
 * lookup the grouped fixture — `resolved_timezone` would read `undefined` off it
 * and the field would be `null` for the wrong reason, on every test. Dispatched on
 * the ATTEMPTS TABLE rather than on the zone statement's own alias: the zone
 * lookup is the one statement here that does not touch `agency_call_attempts`, so
 * a renamed column or alias fails these tests loudly instead of silently
 * re-routing the fixture.
 */
const isZoneStatement = (statement: unknown): boolean =>
  !isControl(statement) && !String(statement).includes('agency_call_attempts');

function serveWithZone(rows: unknown[], zoneRows: unknown[]): void {
  pool.query.mockImplementation((statement: unknown) => Promise.resolve({
    rows: isZoneStatement(statement) ? zoneRows : rows,
  }));
}

const zoneCall = () => statements().find((call) => isZoneStatement(call[0]));
const zoneSql = (): string => String(zoneCall()?.[0] ?? '');
const zoneParams = (): unknown[] => (zoneCall()?.[1] ?? []) as unknown[];

beforeEach(() => {
  pool.query.mockReset();
  // The clients handed out by the previous test, and their own call records. Reset
  // rather than left to accumulate: `clients` is asserted to have LENGTH 1 on a
  // transacted read, which is only a claim about this test if the array starts
  // empty. `connect`'s implementation is deliberately NOT reset — it is the
  // factory, not a fixture.
  clients.length = 0;
  pool.connect.mockClear();
  warn.mockReset();
  serve(GROUPED_ROWS);
});

const read = (over: Partial<AgentGroupedParams> = {}) =>
  new AgencyAgentStatsRepository().groupedStats(SCOPE, { ...WINDOW, ...over });

// ─── the scope is a PREDICATE ────────────────────────────────────────────────

describe('the tenant AND account scope is a predicate in the one statement', () => {
  it('binds both, and spells the predicate on the ATTEMPT literally', async () => {
    // There is no path parameter on this route either, so these two predicates are
    // the ONLY thing separating one account's numbers from another's — and unlike
    // the roster, a `campaign`-grouped row is not even keyed on a person, so a
    // missing predicate would not look wrong on the payload.
    //
    // ── On `a`, not on `s`, and the move is the point ─────────────────────────
    //
    // It used to read `s.tenant_id = $3`, off the SESSION. That cannot survive the
    // LEFT join a campaign-shaped read now takes (see the join tests): the NULL side
    // fails any predicate on `s`, so every unreserved attempt would be dropped by
    // the WHERE clause instead of by the join and the LEFT join would be silently
    // undone. The attempt is the row being counted, its `tenant_id`/`account_id` are
    // NOT NULL (migration 075), and it is the pair the billing sweep scopes on.
    //
    // Bound in the SAME ORDER as `rosterAttemptTotals` — from, to, tenant, account,
    // then the optional campaign — because that statement and this one share their
    // whole FROM and WHERE clause and a future editor will diff between them. A
    // swapped from/to survives review: an inverted window is an empty result rather
    // than an error.
    await read();
    expect(sql()).toContain('a.tenant_id = $3');
    expect(sql()).toContain('a.account_id = $4');
    expect(params()[0]).toEqual(WINDOW.from);
    expect(params()[1]).toEqual(WINDOW.to);
    expect(params()[2]).toBe('t1');
    expect(params()[3]).toBe('a1');
  });

  it('keeps the scope INSIDE the CTE, where the rows are produced', async () => {
    // Not applied to the CTE's output. A `WHERE` on the outer select would run
    // AFTER the `GROUP BY`, so every aggregate would already have been computed
    // over both accounts' attempts — and the number a supervisor reads would be
    // wrong even though every row shown belonged to them.
    await read();
    const text = executable(sql());
    const cteEnd = text.indexOf('GROUP BY');
    expect(cteEnd).toBeGreaterThan(0);
    expect(text.slice(0, cteEnd)).toContain('a.tenant_id = $3');
    expect(text.slice(0, cteEnd)).toContain('a.account_id = $4');
  });

  it('narrows the optional campaign on the ATTEMPT, inside the CTE too', async () => {
    await read({ campaignId: ONE_CAMPAIGN });
    expect(executable(sql())).toContain('a.campaign_id = $5::uuid');
    expect(params()[4]).toBe(ONE_CAMPAIGN);
  });

  it('bounds the window half-open on `dialed_at`, and nothing else', async () => {
    await read();
    const text = executable(sql());
    expect(text).toContain('a.dialed_at IS NOT NULL');
    expect(text).toContain('a.dialed_at >= $1');
    expect(text).toContain('a.dialed_at < $2');
    // Never `created_at` (a dispatch hop earlier, so it can bucket an attempt into
    // a day nothing was dialled in) and never `ended_at` (which pushes a call
    // straddling midnight into the later day and leaves a live one in no day at
    // all). Same choice, same reasons, as every other aggregate on this surface.
    expect(text).not.toContain('a.created_at');
    expect(text).not.toContain('a.ended_at >');
  });
});

// ─── the SESSION join, and which way it points ───────────────────────────────
//
// Review finding C5. `agency_call_attempts.reserved_agent_id` is nullable and NULL
// on every attempt that failed before an agent was on it, so the join word decides
// whether those attempts are COUNTED — and the right answer differs by question:
// LEFT where the grouping is campaign-shaped (the dial happened, in a real hour, and
// billing counts it), INNER where `agent` is the key (a row with no agent belongs to
// no agent's group).
//
// ⚠️ These are TEXT assertions. The pool is mocked, so nothing here can show an
// unreserved row being counted — the fixtures are handed back whatever the join
// says. That behaviour is pinned against a real Postgres in
// `test/integration/agency/agent-grouped-read.test.ts`, both directions, and this
// file's job is only that the emitted word tracks `group_by`.

describe('the session join is LEFT unless `agent` is being attributed', () => {
  /** The session join clause alone, from the emitted statement. */
  const sessionJoin = (): string => {
    const match = /(LEFT )?JOIN agency_agent_sessions[\s\S]*?(?=\n\s*JOIN agency_campaigns)/
      .exec(executable(sql()));
    if (!match) throw new Error('session join clause not found');
    return match[0];
  };

  it('LEFT joins on every grouping that does NOT include `agent`', async () => {
    // The whole campaign-shaped vocabulary, including both best-hours dimensions.
    // A `campaign_id` is supplied wherever a zoned dimension is grouped because the
    // parser would otherwise refuse the read (D5) — that is a different rule and it
    // is pinned elsewhere; here it only has to not get in the way.
    for (const over of [
      { groupBy: ['campaign'] as const },
      { groupBy: ['disposition'] as const },
      { groupBy: ['campaign', 'disposition'] as const },
      { groupBy: ['hour_of_day'] as const, campaignId: ONE_CAMPAIGN },
      { groupBy: ['day'] as const, campaignId: ONE_CAMPAIGN },
      { groupBy: ['day_of_week', 'hour_of_day'] as const, campaignId: ONE_CAMPAIGN },
    ]) {
      pool.query.mockReset();
      serveWithZone(GROUPED_ROWS, [{ resolved_timezone: 'Asia/Kolkata' }]);
      await read({ groupBy: [...over.groupBy], campaignId: over.campaignId });
      expect(sessionJoin(), over.groupBy.join(',')).toMatch(/^LEFT JOIN agency_agent_sessions/);
    }
  });

  it('keeps the INNER join when `agent` IS grouped, whatever it is paired with', async () => {
    // Not an inconsistency with the case above: here the join IS the attribution,
    // `s.agent_user_id` is the key, and a LEFT join would emit a null-keyed row —
    // a person-shaped group that is not a person.
    for (const over of [
      { groupBy: ['agent'] as const },
      { groupBy: ['agent', 'campaign'] as const },
      { groupBy: ['agent', 'disposition'] as const },
      { groupBy: ['agent', 'day'] as const, campaignId: ONE_CAMPAIGN },
      { groupBy: ['agent', 'hour_of_day'] as const, campaignId: ONE_CAMPAIGN },
    ]) {
      pool.query.mockReset();
      serveWithZone(GROUPED_ROWS, [{ resolved_timezone: 'Asia/Kolkata' }]);
      await read({ groupBy: [...over.groupBy], campaignId: over.campaignId });
      expect(sessionJoin(), over.groupBy.join(',')).toMatch(/^JOIN agency_agent_sessions/);
    }
  });

  it('changes only the JOIN WORD, and the session keeps its own scope either way', async () => {
    // The two clauses are one string with one varying word, which is what stops the
    // tenant predicate from being present on one of them and not the other — the
    // failure a second hand-written join clause would produce, and one that leaks in
    // exactly the direction nobody tests.
    pool.query.mockReset();
    serveWithZone(GROUPED_ROWS, [{ resolved_timezone: 'Asia/Kolkata' }]);
    await read({ groupBy: ['agent'] });
    const attributing = sessionJoin();

    pool.query.mockReset();
    serveWithZone(GROUPED_ROWS, [{ resolved_timezone: 'Asia/Kolkata' }]);
    await read({ groupBy: ['hour_of_day'], campaignId: ONE_CAMPAIGN });
    const optional = sessionJoin();

    expect(optional).toBe(`LEFT ${attributing}`);
    // Bound to the SAME placeholders the WHERE clause reads, so a foreign session
    // cannot attribute this account's attempt under either word: it drops the row
    // where `agent` is grouped and reads as unattributed where it is not.
    for (const clause of [attributing, optional]) {
      expect(clause).toContain('ON s.id = a.reserved_agent_id');
      expect(clause).toContain('s.tenant_id = $3');
      expect(clause).toContain('s.account_id = $4');
    }
  });
});

// ─── the shared metric builder ──────────────────────────────────────────────

describe('the five metric expressions are the SHARED ones, byte for byte', () => {
  /**
   * ── What this test is actually for ─────────────────────────────────────────
   *
   * A supervisor's roster line, an agent's own scorecard and a grouped cell must
   * report the same five numbers for the same attempts, so that subtracting one
   * from another gives zero. That property IS byte-equality of the emitted SQL —
   * a reviewer established it held between the first two by mechanically diffing
   * them, and a third hand-copied statement is exactly how it would stop being
   * true. The three now interpolate one frozen string; this pins that they still
   * do, by comparing the emitted text rather than by trusting the constant.
   *
   * Compared with comment lines removed: the shared block carries one canonical
   * comment set, so the comments are identical too — but the EXPRESSIONS are the
   * claim, and stripping the prose is what keeps this test about them.
   */
  const metricBlock = (statement: string): string => {
    const lines = statement.split('\n');
    const start = lines.findIndex((line) => line.includes('COUNT(*)::text AS attempts'));
    const end = lines.findIndex((line) => line.includes('AS wrapup_seconds'));
    if (start < 0 || end < 0) throw new Error('metric block markers not found');
    return lines.slice(start, end + 1)
      .filter((line) => !/^\s*--/.test(line))
      .join('\n')
      // The last column's trailing comma differs only because a caller with more
      // columns appends one — `rosterAttemptTotals` has `campaigns` after it.
      .replace(/AS wrapup_seconds,?\s*$/, 'AS wrapup_seconds');
  };

  it('emits the same block as the roster aggregate and the per-agent aggregate', async () => {
    const repo = new AgencyAgentStatsRepository();

    pool.query.mockClear();
    serve(GROUPED_ROWS);
    await repo.groupedStats(SCOPE, WINDOW);
    const grouped = metricBlock(sql());

    // The roster's attempts aggregate. Its occupancy read is the statement that
    // touches the transition log, so the other one is the attempts one.
    pool.query.mockClear();
    pool.query.mockImplementation((statement: unknown) => Promise.resolve({
      rows: String(statement).includes('agency_agent_session_events') ? [] : [],
    }));
    await repo.roster(SCOPE, {
      from: WINDOW.from, to: WINDOW.to, sort: 'successes', order: 'desc', limit: 100,
    });
    const roster = metricBlock(String(pool.query.mock.calls[0]?.[0]));

    // The per-agent record's attempts aggregate, likewise.
    pool.query.mockClear();
    pool.query.mockImplementation(() => Promise.resolve({ rows: [] }));
    await repo.stats(
      { ...SCOPE, agentUserId: 'u-anita' },
      { from: WINDOW.from, to: WINDOW.to, bucket: 'day' },
    );
    const perAgent = metricBlock(String(
      pool.query.mock.calls.find((call) => !String(call[0]).includes('agency_agent_session_events'))?.[0],
    ));

    expect(grouped).toBe(roster);
    expect(grouped).toBe(perAgent);
    // And it is the real block, not three empty strings agreeing.
    expect(grouped).toContain('COUNT(*)::text AS attempts');
    expect(grouped).toContain("a.outcome IS DISTINCT FROM 'orphaned'");
    expect(grouped).toContain("a.wrapup_resolution IN ('disposition_submitted','auto_return','agent_returned')");
    expect(grouped).toContain("e->'is_success' = 'true'::jsonb");
  });

  it('keeps the two definitions that have history, and the reasons for them', async () => {
    // The AGENT's leg (`ended_at - bridged_at`), never the persisted
    // `talk_seconds` column — which is anchored on the CARRIER's answer and is
    // nonzero even when no agent bridged, because an abandoned attempt settles
    // carrying the apology clip's talk time. Orphans excluded, because the reaper
    // stamps `ended_at` at SWEEP time.
    await read();
    const text = executable(sql());
    expect(text).toContain('SUM(EXTRACT(EPOCH FROM (a.ended_at - a.bridged_at)))');
    expect(text).not.toContain('SUM(a.talk_seconds)');
    // MEASURED wrap-up, never the allotment copied from the campaign at wrap-up
    // entry — averaging that hands the operator their own setting back as if it
    // were evidence (migration 088).
    expect(text).toContain('SUM(EXTRACT(EPOCH FROM (a.wrapup_ended_at - a.wrapup_started_at)))');
    expect(text).not.toContain('SUM(a.wrapup_seconds)');
  });
});

// ─── the grouping ───────────────────────────────────────────────────────────

describe('every dimension resolves to a STATIC fragment, and nothing else does', () => {
  it('selects and groups each dimension, one at a time', async () => {
    const expected: Record<string, string> = {
      agent: 's.agent_user_id AS agent_user_id',
      campaign: 'a.campaign_id AS campaign_id',
      disposition: 'a.disposition_code AS disposition_code',
      day: "to_char(date_trunc('day', (a.dialed_at AT TIME ZONE COALESCE(z.name, 'UTC'))), 'YYYY-MM-DD') AS day_start",
      day_of_week: "EXTRACT(DOW FROM (a.dialed_at AT TIME ZONE COALESCE(z.name, 'UTC')))::int AS day_of_week",
      hour_of_day: "EXTRACT(HOUR FROM (a.dialed_at AT TIME ZONE COALESCE(z.name, 'UTC')))::int AS hour_of_day",
    };
    for (const dimension of AGENCY_GROUP_DIMENSIONS) {
      pool.query.mockClear();
      serve([]);
      await read({ groupBy: [dimension] });
      expect(executable(sql()), dimension).toContain(expected[dimension] as string);
      // Grouped by ORDINAL rather than by repeating the expression: a
      // `date_trunc(...)` in a GROUP BY has to be spelled identically to the
      // select-list copy or Postgres treats them as two expressions, and one
      // spelling cannot drift from itself.
      expect(executable(sql()), dimension).toContain('GROUP BY 1');
    }
  });

  it('groups by both ordinals when two dimensions are asked for', async () => {
    await read({ groupBy: ['agent', 'campaign'] });
    expect(executable(sql())).toContain('GROUP BY 1, 2');
  });

  it('reuses `bucketStartSql` for `day`, so the format matches `bucket_start`', async () => {
    // The contract says a `day` key has the same format as the per-agent record's
    // `bucket_start`. Sharing the expression is what makes that true rather than
    // claimed — and it inherits that function's reason for formatting in SQL:
    // node-pg parses a bare `timestamp` into a LOCAL-time `Date`, putting the
    // server's zone back on a value the query removed it from.
    const { bucketStartSql } = await import('../../../src/agency/agent-record.js');
    await read({ groupBy: ['campaign', 'day'] });
    expect(executable(sql()))
      .toContain(bucketStartSql('day', 'a.dialed_at', "COALESCE(z.name, 'UTC')"));
  });

  it('casts the numeric dimensions to text OUTSIDE the CTE, so the ORDER BY is numeric', async () => {
    // The cast has to happen somewhere — node-pg hands `numeric` back as a string
    // and `int4` as a number, so one convention per row mapper means casting. It
    // must NOT happen in the CTE: the ORDER BY reads the CTE's column, and a
    // text-typed hour sorts '10' before '9'. With the slice now in SQL that would
    // not merely reorder the page, it would change which hours are ON it.
    await read({ groupBy: ['hour_of_day'], sort: 'key' });
    const text = executable(sql());
    expect(text).toContain('))::int AS hour_of_day');
    expect(text).toContain('g.hour_of_day::text AS hour_of_day');
    expect(text).toContain('ORDER BY g.hour_of_day ASC NULLS LAST');
    expect(text).not.toContain('::int::text AS hour_of_day');
  });

  it('interpolates NO caller-supplied character, for any grouping or ranking', async () => {
    // Unlike the roster — where the answer is that `sort`/`order` never reach a
    // statement at all — this read's ordering and slicing DO happen in SQL. So the
    // injection answer has to be the other one: every fragment comes from a
    // `Record` lookup keyed on a validated union member, and `limit` is a bound
    // parameter like every value.
    for (const sort of GROUP_SORTS) {
      for (const order of ['asc', 'desc'] as const) {
        pool.query.mockClear();
        serve([]);
        await read({ groupBy: ['agent', 'campaign'], sort, order, limit: 7, campaignId: ONE_CAMPAIGN });
        const text = executable(sql());
        // Neither the scope nor the campaign appears as text anywhere.
        expect(text, `${sort}/${order}`).not.toContain('t1');
        expect(text, `${sort}/${order}`).not.toContain('11111111-2222');
        // Nor the limit: it is bound, not spelled.
        expect(text, `${sort}/${order}`).not.toMatch(/LIMIT\s+7/);
        expect(params()).toContain(ONE_CAMPAIGN);
        expect(params()).toContain('t1');
        expect(params()).toContain('a1');
        expect(params().at(-1)).toBe(7);
      }
    }
  });

  it('joins pg_timezone_names UNCONDITIONALLY, and cannot FAN OUT when it does', async () => {
    // `default_timezone` is VARCHAR(64) with no constraint, and
    // `ts AT TIME ZONE 'Mars/Olympus'` raises 22023 which nothing maps to a status
    // — so ONE campaign with a typo would take out every other campaign's numbers
    // in the same statement. The LEFT JOIN turns that into a per-row fallback to
    // UTC, and it is the apparatus the per-agent record already carries.
    //
    // Unconditional on purpose: making the FROM clause depend on `group_by` means a
    // future dimension whose expression reads `z.name` with no `z` in scope, i.e. a
    // runtime 42P01 on a statement that type-checks.
    //
    // LATERAL with `LIMIT 1`, which is the half that is about CORRECTNESS rather
    // than about fail-soft. The join sits inside an aggregate's FROM, so if
    // `lower(z.name)` ever matched two rows for one campaign, every counter for
    // that campaign's attempts would DOUBLE — and `rosterAttemptTotals`, which a
    // supervisor subtracts from this read expecting zero, carries no such join.
    // Nothing declares `lower(name)` unique in `pg_timezone_names`; the LIMIT 1 is
    // what makes the cardinality a property of the statement instead of an
    // assumption about tzdata. Reverting it to the plain equi-join fails here.
    for (const groupBy of [['agent'], ['disposition'], ['campaign', 'hour_of_day']] as const) {
      pool.query.mockClear();
      serve([]);
      await read({ groupBy: [...groupBy] });
      const text = executable(sql());
      expect(text, groupBy.join(',')).toContain(
        'LEFT JOIN LATERAL (SELECT z.name FROM pg_timezone_names z'
        + ' WHERE lower(z.name) = lower(c.default_timezone) LIMIT 1) z ON true',
      );
    }
  });

  it('CONSUMES the resolved zone only where a bucket is actually cut', async () => {
    // The other half of the paragraph above, asserted so the join's unconditional
    // presence is not mistaken for the zone being applied to a count. `agent` and
    // `disposition` are zone-independent, so `COALESCE(z.name, 'UTC')` appears in
    // their statement nowhere — the join is there to keep the FROM clause
    // independent of `group_by`, not because the read uses it.
    for (const groupBy of [['agent'], ['disposition']] as const) {
      pool.query.mockClear();
      serve([]);
      await read({ groupBy: [...groupBy] });
      expect(executable(sql()), groupBy.join(',')).not.toContain("COALESCE(z.name, 'UTC')");
    }
    for (const groupBy of [['campaign', 'day'], ['campaign', 'hour_of_day'], ['campaign', 'day_of_week']] as const) {
      pool.query.mockClear();
      serve([]);
      await read({ groupBy: [...groupBy] });
      expect(executable(sql()), groupBy.join(',')).toContain("AT TIME ZONE COALESCE(z.name, 'UTC')");
    }
  });
});

// ─── the limit is pushed DOWN, unlike the roster's ──────────────────────────

describe('`limit` is applied in SQL, which the roster deliberately cannot do', () => {
  it('binds the limit as the LAST parameter and puts a LIMIT in the statement', async () => {
    // The roster may carry no `LIMIT` at all: its benchmark's occupancy percentiles
    // need per-agent talk+wrapup from one statement and shift_seconds from another,
    // for the WHOLE cohort, so a limit inside either destroys an input the payload
    // needs — and a test in `agent-roster-repository.test.ts` pins that absence.
    // This read has no benchmark and no second statement, so nothing outside the
    // page depends on the rows the page omits and the slice belongs in SQL.
    await read({ limit: 25 });
    expect(executable(sql())).toContain('LIMIT $5');
    expect(params().at(-1)).toBe(25);
  });

  it('moves the limit placeholder when a campaign filter takes $5', async () => {
    // The one thing a hand-counted placeholder gets wrong. `limit` goes last
    // because it belongs to the page rather than to the rows, so its position moves
    // with the optional filter in front of it.
    await read({ limit: 25, campaignId: ONE_CAMPAIGN });
    expect(executable(sql())).toContain('LIMIT $6');
    expect(params()).toEqual([WINDOW.from, WINDOW.to, 't1', 'a1', ONE_CAMPAIGN, 25]);
  });

  it('takes `total_groups` from a window function, not from a second statement', async () => {
    // A window function is evaluated before LIMIT, so it counts the groups the CTE
    // produced. A second `COUNT(*)` statement would be a second scan that could
    // disagree with this one if a write landed between them — and it would double
    // the cost of every read.
    await read();
    expect(executable(sql())).toContain('COUNT(*) OVER ()::text AS total_groups');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('reports `total_groups` PRE-limit, from the rows it was handed', async () => {
    // The fixture says six groups exist and serves two rows, which is the shape a
    // limited read returns.
    serve([GROUPED_ROWS[0], GROUPED_ROWS[1]]);
    const page = await read({ limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.total_groups).toBe(6);
    expect(page.limit).toBe(2);
  });

  it('reports 0 groups on an empty result rather than reading a missing column', async () => {
    // With no rows there is no window-function value to carry the count, and "no
    // groups" is exactly 0 — not `NaN`, which is what `Number(undefined)` would
    // give and which serialises to `null` on the wire.
    serve([]);
    const page = await read();
    expect(page.total_groups).toBe(0);
    expect(page.rows).toEqual([]);
  });
});

// ─── the ordering ───────────────────────────────────────────────────────────

describe('the ORDER BY is TOTAL, which is what makes the limit reproducible', () => {
  it('orders by the whole key under `sort=key`, taking the caller\'s direction', async () => {
    await read({ groupBy: ['agent', 'campaign'], sort: 'key', order: 'asc' });
    expect(executable(sql()))
      .toContain('ORDER BY g.agent_user_id ASC NULLS LAST, g.campaign_id ASC NULLS LAST');

    pool.query.mockClear();
    serve(GROUPED_ROWS);
    await read({ groupBy: ['agent', 'campaign'], sort: 'key', order: 'desc' });
    expect(executable(sql()))
      .toContain('ORDER BY g.agent_user_id DESC NULLS LAST, g.campaign_id DESC NULLS LAST');
  });

  it('tie-breaks a METRIC sort on the key, ASCENDING in both directions', async () => {
    // The key is unique per row by definition of `GROUP BY`, so appending it makes
    // the ordering total — and with the slice in SQL a partial order would mean two
    // identical requests returning DIFFERENT rows, not merely the same rows in a
    // different order.
    //
    // The tiebreak stays ascending under `order=desc` on purpose: it is there to be
    // deterministic rather than meaningful, and reversing it with the direction
    // would make a stable page appear to reshuffle when the reader flipped an
    // unrelated column.
    for (const order of ['asc', 'desc'] as const) {
      pool.query.mockClear();
      serve(GROUPED_ROWS);
      await read({ groupBy: ['agent', 'campaign'], sort: 'successes', order });
      expect(executable(sql()), order).toContain(
        `ORDER BY g.successes::numeric ${order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, `
        + 'g.agent_user_id ASC NULLS LAST, g.campaign_id ASC NULLS LAST',
      );
    }
  });

  it('casts every counter to ::numeric before ordering by it', async () => {
    // The shared metric builder casts every counter to `::text`, so ordering them
    // as they arrive would rank '9' above '400' — a silently wrong "top 200 by
    // attempts" that no type checker can see.
    for (const sort of ['attempts', 'connected', 'successes'] as const) {
      pool.query.mockClear();
      serve(GROUPED_ROWS);
      await read({ sort });
      expect(executable(sql()), sort).toContain(`ORDER BY g.${sort}::numeric`);
    }
  });

  it('guards every rate ORDER BY with NULLIF, so a zero denominator cannot 22012', async () => {
    // Postgres raises `22012 division_by_zero` on `x / 0` and nothing maps that to
    // a status, so a single group that connected nobody would 500 the whole page
    // under `?sort=success_rate_pct`. u-chen is exactly that group, and it is in
    // the fixture. `NULLIF` makes it NULL, which the explicit `NULLS LAST` then
    // files where the contract says an unranked row goes.
    const expected: Record<string, string> = {
      connect_rate_pct: 'g.connected::numeric / NULLIF(g.attempts::numeric, 0)',
      success_rate_pct: 'g.successes::numeric / NULLIF(g.connected::numeric, 0)',
      aht_seconds:
        '(g.talk_seconds::numeric + g.wrapup_seconds::numeric) / NULLIF(g.connected::numeric, 0)',
    };
    for (const [sort, fragment] of Object.entries(expected)) {
      pool.query.mockClear();
      serve(GROUPED_ROWS);
      await read({ sort: sort as 'connect_rate_pct' });
      expect(executable(sql()), sort).toContain(`ORDER BY ${fragment}`);
    }
  });

  it('spells NULLS LAST explicitly in BOTH directions', async () => {
    // Postgres defaults nulls last only under ASC; under DESC it puts them FIRST.
    // So the default would hand a supervisor a page of un-dispositioned groups at
    // the top of "best conversion" — the same false claim the roster's comparator
    // exists to prevent, and the reason both reads state the rule rather than
    // inheriting it.
    for (const order of ['asc', 'desc'] as const) {
      for (const sort of GROUP_SORTS) {
        pool.query.mockClear();
        serve([]);
        await read({ groupBy: ['disposition'], sort, order });
        const orderBy = executable(sql()).slice(executable(sql()).indexOf('ORDER BY'));
        const terms = orderBy.split('NULLS LAST').length - 1;
        // One per ORDER BY term: the metric (when there is one) plus the key.
        expect(terms, `${sort}/${order}`).toBe(sort === 'key' ? 1 : 2);
      }
    }
  });
});

// ─── the key ────────────────────────────────────────────────────────────────

describe('the row key\'s members track `group_by`, and only `group_by`', () => {
  it('carries exactly the grouped members, for every dimension', async () => {
    const raw = {
      agent_user_id: 'u-anita', campaign_id: ONE_CAMPAIGN, disposition_code: 'sale',
      day_start: '2026-08-19', day_of_week: '3', hour_of_day: '14',
      attempts: '10', connected: '5', successes: '2',
      talk_seconds: '600', wrapup_seconds: '60', total_groups: '1',
    };
    const expected: Record<string, unknown> = {
      agent: { agent_user_id: 'u-anita' },
      campaign: { campaign_id: ONE_CAMPAIGN },
      disposition: { disposition_code: 'sale' },
      day: { day: '2026-08-19' },
      day_of_week: { day_of_week: 3 },
      hour_of_day: { hour_of_day: 14 },
    };
    for (const dimension of AGENCY_GROUP_DIMENSIONS) {
      pool.query.mockClear();
      serve([raw]);
      const page = await read({ groupBy: [dimension] });
      // Exactly one member, so a mapper that read every column it could find fails
      // here rather than shipping a key that claims a grouping the read did not do.
      expect(page.rows[0]?.key, dimension).toEqual(expected[dimension]);
    }
  });

  it('numbers `day_of_week` and `hour_of_day`, and does not name them', async () => {
    // 0 = Sunday .. 6 = Saturday, `EXTRACT(DOW)`'s own numbering. A locale-dependent
    // day name in a payload is a formatting decision the console owns, and
    // restating it as a string invites an off-by-one against ISO's 1=Monday.
    serve([{
      day_of_week: '0', hour_of_day: '0',
      attempts: '3', connected: '1', successes: '0',
      talk_seconds: '30', wrapup_seconds: '3', total_groups: '1',
    }]);
    const page = await read({ groupBy: ['day_of_week', 'hour_of_day'] });
    // Zero, not null and not 'Sunday' — and typed as a NUMBER, which is the whole
    // reason the `::text` -> `Number()` hop is asserted rather than assumed.
    expect(page.rows[0]?.key).toEqual({ day_of_week: 0, hour_of_day: 0 });
    expect(typeof page.rows[0]?.key.day_of_week).toBe('number');
  });

  it('echoes `group_by` in canonical order, as its own array', async () => {
    // Bound to a const and PASSED, so the identity assertion below has the array the
    // repository actually received on its left-hand side. Comparing against
    // `WINDOW.groupBy` instead was trivially true — this call overrides `groupBy`, so
    // the params never carried `WINDOW`'s `['agent']` at all, and dropping the spread
    // in `group_by: [...p.groupBy]` passed every test in the tree.
    const requested: AgentGroupedParams['groupBy'] = ['agent', 'campaign'];
    const page = await read({ groupBy: requested });
    expect(page.group_by).toEqual(requested);
    // A copy, not the caller's array: a consumer mutating the echoed list must not
    // reach back into the params object the caller still holds.
    //
    // FALSIFICATION: drop the spread in `group_by: [...p.groupBy]` and this fails.
    expect(page.group_by).not.toBe(requested);
  });

  it('echoes the window, the campaign and all three ranking parameters', async () => {
    const page = await read({
      groupBy: ['campaign', 'day'], sort: 'aht_seconds', order: 'desc', limit: 7,
      campaignId: ONE_CAMPAIGN,
    });
    expect(page).toMatchObject({
      from: '2026-08-17T00:00:00.000Z',
      to: '2026-08-24T00:00:00.000Z',
      campaign_id: ONE_CAMPAIGN,
      group_by: ['campaign', 'day'],
      sort: 'aht_seconds', order: 'desc', limit: 7,
    });
  });

  it('reports `campaign_id` as null rather than omitting it when unfiltered', async () => {
    // Absent and null are indistinguishable to a consumer; the contract says null.
    expect((await read()).campaign_id).toBeNull();
  });
});

// ─── `disposition_code: null` is a GROUP ────────────────────────────────────

describe('a null disposition is a real group, not a gap (contract D3)', () => {
  it('emits the member as null rather than dropping the row or the key', async () => {
    // `agency_call_attempts.disposition_code` is VARCHAR(50) NULL, and an attempt
    // with no disposition submitted is precisely the number a supervisor came to
    // this screen for. Folding it into an "other" bucket, or dropping the group,
    // hides un-dispositioned work.
    serve([
      {
        disposition_code: 'sale', attempts: '30', connected: '30', successes: '30',
        talk_seconds: '3000', wrapup_seconds: '300', total_groups: '2',
      },
      {
        disposition_code: null, attempts: '70', connected: '40', successes: '0',
        talk_seconds: '4000', wrapup_seconds: '0', total_groups: '2',
      },
    ]);
    const page = await read({ groupBy: ['disposition'] });
    expect(page.rows).toHaveLength(2);
    const undispositioned = page.rows[1];
    // PRESENT and null — not absent. An absent member would be indistinguishable
    // from "disposition was not grouped", which is the one thing the key's
    // presence rule exists to keep separable.
    expect(Object.hasOwn(undispositioned?.key ?? {}, 'disposition_code')).toBe(true);
    expect(undispositioned?.key.disposition_code).toBeNull();
    // And the numbers are its own, not folded into the neighbour.
    expect(undispositioned?.attempts).toBe(70);
    expect(page.rows[0]?.attempts).toBe(30);
  });

  it('normalises a missing column to null rather than letting undefined reach JSON', async () => {
    // DEFENSIVE MAPPING: the statement always selects the column when the dimension
    // is grouped, so `undefined` is unreachable from Postgres. Kept because the
    // failure it prevents is silent — `undefined` vanishes from a JSON payload
    // entirely, which makes a grouped row look un-grouped to a consumer keying on
    // member presence.
    serve([{
      attempts: '1', connected: '0', successes: '0',
      talk_seconds: '0', wrapup_seconds: '0', total_groups: '1',
    }]);
    const page = await read({ groupBy: ['disposition'] });
    expect(page.rows[0]?.key.disposition_code).toBeNull();
    expect(JSON.parse(JSON.stringify(page.rows[0]?.key))).toEqual({ disposition_code: null });
  });
});

// ─── `rates_reportable` ─────────────────────────────────────────────────────

describe('`rates_reportable` is the SERVER\'s minimum-volume gate, on every grouping', () => {
  it('is true EXACTLY on the threshold and false one attempt below it', async () => {
    // The `>=` is the whole assertion. u-esi sits on the bound and u-farah one dial
    // under it, which is the only pair that separates `>=` from `>` — every other
    // fixture row is far enough from 20 to pass under either operator.
    const page = await read();
    const esi = page.rows.find((row) => row.key.agent_user_id === 'u-esi');
    const farah = page.rows.find((row) => row.key.agent_user_id === 'u-farah');
    // Derived from the constant, not from the literal 20, so the fixture and the
    // implementation cannot drift apart silently if the threshold is tuned.
    expect(esi?.attempts).toBe(AGENCY_ROSTER_MIN_RATE_DENOMINATOR);
    expect(farah?.attempts).toBe(AGENCY_ROSTER_MIN_RATE_DENOMINATOR - 1);
    expect(esi?.rates_reportable).toBe(true);
    expect(farah?.rates_reportable).toBe(false);
  });

  it('withholds nothing: an unreportable row still carries its rates', async () => {
    // The flag says how a rate READS, not whether it is served. u-dev converted its
    // single connect, so the payload genuinely carries 100% — and that number beside
    // a named person on the contribution screen is exactly what the console renders
    // as words instead, which it cannot do without this flag.
    const page = await read();
    const dev = page.rows.find((row) => row.key.agent_user_id === 'u-dev');
    expect(dev?.rates_reportable).toBe(false);
    expect(dev?.success_rate_pct).toBeCloseTo(100);
    expect(dev?.connect_rate_pct).toBeCloseTo(100);
    // And a high-volume row is reportable, so the flag is not simply always false.
    expect(page.rows.find((row) => row.key.agent_user_id === 'u-anita')?.rates_reportable)
      .toBe(true);
  });

  it('gates on `attempts`, which is `connect_rate_pct`\'s denominator and only that', async () => {
    // u-chen dialled 40 — over the bound — and connected nobody. The row IS
    // reportable on this flag, because the gate is the headline denominator and 40
    // dials genuinely are enough to quote a connect rate of 0% for. What it is NOT
    // is quotable on the two metrics that divide by `connected`, and that is
    // `success_rate_reportable`'s job rather than this one's.
    const page = await read();
    const chen = page.rows.find((row) => row.key.agent_user_id === 'u-chen');
    expect(chen?.rates_reportable).toBe(true);
    expect(chen?.success_rate_reportable).toBe(false);
    expect(chen?.success_rate_pct).toBeNull();
  });

  it('means the same thing on a non-agent grouping — the heatmap cell', async () => {
    // The row is whatever was grouped, and the reading holds for all of them:
    // enough dials behind this cell to quote a rate for it. This is where the flag
    // earns the most — a best-hours cell holding three dials must not show 33%.
    serve([{
      hour_of_day: '18', attempts: '3', connected: '3', successes: '1',
      talk_seconds: '300', wrapup_seconds: '30', total_groups: '1',
    }]);
    const row = (await read({ groupBy: ['hour_of_day'] })).rows[0];
    expect(row?.key).toEqual({ hour_of_day: 18 });
    expect(row?.attempts).toBeLessThan(AGENCY_ROSTER_MIN_RATE_DENOMINATOR);
    expect(row?.rates_reportable).toBe(false);
    expect(row?.success_rate_pct).toBeCloseTo(100 / 3);
  });
});

describe('`success_rate_reportable` is the CONNECTED floor, and it is the point', () => {
  // ── Why a second flag and not a second reading of the first ────────────────
  //
  // `rates_reportable` floors `attempts`; `success_rate_pct` divides by
  // `connected`. So the case that flag was ADDED for — "a 100% conversion rate over
  // a single connect prints beside a named person" — survived it: 20 dials, one
  // connect, one conversion clears `attempts >= 20` and still serves 100%. The
  // house rule is a minimum volume PER METRIC, and one threshold on one denominator
  // cannot be two. Same constant, same predicate as the roster's `success_rate` and
  // `aht` percentile pools; not a third number holding the value 20.

  it('is true EXACTLY on the connected bound and false one connect below it', async () => {
    // u-bala connected exactly 20 — the only fixture row on THIS bound (u-esi sits
    // on the `attempts` one) — so it is the row that separates `>=` from `>`.
    //
    // FALSIFICATION: change `>=` to `>` in `hasRateDenominator` and the first
    // expectation fails; drop the field and both fail.
    const page = await read();
    const bala = page.rows.find((row) => row.key.agent_user_id === 'u-bala');
    expect(bala?.connected).toBe(AGENCY_ROSTER_MIN_RATE_DENOMINATOR);
    expect(bala?.success_rate_reportable).toBe(true);

    // One connect below the bound, served from a fixture variant rather than a
    // sixth global row so the counts every other test in this file asserts do not
    // move. The rest of the row is untouched, so nothing but `connected` decides it.
    serve(GROUPED_ROWS.map((row) => (row.agent_user_id === 'u-bala'
      ? { ...row, connected: String(AGENCY_ROSTER_MIN_RATE_DENOMINATOR - 1) } : row)));
    const narrowed = (await read()).rows.find((row) => row.key.agent_user_id === 'u-bala');
    expect(narrowed?.connected).toBe(AGENCY_ROSTER_MIN_RATE_DENOMINATOR - 1);
    expect(narrowed?.success_rate_reportable).toBe(false);
    // Still reportable on `attempts`, which is what makes the two flags independent
    // rather than one restated: 100 dials did not stop being 100 dials.
    expect(narrowed?.rates_reportable).toBe(true);
  });

  it('withholds THE case the first flag was added for and did not cover', async () => {
    // 20 dials, ONE connect, ONE conversion. `rates_reportable` says quote it;
    // `success_rate_pct` is 100. This is the contract's own justification for adding
    // a flag at all, and without this second one the console still prints "100%"
    // beside a named person on the contribution screen — which is why the pair, not
    // either alone, is what closes it.
    serve([{
      agent_user_id: 'u-thin-connect',
      attempts: String(AGENCY_ROSTER_MIN_RATE_DENOMINATOR),
      connected: '1', successes: '1',
      talk_seconds: '120', wrapup_seconds: '20', total_groups: '1',
    }]);
    const row = (await read()).rows[0];
    expect(row?.rates_reportable).toBe(true);
    expect(row?.success_rate_pct).toBe(100);
    expect(row?.success_rate_reportable).toBe(false);
    // `aht_seconds` divides by the same `connected`, so it is withheld by the same
    // flag — 140 seconds is one call of evidence, not an average.
    expect(row?.aht_seconds).toBe(140);
  });

  it('IMPLIES `rates_reportable` on every row, so gating on it alone is correct', async () => {
    // `connected <= attempts` always — a connect is an attempt that bridged — and
    // `rates_reportable` IS `attempts >= 20`, so the connected floor is strictly
    // stronger and can never be true where the headline flag is false. Asserted
    // over the whole fixture rather than argued, because it is the property that
    // lets a consumer read ONE flag before rendering a conversion rate.
    for (const row of (await read()).rows) {
      if (row.success_rate_reportable) expect(row.rates_reportable, row.key.agent_user_id).toBe(true);
    }
    // And the converse does NOT hold, so the two flags are not one field twice:
    // u-chen and u-esi are both reportable with too few connects to quote.
    const page = await read();
    expect(page.rows.filter((row) => row.rates_reportable).length)
      .toBeGreaterThan(page.rows.filter((row) => row.success_rate_reportable).length);
  });

  it('means the same thing on a heatmap cell as on a person', async () => {
    // The row is whatever was grouped, and this is where the connected floor earns
    // most: an hour cell holding 24 dials clears `rates_reportable`, and its two
    // connects are not a conversion rate.
    serve([{
      hour_of_day: '18', attempts: '24', connected: '2', successes: '1',
      talk_seconds: '240', wrapup_seconds: '24', total_groups: '1',
    }]);
    const row = (await read({ groupBy: ['hour_of_day'] })).rows[0];
    expect(row?.key).toEqual({ hour_of_day: 18 });
    expect(row?.rates_reportable).toBe(true);
    expect(row?.success_rate_reportable).toBe(false);
    expect(row?.success_rate_pct).toBe(50);
  });
});

// ─── the null-not-zero rule ─────────────────────────────────────────────────

describe('a rate over a zero denominator is null, never 0', () => {
  it('u-chen dialled 40 and connected nobody: success_rate and aht are null', async () => {
    const page = await read();
    const chen = page.rows.find((row) => row.key.agent_user_id === 'u-chen');
    // `connect_rate_pct`'s denominator is `attempts` and 40 of them are real, so 0%
    // here is a MEASURED zero and must be the number 0 — the null rule is about an
    // empty denominator, not about a zero numerator. Getting this backwards hides a
    // genuinely broken group behind "we cannot say".
    expect(chen?.connect_rate_pct).toBe(0);
    // These two have `connected` as their denominator, which IS zero. A call that
    // never bridged had no conversation to convert and no handle time to average.
    expect(chen?.success_rate_pct).toBeNull();
    expect(chen?.aht_seconds).toBeNull();
  });

  it('computes every metric from the counters, through the shared helpers', async () => {
    const page = await read();
    const anita = page.rows.find((row) => row.key.agent_user_id === 'u-anita');
    expect(anita).toMatchObject({
      attempts: 400, connected: 200, successes: 60,
      talk_seconds: 40000, wrapup_seconds: 4000,
    });
    expect(anita?.connect_rate_pct).toBeCloseTo(50);
    // The denominator is CONNECTED, not attempts: 60/200, not 60/400.
    expect(anita?.success_rate_pct).toBeCloseTo(30);
    expect(anita?.success_rate_pct).not.toBeCloseTo(15);
    expect(anita?.aht_seconds).toBeCloseTo(220);
  });

  it('serves the rates the HELPERS produce, not a column the statement ordered by', async () => {
    // The statement selects rate expressions for the ORDER BY only. This pins that
    // the payload's numbers come from `ratePct`/`ratio` instead: the fixture carries
    // deliberately wrong rate columns, and they must not appear on the wire.
    //
    // Two reasons the served numbers are not read off SQL. A Postgres `numeric`
    // division round-tripped through text can differ in its last digits from the JS
    // float division the roster and the per-agent record use, so the same data would
    // report two slightly different rates on two adjacent screens. And a hand-rolled
    // `n / d * 100` here would answer `NaN` on a zero denominator, which serialises
    // to `null` in JSON — so the bug would be invisible on the wire.
    const { ratePct, ratio } = await import('@magick-agency/domain/rates');
    serve([{
      agent_user_id: 'u-anita', attempts: '400', connected: '200', successes: '60',
      talk_seconds: '40000', wrapup_seconds: '4000', total_groups: '1',
      connect_rate_pct: '99.9', success_rate_pct: '99.9', aht_seconds: '99.9',
      ord_connect_rate_pct: '0.999',
    }]);
    const row = (await read()).rows[0];
    expect(row?.connect_rate_pct).toBe(ratePct(200, 400));
    expect(row?.success_rate_pct).toBe(ratePct(60, 200));
    expect(row?.aht_seconds).toBe(ratio(44000, 200));
    expect(row?.connect_rate_pct).not.toBeCloseTo(99.9);
  });

  it('maps the `::text` counters through Number(), so a string never reaches the wire', async () => {
    // node-pg returns `bigint` and `numeric` as STRINGS, which is why the fixture
    // types them that way. A mapper that passed them through would serialise
    // `"400"` where the contract says `400`, and a consumer adding two of them
    // would get `"400100"`.
    const page = await read();
    for (const row of page.rows) {
      for (const value of [row.attempts, row.connected, row.successes,
        row.talk_seconds, row.wrapup_seconds]) {
        expect(typeof value).toBe('number');
      }
    }
    expect(typeof page.total_groups).toBe('number');
  });

  it('DERIVED, not asserted: `attempts` is always >= 1, so connect_rate is never null', async () => {
    // ⚠️ A zero-`attempts` row is UNREACHABLE from this statement and no consumer
    // should carry a branch for it. `attempts` is `COUNT(*)` over a `GROUP BY` whose
    // WHERE requires `a.dialed_at IS NOT NULL` and the two window bounds; every join
    // is INNER, there is no `HAVING`, no `ROLLUP`/`GROUPING SETS` and no outer join
    // that could manufacture a null-extended row. A group therefore exists only
    // because at least one attempt satisfied the predicate.
    //
    // So this asserts the reachable consequence — no served row has a null
    // `connect_rate_pct` — rather than fabricating the impossible row. u-dev sits at
    // the minimum a group can hold, one attempt.
    const page = await read();
    for (const row of page.rows) {
      expect(row.attempts).toBeGreaterThanOrEqual(1);
      expect(row.connect_rate_pct).not.toBeNull();
    }
    expect(page.rows.find((row) => row.key.agent_user_id === 'u-dev')?.attempts).toBe(1);
  });

  it('carries no occupancy and no benchmark, and issues no second statement', async () => {
    // Occupancy comes from `agency_agent_session_events`, whose `session_id` is
    // indexed by nothing — the roster gets away with that only because its row count
    // is bounded by HEADCOUNT, where this read's is a PRODUCT. And occupancy cannot
    // be attributed to a `disposition` or an `hour_of_day` without inventing an
    // apportionment rule. The benchmark is absent for a different reason: a cohort
    // of dispositions or of hours is not a peer group, so a median over them would
    // be a number with no meaning that a console would nonetheless render.
    const page = await read();
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(executable(sql())).not.toContain('agency_agent_session_events');
    expect(Object.hasOwn(page, 'benchmark')).toBe(false);
    for (const row of page.rows) {
      expect(Object.keys(row).sort()).toEqual([
        'aht_seconds', 'attempts', 'connect_rate_pct', 'connected', 'key',
        'rates_reportable', 'success_rate_pct', 'success_rate_reportable',
        'successes', 'talk_seconds', 'wrapup_seconds',
      ]);
    }
    // Nothing degrades here, because there is nothing to degrade ALONE: one
    // statement, and if it fails there is no page to serve.
    expect(warn).not.toHaveBeenCalled();
  });

  it('propagates a read failure rather than serving a partial page', async () => {
    pool.query.mockImplementation(() => Promise.reject(new Error('deadlock detected')));
    await expect(read()).rejects.toThrow('deadlock detected');
    expect(warn).not.toHaveBeenCalled();
  });
});

// ─── `resolved_timezone`: the zone the buckets were ACTUALLY cut in (02b E3) ──
//
// ⚠️ **What the mocked pool can and cannot prove here, because this field is the
// one place on this read where the difference decides the test's worth.** It
// cannot prove that Postgres's `COALESCE(z.name, 'UTC')` answers 'UTC' for an
// unresolvable zone — `pg_timezone_names` evaluates that, not this file. What it
// CAN prove, and what is split across the two halves below, is that the statement
// selects the RESOLVED expression rather than the stored column (asserted against
// the SQL text, because a mocked row cannot tell the two apart), and that the
// mapper serves whatever that expression returned rather than reaching for
// anything else on the row (asserted against the mapped output, with the stored
// garbage riding along on the fixture so a mapper that grabbed it fails).
//
// Both halves are needed because a mutation on either side is invisible to the
// other: swapping the SQL expression leaves the mock's canned row untouched, and
// swapping the read key leaves the SQL text untouched.

describe('`resolved_timezone` is read from the RESOLVED zone, never the stored column', () => {
  const GARBAGE = 'Asia/Calcutta_typo';

  it('selects the shared COALESCE through the shared join, and not `default_timezone`', async () => {
    await read({ groupBy: ['hour_of_day'], campaignId: ONE_CAMPAIGN });
    const text = executable(zoneSql());
    // The SAME two constants `groupedStats` cuts its buckets with, so the reported
    // zone cannot drift from the zone used. Byte-compared against the grouped
    // statement's own copy below.
    expect(text).toContain("COALESCE(z.name, 'UTC') AS resolved_timezone");
    expect(text).toContain('LEFT JOIN LATERAL (SELECT z.name FROM pg_timezone_names z');
    expect(text).toContain('WHERE lower(z.name) = lower(c.default_timezone) LIMIT 1) z ON true');
    // ── The mutation this line exists for ──────────────────────────────────
    //
    // `SELECT c.default_timezone AS resolved_timezone` would type-check, pass every
    // mapped-output assertion in this file (the mock's canned row does not change
    // when the SQL does), and ship the bug the field exists to prevent: the stored
    // value and the resolved one differ EXACTLY when the stored value is garbage,
    // so a console would print `Asia/Calcutta_typo` over columns that are in fact
    // UTC, on precisely the campaign whose zone is broken.
    expect(text).not.toMatch(/c\.default_timezone\s+AS resolved_timezone/);
    expect(text).not.toMatch(/SELECT\s+c\.default_timezone/);
  });

  it('uses the SAME resolved-zone expression the buckets were cut with', async () => {
    // Not "an equivalent one". If these two ever diverge, the page names a zone the
    // buckets were not cut in — which is worse than naming none, because it is
    // unfalsifiable from the payload.
    await read({ groupBy: ['hour_of_day'], campaignId: ONE_CAMPAIGN });
    const bucketed = executable(sql());
    expect(bucketed).toContain("AT TIME ZONE COALESCE(z.name, 'UTC')");
    expect(executable(zoneSql())).toContain("COALESCE(z.name, 'UTC')");
    // And the join is the same lateral in both, so neither can fan out.
    const lateral = 'LEFT JOIN LATERAL (SELECT z.name FROM pg_timezone_names z';
    expect(bucketed).toContain(lateral);
    expect(executable(zoneSql())).toContain(lateral);
  });

  it('scopes the lookup by tenant AND account, and binds the campaign', async () => {
    // A `campaign_id` arrives from the caller. Scope is a predicate in every
    // statement on this surface (non-negotiable 3), and a UUID from another account
    // must not resolve to that account's configuration.
    await read({ groupBy: ['day'], campaignId: ONE_CAMPAIGN });
    const text = executable(zoneSql());
    expect(text).toContain('c.id = $1::uuid');
    expect(text).toContain('c.tenant_id = $2');
    expect(text).toContain('c.account_id = $3');
    expect(zoneParams()).toEqual([ONE_CAMPAIGN, 't1', 'a1']);
    // Bound, never spelled — the same rule as the statement beside it.
    expect(text).not.toContain('11111111-2222');
    expect(text).not.toContain('t1');
  });

  it('serves `UTC` and NOT the stored string when the zone does not resolve', async () => {
    // ── The load-bearing case ──────────────────────────────────────────────
    //
    // `default_timezone` is VARCHAR(64) with no constraint, and the join is LEFT so
    // that a typo cannot raise 22023 and take out every other campaign's numbers.
    // The consequence is that the stored value and the zone the buckets were cut in
    // differ EXACTLY when the stored value is garbage, which is the entire reason
    // this field exists.
    //
    // Constructed, because the pool is mocked: the served row is what Postgres
    // returns for an unresolvable zone (`z.name` NULL, so the COALESCE answers
    // 'UTC') and the garbage rides along on the SAME row, so a mapper that reached
    // for `default_timezone` — or for any second key — surfaces the typo here.
    //
    // FALSIFICATION: read `rows[0]?.default_timezone` instead and this reds on both
    // expectations.
    serveWithZone(GROUPED_ROWS, [{ resolved_timezone: 'UTC', default_timezone: GARBAGE }]);
    const page = await read({ groupBy: ['hour_of_day'], campaignId: ONE_CAMPAIGN });
    expect(page.resolved_timezone).toBe('UTC');
    expect(page.resolved_timezone).not.toBe(GARBAGE);
  });

  it('serves a resolvable zone unchanged, for each zoned dimension', async () => {
    // The other half of the pair: 'UTC' must not be a constant the mapper always
    // answers. A real zone comes back unchanged, and the buckets of every zoned
    // dimension are cut in it.
    for (const dimension of ['day', 'day_of_week', 'hour_of_day'] as const) {
      pool.query.mockClear();
      serveWithZone(GROUPED_ROWS, [{ resolved_timezone: 'Asia/Kolkata' }]);
      const page = await read({ groupBy: [dimension], campaignId: ONE_CAMPAIGN });
      expect(page.resolved_timezone, dimension).toBe('Asia/Kolkata');
    }
    // Including the best-hours read itself, which spends the whole two-dimension
    // cap and is therefore the read that MUST carry a campaign filter.
    pool.query.mockClear();
    serveWithZone(GROUPED_ROWS, [{ resolved_timezone: 'Asia/Kolkata' }]);
    const page = await read({
      groupBy: ['day_of_week', 'hour_of_day'], campaignId: ONE_CAMPAIGN,
    });
    expect(page.resolved_timezone).toBe('Asia/Kolkata');
  });

  it('carries the zone on an EMPTY page, which is why it is a second statement', async () => {
    // ── Why the zone cannot be read off the grouped rows ───────────────────
    //
    // A zoned read whose window holds no attempts returns zero rows, so a zone
    // taken off those rows would be `null` on precisely the page that most needs
    // its axis labelled: an empty heatmap is still a heatmap, and an unlabelled
    // hour axis re-introduces "the 18:00 column is not a fact until a zone is
    // named" at the presentation layer.
    //
    // FALSIFICATION: source the zone from the grouped CTE (a `resolved_timezone`
    // column on the outer select, read off `rows[0]`) and this reds while every
    // other test in this block stays green — which is exactly how the first draft
    // of this field would have shipped.
    serveWithZone([], [{ resolved_timezone: 'Europe/London' }]);
    const page = await read({
      groupBy: ['day_of_week', 'hour_of_day'], campaignId: ONE_CAMPAIGN,
    });
    expect(page.rows).toEqual([]);
    expect(page.total_groups).toBe(0);
    expect(page.resolved_timezone).toBe('Europe/London');
  });

  it('is null when the filtered campaign is not in this account', async () => {
    // The degenerate case, settled honestly rather than as 'UTC': a `campaign_id`
    // naming no campaign IN SCOPE matched no row, so the filter did not select
    // "exactly one campaign" and the (necessarily empty) page it produced was cut
    // in no zone at all. 'UTC' here would be a claim about buckets that do not
    // exist.
    serveWithZone([], []);
    const page = await read({ groupBy: ['hour_of_day'], campaignId: ONE_CAMPAIGN });
    expect(page.resolved_timezone).toBeNull();
  });
});

describe('`resolved_timezone` is null exactly when the page has no single zone', () => {
  it('is null for `campaign` + a time dimension with NO campaign filter', async () => {
    // ── The shape any future edit to this field will break ─────────────────
    //
    // D5 accepts a time dimension on EITHER of two remedies and only one of them
    // narrows the read to one zone. This is the other one: a legal 200 spanning
    // every campaign in the account, each row correctly cut in its OWN campaign's
    // zone (`default_timezone` is per campaign, migration 072:34, with no
    // account-level uniqueness). N zones, no page-level label.
    //
    // Two decoys, so this cannot pass merely because nothing answered. The zone
    // lookup's fixture is served anyway — if it fires, it has a real zone to
    // return — and the GROUPED rows carry a `resolved_timezone` column of their
    // own, which is what an implementation that took the zone off the first row
    // would find.
    //
    // FALSIFICATION, and it takes TWO because the correct answer here is guarded
    // twice over:
    //
    //   * read the zone off the grouped rows (`rows[0].resolved_timezone`, the
    //     row-level design creeping up to the page) and all three of these become
    //     'Asia/Kolkata' — the page naming ONE of several zones as though the whole
    //     matrix were cut in it, which is the confidently-wrong hour axis this
    //     field exists to prevent;
    //   * drop the `campaignId` half of `groupedPageHasSingleZone` and these three
    //     still pass, because the lookup has no campaign to look up — that half is
    //     pinned in `agent-record.test.ts`, on the predicate itself, and the
    //     mutation reds there instead. Stated rather than left implicit: a
    //     falsification note that names a mutation this file does not actually
    //     catch is worse than none.
    const DECOY = { ...GROUPED_ROWS[0], resolved_timezone: 'Asia/Kolkata' };
    for (const dimension of ['day', 'day_of_week', 'hour_of_day'] as const) {
      pool.query.mockClear();
      serveWithZone([DECOY], [{ resolved_timezone: 'Asia/Kolkata' }]);
      const page = await read({ groupBy: ['campaign', dimension] });
      expect(page.resolved_timezone, dimension).toBeNull();
      // And no second statement was issued at all: there is nothing to look up.
      expect(pool.query.mock.calls.filter((call) => isZoneStatement(call[0])), dimension)
        .toHaveLength(0);
    }
  });

  it('is null when nothing zoned is grouped, campaign filter or not', async () => {
    // Vacuous rather than convenient. One campaign in scope means one zone is
    // AVAILABLE, but no bucket was cut in it, so there is no zone this page's
    // buckets were cut in.
    //
    // FALSIFICATION: drop the `groupByIsZoned` half and the first two carry a zone
    // for a page with no time axis to label.
    for (const over of [
      { groupBy: ['agent'] as const, campaignId: ONE_CAMPAIGN },
      { groupBy: ['agent', 'disposition'] as const, campaignId: ONE_CAMPAIGN },
      { groupBy: ['agent', 'campaign'] as const },
    ]) {
      pool.query.mockClear();
      serveWithZone(GROUPED_ROWS, [{ resolved_timezone: 'Asia/Kolkata' }]);
      const page = await read({ groupBy: [...over.groupBy], campaignId: over.campaignId });
      expect(page.resolved_timezone, over.groupBy.join(',')).toBeNull();
    }
  });

  it('issues the second statement ONLY on the single-campaign zoned read', async () => {
    // The cost half of the same rule, and the one D4 cares about: an unconditional
    // second round trip on every grouped read would be a second statement for the
    // ~all of them that have no zone to report.
    pool.query.mockClear();
    serveWithZone(GROUPED_ROWS, [{ resolved_timezone: 'Asia/Kolkata' }]);
    await read({ groupBy: ['agent'] });
    expect(statements()).toHaveLength(1);

    pool.query.mockClear();
    serveWithZone(GROUPED_ROWS, [{ resolved_timezone: 'Asia/Kolkata' }]);
    await read({ groupBy: ['hour_of_day'], campaignId: ONE_CAMPAIGN });
    expect(statements()).toHaveLength(2);
    // The grouped statement goes FIRST, which every `sql()`/`params()` assertion in
    // this file depends on — they read the first statement.
    expect(String(statements()[0]?.[0])).toContain('agency_call_attempts');
  });
});

// ─── ONE SNAPSHOT: the two statements share a client and a transaction ───────
//
// Review finding C2, and the sharpest of the batch. The zone lookup used to be
// issued in PARALLEL with the grouped statement on the pool — two connections, so
// two READ COMMITTED snapshots taken at two instants. A `default_timezone` UPDATE
// committing between them makes the page REPORT a zone its buckets were not CUT in,
// which is the single thing `resolved_timezone` exists to rule out, and it is not an
// exotic race: `default_timezone` is customer-facing config and an operator fixing a
// typo'd zone is exactly when the two reads disagree.
//
// ⚠️ What these tests can and cannot show. A mocked pool can prove the WIRING — one
// client, one transaction, the isolation level, the order, the release — and it
// cannot prove that REPEATABLE READ actually hides a concurrent commit, because
// Postgres does that and there is no Postgres here. The snapshot BEHAVIOUR is pinned
// against a real database in `test/integration/agency/agent-grouped-read.test.ts`,
// which commits a zone change between the two statements and asserts the page still
// reports the zone it bucketed with. Both tiers are needed: the integration test
// would still pass if the transaction were opened on a second client for one
// statement, and this one would still pass if the isolation level did nothing.

describe('the zone lookup shares the grouped statement\'s snapshot', () => {
  const zoned = () => read({ groupBy: ['hour_of_day'], campaignId: ONE_CAMPAIGN });

  it('runs both statements on ONE client, in one REPEATABLE READ transaction', async () => {
    serveWithZone(GROUPED_ROWS, [{ resolved_timezone: 'Asia/Kolkata' }]);
    const page = await zoned();
    expect(page.resolved_timezone).toBe('Asia/Kolkata');

    // ONE client. Two would be two snapshots however each was wrapped, which is the
    // defect itself — so this is the assertion, not the transaction control below.
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(clients).toHaveLength(1);

    const issued = clients[0]!.query.mock.calls.map((call) => String(call[0]));
    expect(issued).toHaveLength(4);
    // REPEATABLE READ, not the default: under READ COMMITTED each statement takes
    // its OWN snapshot, so one client and one transaction would not be enough — the
    // second statement would still see a zone update that committed between them.
    expect(issued[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    // The grouped statement TAKES the snapshot, so it must be first: REPEATABLE READ
    // acquires it at the first statement, and reading the zone before the buckets
    // were cut is the same disagreement in the other direction.
    expect(issued[1]).toContain('agency_call_attempts');
    expect(issued[2]).toContain('agency_campaigns');
    expect(issued[2]).not.toContain('agency_call_attempts');
    expect(issued[3]).toBe('COMMIT');

    // Nothing bypassed the transaction. Every statement the POOL saw went through
    // this client — a stray `getPool().query()` for either read would show up as a
    // count mismatch here rather than as an absence nobody asserts.
    expect(pool.query.mock.calls).toHaveLength(clients[0]!.query.mock.calls.length);
    expect(clients[0]!.release).toHaveBeenCalledTimes(1);
  });

  it('does NOT open a transaction when there is no second statement to hold', async () => {
    // A lone statement is one snapshot by construction, so a BEGIN and a COMMIT
    // would be two round trips added to every contribution and trend read on this
    // surface for a guarantee it already has.
    serveWithZone(GROUPED_ROWS, [{ resolved_timezone: 'Asia/Kolkata' }]);
    await read({ groupBy: ['agent'] });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(clients).toHaveLength(0);
    expect(pool.query.mock.calls.filter((call) => isControl(call[0]))).toHaveLength(0);
    expect(statements()).toHaveLength(1);
  });

  it('releases the client and ends the transaction when the zone lookup throws', async () => {
    // A held client is worse than a failed read: the pool is capped, so leaking one
    // per failure takes the whole service down a connection at a time, and the
    // symptom is unrelated timeouts elsewhere. The ROLLBACK reverts nothing — the
    // transaction is READ ONLY — it releases the snapshot.
    pool.query.mockImplementation((statement: unknown) => (isZoneStatement(statement)
      ? Promise.reject(new Error('zone lookup exploded'))
      : Promise.resolve({ rows: GROUPED_ROWS })));

    await expect(zoned()).rejects.toThrow('zone lookup exploded');
    expect(clients).toHaveLength(1);
    const issued = clients[0]!.query.mock.calls.map((call) => String(call[0]));
    expect(issued.at(-1)).toBe('ROLLBACK');
    expect(issued).not.toContain('COMMIT');
    expect(clients[0]!.release).toHaveBeenCalledTimes(1);
  });

  it('releases the client even when the ROLLBACK itself fails', async () => {
    // A connection broken mid-transaction fails its own ROLLBACK, and the error that
    // must reach the caller is the ORIGINAL one — the rollback's failure is noise
    // about a connection that is already gone, and letting it propagate would mask
    // the cause and skip the release.
    pool.query.mockImplementation((statement: unknown) => {
      if (isZoneStatement(statement)) return Promise.reject(new Error('zone lookup exploded'));
      if (/^ROLLBACK/.test(String(statement))) return Promise.reject(new Error('connection gone'));
      return Promise.resolve({ rows: GROUPED_ROWS });
    });

    await expect(zoned()).rejects.toThrow('zone lookup exploded');
    expect(clients[0]!.release).toHaveBeenCalledTimes(1);
  });
});
