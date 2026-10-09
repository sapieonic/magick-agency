import { describe, it, expect } from 'vitest';
import { fieldMatchesFilter, highlightSegments } from '../../utils/agencyFieldFilter';

describe('fieldMatchesFilter', () => {
  it('matches on the header, case-insensitively', () => {
    expect(fieldMatchesFilter({ label: 'Policy #', value: '12345' }, 'pol')).toBe(true);
    expect(fieldMatchesFilter({ label: 'Policy #', value: '12345' }, 'POL')).toBe(true);
  });

  it('matches on the value, case-insensitively', () => {
    expect(fieldMatchesFilter({ label: 'City', value: 'Mumbai' }, 'mum')).toBe(true);
  });

  it('is a substring match, not a whole-word or prefix match', () => {
    expect(fieldMatchesFilter({ label: 'Policy #', value: '12345' }, 'olic')).toBe(true);
    expect(fieldMatchesFilter({ label: 'Amount Due', value: '999' }, 'xyz')).toBe(false);
  });

  it('an empty query matches everything', () => {
    expect(fieldMatchesFilter({ label: 'City', value: 'Mumbai' }, '')).toBe(true);
  });

  it('a query with no match in either header or value fails', () => {
    expect(fieldMatchesFilter({ label: 'City', value: 'Mumbai' }, 'branch')).toBe(false);
  });
});

describe('highlightSegments', () => {
  it('returns one unmatched segment for an empty query', () => {
    expect(highlightSegments('Mumbai', '')).toEqual([{ text: 'Mumbai', matched: false }]);
  });

  it('returns one unmatched segment when the query does not occur', () => {
    expect(highlightSegments('Mumbai', 'xyz')).toEqual([{ text: 'Mumbai', matched: false }]);
  });

  it('splits a single mid-string match into before/match/after', () => {
    expect(highlightSegments('Mumbai', 'mba')).toEqual([
      { text: 'Mu', matched: false },
      { text: 'mba', matched: true },
      { text: 'i', matched: false },
    ]);
  });

  it('matches case-insensitively but preserves the original casing in the segment', () => {
    expect(highlightSegments('Mumbai', 'MUM')).toEqual([
      { text: 'Mum', matched: true },
      { text: 'bai', matched: false },
    ]);
  });

  it('marks a match at the very start with no leading unmatched segment', () => {
    expect(highlightSegments('Policy #', 'pol')).toEqual([
      { text: 'Pol', matched: true },
      { text: 'icy #', matched: false },
    ]);
  });

  it('marks a match at the very end with no trailing unmatched segment', () => {
    expect(highlightSegments('Policy #', '#')).toEqual([
      { text: 'Policy ', matched: false },
      { text: '#', matched: true },
    ]);
  });

  it('marks every non-overlapping occurrence, left to right', () => {
    expect(highlightSegments('abcabc', 'abc')).toEqual([
      { text: 'abc', matched: true },
      { text: 'abc', matched: true },
    ]);
  });
});
