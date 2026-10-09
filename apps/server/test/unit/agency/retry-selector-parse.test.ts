import { describe, it, expect } from 'vitest';
import {
  parseContactFilters,
  parseRetrySelector,
  CONTACT_STATES,
  ATTEMPT_OUTCOMES,
  RETRY_SELECTABLE_STATES,
} from '../../../src/agency/spine-filters.js';
import type { AgencyDisposition } from '@magick-agency/contracts/agency';

// ---------------------------------------------------------------------------
// The retry selector's parse rules — the selector wire contract is FROZEN, and the
// server and the console each implement it.
//
// Every refusal in the contract's table is exercised here, because an ambiguity in that
// table becomes a defect nobody's suite catches: the server and the console are written
// against the same contract and would each be internally correct while together
// describing a selector that means two different things.
//
// The rule this file holds, restated for this surface: a selection that cannot
// match what the operator meant must be REFUSED, never silently widened or
// narrowed. On a read surface a wrong filter costs a wrong page; here it costs a
// roster of real people who do or do not get dialled.
// ---------------------------------------------------------------------------

/** A parent catalog with one operator-authored code and one relabelled built-in. */
const CATALOG: AgencyDisposition[] = [
  { code: 'not_interested', label: 'Not Interested' },
  { code: 'voicemail', label: 'Left voicemail' },
];

function issuesOf(result: ReturnType<typeof parseRetrySelector>): Record<string, string> {
  if (result.ok) throw new Error('expected a refusal, got a parsed selector');
  return Object.fromEntries(result.issues.map((i) => [i.param, i.message]));
}

function selectorOf(result: ReturnType<typeof parseRetrySelector>) {
  if (!result.ok) throw new Error(`expected a parse, got ${JSON.stringify(result.issues)}`);
  return result.filters;
}

describe('parseRetrySelector — one encoding, two transports', () => {
  it('reads a query string and a JSON body to the SAME selector', () => {
    // The whole reason there is one function: `GET /retry/preview` promises a
    // count and `POST /retry` delivers a roster. If they parsed separately they
    // would eventually disagree about what `?state=pending,connected` means, and
    // a supervisor would confirm 812 contacts and get a different set — invisible,
    // because both numbers look plausible.
    const fromQuery = selectorOf(parseRetrySelector(
      { state: 'pending,connected', last_outcome: ['no_answer', 'busy'], never_attempted: 'true', attempt_count_lte: '3' },
      { catalog: CATALOG },
    ));
    const fromBody = selectorOf(parseRetrySelector(
      { state: ['pending', 'connected'], last_outcome: ['no_answer', 'busy'], never_attempted: true, attempt_count_lte: 3 },
      { catalog: CATALOG },
    ));
    expect(fromQuery).toEqual(fromBody);
    expect(fromBody).toEqual({
      state: ['pending', 'connected'],
      last_outcome: ['no_answer', 'busy'],
      never_attempted: true,
      attempt_count_lte: 3,
    });
  });

  it('accepts every value the two closed vocabularies declare', () => {
    // `RETRY_SELECTABLE_STATES`, not `CONTACT_STATES`: `in_flight` is a real
    // contact state and is deliberately not selectable here (see the refusal
    // below). Spread from the exported constant so adding a state exercises it
    // for free rather than quietly falling out of this list.
    expect(parseRetrySelector({ state: [...RETRY_SELECTABLE_STATES] }, { catalog: [] }).ok).toBe(true);
    expect(parseRetrySelector({ last_outcome: [...ATTEMPT_OUTCOMES] }, { catalog: [] }).ok).toBe(true);
  });
});

// ── The refusal table, row by row ─────────────────────────────────────────

