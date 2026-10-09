import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The supervisor stats payload matches the contract it declares.
//
// The defect this suite exists to make un-shippable: `AgencyCampaignStats`
// declared `abandoned_24h`, `answered_24h` and `abandonment_rate_24h_pct` as
// REQUIRED, and `agencyCampaignRepository.stats` produced none of them. They
// existed only as Prometheus metric names. Because they are typed required, every
// consumer read `undefined` off a field the compiler guaranteed was there.
//
// The abandonment auto-pause is specified against `abandonment_rate_24h_pct`, and
// `undefined > ceiling` evaluates to `false` — so the abandonment guardrail would
// have been present in code review, passed every existing test, and silently never
// fired while a campaign dialled through any abandonment rate whatsoever.
//
// Two distinct holes let that happen, and they need different tests:
//
//   1. The producer not writing a declared field. Now a COMPILE error — `stats()`
//      returns `Omit<AgencyCampaignStats, 'campaign_id' | 'status'>`, so this arm
//      is guarded by `npm run lint` and needs no assertion here.
//   2. The producer reading its own SQL by string key. The mapper pulls
//      `row['answered_24h']` out of an untyped `Record<string, string>`, so a
//      renamed or dropped column yields a confident `0` that satisfies every type
//      in the chain. THAT is what this file tests, because no annotation can see
//      across it — only running the query can.
//
// Hence the shape of the assertions below: every numeric column gets a DISTINCT
// value, so a mapper that reads the right count off the wrong key is caught. A row
// of zeros, or of identical numbers, would pass a mis-wired mapper.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

const { AgencyCampaignRepository } = await import('../../../src/db/repositories/agency.repository.js');
const { AGENCY_CAMPAIGN_STATS_FIELDS, AGENCY_STATS_ROUTE_FIELDS } = await import('@magick-agency/contracts/agency');
const { ABANDONED_ATTEMPT_PREDICATE_SQL, ABANDONMENT_WINDOW_HOURS } = await import(
  '@magick-agency/domain/abandonment-predicate'
);

/**
 * The SCALAR-AGGREGATE statement, located by what it is not.
 *
 * `stats()` also runs a second statement for the agent roster,
 * which is set-returning and carries no rate whose halves could disagree. Every
 * assertion in this file is about the aggregates, so they are selected by
 * predicate rather than by call index — a reordering must not silently retarget
 * them at the roster and start passing vacuously.
 */
const isRoster = (sql: unknown): boolean => String(sql).includes('agency_agent_sessions s');
const aggregateCall = (): unknown[] =>
  (pool.query.mock.calls.filter((c) => !isRoster(c[0]))[0] ?? []) as unknown[];
const sqlOf = (): string => String(aggregateCall()[0] ?? '');
const paramsOf = (): unknown[] => (aggregateCall()[1] ?? []) as unknown[];

/**
 * A realistic row with a DISTINCT value per column.
 *
 * pg returns `int8` as a string and the query casts every count `::text`, so the
 * fixture is strings — a fixture of numbers would let a mapper that forgot
 * `Number()` pass here and return strings to the dashboard.
 */
const ROW = {
  contacts_total: '100',
  contacts_pending: '11',
  contacts_in_flight: '12',
  contacts_completed: '13',
  contacts_suppressed: '14',
  contacts_exhausted: '15',
  retries_pending: '16',
  attempts_live: '17',
  attempts_total: '18',
  attempts_connected: '19',
  attempts_retried: '9',
  agents_live: '20',
  answered_24h: '200',
  abandoned_24h: '6',
};

beforeEach(() => {
  pool.query.mockReset();
  serveAggregate(ROW);
});

/**
 * Serve one aggregate row (or none), and always an empty floor.
 *
 * The roster statement deliberately does NOT get the aggregate row: serving one
 * as an agent session would put a nonsense agent on the payload and make the
 * assertions below read as though it belonged there.
 */
function serveAggregate(row: Record<string, string> | null): void {
  pool.query.mockImplementation((sql: unknown) =>
    Promise.resolve({ rows: isRoster(sql) || row === null ? [] : [row] }),
  );
}

// ─── the payload is complete ────────────────────────────────────────────────

