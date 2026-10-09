import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RETRY_SELECTOR,
  NON_SELECTOR_CONTACT_FILTERS,
  RETRY_SELECTOR_KEYS,
  defaultRetryName,
  describeSelector,
  dispositionBucketLabel,
  droppedFilterNotice,
  isSelectorEmpty,
  mintRetryIdempotencyKey,
  outcomeBucketLabel,
  refusedValueNotice,
  retryCreatedToast,
  retryRefusalCopy,
  selectorFromContactFilters,
  selectorQueryParams,
} from '../../utils/agencyRetrySelector';
import type { AgencyContactFilters } from '../../types/agency-spine';

/**
 * The retry selector's encoding and its copy.
 *
 * What is pinned here is the wire contract's §1, not the implementation: which
 * dimensions travel, which are stripped, and that the strip is announced. Core
 * refuses the WHOLE request over an unrecognised key, so a filter leaking
 * through is not a widened cohort — it is a refused retry with a message about
 * a field the supervisor never typed.
 */

describe('phone, from and to are stripped — and said out loud', () => {
  it('carries the four selector dimensions and drops the three lookups', () => {
    const filters: AgencyContactFilters = {
      state: ['suppressed'],
      suppressed_reason: ['max_attempts'],
      last_disposition: ['voicemail'],
      last_outcome: ['no_answer'],
      phone: '98765',
      from: '2026-08-01',
      to: '2026-08-31',
    };

    const { selector, dropped } = selectorFromContactFilters(filters);

    expect(selector).toEqual({
      state: ['suppressed'],
      suppressed_reason: ['max_attempts'],
      last_disposition: ['voicemail'],
      last_outcome: ['no_answer'],
    });
    expect(dropped).toEqual(['phone', 'from', 'to']);
    // The exact keys core would 400 on must not reach the selector at all.
    for (const key of Object.keys(NON_SELECTOR_CONTACT_FILTERS)) {
      expect(Object.hasOwn(selector, key)).toBe(false);
    }
  });

  it('names each dropped filter rather than counting them', () => {
    const notice = droppedFilterNotice(['phone']);
    expect(notice).toContain('phone-number search');
    // A supervisor cannot judge "1 filter was removed" against what they meant.
    expect(notice).not.toMatch(/\b1 filter\b/);
  });

  it('says nothing when nothing was dropped', () => {
    expect(droppedFilterNotice([])).toBeNull();
  });

  it('treats a blank phone box as no filter at all', () => {
    // `?phone=` is what a cleared search box posts; reporting it as dropped
    // would put a notice on screen about a filter that was never applied.
    const { dropped } = selectorFromContactFilters({ phone: '   ' });
    expect(dropped).toEqual([]);
  });

  it('drops an empty chip group instead of sending an empty array', () => {
    // `state: []` is what a cleared chip group leaves behind, and
    // `= ANY('{}')` matches nothing — sending it would turn "I cleared that
    // filter" into "match no contacts at all".
    const { selector } = selectorFromContactFilters({ state: [], last_disposition: [] });
    expect(selector).toEqual({});
    expect(isSelectorEmpty(selector)).toBe(true);
  });

  it('copies the arrays rather than aliasing the caller’s', () => {
    const filters: AgencyContactFilters = { state: ['pending'] };
    const { selector } = selectorFromContactFilters(filters);
    selector.state?.push('suppressed');
    expect(filters.state).toEqual(['pending']);
  });
});