describe('parseRetrySelector — the frozen refusals', () => {
  it('refuses a selector that names no dimension at all, and says how to ask for everything', () => {
    // The most important refusal here. An empty `AgencyContactFilters` means "the
    // whole roster", which is the right default on a READ (the contacts page opens
    // unfiltered) and would here seed a second copy of an entire campaign from a
    // request that named nothing — with no campaign delete route in either service
    // to undo it with.
    const issues = issuesOf(parseRetrySelector({}, { catalog: CATALOG }));
    expect(issues['selector']).toBe(
      'name at least one dimension — to retry the whole roster, select every contact state',
    );
  });

  it('treats a request of only blank values as naming no dimension', () => {
    // `?state=` is what a cleared filter chip posts. Counting the KEY rather than
    // the parsed value would let it through as "a dimension was named" and return
    // the whole roster under a chip saying otherwise.
    expect(issuesOf(parseRetrySelector({ state: '', last_outcome: '  ,  ' }, { catalog: CATALOG })))
      .toHaveProperty('selector');
  });

  it.each(['dnc', 'invalid'])('refuses suppressed_reason=%s with the rule, not a vocabulary error', (reason) => {
    // DNC and invalid contacts are never retried. The message has to explain the rule: "unknown suppressed_reason: dnc"
    // invites the reader to conclude the server does not know what DNC is, when in fact
    // it knows exactly what it is and is declining to dial it.
    const issues = issuesOf(parseRetrySelector({ suppressed_reason: reason }, { catalog: CATALOG }));
    expect(issues['suppressed_reason']).toBe(
      "dnc and invalid suppressions are never retried — see the campaign's DNC list",
    );
  });

  it('refuses state=in_flight with the rule, the way the DNC rule refuses dnc', () => {
    // A contact in `in_flight` is ON A CALL right now: `claimDialable` flips the
    // state at dial, `chargeAttempt` writes the outcome at settle. Seeding it
    // into a child and starting that child dials a number the parent has an open
    // call on. Refused by name rather than left out of the vocabulary, because
    // "unknown state: in_flight" reads as the server not knowing its own states.
    // The two lists differ by exactly this one member, pinned so a future edit
    // that "tidies" `RETRY_SELECTABLE_STATES` back into `CONTACT_STATES` reds.
    expect(CONTACT_STATES).toContain('in_flight');
    expect(RETRY_SELECTABLE_STATES).not.toContain('in_flight');
    // Mid-call `connected` is excluded by the live-attempt predicate, not here:
    // wrap-up after settle is a real cohort and must stay selectable.
    expect(RETRY_SELECTABLE_STATES).toContain('connected');

    const issues = issuesOf(parseRetrySelector({ state: 'in_flight' }, { catalog: CATALOG }));
    expect(issues['state']).toBe(
      'in_flight contacts are on a call right now and are never seeded into a retry — '
      + 'retry them once their attempt settles',
    );
  });

  it('refuses the whole state list when in_flight is one of several', () => {
    // Not silently dropped from the list. A supervisor who typed it is told; the
    // alternative hands them a cohort smaller than the one they asked for with
    // nothing on screen to explain the gap.
    expect(issuesOf(parseRetrySelector({ state: 'pending,in_flight' }, { catalog: CATALOG })))
      .toHaveProperty('state');
  });

  it('still accepts the two suppressions that ARE retryable', () => {
    expect(selectorOf(parseRetrySelector(
      { suppressed_reason: 'max_attempts,manual' }, { catalog: CATALOG },
    ))).toEqual({ suppressed_reason: ['max_attempts', 'manual'] });
  });

  it('refuses a last_disposition outside the parent catalog and ECHOES the catalog', () => {
    // Echoed for the same reason `AgencyActionErrorResponse.allowed_codes` is: the
    // operator's next move is to pick a code that exists, and they cannot do that
    // unless they are told which do.
    const issues = issuesOf(parseRetrySelector(
      { last_disposition: 'not_intrested' }, { catalog: CATALOG },
    ));
    expect(issues['last_disposition']).toContain('unknown last_disposition: not_intrested');
    expect(issues['last_disposition']).toContain('not_interested');
    expect(issues['last_disposition']).toContain('voicemail');
  });

  it('accepts a BUILT-IN disposition code the parent catalog does not list', () => {
    // `callback` and `do_not_call` are written onto contacts by the disposition
    // path whether or not the operator listed them, so they are legitimately
    // present in the data being selected over.
    expect(selectorOf(parseRetrySelector(
      { last_disposition: ['callback', 'do_not_call'] }, { catalog: CATALOG },
    ))).toEqual({ last_disposition: ['callback', 'do_not_call'] });
  });

  it.each(['phone', 'from', 'to', 'limit', 'cursor'])('refuses `%s` BY NAME', (key) => {
    // These are contacts-list filters, and the supervisor reaches the retry dialog
    // from a filtered contacts list. Carrying them through and ignoring them would
    // seed a roster WIDER than the list they were looking at while the dialog still
    // showed their chips — a wider answer presented as a narrower one.
    const issues = issuesOf(parseRetrySelector(
      { state: 'pending', [key]: 'anything' }, { catalog: CATALOG },
    ));
    expect(issues[key]).toBe(`${key} is not a retry selector dimension`);
  });

  it('reports EVERY unknown key at once, not just the first', () => {
    const issues = issuesOf(parseRetrySelector(
      { phone: '+1', from: '2026-01-01' }, { catalog: CATALOG },
    ));
    expect(Object.keys(issues).sort()).toEqual(['from', 'phone']);
  });

  it('refuses never_attempted:true combined with attempt_count_gte >= 1', () => {
    const issues = issuesOf(parseRetrySelector(
      { never_attempted: true, attempt_count_gte: 1 }, { catalog: CATALOG },
    ));
    expect(issues['never_attempted']).toBe('never_attempted cannot be combined with attempt_count_gte');
  });

  it('allows never_attempted:true with attempt_count_gte: 0 — that pair is consistent', () => {
    // `attempt_count >= 0` constrains nothing, so it contradicts nothing. Refusing
    // it would turn a redundant filter into an error.
    expect(parseRetrySelector({ never_attempted: true, attempt_count_gte: 0 }, { catalog: CATALOG }).ok)
      .toBe(true);
  });

  it('refuses an inverted attempt-count range instead of matching nothing', () => {
    const issues = issuesOf(parseRetrySelector(
      { attempt_count_gte: 5, attempt_count_lte: 2 }, { catalog: CATALOG },
    ));
    expect(issues['attempt_count_gte']).toBe('must not exceed attempt_count_lte');
  });
});

