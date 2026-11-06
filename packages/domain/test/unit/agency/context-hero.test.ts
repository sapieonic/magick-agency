import { describe, expect, it } from 'vitest';
import { contextValueText, heroColumnsFor, isBlankContextValue, MAX_HERO_FIELDS } from '../../../src/context-hero';

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

  it('values: text as is, scalars stringified, placeholders blank', () => {
    expect(contextValueText(5)).toBe('5');
    expect(contextValueText({ a: 1 })).toBe('{"a":1}');
    expect(contextValueText(null)).toBeNull();
    for (const blank of ['', ' N/A ', '-', 'none', null, undefined]) expect(isBlankContextValue(blank)).toBe(true);
    expect(isBlankContextValue(0)).toBe(false);
  });
});
