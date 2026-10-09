import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// The agent's own record — the pure half.
//
// Everything here is a leaf function: query parsing, the shared bucket
// expression, the occupancy fold and the two rate rules. They are tested apart
// from the SQL on purpose, because the two failures they exist to prevent are
// both invisible in a query plan:
//
//   * a rate reported as `0` where it should be `null` — "nothing has converted
//     yet" rendered as "nothing converts", which is how a metric gets trusted
//     before it has measured anything;
//   * a vocabulary that silently stops describing the data, which is the failure
//     `spine-filters.ts`'s own header documents at length.
// ---------------------------------------------------------------------------

import {
  AGENCY_GROUP_DIMENSIONS,
  AGENT_STATS_BUCKETS,
  AGENT_STATS_MAX_WINDOW_DAYS,
  GROUP_DEFAULT_LIMIT,
  GROUP_DEFAULT_ORDER,
  GROUP_DEFAULT_SORT,
  GROUP_MAX_DIMENSIONS,
  GROUP_MAX_LIMIT,
  GROUP_SORTS,
  groupByIsZoned,
  groupedPageHasSingleZone,
  parseGroupedStatsQuery,
  ROSTER_DEFAULT_LIMIT,
  ROSTER_MAX_LIMIT,
  ROSTER_MAX_WINDOW_DAYS,
  ROSTER_ORDERS,
  ROSTER_SORTS,
  bucketStartSql,
  bucketTruncSql,
  foldOccupancy,
  parseAgentAttemptFilters,
  parseAgentStatsQuery,
  parseRosterQuery,
  rosterPercentiles,
  sortRosterRows,
  zeroOccupancy,
} from '../../../src/agency/agent-record.js';
import type { AgencyRosterAgentRow, AgencyRosterSort } from '@magick-agency/contracts/agency';
import { ratePct, ratio } from '@magick-agency/domain/rates';
import { successDispositionSql } from '@magick-agency/domain/success-disposition';

const issueFor = (result: ReturnType<typeof parseAgentStatsQuery>, param: string): string => {
  if (result.ok) throw new Error(`expected a refusal, got filters`);
  const issue = result.issues.find((i) => i.param === param);
  if (!issue) throw new Error(`no issue for ${param}; got ${JSON.stringify(result.issues)}`);
  return issue.message;
};

// ─── the null-not-zero rule ─────────────────────────────────────────────────

