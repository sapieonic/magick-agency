import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// `GET /agency-agents/stats` — the roster: two aggregates, one merge, one ranking.
//
// THE POOL IS MOCKED, so the fixtures supply the column names and no assertion
// here can catch a renamed SQL column. Same split as
// `agent-stats-repository.test.ts` and `supervisor-stats.test.ts`, and it means
// every rule is asserted on whichever side it actually lives:
//
//   * against the SQL TEXT — the tenant/account predicate in BOTH statements, the
//     `agent_user_id` predicate the occupancy index needs, the absence of any
//     bucketing machinery, and the fact that `sort`/`order`/`limit` never reach a
//     query at all;
//   * against the MAPPED OUTPUT — the null-not-zero rates, `rates_reportable`,
//     which rows enter each percentile pool, the ranking (nulls last in BOTH
//     directions, `agent_user_id` as the tiebreaker), `total_agents` being
//     pre-`limit`, and the occupancy degrade.
//
// ── The two thresholds, and which fixture row pins each ─────────────────────
//
// `AGENCY_ROSTER_MIN_RATE_DENOMINATOR` is compared TWICE, against two different
// denominators, and each comparison needs its own row sitting exactly ON the
// bound or the `>=` is unpinned:
//
//   * `rates_reportable` = `attempts >= 20`. Pinned by **u-esi**, at attempts
//     exactly 20. Mutate that `>=` to `>` and u-esi drops out of `agents_rated`,
//     out of the connect-rate pool, and off the `rates_reportable` list.
//   * the SUCCESS-rate pool's extra gate = `connected >= 20`. Pinned by
//     **u-bala**, at connected exactly 20.
//
// This file's header used to claim the boundary was covered when only the second
// row existed. A reviewer mutated the first `>=` to `>` and the entire suite
// stayed green — the fixture held agents at 400, 100, 40 and 11 attempts and
// nothing at 20. That is the false-coverage shape: an assertion that reads like it covers
// a boundary and does not. Both are named above so the next reader can check the
// claim against the fixture rather than trusting it.
//
// ⚠️ **What the mocked pool CANNOT prove, stated so no assertion here is read as
// stronger than it is:** that the scope predicate excludes another account's
// sessions. Postgres evaluates the WHERE clause, not this file. What the scope
// tests below do prove is the half that is actually ours — that the caller's
// tenant and account are BOUND into the parameter positions the literal predicate
// reads, in every statement — and one of them goes further by having the mock
// itself honour the binding, so a repository that dropped `$4` produces a row for
// an agent in another account and the test fails on the OUTPUT.
// ---------------------------------------------------------------------------

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@magick-agency/observability', () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

const { AgencyAgentStatsRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { AGENCY_ROSTER_MIN_RATE_DENOMINATOR } = await import('@magick-agency/contracts/agency');
const { ROSTER_SORTS } = await import('../../../src/agency/agent-record.js');
type AgentRosterParams = import('../../../src/agency/agent-record.js').AgentRosterParams;

const SCOPE = { tenantId: 't1', accountId: 'a1' };
/**
 * Annotated rather than inferred: without it TypeScript narrows `sort` to the
 * literal `'successes'`, and every override below (`{ sort: 'occupancy_pct' }`)
 * becomes a type error against a `Partial` of the narrowed shape.
 */
const WINDOW: AgentRosterParams = {
  from: new Date('2026-08-17T00:00:00.000Z'),
  to: new Date('2026-08-24T00:00:00.000Z'),
  sort: 'successes',
  order: 'desc',
  limit: 100,
};

/** The occupancy read is the one that touches the transition log. */
const isOccupancy = (sql: unknown): boolean => String(sql).includes('agency_agent_session_events');

const attemptsCall = () => pool.query.mock.calls.find((c) => !isOccupancy(c[0]));
const occupancyCall = () => pool.query.mock.calls.find((c) => isOccupancy(c[0]));
const attemptsSql = (): string => String(attemptsCall()?.[0] ?? '');
const attemptsParams = (): unknown[] => (attemptsCall()?.[1] ?? []) as unknown[];
const occupancySql = (): string => String(occupancyCall()?.[0] ?? '');
const occupancyParams = (): unknown[] => (occupancyCall()?.[1] ?? []) as unknown[];

/**
 * The statement with its `--` comments stripped.
 *
 * Every NEGATIVE assertion runs against this. Both statements are heavily
 * commented and the comments NAME the things the query deliberately does not do —
 * `date_trunc`, `generate_series`, the billing index, `LIMIT` — so
 * `not.toContain('date_trunc')` against the raw text would fail on the sentence
 * explaining why there is no bucketing, and would keep failing until someone
 * deleted the explanation. Same helper, same reason, as
 * `agent-stats-repository.test.ts`.
 */
const executable = (sql: string): string => sql.replace(/--[^\n]*/g, '');

// ─── the fixture ────────────────────────────────────────────────────────────
//
// Four agents, chosen so every rule has a row it decides differently:
//
//   u-anita  the volume agent. Everything measurable, everything reportable.
//   u-bala   `connected` exactly AT the threshold, so an off-by-one in the
//            success-rate pool's `>=` shows up as a changed median.
//   u-chen   dialled 40 and connected NOBODY. Its `success_rate_pct` and
//            `aht_seconds` are the zero-denominator nulls, and it has NO
//            occupancy rows at all, so its `occupancy_pct` is the other null.
//   u-dev    THIN: 11 attempts, below the threshold. Its rates are deliberately
//            FLATTERING (45% connect, 40% success) and its occupancy deliberately
//            terrible (11%), so a leak into any of the three percentile pools
//            moves that pool in a direction the assertions name.
//   u-esi    `attempts` exactly AT the threshold — the row that pins
//            `rates_reportable`'s own `>=`, which nothing pinned before. Placed
//            mid-cohort on the two metrics it is NOT about (its 25% success rate
//            and 49.5% occupancy are each the median of their pool, so adding it
//            leaves those percentiles unchanged) and deliberately EXTREME on the
//            one it is (100% connect, so its arrival into or departure from the
//            connect-rate pool is visible in every quantile).
//
// Every value distinct, so reading the right number off the wrong key fails.

const ATTEMPT_ROWS = [
  {
    agent_user_id: 'u-anita', attempts: '400', connected: '200', successes: '60',
    talk_seconds: '40000', wrapup_seconds: '4000', campaigns: '2',
    last_dialed_at: '2026-08-23T17:04:11.000Z',
  },
  {
    agent_user_id: 'u-bala', attempts: '100', connected: '20', successes: '4',
    talk_seconds: '4000', wrapup_seconds: '400', campaigns: '1',
    last_dialed_at: '2026-08-22T11:30:00.000Z',
  },
  {
    agent_user_id: 'u-chen', attempts: '40', connected: '0', successes: '0',
    talk_seconds: '0', wrapup_seconds: '0', campaigns: '1',
    last_dialed_at: '2026-08-18T09:12:45.000Z',
  },
  {
    agent_user_id: 'u-dev', attempts: '11', connected: '5', successes: '2',
    talk_seconds: '500', wrapup_seconds: '50', campaigns: '1',
    last_dialed_at: '2026-08-21T14:00:00.000Z',
  },
  // Exactly ON `AGENCY_ROSTER_MIN_RATE_DENOMINATOR`, on BOTH denominators: 20
  // attempts pins `rates_reportable`'s `>=` and 20 connects keeps it inside the
  // success-rate pool's own gate, so one row exercises both comparisons at the
  // bound. handled = 1800 + 180 = 1980 against a 4000-second shift is 49.5%.
  {
    agent_user_id: 'u-esi', attempts: '20', connected: '20', successes: '5',
    talk_seconds: '1800', wrapup_seconds: '180', campaigns: '1',
    last_dialed_at: '2026-08-20T08:00:00.000Z',
  },
];

// `shift_seconds` excludes `offline` (foldOccupancy), so anita's shift is
// 30000 + 40000 + 10000 = 80000 and her 5000 offline seconds are reported by the
// fold but not in the denominator.
const OCCUPANCY_ROWS = [
  { agent_user_id: 'u-anita', state: 'available', seconds: '30000' },
  { agent_user_id: 'u-anita', state: 'on_call', seconds: '40000' },
  { agent_user_id: 'u-anita', state: 'break', seconds: '10000' },
  { agent_user_id: 'u-anita', state: 'offline', seconds: '5000' },
  { agent_user_id: 'u-bala', state: 'available', seconds: '5000' },
  { agent_user_id: 'u-bala', state: 'on_call', seconds: '4000' },
  { agent_user_id: 'u-bala', state: 'break', seconds: '1000' },
  // u-chen has NO rows: an agent whose sessions predate migration 105.
  { agent_user_id: 'u-dev', state: 'available', seconds: '4500' },
  { agent_user_id: 'u-dev', state: 'on_call', seconds: '500' },
  // 3000 + 900 + 100 = a 4000-second shift, which puts u-esi's occupancy at the
  // median of the pool it joins rather than at either end of it.
  { agent_user_id: 'u-esi', state: 'available', seconds: '3000' },
  { agent_user_id: 'u-esi', state: 'on_call', seconds: '900' },
  { agent_user_id: 'u-esi', state: 'break', seconds: '100' },
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

const read = (params: Partial<AgentRosterParams> = {}) =>
  new AgencyAgentStatsRepository().roster(SCOPE, { ...WINDOW, ...params });

const rowFor = async (id: string, params: Partial<AgentRosterParams> = {}) => {
  const page = await read(params);
  const row = page.rows.find((r) => r.agent_user_id === id);
  if (!row) throw new Error(`no row for ${id}; got ${page.rows.map((r) => r.agent_user_id).join()}`);
  return row;
};

// ─── the scope is a PREDICATE, in every statement ────────────────────────────

describe('the tenant AND account scope is in every statement', () => {
  it('binds both into both statements, and spells the predicate literally', async () => {
    // There is no path parameter on this route at all, so these two predicates are
    // the ONLY thing separating one account's floor from another's. `agent_user_id`
    // is the console user's id, opaque to the voice engine (D3), which cannot tell a real one
    // from a guess or from another tenant's.
    await read();
    // The two statements bind the scope at DIFFERENT positions, and deliberately:
    // each occupancy statement in this file matches its `occupancyBuckets` twin
    // rather than its own sibling, because those two are ~90% identical text a
    // future editor will diff or copy between and a swapped `$1`/`$2` there is a
    // silent window inversion that `WHERE i.ended > i.started` absorbs as an empty
    // result. One house rule covers all four statements: the agent selector, when
    // the statement has one, is `$1`; then from, to, tenant, account.
    expect(attemptsSql()).toContain('tenant_id = $3');
    expect(attemptsSql()).toContain('account_id = $4');
    expect(occupancySql()).toContain('tenant_id = $4');
    expect(occupancySql()).toContain('account_id = $5');
    expect(attemptsParams()[2]).toBe('t1');
    expect(attemptsParams()[3]).toBe('a1');
    expect(occupancyParams()[3]).toBe('t1');
    expect(occupancyParams()[4]).toBe('a1');
  });

  it('an agent whose sessions are in ANOTHER account produces no row', async () => {
    // The mock honours the binding here rather than ignoring it: it filters the
    // fixture by the tenant/account actually bound into $3/$4. So this asserts on
    // the OUTPUT, and a repository that dropped `$4` from the predicate — or that
    // bound the wrong positional — hands `u-elsewhere` a line on t1/a1's roster
    // and fails. What it still cannot prove is that Postgres's WHERE clause does
    // what the literal says; that is asserted above, against the text.
    const STAMPED = [
      { ...ATTEMPT_ROWS[0], tenant: 't1', account: 'a1' },
      // Same tenant, DIFFERENT account — the case a tenant-wide read would leak,
      // and the reason `account_id` is a required predicate rather than a filter.
      { ...ATTEMPT_ROWS[1], agent_user_id: 'u-elsewhere', tenant: 't1', account: 'a2' },
      { ...ATTEMPT_ROWS[2], agent_user_id: 'u-othertenant', tenant: 't2', account: 'a1' },
    ];
    pool.query.mockImplementation((sql: unknown, values: unknown[]) => {
      if (isOccupancy(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({
        rows: STAMPED
          .filter((r) => r.tenant === values[2] && r.account === values[3])
          .map(({ tenant: _t, account: _a, ...row }) => row),
      });
    });

    const page = await read();
    expect(page.rows.map((r) => r.agent_user_id)).toEqual(['u-anita']);
    expect(page.total_agents).toBe(1);
    // And the cohort a supervisor is compared against is their own account's, not
    // the tenant's — a benchmark computed over three accounts would be a
    // cross-account disclosure dressed up as a median.
    expect(page.benchmark.agents).toBe(1);
  });

  it('scopes the occupancy read by BOTH the ids and the tenant/account', async () => {
    // Belt and braces on purpose: the ids are already the output of a scoped
    // statement, and `sess` re-applies both predicates anyway. An `agent_user_id`
    // is opaque to the voice engine and could legitimately collide across tenants.
    await read();
    const occupancy = executable(occupancySql());
    expect(occupancy).toContain('s.tenant_id = $4');
    expect(occupancy).toContain('s.account_id = $5');
    expect(occupancy).toContain('s.agent_user_id = ANY($1::uuid[])');
  });
});

// ─── two reads, sequential, and the index predicate that forces it ───────────

describe('the occupancy read is driven by the agent ids the attempts read found', () => {
  it('binds exactly those ids, on BOTH event reads', async () => {
    // `idx_agency_session_events_agent` is `(agent_user_id, at)` and `session_id`
    // is deliberately indexed by nothing (migration 105). Without a predicate on
    // the leading column the planner has nothing to drive the range on `at` from,
    // and the join falls back to a sequential scan of the table written on every
    // state transition. That is why the two reads are SEQUENTIAL here where the
    // per-agent record runs them in parallel.
    await read();
    // `$1`, matching `occupancyBuckets`' `$1 = scope.agentUserId`: the SELECTOR is
    // the leading binding in both occupancy statements, which is what makes them
    // safe to diff against each other.
    expect(occupancyParams()[0]).toEqual(['u-anita', 'u-bala', 'u-chen', 'u-dev', 'u-esi']);
    const occupancy = executable(occupancySql());
    // Once in `in_window`, once in `carried`, once in `sess` — three predicates,
    // and the two event ones are the ones the index needs.
    expect(occupancy.match(/e\.agent_user_id = ANY\(\$1::uuid\[\]\)/g)).toHaveLength(2);
  });

  it('skips the occupancy statement entirely when nobody dialled', async () => {
    // `= ANY('{}')` is a statement whose answer is known, and there is no row for
    // an occupancy figure to attach to.
    serve([], OCCUPANCY_ROWS);
    const page = await read();
    expect(page.rows).toEqual([]);
    expect(page.total_agents).toBe(0);
    expect(pool.query.mock.calls.filter((c) => isOccupancy(c[0]))).toHaveLength(0);
    // An empty floor still gets a benchmark object — the console renders against
    // it — with every percentile null rather than 0.
    expect(page.benchmark.agents).toBe(0);
    expect(page.benchmark.agents_rated).toBe(0);
    expect(page.benchmark.connect_rate_pct).toBeNull();
    expect(page.benchmark.connect_rate).toEqual({ p25: null, median: null, p75: null });
  });
});

// ─── this route has no buckets, so it has no bucketing machinery ─────────────

describe('there is no bucketing, and therefore no timezone to resolve', () => {
  it('neither statement truncates, generates a series, or resolves a zone', async () => {
    // The per-agent record's `pg_timezone_names` LEFT JOIN exists ONLY to stop an
    // unresolvable `default_timezone` raising 22023 inside a bucket expression. A
    // duration and a count are zone-independent, so with no bucket expression the
    // whole apparatus drops out rather than being carried along unused — and a
    // reader who finds it back here should know it was deliberately removed.
    await read();
    for (const sql of [executable(attemptsSql()), executable(occupancySql())]) {
      expect(sql).not.toContain('date_trunc');
      expect(sql).not.toContain('generate_series');
      expect(sql).not.toContain('pg_timezone_names');
      expect(sql).not.toContain('default_timezone');
    }
  });

  it('still bounds the window half-open on `dialed_at`, and nothing else', async () => {
    await read();
    const sql = executable(attemptsSql());
    expect(sql).toContain('a.dialed_at IS NOT NULL');
    expect(sql).toContain('a.dialed_at >= $1');
    expect(sql).toContain('a.dialed_at < $2');
    // Never `created_at` (a dispatch hop earlier) and never `ended_at` (which
    // pushes a call straddling midnight into the later day and leaves a live one
    // in no window at all). Same choice, same reasons, as every other aggregate.
    expect(sql).not.toContain('a.created_at');
    expect(sql).not.toContain('a.ended_at >');
    expect(attemptsParams()[0]).toEqual(WINDOW.from);
    expect(attemptsParams()[1]).toEqual(WINDOW.to);
  });

  it('groups per AGENT and counts DISTINCT campaigns, not sessions', async () => {
    // A session is per shift per campaign, so counting sessions would read an
    // agent who worked one campaign across three days as three campaigns.
    await read();
    const sql = executable(attemptsSql());
    expect(sql).toContain('GROUP BY s.agent_user_id');
    expect(sql).toContain('COUNT(DISTINCT a.campaign_id)');
    expect((await rowFor('u-anita')).campaigns).toBe(2);
  });
});

// ─── `sort` / `order` / `limit` never reach a query ─────────────────────────

describe('the ranking is not in SQL, and that is the injection answer', () => {
  it('produces byte-identical SQL for every sort key and both directions', async () => {
    // `sort` and `order` arrive as free text from a query string. They are
    // validated against a vocabulary before they get here — but the strongest
    // guarantee available is that they never reach a statement at all, and this is
    // what pins it. A future refactor that interpolated `ORDER BY ${sort}` fails
    // here rather than in a penetration test.
    const baseline = await (async () => {
      pool.query.mockClear();
      await read({ sort: 'attempts', order: 'asc' });
      return { attempts: attemptsSql(), occupancy: occupancySql() };
    })();

    for (const sort of ROSTER_SORTS) {
      for (const order of ['asc', 'desc'] as const) {
        pool.query.mockClear();
        await read({ sort, order, limit: 3 });
        expect(attemptsSql()).toBe(baseline.attempts);
        expect(occupancySql()).toBe(baseline.occupancy);
      }
    }
  });

  it('never puts a LIMIT in the aggregate — the benchmark needs the whole cohort', async () => {
    // `benchmark.occupancy_pct`'s percentiles are quantiles of
    // (talk + wrapup) / shift_seconds over the WHOLE cohort. `talk`/`wrapup` come
    // from the attempts statement and `shift_seconds` from the occupancy one, so a
    // LIMIT inside either destroys an input the benchmark needs. That is what
    // forces the slice — and therefore the ordering — out of SQL.
    await read({ limit: 1 });
    for (const sql of [executable(attemptsSql()), executable(occupancySql())]) {
      expect(sql).not.toContain('LIMIT');
    }
  });

  it('binds every value and interpolates no value into either statement', async () => {
    await read({ campaignId: '11111111-2222-3333-4444-555555555555' });
    for (const [sql, values] of [
      [attemptsSql(), attemptsParams()] as const,
      [occupancySql(), occupancyParams()] as const,
    ]) {
      const text = executable(sql);
      // Neither the scope nor the campaign appears as text anywhere. The statements
      // are injection-safe by discipline — every identifier literal, every value
      // bound — and this is the assertion that keeps them that way.
      expect(text).not.toContain('t1');
      expect(text).not.toContain('11111111-2222');
      expect(values).toContain('11111111-2222-3333-4444-555555555555');
      expect(values).toContain('t1');
      expect(values).toContain('a1');
    }
  });

  it('narrows the campaign on the ATTEMPT in one read and the SESSION in the other', async () => {
    // Deliberately different columns: the attempts aggregate narrows the dials
    // themselves, and the occupancy aggregate narrows the SHIFTS, because there is
    // no campaign on a transition event. Both give "this agent's work on this
    // campaign", and neither can be expressed on the other's table.
    await read({ campaignId: '11111111-2222-3333-4444-555555555555' });
    expect(executable(attemptsSql())).toContain('a.campaign_id = $5::uuid');
    expect(executable(occupancySql())).toContain('s.campaign_id = $6::uuid');
  });
});

// ─── the null-not-zero rule, per row ────────────────────────────────────────

describe('a rate over a zero denominator is null, never 0', () => {
  it('u-chen dialled 40 and connected nobody: success_rate and aht are null', async () => {
    const chen = await rowFor('u-chen');
    // `connect_rate_pct`'s denominator is `attempts` and 40 of them are real, so
    // 0% here is a MEASURED zero and must be the number 0 — the null rule is about
    // an empty denominator, not about a zero numerator. Getting this backwards
    // would hide a genuinely broken agent behind "we cannot say".
    expect(chen.connect_rate_pct).toBe(0);
    // These two have `connected` as their denominator, which IS zero. A call that
    // never bridged had no conversation to convert and no handle time to average.
    expect(chen.success_rate_pct).toBeNull();
    expect(chen.aht_seconds).toBeNull();
  });

  it('an agent with no measured shift has a null occupancy, never 0%', async () => {
    // u-chen has no rows in the transition log — a session predating migration
    // 105. `shift_seconds: 0` is the honest reading and 0% occupancy is not.
    const chen = await rowFor('u-chen');
    expect(chen.shift_seconds).toBe(0);
    expect(chen.break_seconds).toBe(0);
    expect(chen.occupancy_pct).toBeNull();
  });

  it('nulls the occupancy when talk+wrapup EXCEEDS the measured shift', async () => {
    // The two halves of this ratio are measured on two INDEPENDENT tables and
    // nothing constrains numerator <= denominator: talk+wrapup comes from
    // `agency_call_attempts`, written transactionally on every settled attempt,
    // and `shift_seconds` from `agency_agent_session_events`, whose writes are
    // BEST-EFFORT — `recordTransitions` swallows a failed INSERT with a warn and no
    // rethrow. Drop transitions and the shift shortens while the calls it contained
    // stay counted. 716% has been seen on a real read.
    //
    // NOT clamped to 100: a clamp hands the reader a plausible number computed from
    // an inconsistency. `null` is what this column already means by "unmeasured",
    // and it is the value the percentile pools already filter.
    serve(
      [{
        agent_user_id: 'u-skew', attempts: '400', connected: '200', successes: '60',
        // 26000 + 2670 = 28670 handled against a 4000-second shift: 716.75%.
        talk_seconds: '26000', wrapup_seconds: '2670', campaigns: '1',
        last_dialed_at: '2026-08-23T17:04:11.000Z',
      }, ATTEMPT_ROWS[0], ATTEMPT_ROWS[1]],
      [
        { agent_user_id: 'u-skew', state: 'available', seconds: '4000' },
        ...OCCUPANCY_ROWS.filter((r) => r.agent_user_id === 'u-anita' || r.agent_user_id === 'u-bala'),
      ],
    );
    const page = await read();
    const skew = page.rows.find((r) => r.agent_user_id === 'u-skew');
    expect(skew?.occupancy_pct).toBeNull();
    // The denominator is still SERVED, unchanged — the row is not censored, and a
    // consumer can see for itself that 28670 seconds of handling were recorded
    // against a 4000-second shift.
    expect(skew?.shift_seconds).toBe(4000);
    expect(skew?.talk_seconds).toBe(26000);
    expect(skew?.wrapup_seconds).toBe(2670);
    // And this is the half that matters: the row is REPORTABLE on 400 attempts, so
    // without the null it would be in the occupancy pool — as its maximum, dragging
    // p75 to an impossible place and flagging every other agent against a cohort
    // containing 716%. It also ranks #1 under `?sort=occupancy_pct&order=desc`.
    expect(skew?.rates_reportable).toBe(true);
    // The pool is anita 55 and bala 44 alone: two values, so p25/median/p75
    // interpolate between them. With 716.75 in it, p75 would be ~385.
    expect(page.benchmark.occupancy_pct.p25).toBeCloseTo(46.75);
    expect(page.benchmark.occupancy_pct.median).toBeCloseTo(49.5);
    expect(page.benchmark.occupancy_pct.p75).toBeCloseTo(52.25);
    const ranked = await read({ sort: 'occupancy_pct', order: 'desc' });
    expect(ranked.rows[0]?.agent_user_id).not.toBe('u-skew');
    expect(ranked.rows.at(-1)?.agent_user_id).toBe('u-skew');
  });

  it('DEFENSIVE MAPPING ONLY: a zero `attempts` row would null every rate', async () => {
    // ⚠️ `attempts: 0` is UNREACHABLE from `rosterAttemptTotals`, and no consumer
    // should carry a branch for it. `attempts` is `COUNT(*)` over a `GROUP BY
    // s.agent_user_id` whose WHERE requires `a.dialed_at IS NOT NULL` and the two
    // window bounds; every join in the statement is INNER, there is no `HAVING`,
    // no `ROLLUP`/`GROUPING SETS` and no outer join that could manufacture a
    // null-extended row. A group therefore exists only because at least one
    // attempt row satisfied the predicate, so the minimum `attempts` on any emitted
    // row is 1. `connected: 0` IS reachable and u-chen covers it; `attempts: 0` is
    // not, and this test asserts a MAPPER property rather than a served state.
    //
    // Kept rather than deleted because the property it pins is real: the shared
    // `ratePct` helper is what makes a zero denominator null, and a hand-rolled
    // `n / d * 100` at this call site would answer `NaN` — which serialises to
    // `null` in JSON and would look identical on the wire until a consumer did
    // arithmetic with it.
    serve([{ ...ATTEMPT_ROWS[2], agent_user_id: 'u-zero', attempts: '0' }], []);
    const row = (await read()).rows[0];
    expect(row?.connect_rate_pct).toBeNull();
    expect(row?.success_rate_pct).toBeNull();
    expect(row?.aht_seconds).toBeNull();
  });
});

// ─── `rates_reportable` and the percentile pools ────────────────────────────

describe('a thin row is served in full, flagged, and excluded from the cohort', () => {
  it('carries its rates and its denominators, with the flag false', async () => {
    // The threshold is 20 and u-dev dialled 11. The rates are STILL SERVED: the
    // caller gets the number and the denominator and decides. What the flag buys
    // is that every consumer applies ONE threshold rather than three, and that the
    // console can render "not enough calls" instead of a flattering 45%.
    const dev = await rowFor('u-dev');
    expect(dev.attempts).toBeLessThan(AGENCY_ROSTER_MIN_RATE_DENOMINATOR);
    expect(dev.rates_reportable).toBe(false);
    expect(dev.connect_rate_pct).toBeCloseTo((5 / 11) * 100);
    expect(dev.success_rate_pct).toBeCloseTo((2 / 5) * 100);
    expect(dev.occupancy_pct).toBeCloseTo(11);
    // The denominators travel with the rates, which is the rule that makes any of
    // them checkable.
    expect(dev.connected).toBe(5);
    expect(dev.shift_seconds).toBe(5000);
  });

  it('flags the reportable rows on `attempts`, the row\'s headline denominator', async () => {
    const page = await read();
    expect(page.rows.filter((r) => r.rates_reportable).map((r) => r.agent_user_id).sort())
      .toEqual(['u-anita', 'u-bala', 'u-chen', 'u-esi']);
    expect(page.benchmark.agents).toBe(5);
    expect(page.benchmark.agents_rated).toBe(4);
  });

  it('flags the CONNECTED floor separately, on the same constant', async () => {
    // ── Why `rates_reportable` alone was not enough on the wire ──────────────
    //
    // It floors `attempts`. `success_rate_pct` and `aht_seconds` divide by
    // `connected`, and the benchmark already refuses to RANK a row that fails the
    // connected floor — but until now nothing said so on the payload, so a console
    // rendering a per-row conversion rate had no flag for the very rows the cohort
    // it is compared against declined to include. `success_rate_reportable` is that
    // gate, from `hasRateDenominator`: the same function the two pools admit rows by,
    // so the flag and the pool membership cannot disagree.
    //
    // u-bala and u-esi are both AT 20 connects, which is why the fixture carries two
    // rows there — and it makes this the boundary assertion for the `>=`.
    //
    // FALSIFICATION: change `>=` to `>` in `hasRateDenominator` and the first two
    // expectations fail (along with both percentile-pool tests below, which is the
    // point of sharing the predicate).
    const page = await read();
    const flagged = page.rows
      .filter((r) => r.success_rate_reportable).map((r) => r.agent_user_id).sort();
    expect(flagged).toEqual(['u-anita', 'u-bala', 'u-esi']);
    for (const id of ['u-bala', 'u-esi']) {
      expect(page.rows.find((r) => r.agent_user_id === id)?.connected, id)
        .toBe(AGENCY_ROSTER_MIN_RATE_DENOMINATOR);
    }

    // u-chen is the row the two flags disagree about, and it is not a corner case:
    // 40 dials is a real day's work whose 0% connect rate is exactly the finding, so
    // it must stay quotable on `connect_rate_pct` while having no conversion rate at
    // all. One flag could not say both.
    const chen = await rowFor('u-chen');
    expect(chen.rates_reportable).toBe(true);
    expect(chen.success_rate_reportable).toBe(false);
    expect(chen.connect_rate_pct).toBe(0);
    expect(chen.success_rate_pct).toBeNull();

    // The IMPLICATION, asserted rather than argued: `connected <= attempts` always,
    // so the connected floor is strictly stronger and a consumer may gate a
    // conversion rate on this flag ALONE without ANDing the two.
    for (const row of page.rows) {
      if (row.success_rate_reportable) expect(row.rates_reportable, row.agent_user_id).toBe(true);
    }
  });

  it('puts EXACTLY the flagged rows in the two pools the flag describes', async () => {
    // What makes the flag honest: the rows a console withholds are the rows the
    // benchmark refused to rank, because both come from `hasRateDenominator`.
    // `agents_rated` is the `attempts` cohort (4) and the connected cohort is
    // smaller (3) — u-chen is the difference, and `success_rate`'s pool loses it to
    // the null on top of that, so the two numbers are checked on different rows.
    const page = await read();
    const flagged = page.rows.filter((r) => r.success_rate_reportable);
    expect(page.benchmark.agents_rated).toBe(4);
    expect(flagged).toHaveLength(3);
    // The pool IS these three rows' rates: 20 (bala), 25 (esi), 30 (anita). With an
    // odd pool the median is the middle row's own number, so it is checked by
    // identity rather than by restating the interpolation — and p25/p75 must lie
    // strictly inside the pool's range, which is what fails if an unflagged row
    // (u-dev's flattering 40%, or u-chen's null ranked as 0) leaked in.
    const rates = flagged
      .map((r) => r.success_rate_pct)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    expect(rates.map((r) => Math.round(r))).toEqual([20, 25, 30]);
    expect(page.benchmark.success_rate.median).toBeCloseTo(rates[1] as number, 5);
    expect(page.benchmark.success_rate.p25 as number).toBeGreaterThan(rates[0] as number);
    expect(page.benchmark.success_rate.p75 as number).toBeLessThan(rates[2] as number);
  });

  it('flags a row sitting EXACTLY on the threshold as reportable', async () => {
    // The boundary of `attempts >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR` itself, and
    // it needs its own row: with the fixture at 400 / 100 / 40 / 11 the comparison
    // was unpinned, and a reviewer mutated the `>=` to `>` with the whole
    // suite staying green. u-esi dials exactly 20.
    //
    // FALSIFICATION: change that `>=` to `>` in `roster()` and this fails three
    // ways — the flag, the cohort count, and the pool membership below.
    const esi = await rowFor('u-esi');
    expect(esi.attempts).toBe(AGENCY_ROSTER_MIN_RATE_DENOMINATOR);
    expect(esi.rates_reportable).toBe(true);

    // And "reportable" has to MEAN something, so the same row is asserted inside
    // the pool it therefore joins. u-esi connected all 20 of its dials, so its
    // 100% is the pool's maximum — `p75` cannot be computed from the other three
    // reportable rows (0 / 20 / 50) and land here.
    const { benchmark } = await read();
    expect(esi.connect_rate_pct).toBe(100);
    expect(benchmark.agents_rated).toBe(4);
    expect(benchmark.connect_rate.p75).toBeCloseTo(62.5);
    // Dropping u-esi from the pool would leave [0, 20, 50] and a p75 of 42.5.
    expect(benchmark.connect_rate.p75).not.toBeCloseTo(42.5);
  });

  it('keeps the thin row out of ALL THREE percentile pools', async () => {
    // u-dev's numbers are deliberately extreme in both directions — 45% connect
    // (best on the floor) and 11% occupancy (worst) — so a leak into any pool
    // moves it visibly. This is the assertion the whole threshold exists for: a
    // new joiner's eleven calls must not cast a full vote alongside an agent's
    // four hundred.
    const { benchmark } = await read();

    // connect_rate pool = the reportable rows: chen 0, bala 20, anita 50, esi 100.
    expect(benchmark.connect_rate.p25).toBeCloseTo(15);
    expect(benchmark.connect_rate.median).toBeCloseTo(35);
    expect(benchmark.connect_rate.p75).toBeCloseTo(62.5);

    // occupancy pool = the reportable rows with a measurable shift: bala 44,
    // esi 49.5, anita 55. u-chen's null is excluded (a null ranked as 0 would drag
    // p25 down) and so is u-dev's 11.
    expect(benchmark.occupancy_pct.p25).toBeCloseTo(46.75);
    expect(benchmark.occupancy_pct.median).toBeCloseTo(49.5);
    expect(benchmark.occupancy_pct.p75).toBeCloseTo(52.25);
  });

  it('additionally requires `connected >= threshold` for the SUCCESS-rate pool', async () => {
    // That rate's own denominator is `connected`. u-bala connected exactly 20 and
    // is IN; u-chen is reportable on 40 attempts but connected nobody, so it has
    // no success rate to contribute at all. An agent with 400 dials and three
    // connects would be reportable and still be three calls of evidence — which is
    // precisely the noise the threshold keeps out of a median.
    const { benchmark } = await read();
    expect(benchmark.success_rate.p25).toBeCloseTo(22.5);
    expect(benchmark.success_rate.median).toBeCloseTo(25);
    expect(benchmark.success_rate.p75).toBeCloseTo(27.5);

    // Drop BOTH rows that sit on the bound — bala and esi — and the pool collapses
    // to one row, whose own number becomes all three quantiles (interpolating
    // between one value and itself). `rosterPercentiles` does that in TypeScript
    // over rows already served; it follows `percentile_cont`'s convention but no
    // such SQL runs on this read. Both rows have to move: they are the two at
    // exactly 20 connects, which is the whole reason this gate is pinned twice.
    serve(
      ATTEMPT_ROWS.map((r) => (r.agent_user_id === 'u-bala' || r.agent_user_id === 'u-esi'
        ? { ...r, connected: '19' } : r)),
      OCCUPANCY_ROWS,
    );
    const narrowed = (await read()).benchmark.success_rate;
    expect(narrowed).toEqual({ p25: 30, median: 30, p75: 30 });
  });

  it('nulls every percentile when no row qualifies, rather than reporting 0', async () => {
    serve([ATTEMPT_ROWS[3]], OCCUPANCY_ROWS);
    const { benchmark } = await read();
    expect(benchmark.agents).toBe(1);
    expect(benchmark.agents_rated).toBe(0);
    for (const metric of [benchmark.connect_rate, benchmark.success_rate, benchmark.occupancy_pct]) {
      expect(metric).toEqual({ p25: null, median: null, p75: null });
    }
    // ...while the POOLED rates still describe the floor. They are a ratio of two
    // sums, so a thin row contributes in proportion to its own size rather than
    // casting a full vote — which is the whole reason both numbers are served.
    expect(benchmark.connect_rate_pct).toBeCloseTo((5 / 11) * 100);
  });
});

// ─── pooled cohort rates are NOT the medians ────────────────────────────────

describe('the benchmark carries the floor\'s actual rate AND the middle agent\'s', () => {
  it('pools over every row, including the thin ones', async () => {
    const { benchmark } = await read();
    expect(benchmark).toMatchObject({
      attempts: 571, connected: 245, successes: 71,
      talk_seconds: 46300, wrapup_seconds: 4630,
    });
    expect(benchmark.connect_rate_pct).toBeCloseTo((245 / 571) * 100);
    expect(benchmark.success_rate_pct).toBeCloseTo((71 / 245) * 100);
    expect(benchmark.aht_seconds).toBeCloseTo(50930 / 245);
  });

  it('and they are a DIFFERENT number from the median, on this very fixture', async () => {
    // 42.9% pooled against a 35% median: the floor's rate is dominated by its
    // highest-volume agent, and the typical agent is nowhere near it. A consumer
    // handed one cannot derive the other, which is why both are on the payload.
    const { benchmark } = await read();
    expect(benchmark.connect_rate_pct).toBeCloseTo(42.9072, 3);
    expect(benchmark.connect_rate.median).toBeCloseTo(35);
  });

  it('repeats `agents` inside the benchmark as the same number as `total_agents`', async () => {
    // Both are folded from the same row array rather than counted twice, so they
    // are equal by construction. Repeated on the payload so a consumer rendering a
    // comparison does not have to reach outside the object it compares against.
    const page = await read({ limit: 2 });
    expect(page.total_agents).toBe(5);
    expect(page.benchmark.agents).toBe(5);
    expect(page.rows).toHaveLength(2);
  });
});

// ─── the ranking ────────────────────────────────────────────────────────────

describe('nulls sort LAST in both directions', () => {
  // u-chen's `success_rate_pct` is the null. A naive comparator reads it as 0 and
  // files chen at the BOTTOM under `desc` (a 0% conversion the data does not
  // support) or at the TOP under `asc` ("worst converter"), which is the same false
  // claim promoted to the first thing a supervisor sees.
  it('desc: the ranked rows descend and the unranked row is last', async () => {
    const page = await read({ sort: 'success_rate_pct', order: 'desc' });
    expect(page.rows.map((r) => r.agent_user_id))
      .toEqual(['u-dev', 'u-anita', 'u-esi', 'u-bala', 'u-chen']);
    expect(page.rows.at(-1)?.success_rate_pct).toBeNull();
  });

  it('asc: the ranked rows ascend and the unranked row is STILL last', async () => {
    const page = await read({ sort: 'success_rate_pct', order: 'asc' });
    expect(page.rows.map((r) => r.agent_user_id))
      .toEqual(['u-bala', 'u-esi', 'u-anita', 'u-dev', 'u-chen']);
    expect(page.rows.at(-1)?.success_rate_pct).toBeNull();
  });

  it('so a null row is never on the first page of a ranked question', async () => {
    // The consequence that matters operationally: `limit` plus a null-first
    // ordering is how "my three worst converters" comes back as three agents who
    // never connected anyone.
    for (const order of ['asc', 'desc'] as const) {
      const page = await read({ sort: 'occupancy_pct', order, limit: 3 });
      // Four of the five rows have a measurable occupancy, so a page of three can
      // never need u-chen — whose null is last in both directions.
      expect(page.rows.map((r) => r.occupancy_pct)).not.toContain(null);
      expect(page.rows.map((r) => r.agent_user_id)).not.toContain('u-chen');
    }
  });
});

describe('the ranking is deterministic and `limit` is applied after it', () => {
  it('defaults to `successes` descending', async () => {
    const page = await read();
    expect(page.sort).toBe('successes');
    expect(page.order).toBe('desc');
    expect(page.rows.map((r) => r.agent_user_id))
      .toEqual(['u-anita', 'u-esi', 'u-bala', 'u-dev', 'u-chen']);
  });

  it('breaks a tie on `agent_user_id`, ascending in BOTH directions', async () => {
    // Ties are the normal case, not an edge: `successes` is a small integer.
    // Without a total order two reads of the same window return the same rows in a
    // different order — and with `limit`, a different SET of rows.
    const TIED = ['u-zoe', 'u-adam', 'u-mira'].map((id) => ({
      ...ATTEMPT_ROWS[0], agent_user_id: id,
    }));
    serve(TIED, []);
    for (const order of ['asc', 'desc'] as const) {
      const page = await read({ sort: 'successes', order });
      expect(page.rows.map((r) => r.agent_user_id)).toEqual(['u-adam', 'u-mira', 'u-zoe']);
    }
  });

  it('takes the TOP of the ranking, not the first rows the query returned', async () => {
    // The statement orders by `agent_user_id` for determinism, so a `limit` applied
    // in SQL — before the ranking — would answer `u-anita` whatever was asked for.
    // The least-occupied agent on the floor is `u-dev` at 11%, and note that a THIN
    // row is still a ROW: `rates_reportable` gates the percentile pools, never the
    // page. An 11-call agent who was on the floor all week is exactly who a
    // supervisor asking this question is looking for.
    const page = await read({ sort: 'occupancy_pct', order: 'asc', limit: 1 });
    expect(page.rows.map((r) => r.agent_user_id)).toEqual(['u-dev']);
    expect(page.rows[0]?.rates_reportable).toBe(false);
    expect(page.limit).toBe(1);
    expect(page.total_agents).toBe(5);
  });

  it('echoes the window, the campaign, and all three ranking parameters', async () => {
    // Applied server-side, so the response is the only place the applied ordering
    // exists. A caller must never have to infer what they were served.
    const page = await read({
      sort: 'aht_seconds', order: 'asc', limit: 7,
      campaignId: '11111111-2222-3333-4444-555555555555',
    });
    expect(page).toMatchObject({
      from: '2026-08-17T00:00:00.000Z',
      to: '2026-08-24T00:00:00.000Z',
      campaign_id: '11111111-2222-3333-4444-555555555555',
      sort: 'aht_seconds', order: 'asc', limit: 7,
    });
  });

  it('reports `campaign_id` as null rather than omitting it when unfiltered', async () => {
    // Absent and null are indistinguishable to a consumer; the contract says null.
    expect((await read()).campaign_id).toBeNull();
  });
});

// ─── the merge ──────────────────────────────────────────────────────────────

describe('occupancy is folded per agent through the SHARED fold', () => {
  it('excludes `offline` from the shift and reports `break` alongside it', async () => {
    // `foldOccupancy` rather than a sum written here, so "the shift excludes
    // offline", the unknown-state drop and the negative-interval clamp keep exactly
    // one definition across both read surfaces. anita's 5000 offline seconds are
    // measured and are NOT in her denominator: an agent who logged out at 17:00 was
    // not on shift at 18:00.
    const anita = await rowFor('u-anita');
    expect(anita.shift_seconds).toBe(80000);
    expect(anita.break_seconds).toBe(10000);
    // Break time is INCLUDED in the occupancy denominator — this route PICKS the
    // denominator `AgencyAgentOccupancy` deliberately leaves undivided, because a
    // roster column has to be one number. The other reading stays computable as
    // `shift_seconds - break_seconds`, which is why both parts are on the row.
    expect(anita.occupancy_pct).toBeCloseTo(55);
    expect((44000 / (80000 - 10000)) * 100).toBeCloseTo(62.857, 2);
  });

  it('attaches each agent\'s occupancy to that agent and nobody else', async () => {
    const page = await read();
    expect(page.rows.map((r) => [r.agent_user_id, r.shift_seconds])).toEqual(
      expect.arrayContaining([
        ['u-anita', 80000], ['u-bala', 10000], ['u-chen', 0], ['u-dev', 5000],
        ['u-esi', 4000],
      ]),
    );
  });

  it('carries `last_dialed_at` through as the instant the statement formatted', async () => {
    expect((await rowFor('u-anita')).last_dialed_at).toBe('2026-08-23T17:04:11.000Z');
  });
});

// ─── occupancy degrades alone ───────────────────────────────────────────────

describe('an occupancy failure never takes the roster with it', () => {
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
    const page = await read();
    expect(page.rows).toHaveLength(5);
    expect(page.total_agents).toBe(5);
    const anita = page.rows.find((r) => r.agent_user_id === 'u-anita');
    expect(anita).toMatchObject({
      attempts: 400, connected: 200, successes: 60,
      talk_seconds: 40000, wrapup_seconds: 4000, campaigns: 2,
    });
    expect(anita?.connect_rate_pct).toBeCloseTo(50);
    expect(anita?.success_rate_pct).toBeCloseTo(30);
    expect(anita?.aht_seconds).toBeCloseTo(220);
    // The attempt-derived halves of the benchmark survive too.
    expect(page.benchmark.attempts).toBe(571);
    expect(page.benchmark.connect_rate.median).toBeCloseTo(35);
  });

  it('does NOT change the row SET — that is what makes the degrade safe', async () => {
    // The rows are driven by who DIALLED, so a failed events-table read cannot
    // delete an agent from the page. If occupancy could add rows it could also
    // remove them, which is a far worse failure than serving a zero.
    failOccupancy();
    const degraded = await read();
    serve(ATTEMPT_ROWS, OCCUPANCY_ROWS);
    const healthy = await read();
    expect(degraded.rows.map((r) => r.agent_user_id))
      .toEqual(healthy.rows.map((r) => r.agent_user_id));
  });

  it('zeroes the shift and NULLS the occupancy — never 0%', async () => {
    failOccupancy();
    const page = await read();
    for (const row of page.rows) {
      expect(row.shift_seconds).toBe(0);
      expect(row.break_seconds).toBe(0);
      expect(row.occupancy_pct).toBeNull();
    }
    // And the occupancy percentiles empty out rather than filling with zeros, which
    // is the same distinction one level up: "we cannot say" is not "the floor is
    // idle".
    expect(page.benchmark.occupancy_pct).toEqual({ p25: null, median: null, p75: null });
  });

  it('says so at warn — the only symptom the degrade produces', async () => {
    failOccupancy();
    await read();
    expect(warn).toHaveBeenCalledTimes(1);
    const [context, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(message).toContain('occupancy');
    expect(context['err']).toBeInstanceOf(Error);
    // The scope and the window are on the line, because a zeroed occupancy column
    // has three causes and the log is the only place they are told apart. No agent
    // id: this is thirty people's performance in one response.
    expect(context['tenantId']).toBe('t1');
    expect(context['accountId']).toBe('a1');
    expect(context['agents']).toBe(5);
    expect(context['from']).toBe('2026-08-17T00:00:00.000Z');
    expect(context['to']).toBe('2026-08-24T00:00:00.000Z');
  });

  it('does NOT degrade when the ATTEMPTS read is the one that fails', async () => {
    // The mirror case, asserted so the catch cannot quietly widen: the attempts are
    // the roster. There is nothing left to serve, so this one propagates.
    pool.query.mockImplementation((sql: unknown) => (isOccupancy(sql)
      ? Promise.resolve({ rows: OCCUPANCY_ROWS })
      : Promise.reject(new Error('deadlock detected'))));
    await expect(read()).rejects.toThrow('deadlock detected');
    expect(warn).not.toHaveBeenCalled();
  });

  it('sorting by occupancy still returns a deterministic page when it degraded', async () => {
    // Every value is null, so every row ties, so the tiebreaker is the entire
    // ordering. Without it a degraded read would reshuffle between requests.
    failOccupancy();
    for (const order of ['asc', 'desc'] as const) {
      const page = await read({ sort: 'occupancy_pct', order });
      expect(page.rows.map((r) => r.agent_user_id))
        .toEqual(['u-anita', 'u-bala', 'u-chen', 'u-dev', 'u-esi']);
    }
  });
});

// ─── the two ADDITIVE benchmark fields (contract D10) ───────────────────────
//
// Additive, not changed: the roster payload is frozen so its
// data source can be swapped under a console already built against it, and adding a field breaks
// no consumer. Both of these were found by review as gaps the frozen shape could
// not express.
//
// ── The threshold, and which fixture row pins it ────────────────────────────
//
// `aht`'s pool gates on `connected >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR` — a NEW
// comparison at a NEW call site, even though the constant and the operator are the
// success-rate pool's. It is pinned by **u-bala** and **u-esi**, both at connected
// exactly 20, in the test that drops them to 19.

describe('benchmark.shift_seconds / break_seconds: pooled, so the team row can show a rate', () => {
  it('pools over the SAME agent set as the other pooled fields', async () => {
    // anita 80000 + bala 10000 + chen 0 + dev 5000 + esi 4000 = 99000; breaks
    // 10000 + 1000 + 0 + 0 + 100 = 11100. Every row, thin ones included — the same
    // set `attempts` / `connected` / `talk_seconds` pool over, so the new numbers
    // cannot disagree with the ones beside them.
    const { benchmark } = await read();
    expect(benchmark.shift_seconds).toBe(99000);
    expect(benchmark.break_seconds).toBe(11100);
    // Asserted as a relationship, not two constants: the claim is that they pool
    // over the same rows, and summing the rows here is how that stays true if the
    // fixture changes.
    const page = await read();
    expect(benchmark.shift_seconds)
      .toBe(page.rows.reduce((sum, row) => sum + row.shift_seconds, 0));
    expect(benchmark.break_seconds)
      .toBe(page.rows.reduce((sum, row) => sum + row.break_seconds, 0));
  });

  it('closes the hole it exists for: a POOLED utilisation is now derivable', async () => {
    // The console previously showed the cohort MEDIAN utilisation in the team row,
    // honestly labelled as the median, because the benchmark carried the numerator
    // (talk + wrapup) and no pooled denominator. With `shift_seconds` the real rate
    // is derivable — and it is a DIFFERENT number from the median, which is the
    // whole reason both are worth having.
    const { benchmark } = await read();
    const pooled = ((benchmark.talk_seconds + benchmark.wrapup_seconds) / benchmark.shift_seconds) * 100;
    expect(pooled).toBeCloseTo((50930 / 99000) * 100);
    expect(pooled).toBeCloseTo(51.444, 2);
    expect(benchmark.occupancy_pct.median).toBeCloseTo(49.5);
    // And the break-excluding reading stays derivable too, because both terms are
    // on the object — the same refusal to pre-divide as `AgencyAgentOccupancy`.
    expect((50930 / (99000 - 11100)) * 100).toBeCloseTo(57.941, 2);
  });

  it('is 0 — never null — when the occupancy read degraded, like every row\'s', async () => {
    // Inherits every ambiguity the per-row field has. `shift_seconds: 0` here means
    // no events, no events in the window, or a FAILED occupancy read; the warn log
    // is the only place the third case exists. What matters is that a consumer
    // deriving a pooled rate from it gets the null-not-zero answer rather than a
    // division by zero.
    pool.query.mockImplementation((sql: unknown) => (isOccupancy(sql)
      ? Promise.reject(new Error('relation "agency_agent_session_events" does not exist'))
      : Promise.resolve({ rows: ATTEMPT_ROWS })));
    const { benchmark } = await read();
    expect(benchmark.shift_seconds).toBe(0);
    expect(benchmark.break_seconds).toBe(0);
    // The attempt-derived halves are untouched, which is what makes the degrade
    // worth doing at all.
    expect(benchmark.talk_seconds).toBe(46300);
  });

  it('does NOT move when `limit` moves — it is the cohort, not the page', async () => {
    // The reason these are pooled here rather than derived from the visible rows by
    // a consumer: the console's `include_inactive` toggle and the caller's `limit` both
    // change which ROWS are returned, and this object's own contract forbids the
    // benchmark moving when a row filter does. A field summed from `rows` would be
    // a different number under the same name.
    const full = await read();
    const oneRow = await read({ limit: 1 });
    expect(oneRow.rows).toHaveLength(1);
    expect(oneRow.benchmark.shift_seconds).toBe(full.benchmark.shift_seconds);
    expect(oneRow.benchmark.break_seconds).toBe(full.benchmark.break_seconds);
    // And it is genuinely not the page's sum, on this fixture.
    expect(oneRow.benchmark.shift_seconds)
      .not.toBe(oneRow.rows.reduce((sum, row) => sum + row.shift_seconds, 0));
  });
});

describe('benchmark.aht: percentiles for a metric the object had only as a pooled scalar', () => {
  it('gates on the SUCCESS-rate pool\'s predicate, because both divide by `connected`', async () => {
    // `aht_seconds` is (talk + wrapup) / connected, the same denominator
    // `success_rate_pct` divides by — so it takes the same two-part gate:
    // `rates_reportable` AND `connected >= 20`. A row with 400 dials and three
    // connects is a reportable row whose average handling time is three calls of
    // evidence.
    //
    // The pool is therefore anita (44000/200 = 220), bala (4400/20 = 220) and esi
    // (1980/20 = 99). u-chen is reportable on 40 attempts and connected nobody, so
    // it has no aht at all; u-dev is thin.
    const { benchmark } = await read();
    expect(benchmark.aht.p25).toBeCloseTo(159.5);
    expect(benchmark.aht.median).toBeCloseTo(220);
    expect(benchmark.aht.p75).toBeCloseTo(220);
    // The pool has exactly three members. Asserted through the same rows the
    // success-rate pool uses, so a divergence between the two shows up here.
    expect(benchmark.success_rate.median).toBeCloseTo(25);
  });

  it('excludes the THIN row, whose aht is deliberately unlike the rest', async () => {
    // u-dev connected 5 of 11 dials with 550 seconds of handling — an aht of 110,
    // which sits between esi's 99 and the 220s. A leak into the pool moves p25
    // downward and the median off 220, so the exclusion is visible rather than
    // asserted.
    const dev = await rowFor('u-dev');
    expect(dev.aht_seconds).toBeCloseTo(110);
    expect(dev.rates_reportable).toBe(false);
    const { benchmark } = await read();
    expect(benchmark.aht.median).toBeCloseTo(220);
    // With u-dev in the pool the values would be [99, 110, 220, 220] and the median
    // 165 — named so the assertion above cannot pass for the wrong reason.
    expect(benchmark.aht.median).not.toBeCloseTo(165);
  });

  it('excludes a reportable row whose aht is NULL, rather than ranking it as 0', async () => {
    // u-chen is reportable on 40 attempts and connected nobody, so its aht is the
    // zero-denominator null. JavaScript sorts `null` as 0, so passing it through
    // would put "no calls connected" at the FASTEST end of the handling-time
    // distribution and drag p25 to 0 — the exact false reading the null exists to
    // prevent, and it would read as the floor's best performer.
    const chen = await rowFor('u-chen');
    expect(chen.rates_reportable).toBe(true);
    expect(chen.aht_seconds).toBeNull();
    const { benchmark } = await read();
    expect(benchmark.aht.p25).toBeCloseTo(159.5);
    // With chen's null ranked as 0 the pool would be [0, 99, 220, 220] and p25
    // would be 74.25.
    expect(benchmark.aht.p25).not.toBeCloseTo(74.25);
  });

  it('pins the `connected >= 20` gate with the two rows sitting exactly ON it', async () => {
    // The boundary of the NEW comparison. u-bala and u-esi are both at connected
    // exactly 20, which is the whole reason the roster fixture carries two rows
    // there — and it is why they BOTH have to move: dropping one leaves the other
    // holding the bound.
    //
    // FALSIFICATION: change `>=` to `>` in `hasRateDenominator` and the first
    // expectation fails, because the pool collapses to anita alone and all three
    // quantiles become her own 220 — no SQL is involved: `rosterPercentiles` is a
    // TypeScript fold over rows this file already served, and interpolating between
    // one value and itself is that value. (It follows `percentile_cont`'s
    // CONVENTION, which is what its own docstring names; the statement behind this
    // read computes no percentile.)
    const before = (await read()).benchmark.aht;
    expect(before).toEqual({ p25: 159.5, median: 220, p75: 220 });

    serve(
      ATTEMPT_ROWS.map((r) => (r.agent_user_id === 'u-bala' || r.agent_user_id === 'u-esi'
        ? { ...r, connected: '19' } : r)),
      OCCUPANCY_ROWS,
    );
    const narrowed = (await read()).benchmark.aht;
    // anita alone: 44000/200 = 220 for all three quantiles.
    expect(narrowed).toEqual({ p25: 220, median: 220, p75: 220 });
  });

  it('is null throughout when no row qualifies, rather than reporting 0', async () => {
    serve([ATTEMPT_ROWS[3]], OCCUPANCY_ROWS);
    const { benchmark } = await read();
    expect(benchmark.agents_rated).toBe(0);
    expect(benchmark.aht).toEqual({ p25: null, median: null, p75: null });
    // ...while the POOLED scalar still describes the floor, because it is a ratio of
    // two sums rather than a ratio of ratios.
    expect(benchmark.aht_seconds).toBeCloseTo(550 / 5);
  });

  it('is a DIFFERENT number from the pooled scalar, on this very fixture', async () => {
    // The asymmetry both numbers exist for: the pooled scalar is dominated by the
    // highest-volume agent, and the median is the middle AGENT's handling time. A
    // consumer handed one cannot derive the other.
    const { benchmark } = await read();
    expect(benchmark.aht_seconds).toBeCloseTo(50930 / 245);
    expect(benchmark.aht_seconds).toBeCloseTo(207.877, 2);
    expect(benchmark.aht.median).toBeCloseTo(220);
  });

  it('leaves every pre-existing benchmark field exactly as it was', async () => {
    // ADDITIVE means additive. The three new fields must not have moved a number
    // the console is already built against, so the whole pre-D10 shape is asserted
    // here in one place.
    const { benchmark } = await read();
    expect(benchmark).toMatchObject({
      agents: 5, agents_rated: 4,
      attempts: 571, connected: 245, successes: 71,
      talk_seconds: 46300, wrapup_seconds: 4630,
    });
    expect(benchmark.connect_rate).toEqual({ p25: 15, median: 35, p75: 62.5 });
    expect(benchmark.success_rate.median).toBeCloseTo(25);
    expect(benchmark.occupancy_pct.median).toBeCloseTo(49.5);
    // And the object gained exactly three keys, so a fourth arriving unnoticed is a
    // failure here rather than a surprise on the wire.
    expect(Object.keys(benchmark).sort()).toEqual([
      'agents', 'agents_rated', 'aht', 'aht_seconds', 'attempts', 'break_seconds',
      'connect_rate', 'connect_rate_pct', 'connected', 'occupancy_pct',
      'shift_seconds', 'success_rate', 'success_rate_pct', 'successes',
      'talk_seconds', 'wrapup_seconds',
    ]);
  });
});