describe('the stats payload produces every field the contract declares', () => {
  it('produces exactly the contract fields the route does not supply — no more, no fewer', async () => {
    const stats = await new AgencyCampaignRepository().stats('camp-1');

    // The payload has TWO producers since the health strip: the route
    // supplies `campaign_id`/`status` off the campaign row it already loaded, plus
    // the four health fields that need Redis and the calling-hours rule. The
    // repository owes everything else.
    //
    // Both halves are derived from the SAME two exported constants rather than
    // hand-listed here, so a field added to `AgencyCampaignStats` reds this suite
    // instead of quietly shipping undefined, and moving a field between producers
    // is a one-line change in `src/` rather than a silent divergence between the
    // contract and this test's idea of it.
    const routeSupplied = new Set<string>(AGENCY_STATS_ROUTE_FIELDS);
    const expected = new Set(
      Object.keys(AGENCY_CAMPAIGN_STATS_FIELDS).filter((k) => !routeSupplied.has(k)),
    );

    expect(new Set(Object.keys(stats))).toEqual(expected);
  });

  it('the three fields that had no producer at all are produced, and carry their own values', async () => {
    const stats = await new AgencyCampaignRepository().stats('camp-1');

    // The regression in its most literal form. Each was `undefined`.
    expect(stats.answered_24h).toBe(200);
    expect(stats.abandoned_24h).toBe(6);
    expect(stats.abandonment_rate_24h_pct).toBeCloseTo(3);
  });

  it('every count is read off its OWN column, so a mis-wired key cannot pass', async () => {
    const stats = await new AgencyCampaignRepository().stats('camp-1');

    // This is the arm the type system cannot reach: `row['answered_24h']` is a
    // string index into an untyped record. Distinct values per column are what
    // turn a swapped or renamed key into a failure instead of a plausible number.
    expect(stats).toMatchObject({
      contacts_total: 100,
      contacts_pending: 11,
      contacts_in_flight: 12,
      contacts_completed: 13,
      contacts_suppressed: 14,
      contacts_exhausted: 15,
      retries_pending: 16,
      attempts_live: 17,
      attempts_total: 18,
      attempts_connected: 19,
      // ClickUp 86d45k0bk item 3. A DIFFERENT question from `retries_pending`
      // above — that counts contacts still QUEUED for a retry, this counts dials
      // already PLACED that were not the contact's first — so the two carry
      // distinct fixture values and reading one off the other's key fails.
      attempts_retried: 9,
      agents_live: 20,
      answered_24h: 200,
      abandoned_24h: 6,
    });
  });

  it('coerces to number rather than passing pg int8 strings through', async () => {
    const stats = await new AgencyCampaignRepository().stats('camp-1');

    // A string `'200'` compares `'200' > 5` as false-ish nonsense in the guardrail
    // and renders as a string in the dashboard. Both are silent.
    //
    // The skip list is the payload's genuinely non-numeric fields, and it is
    // written out rather than inferred so that a NEW count arriving as a string
    // still reds this test: every rate and average is `number | null` by design
    // ("no evidence" and "zero" are different facts), the floor and
    // its by-state tally are structures, `machine_connects_available` is a
    // boolean, and `previous_hour` is a nested object whose own coercion is
    // covered in `supervisor-stats.test.ts`.
    const notPlainNumbers = new Set([
      'abandonment_rate_24h_pct',
      'connect_rate_pct',
      // The conversion rate. `null` here on a fixture that supplies no connect
      // columns, which is the point of the rule rather than a gap in the fixture:
      // nothing bridged, so there is nothing to have converted. `attempts_success`
      // itself is a plain count and is deliberately NOT skipped.
      'success_rate_pct',
      'aht_seconds',
      'aht_seconds_including_machine',
      'avg_wrapup_seconds',
      'agents',
      'agents_by_state',
      'machine_connects_available',
      'previous_hour',
    ]);
    for (const [key, value] of Object.entries(stats)) {
      if (notPlainNumbers.has(key)) continue;
      expect(typeof value, `${key} must be a number, not a pg string`).toBe('number');
    }
  });
});

describe('attempts_retried counts dials PLACED, not retries queued', () => {
  it('counts attempt_number > 1 on the attempts table', async () => {
    await new AgencyCampaignRepository().stats('camp-1');
    // `attempt_number` is the attempts table's own counter, derived at insert from
    // `MAX(attempt_number)` over the contact's rows — deliberately
    // NOT `agency_contacts.attempt_count`, which the two were decoupled from and
    // which does not charge our-fault redials.
    expect(sqlOf()).toContain('attempt_number > 1');
    expect(sqlOf()).toContain('AS attempts_retried');
    // And the `dialed_at` gate, which is what makes PLACED true rather than
    // aspirational: attempts are INSERTed `state = 'queued'` with `dialed_at` NULL,
    // so without it a paused campaign holding 50 reserved-but-undialled second
    // attempts reports 50 redials it never placed. Measured against PostgreSQL
    // 16.13 on a fixture of 12 dialled + 50 queued-only second attempts and 3
    // dialled third attempts: 65 without the gate, 15 with it. Same gate the series
    // aggregate applies to the same table.
    expect(sqlOf()).toMatch(
      /attempt_number > 1\s+AND dialed_at IS NOT NULL\)::text AS attempts_retried/,
    );
    // And it is a different predicate from `retries_pending`, which is about
    // contacts whose `next_attempt_at` is in the future.
    expect(sqlOf()).toContain('next_attempt_at > now())::text AS retries_pending');
  });

  it('is ALWAYS produced even though the contract types it optional', async () => {
    const stats = await new AgencyCampaignRepository().stats('camp-1');
    // The `?` is for a client talking to a server that predates the field.
    // This server has it, so omitting it would make "absent" ambiguous between "old
    // server" and "zero redials" — and the field-roster assertion above compares the
    // produced key set exactly, so a conditional spread would red that test too.
    expect(Object.hasOwn(stats, 'attempts_retried')).toBe(true);
    expect(stats.attempts_retried).toBe(9);
  });

  it('reads a genuine zero as 0 rather than as absent', async () => {
    serveAggregate({ ...ROW, attempts_retried: '0' });
    const stats = await new AgencyCampaignRepository().stats('camp-1');
    // A campaign that never redialled anybody. `'0'` must survive the `::text` →
    // `Number()` hop; a truthiness check anywhere in the mapper would swallow it.
    expect(stats.attempts_retried).toBe(0);
  });
});

