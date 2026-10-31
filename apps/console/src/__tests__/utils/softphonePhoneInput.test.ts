import { describe, it, expect } from 'vitest';
import {
  appendDialKey,
  deleteLastDialChar,
  dialBlockReason,
  formatDialNumber,
  normalisePastedNumber,
  normaliseTypedNumber,
  sanitiseDialInput,
} from '../../utils/softphone/phoneInput';

describe('normalisePastedNumber — what a paste drags in, cleaned', () => {
  it.each([
    ['+91 98204 61733', '+919820461733'],
    ['+91-98204-61733', '+919820461733'],
    ['(+91) 98204 61733', '+919820461733'],
    ['tel:+919820461733', '+919820461733'],
    ['0091 98204 61733', '+919820461733'],
    ['098204 61733', '+919820461733'],
    ['022 2659 4410', '+912226594410'],
    ['  +44 20 7946 0958 ', '+442079460958'],
  ])('%s → %s', (raw, expected) => {
    expect(normalisePastedNumber(raw, '+91')).toBe(expected);
  });

  it('leaves a bare national number for the server, which knows the account’s region', () => {
    // §4.1 step 2: the server normalises `to` in the account's default region.
    // Guessing a country here would be a second, weaker answer.
    expect(normalisePastedNumber('98204 61733', '+91')).toBe('9820461733');
  });

  it('reads the trunk 0 in the account’s own country code, with or without its +', () => {
    expect(normalisePastedNumber('020 7946 0958', '44')).toBe('+442079460958');
    expect(normalisePastedNumber('020 7946 0958', '+44')).toBe('+442079460958');
  });

  it('keeps a plus only in first place', () => {
    expect(normalisePastedNumber('+91+98204', '+91')).toBe('+9198204');
  });
});

describe('typing into the number', () => {
  it('keeps digits, * and #, and a + only first', () => {
    expect(sanitiseDialInput('98a20-4')).toBe('98204');
    expect(sanitiseDialInput('1+2')).toBe('12');
    expect(sanitiseDialInput('+12*#')).toBe('+12*#');
  });

  it('caps the length rather than growing without bound', () => {
    expect(sanitiseDialInput('1'.repeat(40))).toHaveLength(20);
  });

  it('appends a key, ignores anything that is not one, and only starts with +', () => {
    expect(appendDialKey('98', '2')).toBe('982');
    expect(appendDialKey('98', 'x')).toBe('98');
    expect(appendDialKey('', '+')).toBe('+');
    expect(appendDialKey('9', '+')).toBe('9');
    expect(deleteLastDialChar('982')).toBe('98');
    expect(deleteLastDialChar('')).toBe('');
  });
});

describe('dialBlockReason — when Call is refused before it is sent', () => {
  it('names every reason', () => {
    expect(dialBlockReason('')).toBe('empty');
    expect(dialBlockReason('12345')).toBe('too_short');
    expect(dialBlockReason('+1234567890123456')).toBe('too_long');
    expect(dialBlockReason('98204*61733')).toBe('not_a_number');
    expect(dialBlockReason('9820461733')).toBeNull();
    expect(dialBlockReason('+919820461733')).toBeNull();
  });
});

describe('formatDialNumber — display only', () => {
  it('groups an Indian mobile the way it is read aloud', () => {
    expect(formatDialNumber('+919820461733')).toBe('+91 98204 61733');
    expect(formatDialNumber('9820461733')).toBe('98204 61733');
  });

  it('leaves what it cannot recognise unchanged', () => {
    expect(formatDialNumber('+442079460958')).toBe('+442079460958');
    expect(formatDialNumber(null)).toBe('');
  });
});

describe('the trunk "(0)" written after a country code, on paste', () => {
  it.each([
    ['+44 (0)20 7946 0018', '+442079460018'],
    ['+91 (0) 98204 61733', '+919820461733'],
    ['+44(0)20 7946 0018', '+442079460018'],
    ['(+44) (0)20 7946 0018', '+442079460018'],
    ['0044 (0)20 7946 0018', '+442079460018'],
  ])('%s → %s', (raw, expected) => {
    expect(normalisePastedNumber(raw, '+91')).toBe(expected);
  });

  it('leaves a bracketed area code alone: only a lone (0) is the trunk prefix', () => {
    expect(normalisePastedNumber('+44 (020) 7946 0018', '+91')).toBe('+4402079460018');
  });
});

describe('normaliseTypedNumber — a typed number, read after the country-code chip', () => {
  it('drops a typed trunk 0, so "098204 61733" reads +91 98204 61733 and not +91 0…', () => {
    expect(normaliseTypedNumber(sanitiseDialInput('098204 61733'))).toBe('9820461733');
    expect(normaliseTypedNumber('022')).toBe('22');
  });

  it('reads a typed 00 as the international prefix, as a paste does', () => {
    expect(normaliseTypedNumber('0044')).toBe('+44');
    expect(normaliseTypedNumber('00')).toBe('+');
    expect(normalisePastedNumber('0044 20 7946 0958', '+91')).toBe(normaliseTypedNumber('00442079460958'));
  });

  it('keeps a lone 0 until the next key says which it is', () => {
    expect(normaliseTypedNumber('0')).toBe('0');
  });

  it('leaves everything else as typed', () => {
    expect(normaliseTypedNumber('9820461733')).toBe('9820461733');
    expect(normaliseTypedNumber('+919820461733')).toBe('+919820461733');
    expect(normaliseTypedNumber('+44020')).toBe('+44020');
    expect(normaliseTypedNumber('')).toBe('');
  });

  it('applies key by key on the pad: 0, 9 → 9; 0, 0, 4, 4 → +44', () => {
    expect(appendDialKey(appendDialKey('', '0'), '9')).toBe('9');
    let value = '';
    for (const key of ['0', '0', '4', '4']) value = appendDialKey(value, key);
    expect(value).toBe('+44');
  });
});
