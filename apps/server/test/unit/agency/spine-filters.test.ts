import { describe, it, expect } from 'vitest';
import {
  ATTEMPT_OUTCOMES,
  ATTEMPT_STATES,
  CONTACT_STATES,
  SPINE_DEFAULT_LIMIT,
  SPINE_MAX_LIMIT,
  clampLimit,
  multiParam,
  singleParam,
  parseAttemptFilters,
  parseContactFilters,
  parsePhoneFilter,
} from '../../../src/agency/spine-filters.js';

// ---------------------------------------------------------------------------
// MAG-159 — query parsing for the supervisor read surface.
//
// The rule this file exists to hold: on THIS surface an empty result set is
// read as a fact about the campaign ("we never dialled anyone", "nothing was
// suppressed"), not as a fact about the query. So every input that cannot match
// has to be refused loudly instead of passed through to return nothing.
// ---------------------------------------------------------------------------

describe('multi-value params', () => {
  it('accepts repeats and comma-separated forms identically', () => {
    expect(multiParam(['connected', 'busy'])).toEqual(['connected', 'busy']);
    expect(multiParam('connected,busy')).toEqual(['connected', 'busy']);
    expect(multiParam(['connected,busy', 'failed'])).toEqual(['connected', 'busy', 'failed']);
  });

  it('treats blank and whitespace-only as absent, not as a filter on ""', () => {
    expect(multiParam('')).toBeUndefined();
    expect(multiParam('  ,  ')).toBeUndefined();
    expect(multiParam(undefined)).toBeUndefined();
  });

  it('singleParam treats an explicit null as absent, not as the string "null"', () => {
    // The same `raw === null` arm, on the single-value reader. Without it,
    // `String(null)` is the four-character string `"null"` — truthy, length 4 —
    // and every caller downstream believes a value was supplied. The visible
    // damage differs per caller and none of it is good: `?contact_id=null` 400s
    // with "must be a contact id" instead of being no filter at all, and on the
    // agent-record surface `?from=null` stops being "is required" and becomes
    // "must be an ISO-8601 date", which points the caller at a format problem
    // when what they actually did was omit a required bound.
    expect(singleParam(null)).toBeUndefined();
    expect(singleParam(undefined)).toBeUndefined();
    expect(singleParam('  ')).toBeUndefined();
    // And it is still the FIRST element of a repeat, trimmed.
    expect(singleParam([' u-ravi ', 'u-other'])).toBe('u-ravi');
    // The route-level consequence, on the parser that has REQUIRED bounds.
    const parsed = parseAttemptFilters({ contact_id: null });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.hasOwn(parsed.filters, 'contactId')).toBe(false);
  });

  it('treats an explicit null as absent too', () => {
    // Not a hypothetical shape: Fastify's query parser can yield `null` for a
    // parameter, and `String(null)` is the four-character string `"null"` — which
    // would reach `validateEnum` as an unknown outcome and turn a
    // no-filter-supplied request into a 400 reading `unknown outcome: null`. The
    // `raw === null` arm of the guard is what stops that, and nothing exercised it.
    expect(multiParam(null)).toBeUndefined();
    expect(parseAttemptFilters({ outcome: null }).ok).toBe(true);
    expect(parseContactFilters({ state: null }).ok).toBe(true);
  });
});

