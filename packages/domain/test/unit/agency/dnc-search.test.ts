// The Do Not Call list search's digit floors (`dnc-search.ts`): the console's DNC page checks them
// before it sends and the server refuses by them, so the two never disagree.
import { describe, expect, it } from 'vitest';
import {
  DNC_SEARCH_MIN_DIGITS,
  DNC_SEARCH_MIN_PREFIX_DIGITS,
  DNC_SEARCH_TOO_SHORT,
  dncSearchInternationalDigits,
  dncSearchPrefixMinDigits,
  dncSearchShortfall,
} from '../../../src/dnc-search';
import { SEARCH_COUNTRIES } from '../../../src/customer-search-number';

const ENDING = { code: 'search_too_short', message: DNC_SEARCH_TOO_SHORT };
const prefix = (message: string) => ({ code: 'search_prefix_too_short', message });

describe('dncSearchShortfall', () => {
  it('an ending needs 4 digits, zeros and 00 included', () => {
    expect(DNC_SEARCH_MIN_DIGITS).toBe(4);
    expect(DNC_SEARCH_TOO_SHORT).toBe('Type at least 4 digits of the number.');
    for (const typed of ['0', '060', '1 2 3', '00', '004']) expect(dncSearchShortfall(typed), typed).toEqual(ENDING);
    for (const typed of ['5060', '0060', '150 60', '0044']) expect(dncSearchShortfall(typed), typed).toBeNull();
  });

  it('a + number cut short needs its listed calling code and 4 more digits', () => {
    expect(dncSearchShortfall('+91 990')).toEqual(prefix('Type at least 4 digits after +91, or leave off the + to search by the last digits.'));
    expect(dncSearchShortfall('+1 555')).toEqual(prefix('Type at least 4 digits after +1, or leave off the + to search by the last digits.'));
    expect(dncSearchShortfall('+971 501')).toEqual(prefix('Type at least 4 digits after +971, or leave off the + to search by the last digits.'));
    for (const typed of ['+91 9908', '+1 5551', '+44 2079', '+971 5012', '+44 (0)20 79']) {
      expect(dncSearchShortfall(typed), typed).toBeNull();
    }
  });

  it('a calling code the number rule does not list needs 7 digits in all', () => {
    expect(DNC_SEARCH_MIN_PREFIX_DIGITS).toBe(7);
    const words = prefix('Type at least 7 digits after the +, or leave off the + to search by the last digits.');
    for (const typed of ['+9', '+27 8212', '+4']) expect(dncSearchShortfall(typed), typed).toEqual(words);
    expect(dncSearchShortfall('+27 82123')).toBeNull();
  });

  it('text that is no number at all is never too short (it runs and matches nothing)', () => {
    for (const typed of ['', '   ', '+', 'abc', '12ab', '9.19E+11']) expect(dncSearchShortfall(typed), typed).toBeNull();
  });

  it('a whole number is never too short, in any listed country or an unlisted one', () => {
    for (const c of SEARCH_COUNTRIES) {
      const national = '9'.repeat(c.minNationalLength);
      expect(dncSearchShortfall(`+${c.callingCode}${national}`), c.iso).toBeNull();
      expect(dncSearchShortfall(`00${c.callingCode}${national}`), c.iso).toBeNull();
      expect(dncSearchShortfall(national), c.iso).toBeNull();
    }
    expect(dncSearchShortfall('+27821234567')).toBeNull();
  });
});

describe('dncSearchInternationalDigits and dncSearchPrefixMinDigits', () => {
  it('reads the digits after + or 00, a bracketed trunk after the code dropped', () => {
    expect(dncSearchInternationalDigits('+44 (0)20 79')).toBe('442079');
    expect(dncSearchInternationalDigits(' 0044 (0)20 79')).toBe('442079');
    expect(dncSearchInternationalDigits('0060')).toBe('60');
    expect(dncSearchInternationalDigits('15060')).toBeNull();
    expect(dncSearchInternationalDigits('060')).toBeNull();
  });

  it('is the listed code’s length and 4, else 7', () => {
    expect(dncSearchPrefixMinDigits('1555')).toBe(5);
    expect(dncSearchPrefixMinDigits('442')).toBe(6);
    expect(dncSearchPrefixMinDigits('9715')).toBe(7);
    expect(dncSearchPrefixMinDigits('97')).toBe(7);
    expect(dncSearchPrefixMinDigits('2782')).toBe(7);
  });
});
