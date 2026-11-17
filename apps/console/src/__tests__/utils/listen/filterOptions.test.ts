import { describe, it, expect } from 'vitest';
import { sortedFilterOptions } from '../../../utils/listen/filterOptions';

describe('sortedFilterOptions', () => {
  it('lists the names by name, case and accents aside', () => {
    const names = new Map([['u-2', 'zara'], ['u-1', 'Émile'], ['u-3', 'anil']]);
    expect(sortedFilterOptions(names)).toEqual([
      { id: 'u-3', name: 'anil' },
      { id: 'u-1', name: 'Émile' },
      { id: 'u-2', name: 'zara' },
    ]);
  });

  it('keeps the one chosen when nothing else offers it, and prefers the known name when something does', () => {
    const names = new Map([['u-1', 'Vikram Das']]);
    expect(sortedFilterOptions(names, { id: 'u-9', name: 'Asha Rao' })).toEqual([
      { id: 'u-9', name: 'Asha Rao' },
      { id: 'u-1', name: 'Vikram Das' },
    ]);
    expect(sortedFilterOptions(names, { id: 'u-1', name: 'Old name' })).toEqual([{ id: 'u-1', name: 'Vikram Das' }]);
    expect(sortedFilterOptions(names, null)).toEqual([{ id: 'u-1', name: 'Vikram Das' }]);
    // The map handed in is not changed.
    expect([...names.keys()]).toEqual(['u-1']);
  });
});
