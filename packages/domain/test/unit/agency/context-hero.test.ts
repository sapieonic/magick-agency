import { describe, expect, it } from 'vitest';
import { AGENCY_FACT_FIELDS_MAX } from '@magick-agency/contracts/agency';
import {
  configuredHeroNames, contextValueText, heroCapFor, heroColumnsFor, isBlankContextValue, MAX_HERO_FIELDS,
} from '../../../src/context-hero';

/**
 * A roster row's hero columns (`src/context-hero.ts`): the configured heroes, else one per
 * heuristic bucket, else the first columns with a value, in the import's column order, and never
 * a hidden column at any stage.
 */
describe('heroColumnsFor', () => {
  const row = { Id: '7', City: 'Pune', Name: 'Asha Rao', Aadhaar: '1234 5678 9012', 'Loan No': 'LN-0042' };

  it('the configured heroes, in their order, matched case-insensitively, capped', () => {
    expect(heroColumnsFor(row, { hero: ['loan no', 'NAME'] })).toEqual(['Loan No', 'Name']);
    expect(heroColumnsFor(row, { hero: ['Id', 'City', 'Name', 'Aadhaar', 'Loan No'] })).toHaveLength(MAX_HERO_FIELDS);
    // A configured name missing from the row is skipped, not shown blank.
    expect(heroColumnsFor(row, { hero: ['Policy', 'Name'] })).toEqual(['Name']);
  });

  it('a hidden column is never a hero: not configured, not guessed, not a fallback', () => {
    expect(heroColumnsFor(row, { hero: ['Aadhaar', 'Name'], hidden: ['aadhaar'] })).toEqual(['Name']);
    const ids = { Id: '7', Aadhaar: '1234', Ref2: 'x' };
    expect(heroColumnsFor(ids, { hidden: ['Aadhaar'] }, ['Aadhaar', 'Id', 'Ref2'])).not.toContain('Aadhaar');
    expect(heroColumnsFor({ Aadhaar: '1', b: '2' }, { hidden: ['Aadhaar'] }, ['Aadhaar', 'b'])).toEqual(['b']);
  });

  it('no heroes configured: one column per bucket (name, amount, identifier, place), skipping empty values', () => {
    expect(heroColumnsFor({ ...row, Balance: '-' }, {}, ['Name', 'Loan No', 'Id', 'Aadhaar', 'City', 'Balance']))
      .toEqual(['Name', 'Loan No', 'City']);
  });

  it('nothing guessed: the first columns with a value, in the IMPORT order, not the JSONB key order', () => {
    // Postgres hands this object back as {a, bb, ccc, dddd, eeeee}: by length, then bytes.
    const jsonbOrder = { a: '1', bb: '2', ccc: '', dddd: '4', eeeee: '5' };
    expect(heroColumnsFor(jsonbOrder, null, ['eeeee', 'dddd', 'ccc', 'bb', 'a'])).toEqual(['eeeee', 'dddd', 'bb', 'a']);
    expect(heroColumnsFor(jsonbOrder, null)).toEqual(['a', 'bb', 'dddd', 'eeeee']);
  });

  it('max: the surface\'s cap, at every stage', () => {
    expect(heroColumnsFor(row, { hero: ['Name', 'Loan No', 'City'] }, null, { max: 2 })).toEqual(['Name', 'Loan No']);
    expect(heroColumnsFor(row, {}, ['Name', 'Loan No', 'Id', 'Aadhaar', 'City'], { max: 2 })).toEqual(['Name', 'Loan No']);
    expect(heroColumnsFor({ a: '1', bb: '2', ccc: '3' }, null, null, { max: 2 })).toEqual(['a', 'bb']);
  });

  it('fallbackToFirstColumns: false (the contact panel) pins nothing when nothing is configured or guessed', () => {
    const plain = { a: '1', bb: '2' };
    expect(heroColumnsFor(plain, null)).toEqual(['a', 'bb']);
    expect(heroColumnsFor(plain, null, null, { fallbackToFirstColumns: false })).toEqual([]);
    // Stages 1 and 2 are unchanged by it.
    expect(heroColumnsFor(row, { hero: ['City'] }, null, { fallbackToFirstColumns: false })).toEqual(['City']);
    expect(heroColumnsFor({ ...plain, City: 'Pune' }, {}, null, { fallbackToFirstColumns: false })).toEqual(['City']);
  });

  it('values: text as is, scalars stringified, placeholders blank', () => {
    expect(contextValueText(5)).toBe('5');
    expect(contextValueText({ a: 1 })).toBe('{"a":1}');
    expect(contextValueText(null)).toBeNull();
    for (const blank of ['', ' N/A ', '-', 'none', null, undefined]) expect(isBlankContextValue(blank)).toBe(true);
    expect(isBlankContextValue(0)).toBe(false);
  });
});