describe('ratePct / ratio: null, never zero, on an empty denominator', () => {
  it('is null — not 0 — when nothing has been measured', () => {
    // The whole point. `0` reads as a measurement; `null` reads as "we cannot
    // say", and only one of those is true of a campaign that has connected nobody.
    expect(ratePct(0, 0)).toBeNull();
    expect(ratePct(5, 0)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(120, 0)).toBeNull();
  });

  it('is 0 when there IS a denominator and the numerator is genuinely zero', () => {
    // The other half of the distinction, and the reason `null` is not simply
    // "falsy": a hundred connected calls and no conversions IS a 0% success rate,
    // and it must not be indistinguishable from having measured nothing.
    expect(ratePct(0, 100)).toBe(0);
    expect(ratio(0, 100)).toBe(0);
  });

  it('scales to a percentage, and `ratio` deliberately does not', () => {
    expect(ratePct(3, 4)).toBeCloseTo(75);
    expect(ratio(3, 4)).toBeCloseTo(0.75);
  });

  it('treats a negative or non-finite denominator as no denominator at all', () => {
    // Unreachable through a COUNT, and guarded anyway: inventing a rate from one
    // would be the same failure wearing a different disguise.
    expect(ratePct(1, -1)).toBeNull();
    expect(ratePct(1, Number.NaN)).toBeNull();
    expect(ratio(1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('the two functions AGREE on what an empty denominator is, for every shape', () => {
    // ── The invariant the module header states and nothing pinned ─────────────
    //
    // `ratePct` is defined as `ratio` scaled, sharing the zero-denominator branch,
    // and the header says why in as many words: "two functions, one rule, so a
    // change to what counts as an empty denominator cannot apply to the rates and
    // miss the averages". The rates are `connect_rate_pct` / `success_rate_pct`;
    // the average is `aht_seconds`. A version where `ratePct` grew its own guard
    // would pass every test above — each one exercises one function at a time —
    // and then report `success_rate_pct: null` beside `aht_seconds: 0` for the same
    // agent, on the same denominator, in the same payload.
    //
    // So: one table, both functions, and the assertion is that they never disagree
    // about whether an answer exists.
    const denominators = [
      0, -0, -1, -100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
      1, 2, 100, 0.5,
    ];
    for (const d of denominators) {
      const pct = ratePct(7, d);
      const raw = ratio(7, d);
      expect(pct === null, `ratePct(7, ${d})`).toBe(raw === null);
      // And where both answer, one is exactly a hundred times the other — so the
      // scaling cannot drift either.
      if (pct !== null && raw !== null) expect(pct).toBeCloseTo(raw * 100, 10);
    }
  });
});

// ─── the bucket vocabulary ──────────────────────────────────────────────────

describe('parseAgentStatsQuery: the bucket vocabulary', () => {
  it('accepts exactly day, week and month', () => {
    expect([...AGENT_STATS_BUCKETS]).toEqual(['day', 'week', 'month']);
    for (const bucket of AGENT_STATS_BUCKETS) {
      const parsed = parseAgentStatsQuery({ from: '2026-08-01', to: '2026-08-08', bucket });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.filters.bucket).toBe(bucket);
    }
  });

  it('refuses an unknown bucket and NAMES the valid set', () => {
    // Echoing the set is what lets a client holding a stale vocabulary recover in
    // one round trip instead of guessing — the same rule `unknown_break_reason`
    // and `validateEnum` already follow.
    const parsed = parseAgentStatsQuery({ from: '2026-08-01', to: '2026-08-08', bucket: 'hour' });
    const message = issueFor(parsed, 'bucket');
    expect(message).toContain('hour');
    expect(message).toContain('day, week, month');
  });

  it('defaults to day when no bucket is supplied', () => {
    const parsed = parseAgentStatsQuery({ from: '2026-08-01', to: '2026-08-08' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.filters.bucket).toBe('day');
  });
});

describe('parseAgentStatsQuery: the window', () => {
  it('requires both bounds — an aggregate with no window is the agent\'s whole life', () => {
    expect(issueFor(parseAgentStatsQuery({ to: '2026-08-08' }), 'from')).toContain('required');
    expect(issueFor(parseAgentStatsQuery({ from: '2026-08-01' }), 'to')).toContain('required');
    expect(issueFor(parseAgentStatsQuery({}), 'from')).toContain('required');
  });

  it('parses a date-only bound at UTC midnight and a zoned date-time as given', () => {
    const parsed = parseAgentStatsQuery({ from: '2026-08-01', to: '2026-08-02T09:30:00+05:30' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(parsed.filters.to.toISOString()).toBe('2026-08-02T04:00:00.000Z');
  });

  it('refuses a zone-less date-time, because that would mean the SERVER\'s zone', () => {
    // Imported from `spine-filters`, asserted here so the reuse is real: a second
    // date parser on this surface is how one of them starts accepting a window the
    // other refuses.
    expect(issueFor(parseAgentStatsQuery({ from: '2026-08-01T09:00:00', to: '2026-08-08' }), 'from'))
      .toContain('zone');
  });

  it('refuses a rolled-forward impossible date rather than answering for March 2nd', () => {
    expect(issueFor(parseAgentStatsQuery({ from: '2026-02-30', to: '2026-03-08' }), 'from'))
      .toContain('not a real date');
  });

  it('refuses an inverted or zero-width window rather than answering "nothing"', () => {
    // "Nothing matched" on a record page reads as a fact about the agent.
    expect(issueFor(parseAgentStatsQuery({ from: '2026-08-08', to: '2026-08-01' }), 'from'))
      .toContain('earlier than');
    expect(issueFor(parseAgentStatsQuery({ from: '2026-08-08', to: '2026-08-08' }), 'from'))
      .toContain('earlier than');
  });

  it('caps the window and says what the cap is', () => {
    const parsed = parseAgentStatsQuery({ from: '2020-01-01', to: '2026-01-01' });
    expect(issueFor(parsed, 'from')).toContain(String(AGENT_STATS_MAX_WINDOW_DAYS));
  });

  it('accepts EXACTLY the cap and refuses one day more', () => {
    // The boundary itself, because a six-year window would still be refused by a
    // comparison that is off by a day in either direction — and the two mistakes
    // fail in opposite, equally silent ways: `>=` refuses the full leap year the
    // cap exists to allow, `>` on a wider constant admits a window the response
    // size argument was drawn against.
    const day = (n: number): string => new Date(Date.UTC(2024, 0, 1 + n)).toISOString().slice(0, 10);

    const atCap = parseAgentStatsQuery({ from: day(0), to: day(AGENT_STATS_MAX_WINDOW_DAYS) });
    expect(atCap.ok).toBe(true);
    if (atCap.ok) {
      expect(atCap.filters.to.getTime() - atCap.filters.from.getTime())
        .toBe(AGENT_STATS_MAX_WINDOW_DAYS * 86_400_000);
    }

    // 2024 is a leap year, so [Jan 1 2024, Jan 1 2025) is 366 days: the cap is
    // exactly "a full year including a leap one", not an approximation of it.
    expect(day(AGENT_STATS_MAX_WINDOW_DAYS)).toBe('2025-01-01');

    const overCap = parseAgentStatsQuery({ from: day(0), to: day(AGENT_STATS_MAX_WINDOW_DAYS + 1) });
    expect(issueFor(overCap, 'from')).toContain(String(AGENT_STATS_MAX_WINDOW_DAYS));
  });

  it('refuses a campaign_id that is not a uuid, before it can reach a ::uuid cast', () => {
    // Postgres answers 22P02 and nothing maps that to a status, so the alternative
    // is a 500 carrying the database's error text on a link someone clicked.
    expect(issueFor(
      parseAgentStatsQuery({ from: '2026-08-01', to: '2026-08-08', campaign_id: 'nope' }),
      'campaign_id',
    )).toContain('campaign id');
  });

  it('collects EVERY issue rather than stopping at the first', () => {
    const parsed = parseAgentStatsQuery({ bucket: 'fortnight', campaign_id: 'nope' });
    if (parsed.ok) throw new Error('expected a refusal');
    expect(parsed.issues.map((i) => i.param).sort()).toEqual(['bucket', 'campaign_id', 'from', 'to']);
  });
});

describe('parseAgentAttemptFilters: the vocabulary is imported, not forked', () => {
  it('refuses an unknown outcome with the SAME message the campaign spine gives', () => {
    const parsed = parseAgentAttemptFilters({ outcome: 'sold' });
    if (parsed.ok) throw new Error('expected a refusal');
    const message = parsed.issues.find((i) => i.param === 'outcome')?.message ?? '';
    expect(message).toContain('unknown outcome: sold');
    // The whole set, from `ATTEMPT_OUTCOMES` — one definition, two routes.
    expect(message).toContain('connected, no_answer, busy, failed, machine, invalid, abandoned');
  });

  it('carries campaign_id through, and refuses a malformed one', () => {
    const ok = parseAgentAttemptFilters({ campaign_id: '11111111-2222-3333-4444-555555555555' });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.filters.campaignId).toBe('11111111-2222-3333-4444-555555555555');

    const bad = parseAgentAttemptFilters({ campaign_id: '../etc' });
    if (bad.ok) throw new Error('expected a refusal');
    expect(bad.issues.map((i) => i.param)).toContain('campaign_id');
  });

  it('accepts the shared filters — state, disposition_code, from/to — unchanged', () => {
    const parsed = parseAgentAttemptFilters({
      state: 'ended,bridged', disposition_code: 'sale', from: '2026-08-01', to: '2026-08-08',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters.states).toEqual(['ended', 'bridged']);
    expect(parsed.filters.dispositionCodes).toEqual(['sale']);
    expect(parsed.filters.from).toBeInstanceOf(Date);
  });
});

// ─── the shared bucket expression ───────────────────────────────────────────

describe('bucketStartSql / bucketTruncSql', () => {
  it('truncates in the ROW\'s zone expression, not in UTC and not in the session zone', () => {
    const sql = bucketStartSql('day', 'a.dialed_at', 'c.default_timezone');
    expect(sql).toContain('a.dialed_at AT TIME ZONE c.default_timezone');
    expect(sql).toContain("date_trunc('day'");
    // The zone is a column expression, so it is derived PER ROW. `not.toContain("AT
    // TIME ZONE 'UTC'")` says nothing here — this helper is handed the zone, so it
    // cannot produce that string with any argument, and the line above already
    // catches a hard-coded one. What CAN go wrong is a literal creeping in beside
    // the caller's expression, e.g. a `COALESCE(<expr>, 'UTC')` fallback moved down
    // here from the repository: that keeps the assertion above true while pinning
    // every unresolvable zone to UTC in one more place than the repository owns.
    //
    // So the assertion is that the zone position holds the caller's expression
    // VERBATIM — nothing added, for any unit and any expression.
    const zoneOperand = (unit: typeof AGENT_STATS_BUCKETS[number], tz: string): string => {
      const match = /AT TIME ZONE (.*)\)\)$/.exec(bucketTruncSql(unit, 'a.dialed_at', tz));
      if (!match) throw new Error(`no AT TIME ZONE operand in ${bucketTruncSql(unit, 'a.dialed_at', tz)}`);
      return match[1] as string;
    };
    for (const unit of AGENT_STATS_BUCKETS) {
      expect(zoneOperand(unit, 'c.default_timezone')).toBe('c.default_timezone');
      expect(zoneOperand(unit, 'i.zone')).toBe('i.zone');
    }
  });

  it('formats the label in SQL as YYYY-MM-DD for every unit', () => {
    // node-pg parses a bare `timestamp` into a LOCAL-time Date, which would put
    // the server's zone back onto a value the query just removed it from. Same
    // reason `hourlyBuckets` formats in SQL.
    for (const unit of AGENT_STATS_BUCKETS) {
      expect(bucketStartSql(unit, 'a.dialed_at', 'z')).toContain("to_char(");
      expect(bucketStartSql(unit, 'a.dialed_at', 'z')).toContain("'YYYY-MM-DD'");
    }
  });

  it('is the label wrapped around the truncation — one spelling, two callers', () => {
    // The occupancy read needs the boundary as a VALUE (it walks the buckets an
    // interval spans); the attempt read needs it as a LABEL. If these two ever
    // stopped agreeing, occupancy would attach to a bucket whose attempts are in
    // the next one.
    const trunc = bucketTruncSql('week', 'i.started', 'i.zone');
    expect(bucketStartSql('week', 'i.started', 'i.zone')).toBe(`to_char(${trunc}, 'YYYY-MM-DD')`);
  });
});

// ─── what counts as a conversion ────────────────────────────────────────────

describe('successDispositionSql', () => {
  const sql = successDispositionSql({ attempt: 'a', catalog: 'c.disposition_catalog' });

  it('is an EXISTS, so a catalog with a duplicated code cannot double-count', () => {
    // `jsonb_array_elements` is set-returning: joined, two entries sharing one
    // code would produce two rows per attempt and double the success count.
    expect(sql.startsWith('EXISTS (')).toBe(true);
    expect(sql).toContain('jsonb_array_elements(c.disposition_catalog)');
  });

  it('guards on element SHAPE, because the catalog\'s elements are unconstrained', () => {
    // Migration 072 CHECKs only that the column is a JSON array. A malformed
    // catalog must not take a stats read down — same defensiveness as
    // `resolveDisposition`.
    expect(sql).toContain("jsonb_typeof(e) = 'object'");
  });

  it('compares a jsonb literal and NEVER casts to boolean', () => {
    // `(e->>'is_success')::boolean` raises 22P02 on `"maybe"`, nothing maps that
    // to a status, and the whole payload becomes a 500 carrying the database's
    // error text — for one bad character in one operator's config. This is the
    // assertion that keeps that from coming back.
    expect(sql).toContain("e->'is_success' = 'true'::jsonb");
    expect(sql).not.toContain('::boolean');
    expect(sql).not.toContain("->>'is_success'");
  });

  it('matches the attempt\'s own disposition_code through the supplied alias', () => {
    expect(sql).toContain("e->>'code' = a.disposition_code");
    expect(successDispositionSql({ attempt: 'att', catalog: 'x' }))
      .toContain("e->>'code' = att.disposition_code");
  });
});

// ─── occupancy folding ──────────────────────────────────────────────────────

describe('foldOccupancy', () => {
  it('reads as zeros — never as an inference — when there are no events', () => {
    // The pre-migration case. The alternative would be reconstructing time in
    // state from `state_since`, which is a snapshot every transition overwrites,
    // so it would attribute an agent's whole history to whatever state they are
    // in now.
    expect(foldOccupancy([])).toEqual(zeroOccupancy());
    expect(zeroOccupancy()).toEqual({
      shift_seconds: 0,
      by_state: { available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0, offline: 0 },
    });
  });

  it('sums per state and reports every state, present or not', () => {
    const folded = foldOccupancy([
      { state: 'available', seconds: 600 },
      { state: 'on_call', seconds: 1200 },
      { state: 'available', seconds: 300 },
      { state: 'wrapup', seconds: 120 },
      { state: 'break', seconds: 900 },
    ]);
    expect(folded.by_state).toEqual({
      available: 900, reserved: 0, on_call: 1200, wrapup: 120, break: 900, offline: 0,
    });
  });

  it('excludes offline from shift_seconds but still reports it', () => {
    // An agent who logged out at 17:00 was not on shift at 18:00. Folding that in
    // would make every short shift look unoccupied — while dropping the field
    // would make "logged out" indistinguishable from "no data".
    const folded = foldOccupancy([
      { state: 'on_call', seconds: 1800 },
      { state: 'available', seconds: 1200 },
      { state: 'offline', seconds: 50_000 },
    ]);
    expect(folded.by_state.offline).toBe(50_000);
    expect(folded.shift_seconds).toBe(3000);
    // Both denominators a reader might want are derivable from the payload.
    expect(folded.by_state.on_call / folded.shift_seconds).toBeCloseTo(0.6);
  });

  it('drops an unknown state rather than inventing a key', () => {
    // Migration 105's CHECK and `AgencyAgentState` agree today. If a seventh state
    // is added to one and not the other, an invented key is one the console's
    // exhaustive switch cannot render — and all six promised keys would still be
    // there, so nothing would look wrong.
    const folded = foldOccupancy([
      { state: 'on_call', seconds: 60 },
      { state: 'coaching', seconds: 999 },
    ]);
    expect(Object.keys(folded.by_state).sort())
      .toEqual(['available', 'break', 'offline', 'on_call', 'reserved', 'wrapup']);
    expect(folded.shift_seconds).toBe(60);
  });

  it('is not fooled by a prototype-named state', () => {
    // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `toString`
    // would pass the guard and then add a number to a function.
    const folded = foldOccupancy([{ state: 'toString', seconds: 5 }]);
    expect(folded).toEqual(zeroOccupancy());
  });

  it('clamps a negative or non-finite duration instead of subtracting from a total', () => {
    const folded = foldOccupancy([
      { state: 'on_call', seconds: -100 },
      { state: 'available', seconds: Number.NaN },
      { state: 'break', seconds: 30 },
    ]);
    expect(folded.by_state.on_call).toBe(0);
    expect(folded.by_state.available).toBe(0);
    expect(folded.shift_seconds).toBe(30);
  });
});

// ─── the degraded / empty occupancy shape ───────────────────────────────────

describe('zeroOccupancy is ONE shape reached by three different causes', () => {
  /**
   * ── Why this deserves an explicit test rather than being incidental ─────────
   *
   * `zeroOccupancy()` is what a reader sees in three situations that mean
   * genuinely different things, and the repository's own comment calls the
   * collapse out as a contract limitation rather than an accident:
   *
   *   1. **The agent has no events.** A session predating migration 105. The
   *      honest answer is "we recorded nothing".
   *   2. **The occupancy read FAILED.** `stats()` catches, warns, and substitutes
   *      `[]` so the attempt numbers still reach the caller. `AgencyAgentOccupancy`
   *      documents `by_state` as "all six states, always present", so there is no
   *      way to say "not measured" on this payload.
   *   3. **Every row carried a state the contract does not know.** `foldOccupancy`
   *      drops an unknown state rather than inventing a key, so a vocabulary drift
   *      between migration 105's CHECK and `AgencyAgentState` empties the block.
   *
   * All three produce byte-identical output. The tests below pin that, because the
   * property a consumer relies on is not "it is zeros" but "it is ALWAYS THE SAME
   * zeros, with all six keys" — a console rendering six tiles must never be handed
   * five, and a `shift_seconds` of `undefined` divides to `NaN` on screen. The
   * distinction between the three causes lives only in the warn log, and that is
   * asserted in `agent-stats-repository.test.ts`; here the point is that the
   * payload cannot be used to tell them apart, so nothing downstream should try.
   */
  it('the three causes are indistinguishable, down to key order', () => {
    const noEvents = foldOccupancy([]);
    const degraded = foldOccupancy([] as { state: string; seconds: number }[]);
    const allUnknown = foldOccupancy([
      { state: 'coaching', seconds: 900 },
      { state: 'training', seconds: 60 },
    ]);

    expect(noEvents).toEqual(zeroOccupancy());
    expect(degraded).toEqual(zeroOccupancy());
    expect(allUnknown).toEqual(zeroOccupancy());
    // Key ORDER too, not just key set: the payload is serialised to JSON and a
    // consumer diffing two records byte-for-byte would otherwise see a change
    // where none happened.
    expect(Object.keys(allUnknown.by_state)).toEqual(Object.keys(zeroOccupancy().by_state));
  });

  it('promises all six states and a numeric shift, never absent keys', () => {
    // A missing key is indistinguishable from zero to a consumer that reads it,
    // and fatal to one that renders `Object.entries`. `undefined` divides to NaN.
    const zero = zeroOccupancy();
    expect(Object.keys(zero.by_state).sort())
      .toEqual(['available', 'break', 'offline', 'on_call', 'reserved', 'wrapup']);
    for (const [state, seconds] of Object.entries(zero.by_state)) {
      expect(typeof seconds, state).toBe('number');
    }
    expect(zero.shift_seconds).toBe(0);
  });

  it('returns a FRESH object per call, so one fold cannot leak into the next', () => {
    // `foldOccupancy` MUTATES what `zeroOccupancy()` hands it (`+=` on
    // `by_state`), so a module-level constant returned by reference would make
    // every fold accumulate the previous one — an agent's record silently
    // carrying the seconds of whoever was read before them, on a shared process
    // serving many tenants. That is the single worst failure available on this
    // payload and it is invisible in a single-request test.
    expect(zeroOccupancy()).not.toBe(zeroOccupancy());
    expect(zeroOccupancy().by_state).not.toBe(zeroOccupancy().by_state);

    const first = foldOccupancy([{ state: 'on_call', seconds: 1200 }]);
    const second = foldOccupancy([{ state: 'on_call', seconds: 5 }]);
    expect(first.by_state.on_call).toBe(1200);
    // Not 1205, and the shared-template failure is exactly what would make it so.
    expect(second.by_state.on_call).toBe(5);
    expect(second.shift_seconds).toBe(5);
    // And the template itself is still pristine after both folds.
    expect(zeroOccupancy()).toEqual({
      shift_seconds: 0,
      by_state: { available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0, offline: 0 },
    });
  });

  it('a row of exactly zero seconds changes nothing and adds no key', () => {
    // The clamp is `seconds > 0 ? seconds : 0`, so zero takes the same arm a
    // negative does. The HAVING in the occupancy query already drops zero-width
    // buckets, but the series is inclusive of the bucket containing `ended`, so a
    // zero can legitimately reach here — it must be a no-op rather than a state
    // that "was measured at 0" and looks different from one that was not.
    expect(foldOccupancy([{ state: 'break', seconds: 0 }])).toEqual(zeroOccupancy());
  });
});

// ─── `?agent_user_id=` on the agent-scoped spine ────────────────────────────

describe('parseAgentAttemptFilters: `agent_user_id` is accepted and then ignored', () => {
  /**
   * ── The rule, and why "accept and ignore" was chosen over a 400 ─────────────
   *
   * The path parameter is the agent. `?agent_user_id=` is part of the IMPORTED
   * filter vocabulary — `parseAgentAttemptFilters` delegates to
   * `parseAttemptFilters`, which is the campaign spine's parser and does have a
   * real `agent_user_id` filter — so it parses here for free. The repository then
   * uses the PATH's value and never `filters.agentUserId`
   * (`agent-attempts-repository.test.ts` pins that half against the SQL).
   *
   * Refusing it outright was the alternative. Accepting keeps a client that sends
   * both — the obvious thing for code generated from the campaign route — working
   * rather than 400ing on a redundancy.
   *
   * **What must NOT happen is the third option: honouring it.** A query parameter
   * that narrowed or contradicted the path would make one URL mean two things, and
   * the dangerous direction is not the contradiction — it is
   * `/agency-agents/me/attempts?agent_user_id=someone-else`, which would read as
   * one agent's URL and answer with another's calls. Nothing in the parser can
   * prevent that; what the parser owes is that the value arrives in a field the
   * repository is known to ignore, which is what these tests pin.
   */
  it('parses a contradicting value into the filter, leaving the path to win', () => {
    const parsed = parseAgentAttemptFilters({ agent_user_id: 'u-someone-else' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Present, and NOT promoted to anything the repository keys on. If a future
    // change makes `listForAgent` read this field, the repository test's
    // "ignores `filters.agentUserId` and uses the PATH's agent" fails — that is
    // the pairing, and neither test is sufficient alone.
    expect(parsed.filters.agentUserId).toBe('u-someone-else');
  });

  it('reads a blank one as absent rather than as an empty-string filter', () => {
    // `?agent_user_id=` is what a cleared form field posts. `singleParam` returns
    // `undefined` for it and the spread omits the key — which matters because an
    // empty STRING is falsy but present, and a repository that tested
    // `'agentUserId' in filters` rather than truthiness would build
    // `s.agent_user_id = ''` and answer an empty page for every request.
    for (const raw of ['', '   ', undefined]) {
      const parsed = parseAgentAttemptFilters({ agent_user_id: raw });
      expect(parsed.ok, JSON.stringify(raw)).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.filters.agentUserId).toBeUndefined();
      expect(Object.hasOwn(parsed.filters, 'agentUserId')).toBe(false);
    }
  });

  it('omits `campaign_id` entirely when it is blank or absent', () => {
    // The same "absent, not empty" rule, and here it is load-bearing rather than
    // merely tidy: `campaignId` reaches SQL as `a.campaign_id = $n::uuid`, so an
    // empty string present on the filter object would be `''::uuid` — `22P02
    // invalid input syntax for type uuid`, which nothing maps to a status and
    // therefore surfaces as a **500 carrying the database's error text** on the
    // ordinary "no campaign filter" request. The truthiness spread is what keeps
    // the key off, and `?campaign_id=` is exactly what a cleared campaign picker
    // posts.
    for (const raw of ['', '   ', undefined]) {
      const parsed = parseAgentAttemptFilters({ campaign_id: raw });
      expect(parsed.ok, JSON.stringify(raw)).toBe(true);
      if (!parsed.ok) continue;
      expect(Object.hasOwn(parsed.filters, 'campaignId'), JSON.stringify(raw)).toBe(false);
    }
    // And the stats surface, which has its own copy of the same guard.
    const stats = parseAgentStatsQuery({ from: '2026-08-17', to: '2026-08-19', campaign_id: '' });
    expect(stats.ok).toBe(true);
    if (!stats.ok) return;
    expect(Object.hasOwn(stats.filters, 'campaignId')).toBe(false);
  });

  it('reports a bad campaign_id ALONGSIDE the shared parser\'s issues, not instead', () => {
    // Both halves of the parse contribute: `issues` starts as a copy of the
    // delegate's and the campaign check appends. A version that returned early on
    // `!parsed.ok` would tell a caller with two mistakes about one of them, and
    // the second 400 would look like the fix did not work.
    const parsed = parseAgentAttemptFilters({ outcome: 'sold', campaign_id: 'nope' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.map((i) => i.param).sort()).toEqual(['campaign_id', 'outcome']);
  });

  it('never returns ok with a campaign_id it refused', () => {
    // The `issues.length > 0 || !parsed.ok` guard. The second arm is what stops a
    // delegate refusal from being dropped when the campaign id happens to be
    // fine, and the first is what stops a bad campaign id passing when the
    // delegate is happy. Both directions, because either alone leaves a hole.
    expect(parseAgentAttemptFilters({ campaign_id: 'nope' }).ok).toBe(false);
    expect(parseAgentAttemptFilters({ outcome: 'sold' }).ok).toBe(false);
    const good = parseAgentAttemptFilters({
      outcome: 'connected', campaign_id: '11111111-2222-4333-8444-555555555555',
    });
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.filters.campaignId).toBe('11111111-2222-4333-8444-555555555555');
    expect(good.filters.outcomes).toEqual(['connected']);
  });
});

// ─── the roster: parsing, ranking and percentiles, all pure ─────────────────

const rosterIssue = (result: ReturnType<typeof parseRosterQuery>, param: string): string => {
  if (result.ok) throw new Error('expected a refusal, got filters');
  const issue = result.issues.find((i) => i.param === param);
  if (!issue) throw new Error(`no issue for ${param}; got ${JSON.stringify(result.issues)}`);
  return issue.message;
};
const rosterFilters = (query: Record<string, unknown>) => {
  const result = parseRosterQuery(query);
  if (!result.ok) throw new Error(`expected filters, got ${JSON.stringify(result.issues)}`);
  return result.filters;
};
const WINDOW_QUERY = { from: '2026-08-17', to: '2026-08-24' };

describe('parseRosterQuery: the window rules are imported, not restated', () => {
  it('requires both bounds — a defaulted window would be worse than a refusal', async () => {
    // The roster aggregates, so an absent bound means "every shift this floor has
    // ever worked". A caller cannot tell from the response which window they got.
    expect(rosterIssue(parseRosterQuery({}), 'from')).toContain('required');
    expect(rosterIssue(parseRosterQuery({}), 'to')).toContain('required');
  });

  it('refuses an inverted or zero-width window rather than answering "nothing"', () => {
    expect(rosterIssue(parseRosterQuery({ from: '2026-08-24', to: '2026-08-17' }), 'from'))
      .toContain('half-open');
    // Equality too: a half-open window of zero width has no honest answer, and an
    // empty roster reads as a fact about the floor rather than about the request.
    expect(rosterIssue(parseRosterQuery({ from: '2026-08-17', to: '2026-08-17' }), 'from'))
      .toContain('half-open');
  });

  it('caps the window at a QUARTER, not at the per-agent record\'s year', () => {
    // The two surfaces deliberately DIVERGE here, and the divergence is the point:
    // the per-agent read is bounded to one `agent_user_id`, which is also the
    // predicate its occupancy index is reachable through. This one names no agent,
    // so `rosterOccupancyTotals` differences every transition of every agent in the
    // ACCOUNT — an ~N-fold cost in a floor of N. Neither statement may carry a
    // `LIMIT` (the benchmark needs the whole pre-`limit` cohort) and core sets no
    // `statement_timeout`, so the window is the only bound there is.
    const tooWide = parseRosterQuery({ from: '2025-01-01', to: '2026-08-24' });
    expect(rosterIssue(tooWide, 'from')).toContain(String(ROSTER_MAX_WINDOW_DAYS));
    // Named explicitly rather than only compared, so a future edit that "restored
    // consistency" by pointing this back at the per-agent constant fails here.
    expect(ROSTER_MAX_WINDOW_DAYS).toBe(92);
    expect(ROSTER_MAX_WINDOW_DAYS).toBeLessThan(AGENT_STATS_MAX_WINDOW_DAYS);
    // And the per-agent read is untouched: a 366-day window is still accepted
    // there, which is the half of the divergence a shared constant would have
    // silently taken away.
    expect(parseAgentStatsQuery({ from: '2024-01-01', to: '2025-01-01' }).ok).toBe(true);
  });

  it('accepts EXACTLY 92 days and refuses one day more, naming the bound', () => {
    // The boundary itself, because a 20-month window would still be refused by a
    // comparison off by a day in either direction, and the two mistakes fail in
    // opposite silent ways: `>=` refuses the full quarter the cap exists to allow,
    // `>` on a wider constant admits a window the cost argument was drawn against.
    const day = (n: number): string => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);

    const atCap = parseRosterQuery({ from: day(0), to: day(ROSTER_MAX_WINDOW_DAYS) });
    expect(atCap.ok).toBe(true);
    if (atCap.ok) {
      expect(atCap.filters.to.getTime() - atCap.filters.from.getTime())
        .toBe(ROSTER_MAX_WINDOW_DAYS * 86_400_000);
    }

    // 92 days is a quarter, so it covers every period the console offers — today,
    // this week, this month, and the completed last-week / last-month ranges — with
    // room above the longest of them.
    expect(day(ROSTER_MAX_WINDOW_DAYS)).toBe('2026-04-03');

    const overCap = parseRosterQuery({ from: day(0), to: day(ROSTER_MAX_WINDOW_DAYS + 1) });
    expect(rosterIssue(overCap, 'from')).toContain(String(ROSTER_MAX_WINDOW_DAYS));
    // The refusal names the bound so a caller wanting a year learns to page by
    // quarter, in the same shape as every other refusal in this function.
    expect(rosterIssue(overCap, 'from')).toContain('at most 92 days');
  });

  it('parses the bounds with the shared parser — no second opinion about a date', () => {
    // `17 Aug 2026` parses fine through `new Date`'s legacy fallback, and
    // `2026-02-30` rolls forward to March 2nd rather than refusing. Both are a
    // wrong answer reported as a right one, and both are refused because the
    // parser is imported rather than rewritten here.
    expect(rosterIssue(parseRosterQuery({ from: '17 Aug 2026', to: '2026-08-24' }), 'from'))
      .toContain('ISO-8601');
    expect(rosterIssue(parseRosterQuery({ from: '2026-02-30', to: '2026-08-24' }), 'from'))
      .toContain('not a real date');
    // A date-only bound is anchored at UTC midnight, and `to` is EXCLUSIVE.
    expect(rosterFilters(WINDOW_QUERY).to).toEqual(new Date('2026-08-24T00:00:00.000Z'));
  });

  it('shape-checks campaign_id before it can reach a ::uuid cast', () => {
    expect(rosterIssue(parseRosterQuery({ ...WINDOW_QUERY, campaign_id: 'nope' }), 'campaign_id'))
      .toContain('campaign id');
    // Absent rather than present-and-empty: a repository testing presence rather
      // than truthiness would build `campaign_id = ''` and answer an empty roster.
    expect(Object.hasOwn(rosterFilters({ ...WINDOW_QUERY, campaign_id: '' }), 'campaignId')).toBe(false);
  });
});

describe('parseRosterQuery: the ranking vocabulary refuses, and echoes the set', () => {
  it('accepts every declared sort key, and only those', () => {
    // The two objects that must agree — the vocabulary that guards the 400 and the
    // accessor map that does the ranking — are separate, so this walks the union.
    for (const sort of ROSTER_SORTS) {
      expect(rosterFilters({ ...WINDOW_QUERY, sort }).sort).toBe(sort);
    }
    expect([...ROSTER_SORTS]).toHaveLength(9);
    expect([...ROSTER_ORDERS]).toEqual(['asc', 'desc']);
  });

  it('400s an unknown sort with the valid set spelled out', () => {
    // A client holding a stale vocabulary recovers in one round trip instead of
    // being handed a differently-ordered page that looks like an answer.
    const message = rosterIssue(parseRosterQuery({ ...WINDOW_QUERY, sort: 'agent_score' }), 'sort');
    expect(message).toContain('unknown sort: agent_score');
    for (const sort of ROSTER_SORTS) expect(message).toContain(sort);
  });

  it('refuses a comma-separated sort rather than silently using the first', () => {
    // Two sort keys is not a request this route can honour, and `singleEnum` wraps
    // the shared multi-value validator so the refusal names the offending value.
    expect(rosterIssue(parseRosterQuery({ ...WINDOW_QUERY, sort: 'attempts,connected' }), 'sort'))
      .toContain('unknown sort');
  });

  it('defaults to `successes` descending, which is the outcome the floor is run for', () => {
    // Deliberately not `attempts`: a roster ranked by dial count ranks agents by how
    // hard the DIALER worked them. And a raw count rather than a rate, so the default
    // page cannot be topped by an agent with one connect and one sale.
    expect(rosterFilters(WINDOW_QUERY)).toMatchObject({
      sort: 'successes', order: 'desc', limit: ROSTER_DEFAULT_LIMIT,
    });
  });

  it('400s an unknown order', () => {
    expect(rosterIssue(parseRosterQuery({ ...WINDOW_QUERY, order: 'descending' }), 'order'))
      .toContain('expected one of asc, desc');
  });
});

describe('parseRosterQuery: `limit` REFUSES where the spine clamps', () => {
  // The spine's `clampLimit` pins a page size on a CURSOR-paged list, where a
  // clamped value still returns the next rows and the caller loses a round trip.
  // This limit truncates a RANKED list with no cursor: a silently changed limit
  // changes WHICH agents are on the page, and `total_agents` is the only hint.
  it('accepts the bounds and everything between', () => {
    expect(rosterFilters({ ...WINDOW_QUERY, limit: '1' }).limit).toBe(1);
    expect(rosterFilters({ ...WINDOW_QUERY, limit: String(ROSTER_MAX_LIMIT) }).limit)
      .toBe(ROSTER_MAX_LIMIT);
  });

  it('refuses everything outside them, naming the bound', () => {
    for (const limit of ['0', '-1', '201', '99999', 'abc', '1.5', '1e2', ' 7 x']) {
      expect(rosterIssue(parseRosterQuery({ ...WINDOW_QUERY, limit }), 'limit'), limit)
        .toContain(`between 1 and ${ROSTER_MAX_LIMIT}`);
    }
  });

  it('treats a BLANK limit as absent, not as zero', () => {
    // `?limit=` is what a cleared form field posts. `Number('')` is 0, so a naive
    // parse would refuse a bound the caller never typed.
    expect(rosterFilters({ ...WINDOW_QUERY, limit: '' }).limit).toBe(ROSTER_DEFAULT_LIMIT);
    expect(rosterFilters({ ...WINDOW_QUERY, limit: '   ' }).limit).toBe(ROSTER_DEFAULT_LIMIT);
  });

  it('collects every issue at once rather than refusing one at a time', () => {
    // A caller fixing a form should see all of it. Same shape as every other parser
    // on this surface: issues accumulate, and the parse returns them together.
    const result = parseRosterQuery({ sort: 'nope', order: 'nope', limit: '0', campaign_id: 'x' });
    if (result.ok) throw new Error('expected a refusal');
    expect(result.issues.map((i) => i.param).sort())
      .toEqual(['campaign_id', 'from', 'limit', 'order', 'sort', 'to']);
  });
});

// ─── the ranking rule ───────────────────────────────────────────────────────

/** A roster row with only the fields a sort key reads; the rest is filler. */
const rosterRow = (over: Partial<AgencyRosterAgentRow>): AgencyRosterAgentRow => ({
  agent_user_id: 'u-x', attempts: 0, connected: 0, successes: 0,
  talk_seconds: 0, wrapup_seconds: 0,
  connect_rate_pct: null, success_rate_pct: null, aht_seconds: null,
  campaigns: 0, shift_seconds: 0, break_seconds: 0, occupancy_pct: null,
  last_dialed_at: null, rates_reportable: false, success_rate_reportable: false,
  ...over,
});

describe('sortRosterRows: nulls last in BOTH directions', () => {
  /**
   * The failure this prevents, in both directions:
   *
   *   * `desc` with a naive `b - a` coerces `null` to 0 and files an agent who
   *     connected nobody at the BOTTOM — asserting a 0% rate the data does not
   *     support.
   *   * `asc` promotes that same false claim to the TOP of "worst converter",
   *     which is the first thing a supervisor sees.
   *
   * A row with no measurable rate is not the best row and not the worst row. It is
   * not ranked.
   */
  const ROWS = [
    rosterRow({ agent_user_id: 'u-null-a', success_rate_pct: null }),
    rosterRow({ agent_user_id: 'u-low', success_rate_pct: 5 }),
    rosterRow({ agent_user_id: 'u-null-b', success_rate_pct: null }),
    rosterRow({ agent_user_id: 'u-high', success_rate_pct: 90 }),
  ];

  it('desc: ranked rows descend, then the nulls', () => {
    expect(sortRosterRows(ROWS, 'success_rate_pct', 'desc').map((r) => r.agent_user_id))
      .toEqual(['u-high', 'u-low', 'u-null-a', 'u-null-b']);
  });

  it('asc: ranked rows ascend, and the nulls are STILL last', () => {
    expect(sortRosterRows(ROWS, 'success_rate_pct', 'asc').map((r) => r.agent_user_id))
      .toEqual(['u-low', 'u-high', 'u-null-a', 'u-null-b']);
  });

  it('holds for every nullable sort key', () => {
    const NULLABLE: AgencyRosterSort[] =
      ['connect_rate_pct', 'success_rate_pct', 'aht_seconds', 'occupancy_pct'];
    for (const sort of NULLABLE) {
      const rows = [
        rosterRow({ agent_user_id: 'u-null' }),
        rosterRow({ agent_user_id: 'u-value', [sort]: 42 } as Partial<AgencyRosterAgentRow>),
      ];
      for (const order of ['asc', 'desc'] as const) {
        expect(sortRosterRows(rows, sort, order).at(-1)?.agent_user_id, `${sort} ${order}`)
          .toBe('u-null');
      }
    }
  });

  it('does not mutate its input', () => {
    const rows = [...ROWS];
    sortRosterRows(rows, 'success_rate_pct', 'asc');
    expect(rows.map((r) => r.agent_user_id)).toEqual(ROWS.map((r) => r.agent_user_id));
  });
});

describe('sortRosterRows: `agent_user_id` is the tiebreaker on every sort', () => {
  it('breaks ties ASCENDING regardless of the requested direction', () => {
    // Ties are the normal case: `successes` is a small integer and a floor of thirty
    // will have several agents on 4. Without a total order two reads of the same
    // window return the same rows in a different order — and with `limit`, a
    // different SET of rows. The tiebreak does not flip with `order` because it is
    // there to be deterministic, not meaningful: flipping it would make a stable
    // page appear to reshuffle when the reader toggled an unrelated column.
    const tied = ['u-zoe', 'u-adam', 'u-mira'].map((id) =>
      rosterRow({ agent_user_id: id, successes: 4 }));
    for (const order of ['asc', 'desc'] as const) {
      expect(sortRosterRows(tied, 'successes', order).map((r) => r.agent_user_id))
        .toEqual(['u-adam', 'u-mira', 'u-zoe']);
    }
  });

  it('breaks ties among NULLS too, so a degraded metric still pages deterministically', () => {
    // When the occupancy read fails every value is null, so every row ties and the
    // tiebreak is the entire ordering.
    const nulls = ['u-c', 'u-a', 'u-b'].map((id) => rosterRow({ agent_user_id: id }));
    for (const order of ['asc', 'desc'] as const) {
      expect(sortRosterRows(nulls, 'occupancy_pct', order).map((r) => r.agent_user_id))
        .toEqual(['u-a', 'u-b', 'u-c']);
    }
  });

  it('honours `order` when the sort key IS `agent_user_id`', () => {
    const rows = ['u-b', 'u-a', 'u-c'].map((id) => rosterRow({ agent_user_id: id }));
    expect(sortRosterRows(rows, 'agent_user_id', 'asc').map((r) => r.agent_user_id))
      .toEqual(['u-a', 'u-b', 'u-c']);
    expect(sortRosterRows(rows, 'agent_user_id', 'desc').map((r) => r.agent_user_id))
      .toEqual(['u-c', 'u-b', 'u-a']);
  });

  it('ranks every declared sort key rather than falling through to a default', () => {
    // `ROSTER_SORT_VALUES` is a `Record` over the union precisely so a tenth key is
    // a build error rather than a silent fallback. This is the runtime half: every
    // key must actually reorder two rows that differ only on it.
    for (const sort of ROSTER_SORTS) {
      if (sort === 'agent_user_id') continue;
      const rows = [
        rosterRow({ agent_user_id: 'u-small', [sort]: 1 } as Partial<AgencyRosterAgentRow>),
        rosterRow({ agent_user_id: 'u-big', [sort]: 99 } as Partial<AgencyRosterAgentRow>),
      ];
      expect(sortRosterRows(rows, sort, 'desc')[0]?.agent_user_id, sort).toBe('u-big');
      expect(sortRosterRows(rows, sort, 'asc')[0]?.agent_user_id, sort).toBe('u-small');
    }
  });
});

describe('rosterPercentiles: the `percentile_cont` reading, null when empty', () => {
  it('nulls all three on an empty pool rather than reporting 0', () => {
    // Same rule as every rate on this surface: "nothing qualified" and "the cohort
    // scores zero" are different facts, and only one of them is a measurement.
    expect(rosterPercentiles([])).toEqual({ p25: null, median: null, p75: null });
  });

  it('reports a single value as all three quantiles', () => {
    expect(rosterPercentiles([42])).toEqual({ p25: 42, median: 42, p75: 42 });
  });

  it('interpolates between neighbours rather than snapping to a row', () => {
    // `percentile_disc` would snap to an actual row, and on a floor of four agents
    // that makes the median one named person's number — which invites reading the
    // benchmark as a comparison against THEM.
    expect(rosterPercentiles([0, 20, 50])).toEqual({ p25: 10, median: 20, p75: 35 });
    expect(rosterPercentiles([20, 30])).toEqual({ p25: 22.5, median: 25, p75: 27.5 });
  });

  it('sorts the input itself, and does not mutate it', () => {
    const values = [50, 0, 20];
    expect(rosterPercentiles(values).median).toBe(20);
    expect(values).toEqual([50, 0, 20]);
  });

  it('matches Postgres percentile_cont on a known four-value set', () => {
    // percentile_cont over (1,2,3,4): p25 = 1.75, p50 = 2.5, p75 = 3.25.
    expect(rosterPercentiles([4, 1, 3, 2])).toEqual({ p25: 1.75, median: 2.5, p75: 3.25 });
  });
});

// ─── the grouped read: parsing, and the two refusals that are not typos ──────
//
// Everything below is `parseGroupedStatsQuery`, which is where every rule about
// WHICH question this read can answer lives — including the one rule that has no
// counterpart anywhere else on this surface: a well-formed request, every value in
// its vocabulary, that still cannot be answered because a time bucket across
// campaigns in different zones is not one column (contract D5).
//
// ── The thresholds in this section, and which case pins each ────────────────
//
// Three comparisons are introduced by this read, and each has a case sitting
// EXACTLY on the bound — a threshold with no case on it is untested however much a
// header claims otherwise:
//
//   * `entries.length > GROUP_MAX_DIMENSIONS`. Pinned by the TWO-dimension case
//     ('agent,campaign' must be accepted) and the three-dimension case. Mutate the
//     `>` to `>=` and the two-dimension case refuses.
//   * `parsed > GROUP_MAX_LIMIT` and `parsed < 1`. Pinned by `limit=1000` and
//     `limit=1` being accepted, and `1001`/`0` refused.
//   * the window cap, reusing `ROSTER_MAX_WINDOW_DAYS`. Pinned by a window of
//     exactly 92 days being accepted and 92 days plus one millisecond refused.

const groupIssue = (result: ReturnType<typeof parseGroupedStatsQuery>, param: string): string => {
  if (result.ok) throw new Error('expected a refusal, got filters');
  const issue = result.issues.find((i) => i.param === param);
  if (!issue) throw new Error(`no issue for ${param}; got ${JSON.stringify(result.issues)}`);
  return issue.message;
};
const groupCode = (result: ReturnType<typeof parseGroupedStatsQuery>): string | undefined => {
  if (result.ok) throw new Error('expected a refusal, got filters');
  return result.issues.find((i) => i.code !== undefined)?.code;
};
const groupFilters = (query: Record<string, unknown>) => {
  const result = parseGroupedStatsQuery(query);
  if (!result.ok) throw new Error(`expected filters, got ${JSON.stringify(result.issues)}`);
  return result.filters;
};
/** A window plus the one grouping that needs no zone, so each test varies one thing. */
const GROUP_QUERY = { from: '2026-08-17', to: '2026-08-24', group_by: 'agent' };
const ONE_CAMPAIGN = '11111111-2222-3333-4444-555555555555';

describe('parseGroupedStatsQuery: `group_by` is required, whitelisted and capped at two', () => {
  it('requires it — a grouped read with no grouping is a different route', () => {
    // Not defaulted: with no grouping this is either the roster (by agent) or a
    // one-row total, and both already have routes. A default would make the same
    // URL mean a different question depending on which build answered it.
    const issue = groupIssue(parseGroupedStatsQuery({ from: '2026-08-17', to: '2026-08-24' }), 'group_by');
    expect(issue).toContain('required');
    // The vocabulary is echoed on the refusal, as every other refusal here does it.
    for (const dimension of AGENCY_GROUP_DIMENSIONS) expect(issue).toContain(dimension);
  });

  it('400s an unknown dimension and names the whole vocabulary', () => {
    const issue = groupIssue(parseGroupedStatsQuery({ ...GROUP_QUERY, group_by: 'team' }), 'group_by');
    expect(issue).toContain('unknown group_by: team');
    expect(issue).toContain('hour_of_day');
  });

  it('accepts EXACTLY two dimensions and refuses three, with a code', () => {
    // The boundary of `entries.length > GROUP_MAX_DIMENSIONS`, which nothing else
    // pins. Two is the whole point of the cap — every screen in scope needs two —
    // so a `>=` here would refuse the reads this route exists for while still
    // refusing the three-dimension case, i.e. it would look correct from the
    // refusal side alone.
    //
    // FALSIFICATION: change that `>` to `>=` and this test fails on the first
    // expectation, not on the third.
    expect(GROUP_MAX_DIMENSIONS).toBe(2);
    expect(groupFilters({ ...GROUP_QUERY, group_by: 'agent,campaign' }).groupBy)
      .toEqual(['agent', 'campaign']);

    const three = parseGroupedStatsQuery({ ...GROUP_QUERY, group_by: 'agent,campaign,disposition' });
    // A CODE, not just a message: the request is well-formed — every value is in
    // the vocabulary — so a client needs to tell this from a typo without parsing
    // prose.
    expect(groupCode(three)).toBe('too_many_dimensions');
    expect(groupIssue(three, 'group_by')).toContain('at most 2 dimensions');
    // The reason is in the message, because it is not obvious: the row count is the
    // PRODUCT of the dimensions' cardinalities.
    expect(groupIssue(three, 'group_by')).toContain('product');
  });

  it('counts the dimensions BEFORE consulting the vocabulary', () => {
    // Four typos should be told they asked for too many dimensions, not handed four
    // unknown-value messages that all become moot the moment two are dropped.
    const result = parseGroupedStatsQuery({ ...GROUP_QUERY, group_by: 'aa,bb,cc,dd' });
    expect(groupCode(result)).toBe('too_many_dimensions');
    expect(groupIssue(result, 'group_by')).not.toContain('unknown group_by');
  });

  it('refuses a repeated dimension rather than deduplicating it silently', () => {
    // Grouping by one dimension twice halves the dimensionality of the answer, so a
    // caller who wrote it meant something else and silently answering the narrower
    // question is the worse outcome.
    expect(groupIssue(parseGroupedStatsQuery({ ...GROUP_QUERY, group_by: 'agent,agent' }), 'group_by'))
      .toContain('repeat');
  });

  it('CANONICALISES the order, so two spellings are one read', () => {
    // The response echoes this list, and it is also the order the row key's members
    // are compared in — so `agent,campaign` and `campaign,agent` must be the same
    // read, echo the same `group_by`, and cache the same.
    expect(groupFilters({ ...GROUP_QUERY, group_by: 'campaign,agent' }).groupBy)
      .toEqual(['agent', 'campaign']);
    expect(groupFilters({ ...GROUP_QUERY, group_by: 'hour_of_day,day_of_week', campaign_id: ONE_CAMPAIGN }).groupBy)
      .toEqual(['day_of_week', 'hour_of_day']);
    // Canonical means the DECLARATION order of the vocabulary, not alphabetical —
    // asserted because an alphabetical sort would agree on the first case above and
    // disagree here.
    expect([...AGENCY_GROUP_DIMENSIONS]).toEqual([
      'agent', 'campaign', 'disposition', 'day', 'day_of_week', 'hour_of_day',
    ]);
  });

  it('drops a trailing empty entry rather than refusing it', () => {
    // `?group_by=agent,` is what string concatenation in a client produces, and it
    // plainly means one dimension.
    expect(groupFilters({ ...GROUP_QUERY, group_by: 'agent,' }).groupBy).toEqual(['agent']);
    expect(groupFilters({ ...GROUP_QUERY, group_by: ' agent , campaign ' }).groupBy)
      .toEqual(['agent', 'campaign']);
  });
});

describe('parseGroupedStatsQuery: a time dimension needs an unambiguous zone (D5)', () => {
  // Buckets are cut in the CAMPAIGN's own `default_timezone`, so across campaigns
  // in different zones "the 18:00 row" is several local 18:00s summed into one
  // number that describes no hour anywhere. There is deliberately no implicit UTC
  // fallback and no `tz` parameter: silently bucketing an `Asia/Kolkata` account as
  // UTC puts the real connect peak six columns to the left, and the only visible
  // symptom is a rostering decision that is quietly wrong.

  it('refuses each time dimension on its own, with the code and BOTH remedies', () => {
    for (const dimension of ['day', 'day_of_week', 'hour_of_day']) {
      const result = parseGroupedStatsQuery({ ...GROUP_QUERY, group_by: dimension });
      expect(groupCode(result), dimension).toBe('timezone_ambiguous');
      const message = groupIssue(result, 'group_by');
      // BOTH remedies are named. A refusal that names one trains every caller to
      // reach for that one, and the two are not interchangeable: adding `campaign`
      // keeps the read cross-campaign, filtering to one narrows it.
      expect(message).toContain('campaign');
      expect(message).toContain('campaign_id');
      expect(message).toContain('timezone');
    }
  });

  it('allows it when `campaign` is ALSO grouped — each row carries its own zone', () => {
    expect(groupFilters({ ...GROUP_QUERY, group_by: 'campaign,hour_of_day' }).groupBy)
      .toEqual(['campaign', 'hour_of_day']);
    expect(groupFilters({ ...GROUP_QUERY, group_by: 'campaign,day' }).groupBy)
      .toEqual(['campaign', 'day']);
  });

  it('allows it when exactly one `campaign_id` is filtered — one zone for the read', () => {
    const filters = groupFilters({ ...GROUP_QUERY, group_by: 'hour_of_day', campaign_id: ONE_CAMPAIGN });
    expect(filters.groupBy).toEqual(['hour_of_day']);
    expect(filters.campaignId).toBe(ONE_CAMPAIGN);
  });

  it('is NOT triggered by a non-time dimension, however many campaigns are in scope', () => {
    // A count and a duration are zone-independent. `agent`, `campaign` and
    // `disposition` therefore need no zone at all, and refusing them would be a
    // cap on the reads the rule was never about.
    for (const dimension of ['agent', 'campaign', 'disposition']) {
      expect(parseGroupedStatsQuery({ ...GROUP_QUERY, group_by: dimension }).ok, dimension).toBe(true);
    }
    expect(groupFilters({ ...GROUP_QUERY, group_by: 'agent,disposition' }).groupBy)
      .toEqual(['agent', 'disposition']);
  });

  it('refuses a MIXED pair: one zoned dimension beside a non-campaign one', () => {
    // ── The case that separates `some` from `every`, and nothing else does ────
    //
    // Every other case in this block groups by ALL time dimensions or by NONE, plus
    // the two `campaign,<time>` remedies — and `groupBy.some(needsZone)` and
    // `groupBy.every(needsZone)` agree on every one of those. They differ ONLY on a
    // pair holding one zoned dimension and one non-zoned dimension that is not
    // `campaign`. Mutating that `some` to `every` therefore left the whole core
    // suite green while ANSWERING these three requests: `agent,day` would sum one
    // agent's attempts across campaigns in Asia/Kolkata and Europe/London into a
    // single "2026-08-19" row, and `agent,hour_of_day` into a single "18:00" — which
    // is exactly the reading D5 exists to refuse, on the third of the three screens
    // the cap of two dimensions was sized for (`agent`+`day`, a trend).
    //
    // FALSIFICATION: change `some` to `every` in `groupByIsZoned` — the shared
    // quantifier D5's condition now reads — and all three expectations below fail.
    // (It also flips `resolved_timezone` to a string on these shapes, which
    // `groupedPageHasSingleZone`'s own block below pins.)
    for (const groupBy of ['agent,day', 'agent,hour_of_day', 'disposition,day_of_week']) {
      const result = parseGroupedStatsQuery({ ...GROUP_QUERY, group_by: groupBy });
      expect(groupCode(result), groupBy).toBe('timezone_ambiguous');
      // The remedies are named here too: the fix for a mixed pair is the same pair
      // of fixes, and a caller who reached it by adding `agent` to `hour_of_day`
      // must not be told something narrower than the caller who asked for
      // `hour_of_day` alone.
      const message = groupIssue(result, 'group_by');
      expect(message, groupBy).toContain('campaign');
      expect(message, groupBy).toContain('campaign_id');
    }
  });

  it('allows the same mixed pair once ONE campaign is filtered', () => {
    // The positive half, and it is not symmetry for its own sake: this is the shape
    // 02b's per-agent heatmap asks for — one campaign, one agent, hour of day — so
    // a rule that refused it would refuse a named screen. One `campaign_id` means
    // one zone for the whole read, which is what makes the hour column one thing.
    const filters = groupFilters({
      ...GROUP_QUERY, group_by: 'agent,hour_of_day', campaign_id: ONE_CAMPAIGN,
    });
    expect(filters.groupBy).toEqual(['agent', 'hour_of_day']);
    expect(filters.campaignId).toBe(ONE_CAMPAIGN);
    // And with `campaign` grouped instead of filtered, the other remedy — which is
    // the mixed pair the existing cases already cover, asserted here beside its
    // sibling so the two remedies are visibly interchangeable.
    expect(groupFilters({ ...GROUP_QUERY, group_by: 'agent,day' , campaign_id: ONE_CAMPAIGN }).groupBy)
      .toEqual(['agent', 'day']);
  });

  it('reports the MISSPELLING rather than the zone when `group_by` did not parse', () => {
    // Naming an ambiguous zone for a dimension the caller never successfully asked
    // for would name the wrong problem, and the misspelling is already on the list.
    const result = parseGroupedStatsQuery({ ...GROUP_QUERY, group_by: 'hour' });
    expect(groupCode(result)).toBeUndefined();
    expect(groupIssue(result, 'group_by')).toContain('unknown group_by: hour');
  });

  it('a malformed campaign_id does not buy its way past the zone rule', () => {
    // It is refused anyway, and the point is that the tz check must not read a
    // value the uuid guard has already rejected as satisfying the remedy — the
    // caller would then fix the uuid and hit a second, unrelated 400.
    const result = parseGroupedStatsQuery({ ...GROUP_QUERY, group_by: 'hour_of_day', campaign_id: 'nope' });
    expect(result.ok).toBe(false);
    expect(groupIssue(result, 'campaign_id')).toContain('campaign id');
  });
});

describe('parseGroupedStatsQuery: the window rules and the CAP are imported', () => {
  it('requires both bounds and refuses an inverted or zero-width window', () => {
    expect(groupIssue(parseGroupedStatsQuery({ group_by: 'agent' }), 'from')).toContain('required');
    expect(groupIssue(parseGroupedStatsQuery({ group_by: 'agent' }), 'to')).toContain('required');
    expect(groupIssue(
      parseGroupedStatsQuery({ from: '2026-08-24', to: '2026-08-17', group_by: 'agent' }), 'from',
    )).toContain('half-open');
    expect(groupIssue(
      parseGroupedStatsQuery({ from: '2026-08-17', to: '2026-08-17', group_by: 'agent' }), 'from',
    )).toContain('half-open');
  });

  it('caps at EXACTLY the roster\'s 92 days, and refuses one millisecond more', () => {
    // The same constant, deliberately, rather than a second 92 declared for this
    // read — two caps holding one value is two things to change and one of them
    // gets missed. The boundary needs its own case for the reason the roster's does:
    // `>=` refuses the full quarter the cap exists to allow, and the mistake is
    // invisible against any window wider than a quarter.
    //
    // FALSIFICATION: change the `>` in the window comparison to `>=` and the first
    // expectation here fails.
    const from = new Date('2026-01-01T00:00:00.000Z');
    const atCap = new Date(from.getTime() + ROSTER_MAX_WINDOW_DAYS * 86_400_000);
    expect(parseGroupedStatsQuery({
      from: from.toISOString(), to: atCap.toISOString(), group_by: 'agent',
    }).ok).toBe(true);

    const overCap = new Date(atCap.getTime() + 1);
    const refused = parseGroupedStatsQuery({
      from: from.toISOString(), to: overCap.toISOString(), group_by: 'agent',
    });
    expect(groupIssue(refused, 'from')).toContain('at most 92 days');
    expect(ROSTER_MAX_WINDOW_DAYS).toBe(92);
  });

  it('parses the bounds with the shared parser — no second opinion about a date', () => {
    expect(groupIssue(parseGroupedStatsQuery({ ...GROUP_QUERY, from: '17 Aug 2026' }), 'from'))
      .toContain('ISO-8601');
    expect(groupIssue(parseGroupedStatsQuery({ ...GROUP_QUERY, from: '2026-02-30' }), 'from'))
      .toContain('not a real date');
    expect(groupFilters(GROUP_QUERY).to).toEqual(new Date('2026-08-24T00:00:00.000Z'));
  });

  it('shape-checks campaign_id before it can reach a ::uuid cast', () => {
    expect(groupIssue(parseGroupedStatsQuery({ ...GROUP_QUERY, campaign_id: 'nope' }), 'campaign_id'))
      .toContain('campaign id');
    // Absent rather than present-and-empty, so a repository testing presence rather
    // than truthiness cannot build `campaign_id = ''`.
    expect(Object.hasOwn(groupFilters({ ...GROUP_QUERY, campaign_id: '' }), 'campaignId')).toBe(false);
  });
});

describe('parseGroupedStatsQuery: sort, order and limit', () => {
  it('defaults to `key` ascending, which is the only order a series reads in', () => {
    // Deliberately NOT the roster's `successes desc`: an hour-of-day series sorted
    // by successes is not a series, it is a league table whose x-axis has been
    // shuffled.
    const filters = groupFilters(GROUP_QUERY);
    expect(filters.sort).toBe('key');
    expect(filters.order).toBe('asc');
    expect(GROUP_DEFAULT_SORT).toBe('key');
    expect(GROUP_DEFAULT_ORDER).toBe('asc');
  });

  it('accepts every declared sort key and refuses an undeclared one, naming the set', () => {
    for (const sort of GROUP_SORTS) {
      expect(groupFilters({ ...GROUP_QUERY, sort }).sort, sort).toBe(sort);
    }
    // `talk_seconds` and `occupancy_pct` are ROSTER sort keys and are deliberately
    // not here — there is no occupancy on this read at all, and the eight metrics
    // this route serves are the ones it can rank by.
    const issue = groupIssue(parseGroupedStatsQuery({ ...GROUP_QUERY, sort: 'occupancy_pct' }), 'sort');
    expect(issue).toContain('unknown sort: occupancy_pct');
    expect(issue).toContain('key');
    expect(issue).toContain('aht_seconds');
  });

  it('refuses an unknown order', () => {
    expect(groupIssue(parseGroupedStatsQuery({ ...GROUP_QUERY, order: 'ascending' }), 'order'))
      .toContain('expected one of asc, desc');
  });

  it('defaults `limit` to 200 and accepts BOTH bounds exactly', () => {
    // Both ends of `1 <= limit <= GROUP_MAX_LIMIT`, because each is a separate
    // comparison and each fails silently in its own direction: `< 1` mutated to
    // `<= 1` refuses the single-row read a "top group" question sends, and
    // `> GROUP_MAX_LIMIT` mutated to `>=` refuses the full page the ceiling exists
    // to allow.
    //
    // FALSIFICATION: mutate either comparison and one of the first three
    // expectations here fails.
    expect(groupFilters(GROUP_QUERY).limit).toBe(GROUP_DEFAULT_LIMIT);
    expect(GROUP_DEFAULT_LIMIT).toBe(200);
    expect(groupFilters({ ...GROUP_QUERY, limit: '1' }).limit).toBe(1);
    expect(groupFilters({ ...GROUP_QUERY, limit: String(GROUP_MAX_LIMIT) }).limit).toBe(GROUP_MAX_LIMIT);
    expect(GROUP_MAX_LIMIT).toBe(1000);
  });

  it('REFUSES outside the bounds rather than clamping, naming them', () => {
    // Same divergence from the spine's `clampLimit`, same reason as the roster: this
    // list has no cursor, so a silently changed limit changes WHICH groups are on
    // the page and `total_groups` is the only hint.
    for (const limit of ['0', '1001', 'abc', '-5', '1.5', '999999']) {
      const result = parseGroupedStatsQuery({ ...GROUP_QUERY, limit });
      expect(result.ok, `limit=${limit}`).toBe(false);
      expect(groupIssue(result, 'limit')).toContain('between 1 and 1000');
    }
  });

  it('is a HIGHER ceiling than the roster\'s, because the row count is a product', () => {
    // A `day`x`agent` matrix over a month on a floor of 30 is ~900 legitimate
    // groups, so the roster's headcount-shaped 200 would make a real screen
    // unrenderable. Asserted as a relationship rather than two numbers so the
    // reason survives a change to either.
    expect(GROUP_MAX_LIMIT).toBeGreaterThan(ROSTER_MAX_LIMIT);
    expect(GROUP_DEFAULT_LIMIT).toBeGreaterThan(ROSTER_DEFAULT_LIMIT);
  });

  it('collects every issue rather than stopping at the first', () => {
    // A caller with three mistakes should learn all three in one round trip. Note
    // the coded issue survives alongside the others — the route lifts the code onto
    // the body and still sends the whole list.
    const result = parseGroupedStatsQuery({
      from: '2026-08-17', to: '2026-08-24',
      group_by: 'day', sort: 'nope', limit: '0',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.param).sort()).toEqual(['group_by', 'limit', 'sort']);
      expect(groupCode(result)).toBe('timezone_ambiguous');
    }
  });
});

// ─── the page's single zone (02b E3) ────────────────────────────────────────

describe('groupByIsZoned: one quantifier, shared with D5\'s refusal', () => {
  it('is true for each zoned dimension and false for each unzoned one', () => {
    for (const dimension of ['day', 'day_of_week', 'hour_of_day'] as const) {
      expect(groupByIsZoned([dimension]), dimension).toBe(true);
    }
    for (const dimension of ['agent', 'campaign', 'disposition'] as const) {
      expect(groupByIsZoned([dimension]), dimension).toBe(false);
    }
  });

  it('is `some`, not `every` — a mixed pair IS cut in a zone', () => {
    // The one shape the two quantifiers disagree on, and the reason this is a named
    // function rather than an inline `some` at each of its two call sites: D5's
    // refusal and `resolved_timezone` must agree about what "zoned" means, or a
    // page gets bucketed in a zone it then declines to name.
    //
    // FALSIFICATION: `every` in `groupByIsZoned` and both pairs below report false.
    expect(groupByIsZoned(['agent', 'day'])).toBe(true);
    expect(groupByIsZoned(['campaign', 'hour_of_day'])).toBe(true);
    expect(groupByIsZoned(['agent', 'campaign'])).toBe(false);
  });
});

describe('groupedPageHasSingleZone: BOTH halves, and the second is the load-bearing one', () => {
  it('is true for every zoned dimension once ONE campaign is filtered', () => {
    for (const dimension of ['day', 'day_of_week', 'hour_of_day'] as const) {
      expect(
        groupedPageHasSingleZone({ groupBy: [dimension], campaignId: ONE_CAMPAIGN }),
        dimension,
      ).toBe(true);
    }
    // The best-hours read itself: both time dimensions, which spends the whole
    // two-dimension cap and is why that screen MUST filter a campaign.
    expect(groupedPageHasSingleZone({
      groupBy: ['day_of_week', 'hour_of_day'], campaignId: ONE_CAMPAIGN,
    })).toBe(true);
  });

  it('is FALSE for `campaign` + a time dimension with no campaign_id filter', () => {
    // ── The case the whole predicate turns on ─────────────────────────────────
    //
    // D5 accepts a time dimension on EITHER of two remedies and only ONE of them
    // narrows the read to a single zone. `group_by=campaign,hour_of_day` with no
    // filter is a legal 200 (pinned by the D5 block above, and by the route test)
    // spanning every campaign in the account — `default_timezone` is per campaign
    // with no account-level uniqueness, so those rows are cut in N zones and there
    // is no one label for the page.
    //
    // FALSIFICATION: drop the `p.campaignId !== undefined` half of
    // `groupedPageHasSingleZone` and all three of these report true — i.e. the page
    // would name ONE of several zones as though the whole matrix were cut in it,
    // which is the confidently-wrong hour axis the field exists to prevent.
    for (const groupBy of [
      ['campaign', 'day'], ['campaign', 'day_of_week'], ['campaign', 'hour_of_day'],
    ] as const) {
      expect(groupedPageHasSingleZone({ groupBy: [...groupBy] }), groupBy.join(',')).toBe(false);
    }
  });

  it('is FALSE when nothing zoned is grouped, campaign filter or not', () => {
    // Vacuous rather than convenient: one campaign is in scope, so there IS one
    // zone available — but no bucket was cut in it, so there is no zone this page's
    // buckets were cut in and the honest answer is `null`.
    //
    // FALSIFICATION: drop the `groupByIsZoned(p.groupBy)` half and the first two
    // report true.
    expect(groupedPageHasSingleZone({ groupBy: ['agent'], campaignId: ONE_CAMPAIGN })).toBe(false);
    expect(groupedPageHasSingleZone({
      groupBy: ['agent', 'disposition'], campaignId: ONE_CAMPAIGN,
    })).toBe(false);
    expect(groupedPageHasSingleZone({ groupBy: ['agent'] })).toBe(false);
  });

  it('agrees with the parser: every read it calls single-zoned is one the parser ALLOWS', () => {
    // The two rules meet on real requests rather than on hand-built params. A
    // predicate that reported "one zone" for a request D5 refuses would be
    // describing a page that cannot exist.
    const zoned = parseGroupedStatsQuery({
      ...GROUP_QUERY, group_by: 'day_of_week,hour_of_day', campaign_id: ONE_CAMPAIGN,
    });
    expect(zoned.ok).toBe(true);
    if (zoned.ok) expect(groupedPageHasSingleZone(zoned.filters)).toBe(true);

    const crossCampaign = parseGroupedStatsQuery({ ...GROUP_QUERY, group_by: 'campaign,hour_of_day' });
    expect(crossCampaign.ok).toBe(true);
    if (crossCampaign.ok) expect(groupedPageHasSingleZone(crossCampaign.filters)).toBe(false);
  });
});
