import { describe, it, expect } from 'vitest';
import {
  humaniseCode,
  resyncCatalog,
  selectionAfterResync,
  numberKeysRemapped,
  typeaheadIndex,
} from '../../utils/agencyCatalogSync';
import type { AgencyDisposition, AgencyBreakReason } from '../../types/agency';

/**
 * The shared catalog concern (§A.13.4 / §A.13.6 / §A.13.8).
 *
 * Every function here has a plausible wrong implementation that passes a glance,
 * so each block below is written to fail against that wrong implementation
 * specifically rather than to restate the right one.
 */

const DISPOSITIONS: AgencyDisposition[] = [
  { code: 'sale', label: 'Sale', is_success: true, requires_note: true },
  { code: 'not_interested', label: 'Not interested' },
  { code: 'callback', label: 'Callback', requires_datetime: true },
];

const BREAKS: AgencyBreakReason[] = [
  { code: 'break', label: 'Break' },
  { code: 'lunch', label: 'Lunch' },
  { code: 'meeting', label: 'Meeting' },
  { code: 'training', label: 'Training' },
  { code: 'technical_issue', label: 'Technical issue' },
  { code: 'admin', label: 'Admin time' },
];

describe('humaniseCode', () => {
  it('turns a slug into a sentence', () => {
    expect(humaniseCode('technical_issue')).toBe('Technical issue');
    expect(humaniseCode('do-not-call')).toBe('Do not call');
  });

  it('does not lowercase what it did not uppercase', () => {
    // Case-folding the tail turns a meaningful acronym into what reads as a typo,
    // in the one place the agent has no other information to go on.
    expect(humaniseCode('DNC')).toBe('DNC');
    expect(humaniseCode('sale_IVR')).toBe('Sale IVR');
  });

  it('returns the code unchanged when there is nothing to humanise', () => {
    expect(humaniseCode('___')).toBe('___');
    expect(humaniseCode('')).toBe('');
  });
});

describe('resyncCatalog — labels for codes we already know', () => {
  it('preserves the whole entry, not just the label', () => {
    // The naive rebuild is `allowedCodes.map(code => ({code, label: code}))`, which
    // passes any test asserting only membership and order. Asserting the FLAGS is
    // what distinguishes it: a rebuilt `sale` that lost `requires_note` stops
    // blocking submit client-side.
    const next = resyncCatalog(DISPOSITIONS, ['sale', 'callback']);
    expect(next.map((e) => e.code)).toEqual(['sale', 'callback']);
    expect(next[0]).toBe(DISPOSITIONS[0]);
    expect(next[0]?.requires_note).toBe(true);
    expect(next[1]?.requires_datetime).toBe(true);
  });

  it('does not render a familiar option as a raw slug', () => {
    // `admin` is chosen deliberately: its operator label ("Admin time") is NOT
    // what `humaniseCode` would produce ("Admin"), so this fails against a rebuild
    // that discards the known entry. The first draft of this test used
    // `technical_issue`, whose two spellings coincide — it passed with the
    // preservation branch deleted and was therefore observing nothing (§16.6).
    const next = resyncCatalog(BREAKS, ['admin', 'lunch']);
    expect(next.map((e) => e.label)).toEqual(['Admin time', 'Lunch']);
  });

  it('humanises a code it has never seen rather than hiding it', () => {
    // Hiding an option the server WILL accept is worse than naming it
    // imperfectly — the agent cannot pick what is not on screen.
    const next = resyncCatalog(BREAKS, ['lunch', 'floor_walk']);
    expect(next.map((e) => e.code)).toEqual(['lunch', 'floor_walk']);
    expect(next[1]?.label).toBe('Floor walk');
  });

  it('carries no invented flags on a synthesized entry', () => {
    // Inventing `requires_note` for a code we were never told about would block a
    // legitimate submit. Core is the real enforcement for criterion (c).
    const next = resyncCatalog(DISPOSITIONS, ['brand_new']);
    expect(next[0]?.requires_note).toBeUndefined();
    expect(next[0]?.requires_datetime).toBeUndefined();
    expect(next[0]?.is_success).toBeUndefined();
  });
});

describe('resyncCatalog — order and shape', () => {
  it('takes order from the server and never re-sorts', () => {
    // A client-side sort remaps every agent's muscle memory the moment an admin
    // renames a code, and both orders look reasonable in review.
    const next = resyncCatalog(DISPOSITIONS, ['callback', 'sale', 'not_interested']);
    expect(next.map((e) => e.code)).toEqual(['callback', 'sale', 'not_interested']);
  });

  it('drops a repeated code so two rows cannot collide on one key', () => {
    const next = resyncCatalog(BREAKS, ['lunch', 'lunch', 'break']);
    expect(next.map((e) => e.code)).toEqual(['lunch', 'break']);
  });

  it('returns an empty catalog for an empty echo rather than keeping the stale one', () => {
    // "The campaign accepts nothing" is a real answer, and the caller's
    // disabled-with-a-stated-reason path is the honest rendering of it. Silently
    // keeping the old list would offer codes the server has just refused.
    expect(resyncCatalog(BREAKS, [])).toEqual([]);
  });

  it('does not mutate the catalog it was given', () => {
    const before = [...BREAKS];
    resyncCatalog(BREAKS, ['lunch']);
    expect(BREAKS).toEqual(before);
  });
});