describe('configuredHeroNames (the first stage, without a row)', () => {
  it('the hero names as written, in order, blank and repeated names dropped, never capped', () => {
    expect(configuredHeroNames({ hero: ['Name', '', '  ', 7, 'Loan No', 'Name', 'a', 'b', 'c'] }))
      .toEqual(['Name', 'Loan No', 'a', 'b', 'c']);
    expect(configuredHeroNames(null)).toEqual([]);
    expect(configuredHeroNames({ hero: 'Name' })).toEqual([]);
  });

  it('minus hidden, matched case-insensitively: a hidden column is never a hero', () => {
    expect(configuredHeroNames({ hero: ['Name', 'Aadhaar', 'City'], hidden: [' aadhaar ', 'CITY'] })).toEqual(['Name']);
  });
});

describe('the configured heroes with the card\'s chosen facts (AS19)', () => {
  const display = {
    hero: ['Loan No', 'City'],
    roles: { name: 'Name', place: 'City', amount_due: 'Balance' },
    facts: [
      { column: 'Balance', label: 'Amount due', key: 'amount_due', highlight: true },
      { column: 'Loan No', label: 'Loan', key: 'loan_no' },
    ],
  };

  it('are the name role then the facts\' columns, and `hero` and the tile roles are not read', () => {
    expect(configuredHeroNames(display)).toEqual(['Name', 'Balance', 'Loan No']);
    const row = { Name: 'Asha Rao', City: 'Pune', Balance: '5000', 'Loan No': 'LN-1', Id: '7' };
    expect(heroColumnsFor(row, display)).toEqual(['Name', 'Balance', 'Loan No']);
  });

  it('`facts: []` is the new model too: only the name role, never `hero`', () => {
    expect(configuredHeroNames({ ...display, facts: [] })).toEqual(['Name']);
    expect(configuredHeroNames({ hero: ['Loan No'], facts: [] })).toEqual([]);
  });

  it('minus hidden; malformed entries skipped; no name role is fine', () => {
    expect(configuredHeroNames({ ...display, hidden: ['balance'] })).toEqual(['Name', 'Loan No']);
    expect(configuredHeroNames({ ...display, hidden: ['NAME'] })).toEqual(['Balance', 'Loan No']);
    expect(configuredHeroNames({ facts: [null, 'Loan No', { column: 7 }, { column: ' ' }, { column: 'EMI' }], roles: 'Name' }))
      .toEqual(['EMI']);
    expect(configuredHeroNames({ facts: [{ column: 'EMI' }, { column: 'EMI' }], roles: { name: 'EMI' } })).toEqual(['EMI']);
  });

  it('a `facts` that is not an array is the old rule, unchanged', () => {
    for (const facts of [undefined, null, {}, 'Balance']) {
      expect(configuredHeroNames({ ...display, facts })).toEqual(['Loan No', 'City']);
    }
  });
});

