import { describe, it, expect } from 'vitest';
import { renderSelectionSummary } from '../../../src/retry-summary.js';
import type { AgencyDisposition } from '@magick-agency/contracts/agency';

// ---------------------------------------------------------------------------
// The agent's retry banner — the banner's rendering rules.
//
// This string is built CORE-SIDE so the copy the agent reads and the query that
// produced their roster cannot disagree. That makes it a payload three repos
// read and one repo writes, which is why the rules are pinned here rather than
// left to the console.
//
// The other property this file holds is that the bootstrap can never be broken
// by the selector: it is the payload between "the agent clicks join" and "the
// console renders", so an unexpected stored shape has to degrade to a shorter
// sentence, never to a throw.
// ---------------------------------------------------------------------------

const CATALOG: AgencyDisposition[] = [
  { code: 'voicemail', label: 'Voicemail' },
  { code: 'callback', label: 'Callback' },
  { code: 'nri_followup', label: 'NRI Followup' },
];

describe('renderSelectionSummary — order and sources', () => {
  it('renders dispositions, then outcomes, then never-attempted', () => {
    // The contract's own worked example. The order is fixed so all three repos
    // read the same sentence.
    expect(renderSelectionSummary(
      {
        last_disposition: ['voicemail', 'callback'],
        last_outcome: ['no_answer', 'busy'],
        never_attempted: true,
      },
      CATALOG,
    )).toBe('voicemail, callback, no answer, busy, never attempted');
  });

  it('takes the label from the PARENT catalog and falls back to the raw code', () => {
    // A code the parent had and the child does not — or one retired since — still
    // shaped the roster, so a bare slug beats dropping the dimension entirely.
    expect(renderSelectionSummary({ last_disposition: ['voicemail', 'gone_code'] }, CATALOG))
      .toBe('voicemail, gone_code');
  });

  it('decapitalizes only the FIRST character, so an operator label keeps its own capitals', () => {
    // `toLocaleLowerCase()` on the whole token is the obvious spelling and mangles
    // operator-authored labels: "NRI Followup" would become "nri followup". Only
    // the leading capital is there because the string starts a label.
    expect(renderSelectionSummary({ last_disposition: ['nri_followup'] }, CATALOG))
      .toBe('nRI Followup');
  });

  it('renders outcomes with the console\'s own copy', () => {
    expect(renderSelectionSummary({ last_outcome: ['agent_disconnected', 'abandoned'] }, []))
      .toBe('agent disconnected, abandoned (no agent free)');
  });
});

describe('renderSelectionSummary — the arm the ordering rules do not specify', () => {
  it('renders the remaining dimensions when the contract\'s three produce nothing', () => {
    // `{ state: ['exhausted'] }` is a perfectly ordinary retry and renders to
    // NOTHING under the three ordering rules — the banner would read `Retry 1 of "X" — `
    // with a trailing dash and no reason. Core is the sole producer of this
    // string, so extending it for a case the contract leaves empty cannot put core
    // out of step with anyone.
    expect(renderSelectionSummary({ state: ['exhausted', 'pending'] }, []))
      .toBe('out of attempts, not yet called');
    expect(renderSelectionSummary({ suppressed_reason: ['max_attempts'] }, []))
      .toBe('out of attempts');
    expect(renderSelectionSummary({ attempt_count_gte: 1, attempt_count_lte: 3 }, []))
      .toBe('1–3 attempts');
    expect(renderSelectionSummary({ attempt_count_gte: 2 }, [])).toBe('2 or more attempts');
    expect(renderSelectionSummary({ attempt_count_lte: 1 }, [])).toBe('1 or fewer attempts');
    expect(renderSelectionSummary({ never_attempted: false }, [])).toBe('already attempted');
  });

  it('does NOT append the fallback when the contract\'s three said something', () => {
    // Otherwise the banner grows a second clause the contract never described and
    // the three repos stop reading the same sentence for the ordinary case.
    expect(renderSelectionSummary(
      { last_outcome: ['no_answer'], state: ['exhausted'], attempt_count_lte: 3 },
      [],
    )).toBe('no answer');
  });
});

describe('renderSelectionSummary — a stored shape it cannot read', () => {
  it.each([null, undefined, 'a string', ['an', 'array'], 42, {}])(
    'returns an empty string for %p rather than throwing',
    (stored) => {
      // The caller reads an empty summary as "no banner". A `TypeError` here would
      // turn a cosmetic line into a 500 that stops an agent working.
      expect(renderSelectionSummary(stored, CATALOG)).toBe('');
    },
  );

  it('ignores fields of the wrong type and renders what it can', () => {
    expect(renderSelectionSummary(
      { last_outcome: ['no_answer', 7, null], never_attempted: 'true', attempt_count_gte: '2' },
      CATALOG,
    )).toBe('no answer');
  });

  it.each([
    ['last_outcome', { last_outcome: ['constructor'] }],
    ['last_outcome', { last_outcome: ['toString'] }],
    ['state', { state: ['constructor'] }],
    ['suppressed_reason', { suppressed_reason: ['hasOwnProperty'] }],
  ])('does not resolve an inherited property through the %s copy map', (_dimension, stored) => {
    // `retry_selector` is JSONB holding whatever a past release — or a hand-run
    // UPDATE — wrote, and the defensive reader above accepts EVERY non-empty
    // string. A bare `MAP[key] ?? key` then returns the inherited `Object`
    // constructor, which is not nullish, so the fallback never fires and
    // `decapitalize` is handed a function: `.length` is 1, `[0]` is undefined,
    // and `.toLocaleLowerCase()` throws.
    //
    // This runs on the SESSION BOOTSTRAP — the payload between an agent
    // clicking join and the console rendering — so the throw is a 500 that
    // stops them working, over a cosmetic banner. `Object.hasOwn` closes it and
    // the raw key falls through as the label, which is the same fallback every
    // unrecognised slug already gets.
    expect(() => renderSelectionSummary(stored, CATALOG)).not.toThrow();
    expect(renderSelectionSummary(stored, CATALOG)).not.toContain('function');
  });
});

describe('`canceled` in the exhaustive copy map', () => {
  it('renders operator-facing copy, not the raw slug', () => {
    // `OUTCOME_COPY` is `Record<AgencyAttemptOutcome, string>` precisely so a
    // member added to `contracts.ts` and forgotten here is a build error naming
    // it. This is the behavioural half: `copy()` falls through to the RAW KEY for
    // anything the map has no own entry for, so an omission would not throw — the
    // agent's retry banner would simply read "canceled", the one string a
    // human must never be shown.
    //
    // The copy was "cancelled before answer" until 2026-09-10. It names the actor
    // now because the old wording omitted WHO, and on a reporting surface the most
    // available reading of "cancelled" on a phone call is that the CUSTOMER
    // declined — which inverts the decision this label informs. A decline is
    // information about the number (they are screening); our own cancel is not,
    // and that is the whole basis for re-dialling these contacts.
    expect(renderSelectionSummary({ last_outcome: ['canceled'] }, []))
      .toBe('stopped by us before answer');
  });

  it('reads as a distinct reason beside the two it was being confused with', () => {
    // The whole point of the member. Before it, a supervisor building a retry
    // list from the pilot's data saw cancelled rings under "abandoned (no agent
    // free)" — a sentence about a customer who picked up and got silence, on
    // dials nobody ever answered. All three now say what they mean, in one line,
    // in the fixed order.
    expect(renderSelectionSummary({ last_outcome: ['no_answer', 'abandoned', 'canceled'] }, []))
      .toBe('no answer, abandoned (no agent free), stopped by us before answer');
  });
});
