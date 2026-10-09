import { describe, it, expect } from 'vitest';
import {
  ATTEMPT_RANGE_NOTE,
  attemptDateRange,
  attemptFilterGroupCount,
  isAttemptFiltered,
  isInvertedDayRange,
  observedDispositionCodes,
} from '../../utils/agencyAttemptFilters';

/**
 * The filter arithmetic behind the cross-campaign attempt lists.
 *
 * ── What is worth pinning here ─────────────────────────────────────────────
 * Three properties, each of which would be a silent wrong answer rather than a
 * visible failure:
 *
 *  1. **`to` is INCLUSIVE** — the opposite of `/my-stats`'s exclusive end, which
 *     is one link away on the performance page. Getting it wrong drops the last
 *     day of every range, and on a one-day range that is the entire result,
 *     presented to the reader as "you took no calls".
 *  2. **An empty filter is not a filter.** `isAttemptFiltered` decides whether an
 *     empty result is a fact about the QUERY or a fact about the PERSON, and
 *     `AgencyCampaignAttemptsPage` shipped the wrong answer once by omitting a
 *     key from its own version of this check.
 *  3. **The disposition-code list is a suggestion, never a catalog.** Codes are
 *     operator-configured free text held per campaign; this list spans many
 *     campaigns, so no complete set exists client-side.
 */

describe('attemptDateRange — the inclusive end', () => {
  it('ends the range at the last millisecond of the chosen day', () => {
    // The off-by-one this closes: `T00:00:00` on the `to` day drops every call
    // made after midnight on the last day of the range.
    const range = attemptDateRange('2026-08-01', '2026-08-03');
    expect(new Date(range.to!).getHours()).toBe(23);
    expect(new Date(range.to!).getMinutes()).toBe(59);
    expect(new Date(range.to!).getMilliseconds()).toBe(999);
  });

  it('starts the range at the first instant of the chosen day', () => {
    const range = attemptDateRange('2026-08-01', '');
    expect(new Date(range.from!).getHours()).toBe(0);
    expect(new Date(range.from!).getMinutes()).toBe(0);
  });

  it('keeps a one-day range from being an empty range', () => {
    /**
     * The whole point, stated as the case that would break. "Show me the 3rd" is
     * `from` and `to` on the same day, and with an exclusive end it matches
     * nothing at all.
     */
    const range = attemptDateRange('2026-08-03', '2026-08-03');
    expect(new Date(range.to!).getTime()).toBeGreaterThan(new Date(range.from!).getTime());
  });

  it('sends nothing for a day that was not chosen', () => {
    // A blank date must be absent from the query, not present and empty: an empty
    // `from` reads as a filter matching nothing rather than as no filter.
    expect(attemptDateRange('', '')).toEqual({});
    expect(attemptDateRange('2026-08-01', '')).not.toHaveProperty('to');
    expect(attemptDateRange('', '2026-08-01')).not.toHaveProperty('from');
  });

  it('is built from LOCAL midnight, not UTC midnight', () => {
    // Somebody picking "3 August" means their own 3rd of August, the same zone
    // the table's timestamps are formatted in.
    const range = attemptDateRange('2026-08-03', '2026-08-03');
    expect(new Date(range.from!).getDate()).toBe(3);
    expect(new Date(range.to!).getDate()).toBe(3);
  });
});

describe('ATTEMPT_RANGE_NOTE — the copy that stops a wrong assumption', () => {
  it('says both dates are included', () => {
    // The reader's only chance to learn the convention before they notice a row
    // missing — which is the one way of finding out that also costs them their
    // trust in the rest of the list.
    expect(ATTEMPT_RANGE_NOTE).toMatch(/included/i);
  });

  it('does NOT borrow the performance page’s period vocabulary', () => {
    /**
     * `/my-stats` selects named periods with an EXCLUSIVE end on `dialed_at`.
     * Using its words here would put one label over two meanings on two screens a
     * link apart, which is worse than two different words for two different
     * things.
     */
    expect(ATTEMPT_RANGE_NOTE).not.toMatch(/\bthis week\b|\bthis month\b/i);
  });

  it('says the range is about when the call was created, not dialled', () => {
    // `created_at`, not `dialed_at`, because `dialed_at` is null on an attempt
    // that never reached the carrier — and filtering a LIST on a nullable column
    // silently drops exactly the rows the list exists to surface.
    expect(ATTEMPT_RANGE_NOTE).toMatch(/created/i);
  });
});

describe('isInvertedDayRange', () => {
  it('catches an end before a start', () => {
    expect(isInvertedDayRange('2026-08-10', '2026-08-01')).toBe(true);
  });

  it('allows a single day', () => {
    expect(isInvertedDayRange('2026-08-03', '2026-08-03')).toBe(false);
  });

  it('is silent while only one end has been picked', () => {
    // Half a range is a range being typed, not a mistake to shout about.
    expect(isInvertedDayRange('2026-08-10', '')).toBe(false);
    expect(isInvertedDayRange('', '2026-08-01')).toBe(false);
  });
});