describe('the name stays a hero after the move to facts (AS19 R1)', () => {
  // A campaign set up before AS19 whose name was guessed, saved with facts and no `name` role.
  const moved = {
    hero: ['Customer Name', 'Amount Due'],
    facts: [{ column: 'Amount Due', label: 'Amount Due', key: 'amount_due' }],
  };
  const row = { 'Customer Name': 'Asha Rao', 'Amount Due': '5000', City: 'Pune', 'Loan No': 'LN-1' };

  it('without a row: the first `hero` entry the name heuristic matches, then the facts', () => {
    expect(configuredHeroNames(moved)).toEqual(['Customer Name', 'Amount Due']);
    // not a hidden one, nor a fact's column; a `name` role wins over it
    expect(configuredHeroNames({ ...moved, hidden: ['customer name'] })).toEqual(['Amount Due']);
    expect(configuredHeroNames({ ...moved, hero: ['Client', 'Customer Name'], facts: [{ column: 'client' }] }))
      .toEqual(['Customer Name', 'client']);
    expect(configuredHeroNames({ ...moved, roles: { name: 'Full Name' } })).toEqual(['Full Name', 'Amount Due']);
    // no `hero` entry it matches: no name
    expect(configuredHeroNames({ ...moved, hero: ['Loan No'] })).toEqual(['Amount Due']);
  });

  it('with a row: its first visible name column with a value, not a fact\'s column, first', () => {
    expect(heroColumnsFor(row, moved)).toEqual(['Customer Name', 'Amount Due']);
    // read from the row, not `hero`
    expect(heroColumnsFor(row, { facts: moved.facts })).toEqual(['Customer Name', 'Amount Due']);
    expect(heroColumnsFor({ ...row, 'Customer Name': '-', Contact: 'Ravi' }, { facts: moved.facts })).toEqual(['Contact', 'Amount Due']);
    expect(heroColumnsFor(row, { facts: moved.facts, hidden: ['Customer Name'] })).toEqual(['Amount Due']);
    expect(heroColumnsFor(row, { facts: [{ column: 'Customer Name' }] })).toEqual(['Customer Name']);
    expect(heroColumnsFor(row, { ...moved, roles: { name: 'Loan No' } })).toEqual(['Loan No', 'Amount Due']);
  });

  it('without facts nothing changes: `hero` as configured', () => {
    expect(configuredHeroNames({ hero: ['Amount Due', 'Customer Name'] })).toEqual(['Amount Due', 'Customer Name']);
    expect(heroColumnsFor(row, { hero: ['Amount Due'] })).toEqual(['Amount Due']);
  });
});

describe('the hero cap with facts (AS19 R2)', () => {
  const four = ['A', 'B', 'C', 'D'].map((column) => ({ column }));
  const row = { Name: 'Asha', A: '1', B: '2', C: '3', D: '4', E: '5' };

  it('is the name and every fact: no surface drops the fourth fact', () => {
    expect(heroCapFor({ facts: four })).toBe(1 + AGENCY_FACT_FIELDS_MAX);
    expect(heroCapFor({ facts: [] })).toBe(1 + AGENCY_FACT_FIELDS_MAX);
    expect(heroColumnsFor(row, { roles: { name: 'Name' }, facts: four })).toEqual(['Name', 'A', 'B', 'C', 'D']);
    expect(heroColumnsFor(row, { facts: four })).toEqual(['Name', 'A', 'B', 'C', 'D']);
  });

  it('without facts it stays MAX_HERO_FIELDS, and a caller\'s own cap still wins', () => {
    expect(heroCapFor({ hero: ['A'] })).toBe(MAX_HERO_FIELDS);
    expect(heroCapFor(null)).toBe(MAX_HERO_FIELDS);
    expect(heroColumnsFor(row, { hero: ['Name', 'A', 'B', 'C', 'D'] })).toHaveLength(MAX_HERO_FIELDS);
    expect(heroColumnsFor(row, { roles: { name: 'Name' }, facts: four }, null, { max: 2 })).toEqual(['Name', 'A']);
  });
});
