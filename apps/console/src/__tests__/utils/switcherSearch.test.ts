import { describe, it, expect } from 'vitest';
import { filterSwitcherItems } from '../../utils/switcherSearch';

const ITEMS = [
  { id: 't-100', name: 'Pacific Trading', subtitle: 'pacific-trading' },
  { id: 't-200', name: 'Acme Corporation', subtitle: 'acme-corp' },
  { id: 't-300', name: 'Globex', subtitle: 'globex' },
];

describe('filterSwitcherItems', () => {
  it('returns the original list for a blank query', () => {
    expect(filterSwitcherItems(ITEMS, '')).toBe(ITEMS);
    expect(filterSwitcherItems(ITEMS, '   ')).toBe(ITEMS);
  });

  it('matches name case-insensitively', () => {
    expect(filterSwitcherItems(ITEMS, 'ACME').map((i) => i.id)).toEqual(['t-200']);
  });

  it('matches subtitle (slug)', () => {
    expect(filterSwitcherItems(ITEMS, 'pacific-trading').map((i) => i.id)).toEqual(['t-100']);
  });

  it('matches id so a pasted id finds its row', () => {
    expect(filterSwitcherItems(ITEMS, 't-300').map((i) => i.name)).toEqual(['Globex']);
  });

  it('keeps original order and drops non-matches', () => {
    expect(filterSwitcherItems(ITEMS, 'a').map((i) => i.id)).toEqual(['t-100', 't-200']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterSwitcherItems(ITEMS, 'nope')).toEqual([]);
  });
});