describe('selectionAfterResync', () => {
  it('keeps a selection that survived', () => {
    const next = resyncCatalog(DISPOSITIONS, ['sale', 'callback']);
    expect(selectionAfterResync('callback', next)).toBe('callback');
  });

  it('returns null — NOT the neighbour that took the index', () => {
    // This is the assertion that matters. `sale` was index 0; after the re-sync
    // index 0 is `not_interested`. An implementation that slides the selection to
    // the surviving index leaves the highlight looking unchanged with a different
    // value underneath, and the agent submits "Not interested" for a sale.
    const next = resyncCatalog(DISPOSITIONS, ['not_interested', 'callback']);
    expect(next[0]?.code).toBe('not_interested');
    expect(selectionAfterResync('sale', next)).toBeNull();
  });

  it('returns null when nothing survived', () => {
    expect(selectionAfterResync('sale', [])).toBeNull();
  });

  it('leaves an absent selection absent', () => {
    expect(selectionAfterResync(null, DISPOSITIONS)).toBeNull();
  });
});

describe('numberKeysRemapped', () => {
  const nine = Array.from({ length: 12 }, (_, i) => ({ code: `c${i}`, label: `C${i}` }));

  it('is false when nothing inside the bound range moved', () => {
    expect(numberKeysRemapped(nine, [...nine], 9)).toBe(false);
  });

  it('is false for a change BEYOND the bound range', () => {
    // Warning here would train the agent that this warning means nothing, which
    // is expensive on the day it does. Index 10 is bound to no key.
    const after = [...nine];
    after[10] = { code: 'moved', label: 'Moved' };
    expect(numberKeysRemapped(nine, after, 9)).toBe(false);
  });

  it('is true for a swap inside the bound range', () => {
    const after = [...nine];
    after[2] = nine[3]!;
    after[3] = nine[2]!;
    expect(numberKeysRemapped(nine, after, 9)).toBe(true);
  });

  it('is true at the last bound position, and false one past it', () => {
    // The boundary is the thing an off-by-one gets wrong, and an off-by-one here
    // is silent in both directions.
    const atNine = [...nine];
    atNine[8] = { code: 'moved', label: 'Moved' };
    expect(numberKeysRemapped(nine, atNine, 9)).toBe(true);

    const atTen = [...nine];
    atTen[9] = { code: 'moved', label: 'Moved' };
    expect(numberKeysRemapped(nine, atTen, 9)).toBe(false);
  });

  it('is true when a key that did nothing now selects something', () => {
    // A NEW binding under a finger that expects nothing to happen.
    const before = nine.slice(0, 3);
    expect(numberKeysRemapped(before, nine.slice(0, 5), 9)).toBe(true);
  });

  it('is true when the list shrank inside the range', () => {
    // The key now fails safe, but the warning's job is "your fingers are no longer
    // a guide to this list", and that is equally true here.
    expect(numberKeysRemapped(nine.slice(0, 5), nine.slice(0, 3), 9)).toBe(true);
  });

  it('never warns at boundCount 0 — the BreakMenu contract', () => {
    // Number keys are the pad's alone (§A.13.4). A surface that binds no digits
    // cannot have remapped one, so this must be false even for a total rewrite.
    expect(numberKeysRemapped(BREAKS, [], 0)).toBe(false);
    expect(numberKeysRemapped(BREAKS, [...BREAKS].reverse(), 0)).toBe(false);
  });
});

describe('typeaheadIndex', () => {
  const entries = [
    { code: 'break', label: 'Break' },
    { code: 'lunch', label: 'Lunch' },
    { code: 'meeting', label: 'Meeting' },
    { code: 'leave', label: 'Leave early' },
  ];

  it('finds the first match from a fresh menu', () => {
    expect(typeaheadIndex(entries, 'm', null)).toBe(2);
  });

  it('wraps, so repeated presses CYCLE between two "L" entries', () => {
    // A non-wrapping search sticks on the last match, and a key that stops
    // responding reads as broken.
    const first = typeaheadIndex(entries, 'l', null);
    expect(first).toBe(1);
    const second = typeaheadIndex(entries, 'l', first);
    expect(second).toBe(3);
    // ...and back again, rather than sticking at 3.
    expect(typeaheadIndex(entries, 'l', second)).toBe(1);
  });

  it('is case-insensitive both ways', () => {
    expect(typeaheadIndex(entries, 'L', null)).toBe(1);
    expect(typeaheadIndex([{ code: 'x', label: 'lower' }], 'L', null)).toBe(0);
  });

  it('returns null for a letter nothing starts with', () => {
    expect(typeaheadIndex(entries, 'z', null)).toBeNull();
  });

  it('returns null for a digit — the break menu binds no number keys', () => {
    // Without this, `1` in the break menu could fall through to a typeahead match
    // and quietly become the number-key binding §A.13.4 forbids.
    expect(typeaheadIndex(entries, '1', null)).toBeNull();
    expect(typeaheadIndex([{ code: 'x', label: '1st break' }], '1', null)).toBeNull();
  });

  it('returns null for non-single-character input', () => {
    expect(typeaheadIndex(entries, '', null)).toBeNull();
    expect(typeaheadIndex(entries, 'le', null)).toBeNull();
    expect(typeaheadIndex(entries, ' ', null)).toBeNull();
  });

  it('returns null on an empty menu instead of an index into nothing', () => {
    expect(typeaheadIndex([], 'l', null)).toBeNull();
  });

  it('finds the only match even when it is the current one', () => {
    expect(typeaheadIndex(entries, 'm', 2)).toBe(2);
  });
});