describe('enum validation', () => {
  it('refuses an unknown outcome rather than returning an empty page', () => {
    const parsed = parseAttemptFilters({ outcome: 'connceted' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]?.param).toBe('outcome');
    // The valid set is echoed, so a client can correct itself.
    expect(parsed.issues[0]?.message).toContain('connected');
  });

  it('refuses an unknown contact state and an unknown suppressed_reason', () => {
    expect(parseContactFilters({ state: 'supressed' }).ok).toBe(false);
    expect(parseContactFilters({ suppressed_reason: 'gdpr' }).ok).toBe(false);
  });

  it('accepts every value the contract declares', () => {
    expect(parseAttemptFilters({ state: [...ATTEMPT_STATES] }).ok).toBe(true);
    expect(parseAttemptFilters({ outcome: [...ATTEMPT_OUTCOMES] }).ok).toBe(true);
    expect(parseContactFilters({ state: [...CONTACT_STATES] }).ok).toBe(true);
  });

  it('`canceled` is in the vocabulary and filterable by name', () => {
    // The spread above is self-fulfilling — it accepts whatever the vocabulary
    // happens to hold, so it stays green on a MISSING member. The `Record<TUnion,
    // true>` in `spine-filters.ts` is what makes an omission a build error, and
    // this is the behavioural half: the literal a supervisor types.
    //
    // Why it matters more here than for most members: these are the rows that
    // REPLACED the pilot's ~19 phantom `abandoned` attempts. An unfilterable
    // outcome excludes nothing from any query — it simply becomes invisible to
    // the read surface — so the audit that motivated the whole change would come
    // back with a 400 calling a live outcome unknown.
    expect(ATTEMPT_OUTCOMES).toContain('canceled');
    expect(parseAttemptFilters({ outcome: 'canceled' }).ok).toBe(true);
    // And on the contacts side, where it is the retry selector's dimension.
    expect(parseContactFilters({ last_outcome: 'canceled' }).ok).toBe(true);
    // Not silently accepted as a near-miss: `cancelled` (the British spelling,
    // which master's own `NON_BILLABLE_STATUSES` happens to use) is NOT this
    // outcome, and a filter that quietly matched nothing would read as "no such
    // calls" rather than "no such outcome".
    expect(parseAttemptFilters({ outcome: 'cancelled' }).ok).toBe(false);
  });

  it('does NOT validate disposition_code — the catalog is per campaign and retired codes still exist on old rows', () => {
    const parsed = parseAttemptFilters({ disposition_code: 'a_code_no_catalog_has_now' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters.dispositionCodes).toEqual(['a_code_no_catalog_has_now']);
  });
});

describe('date range', () => {
  it('refuses an inverted range instead of silently matching nothing', () => {
    const parsed = parseAttemptFilters({ from: '2026-08-10T00:00:00Z', to: '2026-08-01T00:00:00Z' });
    expect(parsed.ok).toBe(false);
  });

  it('refuses an unparseable date', () => {
    expect(parseContactFilters({ from: 'last tuesday' }).ok).toBe(false);
  });

  it('accepts the two forms a caller actually sends', () => {
    // A date picker posts the first; code posts the second.
    const dateOnly = parseAttemptFilters({ from: '2026-08-17' });
    expect(dateOnly.ok).toBe(true);
    if (dateOnly.ok) expect(dateOnly.filters.from?.toISOString()).toBe('2026-08-17T00:00:00.000Z');

    const offset = parseAttemptFilters({ from: '2026-08-17T09:00:00+05:30' });
    expect(offset.ok).toBe(true);
    if (offset.ok) expect(offset.filters.from?.toISOString()).toBe('2026-08-17T03:30:00.000Z');
  });

  /**
   * Each of these was accepted by the bare `new Date(value)` this used to be,
   * and each produces a REAL, plausible, differently-bounded result set — the
   * range moves and nothing on screen says so.
   */
  it.each([
    ['2026-08-17T09:00:00', 'no offset — parsed against the server\u2019s TZ'],
    ['17 Aug 2026', 'not ISO-8601 at all, despite the error message promising it'],
    ['2026-02-30', 'rolled forward to March 2nd rather than refused'],
    ['August 30, 2026 10:00', 'legacy V8 fallback grammar'],
    ['0000-08-17T00:00:00Z', 'year zero'],
  ])('refuses %s (%s)', (value) => {
    expect(parseAttemptFilters({ from: value }).ok).toBe(false);
    expect(parseContactFilters({ to: value }).ok).toBe(false);
  });

  it('names the offending param, so the 400 says which field to fix', () => {
    const parsed = parseAttemptFilters({ to: '2026-02-30' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.map((i) => i.param)).toContain('to');
  });
});

describe('phone filter', () => {
  it('a pasted E.164 is an exact match — the form an index can serve', () => {
    expect(parsePhoneFilter('+91 98765 43210')).toEqual({ mode: 'exact', value: '+919876543210' });
  });

  it('bare digits are a suffix match — what typing the last four means', () => {
    expect(parsePhoneFilter('3210')).toEqual({ mode: 'suffix', value: '3210' });
  });

  it('distinguishes "nothing typed" from "typed, but no digits"', () => {
    // Blank is genuinely no filter — it is what a cleared search box posts.
    expect(parsePhoneFilter('   ')).toBeUndefined();
    expect(parsePhoneFilter(undefined)).toBeUndefined();
    // Punctuation, a wildcard, a name, an emoji: something WAS typed and it
    // cannot be a phone number. Folding this into `undefined` drops the
    // predicate and returns the whole campaign — see the route test below.
    expect(parsePhoneFilter('()-')).toBe('unusable');
    expect(parsePhoneFilter('%')).toBe('unusable');
    expect(parsePhoneFilter('Priya')).toBe('unusable');
    expect(parsePhoneFilter('\u{1F4DE}')).toBe('unusable');
  });
});

describe('a filter that cannot match is refused, never dropped', () => {
  // ── The failure this guards ────────────────────────────────────────────────
  // A dropped predicate returns MORE rows than the query asked for, under a
  // chip that still reads `phone: Priya`. On this surface the reader takes an
  // answer as a fact about the campaign, so "wider, presented as narrower" is
  // the worst available outcome — worse than an error, which at least says so.
  it('refuses a phone filter with no digits, on both lists', () => {
    for (const parse of [parseAttemptFilters, parseContactFilters]) {
      const parsed = parse({ phone: 'Priya' });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.issues[0]?.param).toBe('phone');
      expect(parsed.issues[0]?.message).toContain('digit');
    }
  });

  it('still treats a blank phone box as no filter', () => {
    const parsed = parseAttemptFilters({ phone: '  ' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters.phone).toBeUndefined();
  });

  it('refuses a contact_id that is not a contact id', () => {
    // It reaches SQL as `$n::uuid`, so an unvalidated value is `22P02` —
    // which nothing maps to a status and therefore surfaces as a 500 with the
    // database's error text. The console puts this param in the URL itself
    // (the drill-down link), so a stale or hand-edited one is ordinary.
    const parsed = parseAttemptFilters({ contact_id: 'not-a-uuid' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]?.param).toBe('contact_id');
  });

  it('accepts a well-formed contact_id', () => {
    const id = '3f2a1b0c-1111-4222-8333-444455556666';
    const parsed = parseAttemptFilters({ contact_id: id });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters.contactId).toBe(id);
  });

  it('reports a bad phone AND a bad contact_id together, not one at a time', () => {
    // Both are parsed before the early return; a validator that ran after it
    // could never report anything.
    const parsed = parseAttemptFilters({ phone: 'abc', contact_id: 'xyz' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.map((i) => i.param).sort()).toEqual(['contact_id', 'phone']);
  });
});

describe('limit clamping', () => {
  it('defaults, floors and ceilings', () => {
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit('0')).toBe(1);
    expect(clampLimit('-5')).toBe(1);
    expect(clampLimit('100000')).toBe(500);
    expect(clampLimit('abc')).toBe(50);
    expect(clampLimit('75')).toBe(75);
  });

  /**
   * The BOUNDARIES, not just a value each side of them.
   *
   * The test above pins `0 → 1` and `100000 → 500`, and both of those survive a
   * `Math.min(Math.max(…))` written with the comparisons off by one in either
   * direction: `<` for `<=`, `SPINE_MAX_LIMIT - 1` for `SPINE_MAX_LIMIT`. What
   * that costs is not academic — the ceiling is the EXPORT's page size too (the
   * routes say so), so an off-by-one there silently changes how many rows a
   * supervisor's CSV carries per request, and the only symptom is a page that
   * ends one row early.
   *
   * So the three values that actually define the clamp get named: the smallest
   * accepted, the largest accepted, and the first one refused.
   */
  it('accepts exactly 1 and exactly 500, and refuses 501 down to 500', () => {
    expect(clampLimit('1')).toBe(1);
    expect(clampLimit(String(SPINE_MAX_LIMIT))).toBe(SPINE_MAX_LIMIT);
    expect(clampLimit(String(SPINE_MAX_LIMIT + 1))).toBe(SPINE_MAX_LIMIT);
    // Pinned against the constants rather than the literals, so a deliberate
    // change to the page size moves this test with it instead of failing it —
    // while an accidental off-by-one in the clamp still fails.
    expect(SPINE_MAX_LIMIT).toBe(500);
    expect(SPINE_DEFAULT_LIMIT).toBe(50);
  });

  it('floors a fractional limit rather than handing SQL a non-integer LIMIT', () => {
    // `?limit=50.9` reaches `LIMIT $n` as a bound parameter. Postgres refuses a
    // non-integer there (`22P02`/`42804` depending on the cast), which nothing
    // maps to a status — so it would surface as a 500 on a value a client could
    // produce by dividing a page count. `Math.floor` is what keeps it an integer,
    // and it must floor rather than round: `Math.round(0.4)` is 0, which the
    // lower clamp then lifts to 1 anyway, but `Math.round(500.6)` is 501 and the
    // upper clamp catches it — so only the flooring itself proves the intent.
    expect(clampLimit('50.9')).toBe(50);
    expect(clampLimit('1.9')).toBe(1);
    expect(Number.isInteger(clampLimit('0.5'))).toBe(true);
  });

  it('treats a blank limit box as absent, and an infinity as unparseable', () => {
    // `?limit=` is what a cleared field posts; `singleParam` reads it as absent
    // and the default applies. `Infinity` parses as a finite-looking Number that
    // is not finite, and `Math.min(Math.max(Math.floor(Infinity), 1), 500)` would
    // in fact yield 500 — so the `Number.isFinite` guard is what makes the
    // default the answer instead of silently serving the maximum page.
    expect(clampLimit('')).toBe(SPINE_DEFAULT_LIMIT);
    expect(clampLimit('   ')).toBe(SPINE_DEFAULT_LIMIT);
    expect(clampLimit('Infinity')).toBe(SPINE_DEFAULT_LIMIT);
    expect(clampLimit('NaN')).toBe(SPINE_DEFAULT_LIMIT);
    // A repeated param takes the first, via `singleParam` — not `String([..])`,
    // which would produce `"25,99"` and parse as NaN.
    expect(clampLimit(['25', '99'])).toBe(25);
  });
});

describe('KNOWN GAP: the roll-forward refusal only covers the date-ONLY form', () => {
  /**
   * ── This test documents a defect, and deliberately pins the current behaviour ─
   *
   * `parseFilterDate`'s docstring lists three refusals, the third being "an
   * impossible date is rolled forward, not refused. `2026-02-30` becomes March
   * 2nd, so a typo returns a real, plausible, differently-bounded result set with
   * nothing on screen to say the range moved."
   *
   * The guard that enforces it is
   *
   *     if (dateOnly && parsed.toISOString().slice(0, 10) !== value)
   *
   * and the `dateOnly &&` means the round-trip comparison NEVER RUNS for the
   * date-TIME form. So `2026-02-30` is refused and `2026-02-30T00:00:00Z` — the
   * same impossible day, in the form the docstring says code posts — is accepted
   * and silently becomes March 2nd. The in-code comment beside the guard says the
   * comparison is "on the DATE part only, so that an offset form is checked
   * against its own local reading rather than against the UTC instant it converts
   * to", which reads as an intent to check the offset form; the `dateOnly &&`
   * prevents it.
   *
   * Pinned rather than fixed here because a fix is a behaviour change on a shared
   * parser used by four routes (both agency spines and both agent-record reads),
   * and it belongs in a change that can say so in its title. Pinned rather than
   * omitted because the alternative is that the gap stays invisible: the suite
   * currently asserts the date-only refusal and nothing distinguishes it from a
   * refusal that covers both forms.
   *
   * **If a later change closes this, these expectations flip to `false` and this
   * block is what tells you the fix landed.** Change it then; do not widen it.
   */
  it.each([
    '2026-02-30T00:00:00Z',
    '2026-02-30T09:00:00+05:30',
    '2026-04-31T12:00:00Z',
  ])('accepts %s and rolls it forward, where the date-only form is refused', (value) => {
    const dateOnly = value.slice(0, 10);
    // The documented, working half.
    expect(parseAttemptFilters({ from: dateOnly }).ok).toBe(false);

    // The half the guard skips.
    const parsed = parseAttemptFilters({ from: value });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // It did not merely pass — it moved. The window a caller gets back is bounded
    // by a day they did not ask for and cannot see.
    expect(parsed.filters.from?.toISOString().slice(0, 10)).not.toBe(dateOnly);
  });

  it('still refuses a date-time whose calendar fields cannot be a date at all', () => {
    // The other arm of the same block — `Number.isNaN(parsed.getTime())` — is not
    // gated on `dateOnly`, so a month or day outside the calendar's range is
    // refused in BOTH forms. `2026-02-30` rolls forward (a real instant); month 13
    // and day 32 do not exist at all and `new Date` answers Invalid Date. That
    // arm is what keeps this gap a shifted window rather than a NaN reaching SQL.
    for (const value of ['2026-13-01', '2026-13-01T00:00:00Z', '2026-08-32', '2026-00-10']) {
      expect(parseAttemptFilters({ from: value }).ok, value).toBe(false);
    }
  });
});
