import { describe, it, expect } from 'vitest';
import { accountNameKey, accountSlugBase } from '../../../../../src/api/routes/helpers/create-account.js';

/**
 * The two pure rules of account creation (decisions AA2, AA3). The transaction around
 * them (tenant lock, name check, slug choice, the zero-call settings row) runs on real
 * Postgres in `test/integration/api/account.routes.test.ts`.
 */
describe('accountNameKey: when two names are the same name', () => {
  it.each([
    ['Sales', 'sales'],
    ['  Sales  ', 'Sales'],
    ['East  Coast\tSales', 'east coast sales'],
    ['ＳＡＬＥＳ', 'sales'], // full-width letters fold to ASCII (NFKC)
  ])('%j and %j are one name', (a, b) => {
    expect(accountNameKey(a)).toBe(accountNameKey(b));
  });

  it.each([
    ['Sales', 'Sales Team'],
    ['Sales!', 'Sales'],
    ['Crème', 'Creme'],
  ])('%j and %j are different names', (a, b) => {
    expect(accountNameKey(a)).not.toBe(accountNameKey(b));
  });
});

describe('accountSlugBase', () => {
  it.each([
    ['East Coast Sales', 'east-coast-sales'],
    ['  Sales!!  Team ', 'sales-team'],
    ['Crème Brûlée', 'creme-brulee'],
    ['Ventés', 'ventes'],
    ['North & South — Renewals', 'north-south-renewals'],
    ['Team 42', 'team-42'],
  ])('%j → %j', (name, slug) => {
    expect(accountSlugBase(name)).toBe(slug);
  });

  it('is empty for a name with no ASCII letter or digit (the caller substitutes `account`)', () => {
    expect(accountSlugBase('営業')).toBe('');
    expect(accountSlugBase('Продажи')).toBe('');
    expect(accountSlugBase('!!!')).toBe('');
  });

  it('caps at 40 characters and never ends on a dash', () => {
    const slug = accountSlugBase(`${'a'.repeat(39)} bcdef`);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toBe('a'.repeat(39));
    expect(accountSlugBase('x'.repeat(60))).toBe('x'.repeat(40));
  });
});
