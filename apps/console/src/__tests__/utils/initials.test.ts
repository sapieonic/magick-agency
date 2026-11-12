import { describe, it, expect } from 'vitest';
import { initialsFor } from '../../utils/initials';

/** The one initials rule every avatar uses: the profile menu, the station, an agent's row. */
describe('initialsFor', () => {
  it('makes initials from a name, or the email without one', () => {
    expect(initialsFor('Priya Shah', 'p@x.com')).toBe('PS');
    expect(initialsFor('Priya', 'p@x.com')).toBe('PR');
    expect(initialsFor(null, 'rahul@x.com')).toBe('RA');
  });

  it('takes the first and last word of a longer name', () => {
    expect(initialsFor('Anita Priya Sharma')).toBe('AS');
    expect(initialsFor('Maria del Carmen Ruiz')).toBe('MR');
  });

  it('uses letters and digits only, in any script, skipping words without one', () => {
    expect(initialsFor('Manas (Dev)', 'm@x.com')).toBe('MD');
    expect(initialsFor('(Dev) Manas', 'm@x.com')).toBe('DM');
    expect(initialsFor('Manas - Dev', 'm@x.com')).toBe('MD');
    expect(initialsFor('"Priya"', 'p@x.com')).toBe('PR');
    expect(initialsFor('Ölüm Şahin', 'o@x.com')).toBe('ÖŞ');
    expect(initialsFor('मनस निलोरौत', 'm@x.com')).toBe('मनि');
    expect(initialsFor('Team 7', 't@x.com')).toBe('T7');
    // `"𝒜lice"[0]` is half a surrogate pair and would render as a replacement glyph.
    expect(initialsFor('𝒜lice Ng')).toBe('𝒜N');
    // Nothing readable in the name: the email's local part, past its punctuation.
    expect(initialsFor('(  ) --', '_r.ahul@x.com')).toBe('RA');
  });

  it('never renders empty, even for an unresolved agent’s fallback name', () => {
    expect(initialsFor('Agent 4f21ab90')).toBe('A4');
    expect(initialsFor('   ')).toBe('?');
    expect(initialsFor('', '.@x.com')).toBe('?');
    expect(initialsFor(null, null)).toBe('?');
  });
});