// ── The two scalar readers, whose refusals the table does not cover ────────────

describe('parseRetrySelector — scalar coercion is refused, never guessed', () => {
  it.each(['yes', '1', 'TRUE', ''])('refuses never_attempted=%p rather than coercing it', (value) => {
    // A coerced boolean is a cohort the operator did not choose, and on this
    // surface a wrong cohort is a real customer dialled or not dialled. The blank
    // case is included deliberately: it is the one value that reads as "no filter",
    // and it must not silently become `false` (which now CONSTRAINS — see below).
    const result = parseRetrySelector({ state: 'pending', never_attempted: value }, { catalog: CATALOG });
    if (value === '') {
      // Blank means absent, like every other param on this surface.
      expect(selectorOf(result)).toEqual({ state: ['pending'] });
    } else {
      expect(issuesOf(result)['never_attempted']).toContain('must be true or false');
    }
  });

  it('records never_attempted:false, because it CONSTRAINS rather than clearing', () => {
    // The decision worth pinning. Reading `false` as "no constraint" would let
    // `{never_attempted:false}` alone satisfy the "name at least one dimension"
    // rule and return the whole roster — a present key that constrains nothing is
    // the dangerous reading. The repository turns this into `attempt_count > 0`.
    expect(selectorOf(parseRetrySelector({ never_attempted: false }, { catalog: CATALOG })))
      .toEqual({ never_attempted: false });
  });

  it.each([['2.5'], ['-1'], ['abc'], [2.5], [-1]])('refuses attempt_count_gte=%p', (value) => {
    const issues = issuesOf(parseRetrySelector(
      { attempt_count_gte: value }, { catalog: CATALOG },
    ));
    expect(issues['attempt_count_gte']).toBe('must be a whole number of attempts, 0 or more');
  });

  it('accepts 0 as a bound — it is a real answer, not an absent one', () => {
    expect(selectorOf(parseRetrySelector({ attempt_count_lte: 0 }, { catalog: CATALOG })))
      .toEqual({ attempt_count_lte: 0 });
  });
});

// ── The contacts-list half of the same change ─────────────────────────────

describe('parseContactFilters — last_disposition', () => {
  it('passes disposition codes through UNVALIDATED on the read surface', () => {
    // Not a `Record<TUnion, true>` vocabulary, and it cannot be one: codes are
    // operator-authored per campaign. More than that, a code RETIRED from the
    // catalog still exists on historic rows — and those are exactly the rows a
    // supervisor asking "who did we mark voicemail" is looking for. Same rule as
    // `disposition_code` on the attempt filters.
    const parsed = parseContactFilters({ last_disposition: 'a_code_no_catalog_has_now' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters.lastDispositions).toEqual(['a_code_no_catalog_has_now']);
  });

  it('accepts the repeated and comma-joined forms, like every other multi-value filter', () => {
    const parsed = parseContactFilters({ last_disposition: ['voicemail', 'callback,not_interested'] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters.lastDispositions).toEqual(['voicemail', 'callback', 'not_interested']);
  });

  it('leaves the filter absent when nothing was supplied', () => {
    const parsed = parseContactFilters({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters).not.toHaveProperty('lastDispositions');
  });
});
