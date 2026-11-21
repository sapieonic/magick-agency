import { describe, expect, it } from 'vitest';
import { NAME_GUESS_COLUMNS, squashColumnName } from '@magick-agency/domain/customer-name';
import { contactNameContextSql } from '../../../src/db/repositories/agency/sql-fragments.js';
import { matchName } from '../../../src/agency/inbound/match-name.js';

/**
 * The live calls list, the floor, the listening history and the inbound Missed list read a
 * contact's name through one SQL spelling (AS19 S1): only the columns `matchName` can read leave the
 * database. What it returns on a real row is pinned in `test/integration/agency/listen-history.test.ts`.
 */
describe('contactNameContextSql', () => {
  it('NULL when the join found no contact; the aliases as given', () => {
    const sql = contactNameContextSql('ct', 'cam');
    expect(sql).toMatch(/^CASE WHEN ct\.id IS NULL THEN NULL/);
    expect(sql).toContain('jsonb_each(ct.context)');
    expect(sql).toContain("cam.context_display #>> '{roles,name}'");
  });

  it('reads the guess\'s columns, squashed, in the domain\'s order', () => {
    const listed = /IN \(([^)]*)\)/.exec(contactNameContextSql('mc', 'cam'))![1]!;
    expect([...listed.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1])).toEqual(NAME_GUESS_COLUMNS.map(squashColumnName));
  });
});

describe('matchName: the domain\'s one name reading (AS19 S1)', () => {
  it('never guesses a column the campaign\'s `types` reads as a phone number', () => {
    const row = { Name: '9876543210', 'Customer Name': 'Ravi K' };
    expect(matchName(row, { types: { NAME: 'phone' } })).toBe('Ravi K');
    expect(matchName(row, null)).toBe('9876543210');
  });

  it('the campaign\'s name role first; else the guess, any case and spacing; never hidden, never a fact', () => {
    const row = { Borrower: ' Asha Rao ', 'Customer Name': 'Ravi K' };
    expect(matchName(row, { roles: { name: 'borrower' } })).toBe('Asha Rao');
    expect(matchName(row, null)).toBe('Ravi K');
    expect(matchName(row, { hidden: ['customer name'] })).toBeUndefined();
    expect(matchName(row, { facts: [{ column: 'Customer Name', label: 'Who', key: 'who' }] })).toBeUndefined();
  });
});
