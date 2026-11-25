import { describe, it, expect } from 'vitest';
import { concurrencyLimitText, parseConcurrencyLimit } from '../../utils/credentialConcurrency';

describe('a carrier account\'s own cap in the console (CR13)', () => {
  it.each<[number | null, number | undefined | null, string]>([
    [null, undefined, 'No limit of its own'],
    [null, 3, 'No limit of its own'],
    [5, undefined, 'Up to 5'],
    [5, null, 'Up to 5'],
    [5, 0, '0 of 5 in use'],
    [5, 7, '7 of 5 in use'],
  ])('cap %j with %j in use reads %j', (cap, inUse, text) => {
    expect(concurrencyLimitText(cap, inUse)).toBe(text);
  });

  it.each<[string, number | null]>([['', null], ['  ', null], ['1', 1], [' 25 ', 25], ['1000', 1000]])('parses %j as %j', (text, cap) => {
    expect(parseConcurrencyLimit(text)).toEqual({ cap });
  });

  it.each(['0', '1001', '-2', '2.5', 'ten', '1e3'])('refuses %j with a message', (text) => {
    expect(parseConcurrencyLimit(text)).toHaveProperty('error');
  });
});