describe('isAttemptFiltered — whether an empty result is about the query', () => {
  it('is false for no filters at all', () => {
    expect(isAttemptFiltered({})).toBe(false);
  });

  it('is false for filters left empty rather than set', () => {
    // An empty array and an empty string are a control nobody touched. Counting
    // them would tell somebody who has never filtered anything that their empty
    // result is the filter's fault.
    expect(isAttemptFiltered({ outcome: [], state: [], disposition_code: [] })).toBe(false);
  });

  it.each([
    ['outcome', { outcome: ['abandoned'] }],
    ['state', { state: ['ended'] }],
    ['disposition code', { disposition_code: ['not_interested'] }],
    ['campaign', { campaign_id: 'camp-1' }],
    ['from', { from: '2026-08-01T00:00:00.000Z' }],
    ['to', { to: '2026-08-03T23:59:59.999Z' }],
  ])('is true for a %s filter', (_label, filters) => {
    /**
     * Every key, individually. The defect this closes is one key being forgotten:
     * `AgencyCampaignAttemptsPage` omitted `contact_id` from its own version and
     * so told a supervisor that a campaign which had dialled thousands "has not
     * dialed anyone yet" — an answer about the query presented as an answer about
     * the campaign.
     */
    expect(isAttemptFiltered(filters)).toBe(true);
  });

  it('counts a phone search, now that the agent routes really forward it', () => {
    /**
     * This assertion used to run the other way, and both readings obeyed the same
     * rule: **a key is counted if and only if the surface can actually send it.**
     *
     * `phone` was excluded because master's whitelist for the two agent routes
     * dropped it silently — the control returned an unfiltered list dressed as a
     * search result, so counting it would have turned an empty page into "your
     * search matched nothing" about a search that never happened. `phone` is now in
     * `AGENT_ATTEMPT_QUERY_PARAMS` for both routes and `forwardAllowedQuery` 400s
     * on an unknown key rather than dropping it, so the exclusion had become the
     * mirror-image lie: an applied search with no Clear button and a badge counting
     * nothing, i.e. a narrowed list presented as an unnarrowed one.
     *
     * Kept as one assertion rather than deleted, because the rule is what is being
     * pinned and it is the same rule under both answers. The `contact_id` defect
     * above is the other direction of the identical mistake.
     */
    expect(isAttemptFiltered({ phone: '98765' })).toBe(true);
    expect(attemptFilterGroupCount({ phone: '98765' })).toBe(1);
  });

  it('counts the phone search as its own group alongside every other filter', () => {
    // The group count is what the badge renders, so an off-by-one here is visible
    // on screen. Every key both surfaces can send: six independent narrowings,
    // the date range counted once. `campaign_id` belongs in this input — the name
    // says "every other filter", and omitting it made 5 the right answer to a
    // different question.
    expect(
      attemptFilterGroupCount({
        outcome: ['abandoned'],
        state: ['orphaned'],
        disposition_code: ['CB'],
        campaign_id: 'camp-1',
        phone: '98765',
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-03T23:59:59.999Z',
      }),
    ).toBe(6);
  });
});

describe('attemptFilterGroupCount — groups, not values', () => {
  it('counts three ticked outcomes as one narrowing', () => {
    // A badge reading "3 active" beside a single row of chips sends the reader
    // hunting for two more controls they have already found.
    expect(attemptFilterGroupCount({ outcome: ['abandoned', 'failed', 'busy'] })).toBe(1);
  });

  it('counts a date range once, not once per input', () => {
    expect(
      attemptFilterGroupCount({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-03T23:59:59.999Z' }),
    ).toBe(1);
  });

  it('counts one per independent group', () => {
    expect(
      attemptFilterGroupCount({
        outcome: ['connected'],
        state: ['ended'],
        disposition_code: ['sold'],
        campaign_id: 'camp-1',
        from: '2026-08-01T00:00:00.000Z',
      }),
    ).toBe(5);
  });

  it('counts nothing for an untouched card', () => {
    expect(attemptFilterGroupCount({})).toBe(0);
  });
});

describe('observedDispositionCodes — a suggestion list, never a catalog', () => {
  it('offers the codes on the rows in hand', () => {
    expect(
      observedDispositionCodes([
        { disposition_code: 'sold' },
        { disposition_code: 'not_interested' },
      ]),
    ).toEqual(['not_interested', 'sold']);
  });

  it('de-duplicates and sorts, so chips do not reorder under the cursor', () => {
    // "Load more" brings new codes in while the reader is choosing; a list that
    // re-sorts itself into a new order moves the chip they were about to click.
    expect(
      observedDispositionCodes([
        { disposition_code: 'sold' },
        { disposition_code: 'sold' },
        { disposition_code: 'callback' },
      ]),
    ).toEqual(['callback', 'sold']);
  });

  it('ignores rows nobody wrote up', () => {
    // `disposition_code` is null on every call that was never dispositioned,
    // which is most of an abandoned afternoon.
    expect(observedDispositionCodes([{ disposition_code: null }])).toEqual([]);
  });

  it('keeps a SELECTED code that no loaded row carries', () => {
    /**
     * The case that makes this function more than a `Set` of the rows: a code
     * typed by hand, or one whose only row has been paged past, must still render
     * as a chip that can be switched off. A selected filter with no visible
     * control is a list nobody can un-narrow.
     */
    expect(observedDispositionCodes([{ disposition_code: 'sold' }], ['typed_by_hand'])).toEqual([
      'sold',
      'typed_by_hand',
    ]);
  });

  it('keeps a code containing a comma as ONE code', () => {
    /**
     * Codes are operator-configured free text, so a code is whatever the operator
     * typed — including a comma. This function must therefore not split one.
     *
     * Such a code is nevertheless **unfilterable end to end**, and that is not
     * this function's doing: master's `forwardAllowedQuery` joins repeated params
     * with a comma and core's `multiParam` splits on one. Splitting here would
     * produce the same two useless codes one hop earlier while hiding the fact
     * that the code the reader typed cannot match.
     */
    expect(observedDispositionCodes([{ disposition_code: 'wrong number, do not call' }])).toEqual([
      'wrong number, do not call',
    ]);
  });
});