// ─── the rate is derived from the TABLE, ─────────────────────────

describe('the guardrail source is the table, not a counter', () => {
  it('counts the 24h window from agency_call_attempts using the shared predicate', async () => {
    await new AgencyCampaignRepository().stats('camp-1');
    const sql = sqlOf();

    // The constraint, asserted rather than commented: the auto-pause must
    // read the SQL-derived window that survives a restart, not the process-local
    // prom-client counter that under-reports by construction. Asserting against the
    // IMPORTED predicate constant is what proves there is one definition and not a
    // second copy that can drift — a hand-written `expect(sql).toContain("outcome
    // = 'abandoned'")` would still pass after someone forked the rule.
    expect(sql).toContain(ABANDONED_ATTEMPT_PREDICATE_SQL);
    expect(sql).toContain('answered_24h');
    expect(sql).toContain('abandoned_24h');
    expect(sql).toContain('FROM agency_call_attempts');
  });

  it('takes the window length from the shared constant rather than a literal 24', async () => {
    await new AgencyCampaignRepository().stats('camp-1');

    // The regulatory window is a business threshold with one home. If this becomes
    // a hardcoded `interval '24 hours'`, changing the constant silently moves the
    // gauge and leaves the dashboard measuring a different window than the alert.
    expect(paramsOf()).toContain(ABANDONMENT_WINDOW_HOURS);
  });

  it('reads both counts in one statement, so numerator and denominator share a window', async () => {
    await new AgencyCampaignRepository().stats('camp-1');

    // `now()` is the statement timestamp in Postgres, so ONE statement is what
    // guarantees the abandoned count is not measured against a window one tick
    // later than the answered count — which at a window boundary is how a rate
    // briefly exceeds 100% and trips a guardrail on arithmetic alone.
    //
    // Asserted as "every aggregate is in the SAME statement" rather than "there is
    // only one query": the health strip added a second statement for the agent roster,
    // which is set-returning and holds no rate. A bare call count would either
    // have to be relaxed to "at most two" — which would let a future edit split
    // the aggregates apart, the exact failure this test exists to catch — or would
    // red every time an unrelated set-returning read is added.
    const aggregateSql = sqlOf();
    for (const alias of ['AS answered_24h', 'AS abandoned_24h']) {
      expect(aggregateSql, alias).toContain(alias);
    }
    expect(
      pool.query.mock.calls.filter((c) => !isRoster(c[0])),
      'the aggregates must be read by exactly one statement',
    ).toHaveLength(1);
  });
});

// ─── null, never zero ───────────────────────────────────────────────────────

describe('an unmeasured campaign reports null, not a reassuring zero', () => {
  it('is null when nothing has been answered', async () => {
    serveAggregate({ ...ROW, answered_24h: '0', abandoned_24h: '0' });

    const stats = await new AgencyCampaignRepository().stats('camp-1');

    // "No calls answered yet" and "no calls abandoned" are different facts.
    // Rendering the first as 0.0% tells a supervisor the campaign is compliant when
    // there is no evidence either way, and it is how the guardrail gets trusted
    // before it has measured anything. The auto-pause's answer to null is
    // "do not pause on it" — which requires null to actually arrive.
    expect(stats.abandonment_rate_24h_pct).toBeNull();
    expect(stats.answered_24h).toBe(0);
  });

  it('is null on an empty result row rather than NaN', async () => {
    serveAggregate(null);

    const stats = await new AgencyCampaignRepository().stats('camp-1');

    // `NaN > ceiling` is false, so a NaN rate is the same silent non-firing
    // guardrail this ticket exists to remove — just one layer further in.
    expect(stats.abandonment_rate_24h_pct).toBeNull();
    expect(Number.isNaN(stats.answered_24h)).toBe(false);
  });

  it('reports a real rate once the window has answered calls', async () => {
    serveAggregate({ ...ROW, answered_24h: '40', abandoned_24h: '5' });

    const stats = await new AgencyCampaignRepository().stats('camp-1');

    // 12.5% — comfortably over a 3% ceiling, which is the case the guardrail has to
    // be able to see. A rate that is merely non-null is not evidence it is correct.
    expect(stats.abandonment_rate_24h_pct).toBeCloseTo(12.5);
  });
});
