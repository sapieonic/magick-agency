import { describe, it, expect } from 'vitest';
import { filterTenants, matchesTenant, queryTerms } from '../../utils/tenant-search';

const TENANTS = [
  { id: 't-100', name: 'Pacific Trading', slug: 'pacific-trading' },
  { id: 't-200', name: 'Acme Corporation', slug: 'acme-corp' },
  { id: 't-300', name: 'Globex', slug: 'globex' },
  { id: 't-400', name: 'Acme Logistics', slug: 'acme-logistics' },
];

describe('queryTerms', () => {
  it('splits on whitespace and drops empties', () => {
    expect(queryTerms('  acme   corp ')).toEqual(['acme', 'corp']);
  });

  it('returns nothing for a blank query', () => {
    expect(queryTerms('   ')).toEqual([]);
  });
});

describe('matchesTenant', () => {
  const tenant = TENANTS[1]!;

  it('matches on name, case-insensitively', () => {
    expect(matchesTenant(tenant, 'ACME')).toBe(true);
  });

  it('matches on slug', () => {
    expect(matchesTenant(tenant, 'acme-corp')).toBe(true);
  });

  it('matches on id, so a pasted id finds its tenant', () => {
    expect(matchesTenant(tenant, 't-200')).toBe(true);
  });

  it('requires every term but ignores their order', () => {
    expect(matchesTenant(tenant, 'corporation acme')).toBe(true);
    expect(matchesTenant(tenant, 'acme globex')).toBe(false);
  });

  it('matches everything when the query is blank', () => {
    expect(matchesTenant(tenant, '  ')).toBe(true);
  });
});

describe('filterTenants', () => {
  it('returns the original list for a blank query', () => {
    expect(filterTenants(TENANTS, '')).toBe(TENANTS);
  });

  it('filters to matching tenants only', () => {
    expect(filterTenants(TENANTS, 'acme').map((t) => t.id)).toEqual(['t-200', 't-400']);
  });

  it('ranks name-prefix matches above mid-name matches', () => {
    // "Pacific" contains "ac" mid-word; "Acme *" start with it.
    expect(filterTenants(TENANTS, 'ac').map((t) => t.id)).toEqual(['t-200', 't-400', 't-100']);
  });

  it('ranks name matches above slug-only matches', () => {
    const rows = [
      { id: 't-1', name: 'Zenith Retail', slug: 'northwind-ops' },
      { id: 't-2', name: 'Northwind Foods', slug: 'nw-foods' },
    ];
    expect(filterTenants(rows, 'northwind').map((t) => t.id)).toEqual(['t-2', 't-1']);
  });

  it('preserves server order within the same rank', () => {
    expect(filterTenants(TENANTS, 'acme ').map((t) => t.name)).toEqual([
      'Acme Corporation',
      'Acme Logistics',
    ]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterTenants(TENANTS, 'nope')).toEqual([]);
  });
});
