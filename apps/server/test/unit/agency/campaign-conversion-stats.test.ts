import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// `attempts_success` / `success_rate_pct` on the campaign stats payload.
//
// ── The defect ─────────────────────────────────────────────────────────────
//
// `AgencyDisposition.is_success` has existed on every disposition-catalog entry
// since migration 072. It is settable in the campaign builder and styled on the
// agent's disposition pad. **Nothing counted it.** Its only other reference was a type check in `campaign-config.ts`'s validation loop — the platform
// confirmed the operator's answer was a boolean and then discarded it. An
// operator could mark `Sale` a success, watch agents submit it all day, and find
// no number anywhere that had noticed.
//
// A declared-but-dead contract field is worse than an absent one, because the
// console renders the checkbox and so the operator has every reason to believe it
// means something.
//
// ── Why the assertions come in pairs ───────────────────────────────────────
//
// THE POOL IS MOCKED, so the fixture supplies the column names and no mapper
// assertion can catch a renamed SQL column. So each rule is asserted against the
// SQL TEXT (which defines what is counted) and against the MAPPED OUTPUT (which
// defines how it is reported) — the same split `supervisor-stats.test.ts` and
// `campaign-stats-contract.test.ts` document.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

const { AgencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');

const isRoster = (sql: unknown): boolean => String(sql).includes('agency_agent_sessions s');
const aggregateSql = (): string =>
  String(pool.query.mock.calls.find((c) => !isRoster(c[0]))?.[0] ?? '');
/** Comments stripped, for the negative assertions — they name what is NOT read. */
const executable = (sql: string): string => sql.replace(/--[^\n]*/g, '');

/**
 * The three connect buckets are the conversion rate's denominator, so they carry
 * distinct values here and sum to 40 bridged attempts. `attempts_total` is
 * deliberately much larger: a dial that rang out had no conversation to convert,
 * so it must NOT be the denominator.
 */
const ROW: Record<string, string> = {
  attempts_total: '500',
  human_connects: '25',
  machine_connects: '7',
  unclassified_connects: '8',
  attempts_success: '10',
  machine_connects_available: 'true',
};

function serve(row: Record<string, string> | null): void {
  pool.query.mockImplementation((sql: unknown) =>
    Promise.resolve({ rows: isRoster(sql) || row === null ? [] : [row] }));
}

beforeEach(() => {
  pool.query.mockReset();
  serve(ROW);
});

const read = () => new AgencyCampaignRepository().stats('camp-1');

describe('what counts as a conversion', () => {
  it('counts bridged attempts whose disposition maps to an is_success entry', async () => {
    await read();
    const sql = executable(aggregateSql());
    expect(sql).toContain('AS attempts_success');
    expect(sql).toContain('jsonb_array_elements(c.disposition_catalog)');
    expect(sql).toContain("e->>'code' = a.disposition_code");
    expect(sql).toContain("e->'is_success' = 'true'::jsonb");
  });

  it('gates on bridged_at, not on outcome', async () => {
    await read();
    const sql = executable(aggregateSql());
    // `bridged_at` is the instant media actually joined the two parties, and it is
    // the same gate `disposition.ts` uses to decide whether there was a
    // conversation to write up. `outcome` is a classification that can be absent,
    // late, or say connected about a call no agent ever heard.
    // Read the conversion subquery specifically, rather than the whole statement
    // — every other flow metric here also gates on `bridged_at`, so a whole-text
    // match would pass even if this one clause were wrong.
    const start = sql.indexOf('JOIN agency_campaigns c ON c.id = a.campaign_id');
    const end = sql.indexOf('AS attempts_success');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const conversionClause = sql.slice(start, end);
    expect(conversionClause).toContain('a.bridged_at IS NOT NULL');
    expect(conversionClause).not.toContain("a.outcome = 'connected'");
  });

  it('is an EXISTS, so a catalog with a duplicated code cannot double the count', async () => {
    await read();
    // `jsonb_array_elements` is set-returning. Joined, two entries sharing one
    // code would produce two rows per attempt.
    expect(executable(aggregateSql())).toContain('EXISTS (');
  });

  it('SURVIVES A MALFORMED CATALOG: object guard, and never a boolean cast', async () => {
    await read();
    const sql = executable(aggregateSql());
    // The baseline migration CHECKs only `jsonb_typeof(disposition_catalog) = 'array'`. Its
    // ELEMENTS are unconstrained, so a catalog written directly against the voice engine's API can
    // hold strings, numbers, nulls or nested arrays.
    expect(sql).toContain("jsonb_typeof(e) = 'object'");
    // And this is the one that matters most: `(e->>'is_success')::boolean` raises
    // 22P02 on a value like "maybe", nothing maps that to a status, and the WHOLE
    // stats payload becomes a 500 carrying the database's error text — for one bad
    // character in one operator's config. The jsonb comparison cannot throw on any
    // input, and a non-`true` value simply is not a success.
    expect(sql).not.toContain('::boolean');
    expect(sql).not.toContain("->>'is_success'");
  });
});

describe('success_rate_pct', () => {
  it('divides by BRIDGED attempts — the three connect buckets — not by attempts_total', async () => {
    const stats = await read();
    expect(stats.attempts_success).toBe(10);
    // 25 + 7 + 8 = 40 bridged. The three buckets are disjoint and exhaustive over
    // bridged attempts by construction, so summing them IS that count — and
    // deriving it makes the payload internally consistent by arithmetic rather
    // than by a fourth subquery agreeing with three others.
    expect(stats.success_rate_pct).toBeCloseTo(25);
    // Not 10/500. A dial that rang out had no conversation to convert, so using
    // the attempt total would turn the conversion rate into a measure of list
    // quality.
    expect(stats.success_rate_pct).not.toBeCloseTo(2);
  });

  it('is NULL — never 0 — when nothing has bridged', async () => {
    // The rule this whole field pair inherits from `abandonment_rate_24h_pct`:
    // "nothing has converted yet" and "nothing has been dispositioned yet" are
    // different facts, and rendering the second as a confident 0.0% is how a
    // metric gets trusted before it has measured anything.
    serve({ attempts_total: '120', human_connects: '0', machine_connects: '0', unclassified_connects: '0', attempts_success: '0' });
    const stats = await read();
    expect(stats.attempts_success).toBe(0);
    expect(stats.success_rate_pct).toBeNull();
    // ...while the connect rate over a real attempt count IS a genuine zero.
    expect(stats.connect_rate_pct).toBe(0);
  });

  it('is 0 when calls DID bridge and none converted', async () => {
    // The other half of the distinction. Forty conversations and no sales is a
    // real 0%, and it must not be indistinguishable from having no conversations.
    serve({ ...ROW, attempts_success: '0' });
    const stats = await read();
    expect(stats.success_rate_pct).toBe(0);
  });

  it('is null on a campaign with no rows at all', async () => {
    serve(null);
    const stats = await read();
    expect(stats.attempts_success).toBe(0);
    expect(stats.success_rate_pct).toBeNull();
    expect(stats.connect_rate_pct).toBeNull();
  });

  it('coerces the count out of a pg int8 string', async () => {
    const stats = await read();
    // pg returns `int8` as a string and the query casts `::text`; a mapper that
    // forgot `Number()` would ship `'10'` to the dashboard, where it renders
    // plausibly and compares as nonsense.
    expect(typeof stats.attempts_success).toBe('number');
  });
});