describe('the vocabulary is pinned in both directions', () => {
  it('lists exactly the seven dimensions core parses', () => {
    expect(Object.keys(RETRY_SELECTOR_KEYS).sort()).toEqual([
      'attempt_count_gte',
      'attempt_count_lte',
      'last_disposition',
      'last_outcome',
      'never_attempted',
      'state',
      'suppressed_reason',
    ]);
  });

  it('classifies every contact filter as carried or explicitly dropped', () => {
    const all = [
      ...Object.keys(RETRY_SELECTOR_KEYS),
      ...Object.keys(NON_SELECTOR_CONTACT_FILTERS),
    ];
    // The compile-time pin is the real guard; this asserts the two lists are
    // disjoint, which the type system does not say.
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('the query encoding', () => {
  it('sends multi-value keys as repeated params', () => {
    const params = selectorQueryParams({ last_outcome: ['no_answer', 'busy'] });
    expect(params.getAll('last_outcome')).toEqual(['no_answer', 'busy']);
    expect(params.toString()).toBe('last_outcome=no_answer&last_outcome=busy');
  });

  it('sends never_attempted only when true', () => {
    expect(selectorQueryParams({ never_attempted: true }).get('never_attempted')).toBe('true');
    // `false` constrains nothing, so sending it would put a key in the frozen
    // record that describes no part of the roster.
    expect(selectorQueryParams({ never_attempted: false }).has('never_attempted')).toBe(false);
  });

  it('sends a zero attempt bound, which is a real bound', () => {
    const params = selectorQueryParams({ attempt_count_lte: 0 });
    expect(params.get('attempt_count_lte')).toBe('0');
  });

  it('encodes the default selection as the contract writes it', () => {
    const params = selectorQueryParams(DEFAULT_RETRY_SELECTOR);
    expect(params.getAll('last_outcome')).toEqual(['no_answer', 'busy', '__none__']);
    // `never_attempted` is NOT sent: it is expressed as the `__none__` member of
    // the outcome dimension, because as a separate key it would AND rather than
    // OR and the cohort would be empty.
    expect(params.has('never_attempted')).toBe(false);
  });
});

describe('the default selection offered from the campaign header', () => {
  it('is the uncontroversial "we did not reach them" set and nothing else', () => {
    // ⚠️ ONE dimension, three members. The pair this replaced —
    // `last_outcome: [...]` AND `never_attempted: true` — is UNSATISFIABLE: the
    // algebra ANDs across keys and a contact with no attempts has a NULL
    // outcome, so the header's Retry button matched nothing on every campaign.
    // Proven against Postgres in core's `agency-retry-seeding` integration test.
    expect(DEFAULT_RETRY_SELECTOR).toEqual({
      last_outcome: ['no_answer', 'busy', '__none__'],
    });
    // The dimensions must not be split apart again.
    expect(DEFAULT_RETRY_SELECTOR.never_attempted).toBeUndefined();
    // Everything else is opt-in: a suppressed state or a disposition is a
    // decision, not a default.
    expect(DEFAULT_RETRY_SELECTOR.suppressed_reason).toBeUndefined();
    expect(DEFAULT_RETRY_SELECTOR.state).toBeUndefined();
    expect(DEFAULT_RETRY_SELECTOR.last_disposition).toBeUndefined();
  });
});

describe('disposition bucket labels', () => {
  const catalog = [{ code: 'ptp', label: 'PTP' }];

  it('names a code from the campaign’s own catalog', () => {
    expect(dispositionBucketLabel('ptp', catalog)).toBe('PTP');
  });

  it('renders the NULL bucket as words, never as its key', () => {
    expect(dispositionBucketLabel('__none__', catalog)).toBe('Never written up');
  });

  it('falls back to the code, which is exactly the bucket an audit is about', () => {
    expect(dispositionBucketLabel('retired_code', catalog)).toBe('retired_code');
  });
});

describe('the cohort, in words', () => {
  it('names dispositions by their labels', () => {
    const words = describeSelector({ last_disposition: ['ptp'] }, [{ code: 'ptp', label: 'PTP' }]);
    expect(words).toContain('PTP');
  });

  it('describes the default selection in the console’s own outcome copy', () => {
    const words = describeSelector(DEFAULT_RETRY_SELECTOR, []);
    expect(words).toContain('no answer');
    expect(words).toContain('busy');
    expect(words).toContain('never dialed at all');
  });

  it('says so plainly when nothing is selected', () => {
    expect(describeSelector({}, [])).toBe('No cohort is selected yet.');
  });
});

describe('isSelectorEmpty', () => {
  it('is true for a selector naming no dimension', () => {
    expect(isSelectorEmpty({})).toBe(true);
  });

  it('is false for a bound of zero', () => {
    // `attempt_count_lte: 0` is "never dialed" said another way — a real
    // dimension, and `!0` would have swallowed it.
    expect(isSelectorEmpty({ attempt_count_lte: 0 })).toBe(false);
  });

  it('is false for never_attempted', () => {
    expect(isSelectorEmpty({ never_attempted: true })).toBe(false);
  });
});

describe('the default name', () => {
  it('follows core’s own default', () => {
    expect(defaultRetryName('Q3 Winback', 0)).toBe('Q3 Winback — Retry 1');
  });

  it('counts from the parent’s generation, so a retry of a retry is Retry 2', () => {
    expect(defaultRetryName('Q3 Winback — Retry 1', 1)).toBe('Q3 Winback — Retry 1 — Retry 2');
  });
});

describe('the three 409 refusals', () => {
  it('tells an empty selection why it may be empty', () => {
    const copy = retryRefusalCopy('retry_selection_empty');
    expect(copy).toContain('Do Not Call');
    // Nothing was created, and the supervisor has to know that before they
    // go looking for a draft campaign.
    expect(copy).toMatch(/no campaign was created/i);
  });

  it('names the count and the cap when both are known', () => {
    const copy = retryRefusalCopy('retry_selection_too_large', {
      matched: 250_000,
      maxSeedRows: 100_000,
    });
    expect(copy).toContain('250,000');
    expect(copy).toContain('100,000');
  });

  it('omits the numbers rather than printing an undefined one', () => {
    const copy = retryRefusalCopy('retry_selection_too_large', {});
    expect(copy).not.toContain('undefined');
    expect(copy).toContain('Narrow the selection');
  });

  it('returns null for a code this build has not heard of, so core’s own message stands', () => {
    expect(retryRefusalCopy('something_new_from_core')).toBeNull();
  });
});

describe('the success toast', () => {
  const CHILD = { id: 'camp-child', name: 'Q3 Winback — Retry 1' } as never;

  it('names the campaign and the count it actually seeded', () => {
    const copy = retryCreatedToast({
      campaign: CHILD, contacts_seeded: 812, excluded: { dnc: 14, invalid: 3 },
    });
    expect(copy).toContain('Q3 Winback — Retry 1');
    expect(copy).toContain('812');
  });

  it('says "already created" on a replay, and claims NO count', () => {
    // The replay carries `contacts_seeded: null` because this request seeded
    // nothing. Any number here would be a fabricated fact about a transaction
    // that never ran — and the supervisor is reading this precisely because they
    // could not tell whether the first attempt worked.
    // A digit-free name, so "carries no number" is a claim about the SENTENCE
    // rather than about the campaign's name — `Q3 Winback — Retry 1` has three.
    const copy = retryCreatedToast({
      campaign: { id: 'camp-child', name: 'Winback Redial' } as never,
      idempotent_replay: true, contacts_seeded: null, excluded: null,
    });
    expect(copy).toMatch(/already/i);
    expect(copy).not.toMatch(/\d/);
    expect(copy).not.toMatch(/contact/i);
  });

  it('never renders NaN when the count is absent without the flag', () => {
    // Belt and braces on the one failure mode of the old inline copy:
    // `null.toLocaleString()` throws and `undefined` renders as `NaN`, both in
    // a success toast, on the surface with no undo.
    const copy = retryCreatedToast({
      campaign: CHILD, contacts_seeded: null, excluded: null,
    });
    expect(copy).not.toContain('NaN');
  });

  it('explains a roster smaller than the preview, when duplicates were merged', () => {
    // The preview showed a larger number a moment ago. Without this clause the
    // supervisor sees the gap and cannot tell a duplicate collapse from rows
    // lost to a bug — which decides whether they carry on or raise a ticket.
    const copy = retryCreatedToast({
      campaign: CHILD, contacts_seeded: 809, duplicates_collapsed: 3,
      excluded: { dnc: 14, invalid: 3 },
    });
    expect(copy).toContain('809 contacts');
    expect(copy).toContain('3 duplicates were merged');
  });

  it('says nothing about duplicates when none were merged, or when the field is absent', () => {
    // A `0` clause on every successful retry is a caveat that trains the reader
    // to skip it. And an ABSENT field is an older core saying nothing, not a
    // measured zero — claiming "no duplicates were merged" off it would be a
    // fact this build cannot know.
    const zero = retryCreatedToast({
      campaign: CHILD, contacts_seeded: 812, duplicates_collapsed: 0,
      excluded: { dnc: 0, invalid: 0 },
    });
    const absent = retryCreatedToast({
      campaign: CHILD, contacts_seeded: 812, excluded: { dnc: 0, invalid: 0 },
    });
    expect(zero).not.toMatch(/duplicate/i);
    expect(absent).not.toMatch(/duplicate/i);
  });

  it('says "1 contact", not "1 contacts"', () => {
    const copy = retryCreatedToast({
      campaign: CHILD, contacts_seeded: 1, excluded: { dnc: 0, invalid: 0 },
    });
    expect(copy).toContain('1 contact.');
  });
});

describe('the idempotency key', () => {
  it('is a fresh value on every call, within core’s accepted shape', () => {
    // A mint that returned a constant would look like protection and provide
    // none — the second supervisor to open the dialog would replay the first's
    // campaign, and the second campaign nobody wanted would never be created.
    const keys = new Set([
      mintRetryIdempotencyKey(),
      mintRetryIdempotencyKey(),
      mintRetryIdempotencyKey(),
    ]);
    expect(keys.size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^[A-Za-z0-9_.:-]{16,64}$/);
  });
});

describe('describeSelector — the conjunction is core\'s algebra, not a guess', () => {
  it('joins SEPARATE dimensions with "and", because core ANDs them', () => {
    // This read "…, or …" and therefore described a different — and always
    // wider — cohort than the one that will be seeded. `{state:['exhausted'],
    // last_disposition:['callback']}` is the INTERSECTION; rendered as a union,
    // a supervisor expects both groups, sees a much smaller matched count, and
    // reasonably concludes the preview is broken.
    const sentence = describeSelector(
      { state: ['exhausted'], last_disposition: ['callback'] },
      [{ code: 'callback', label: 'Callback' }],
    );
    expect(sentence).toContain(' and ');
    expect(sentence).not.toContain(', or ');
  });

  it('joins values WITHIN one dimension with "or", because core ORs them', () => {
    const sentence = describeSelector({ last_outcome: ['no_answer', 'busy'] }, []);
    expect(sentence).toContain(' or ');
    expect(sentence).not.toContain(' and ');
  });

  it('nests correctly when a dimension has alternatives AND a sibling dimension', () => {
    // `(no answer OR never dialed) AND sitting at pending`. Both conjunctions
    // are present, and each clause opens with its own verb phrase so the "or"
    // is visibly inside one of them.
    const sentence = describeSelector(
      { last_outcome: ['no_answer', '__none__'], state: ['pending'] },
      [],
    );
    expect(sentence).toContain(' or ');
    expect(sentence).toContain(', and ');
    expect(sentence).not.toContain('__none__');
  });

  it('reads as a single clause when only one dimension is named', () => {
    const sentence = describeSelector({ state: ['exhausted'] }, []);
    expect(sentence).not.toContain(' and ');
    expect(sentence).not.toContain(' or ');
  });
});

describe('selectorFromContactFilters — values core refuses never reach the wire', () => {
  it('strips dnc and invalid but keeps the retryable suppressions', () => {
    // As VALUES, not as a key. `{suppressed_reason:['dnc','max_attempts']}` is a
    // legitimate half-intent, and dropping the whole dimension would widen the
    // cohort rather than narrow it.
    const { selector, droppedValues } = selectorFromContactFilters({
      suppressed_reason: ['dnc', 'max_attempts', 'invalid'],
    });
    expect(selector.suppressed_reason).toEqual(['max_attempts']);
    expect(droppedValues).toEqual(['dnc', 'invalid']);
  });

  it('omits the dimension entirely when the strip empties it', () => {
    // NOT `suppressed_reason: []`. An empty `= ANY('{}')` matches nothing, so
    // sending it turns "I filtered on DNC" into "match no contacts at all" —
    // and the supervisor is looking at an empty preview instead of a sentence
    // explaining why.
    const { selector, droppedValues } = selectorFromContactFilters({
      suppressed_reason: ['dnc'],
    });
    expect(selector).not.toHaveProperty('suppressed_reason');
    expect(droppedValues).toEqual(['dnc']);
  });

  it('strips in_flight from the state dimension', () => {
    // Core refuses it by name: the contact is on a call right now, and seeding
    // it into a child that then starts would dial a number the parent has an
    // open call on.
    const { selector, droppedValues } = selectorFromContactFilters({
      state: ['pending', 'in_flight'],
    });
    expect(selector.state).toEqual(['pending']);
    expect(droppedValues).toEqual(['in_flight']);
  });

  it('leaves an ordinary selection untouched and reports nothing dropped', () => {
    const { selector, droppedValues } = selectorFromContactFilters({
      state: ['exhausted'],
      suppressed_reason: ['max_attempts', 'manual'],
    });
    expect(selector).toEqual({ state: ['exhausted'], suppressed_reason: ['max_attempts', 'manual'] });
    expect(droppedValues).toEqual([]);
  });
});

describe('refusedValueNotice', () => {
  it('names DNC in words a supervisor recognises, never the raw value', () => {
    const notice = refusedValueNotice(['dnc'])!;
    expect(notice).toContain('Do Not Call');
    expect(notice).not.toContain('dnc');
  });

  it('lists several with an "and", and says they can never be retried', () => {
    const notice = refusedValueNotice(['dnc', 'invalid', 'in_flight'])!;
    expect(notice).toContain(' and ');
    expect(notice).toContain('never be retried');
  });

  it('is null when nothing was refused, so no empty note renders', () => {
    expect(refusedValueNotice([])).toBeNull();
  });
});

describe('outcomeBucketLabel', () => {
  it('renders the NULL-outcome bucket key as words', () => {
    expect(outcomeBucketLabel('__none__')).toBe('Never dialed');
  });

  it('leaves a real outcome to the shared copy table', () => {
    expect(outcomeBucketLabel('no_answer')).not.toBe('__none__');
    expect(outcomeBucketLabel('no_answer').length).toBeGreaterThan(0);
  });
});
