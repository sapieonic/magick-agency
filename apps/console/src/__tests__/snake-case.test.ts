import { describe, it, expect } from 'vitest';
import {
  toSnakeCase,
  toDimensionKey,
  uniqueDimensionKey,
  MAX_DIMENSION_KEY_LENGTH,
} from '../utils/snake-case';

describe('toSnakeCase', () => {
  it('lowercases input', () => {
    expect(toSnakeCase('Customer')).toBe('customer');
    expect(toSnakeCase('AGREED')).toBe('agreed');
  });

  it('converts spaces to underscores', () => {
    expect(toSnakeCase('agreed to pay')).toBe('agreed_to_pay');
  });

  it('collapses runs of non-alphanumeric chars into a single underscore', () => {
    expect(toSnakeCase('agreed   to')).toBe('agreed_to');
    expect(toSnakeCase('agreed - to')).toBe('agreed_to');
    expect(toSnakeCase('agreed/to.pay')).toBe('agreed_to_pay');
  });

  it('strips leading underscores so keys never start with _', () => {
    expect(toSnakeCase(' agreed')).toBe('agreed');
    expect(toSnakeCase('!!!agreed')).toBe('agreed');
  });

  it('preserves a trailing underscore so multi-word typing appends cleanly', () => {
    // Simulates typing "agreed to " before the next word is entered
    expect(toSnakeCase('agreed to ')).toBe('agreed_to_');
    expect(toSnakeCase('agreed_to_' + 'pay')).toBe('agreed_to_pay');
  });

  it('keeps already-valid snake_case unchanged (idempotent)', () => {
    expect(toSnakeCase('agreed_to_pay')).toBe('agreed_to_pay');
  });

  it('handles empty string', () => {
    expect(toSnakeCase('')).toBe('');
  });
});

/** The API's contract for `analytics_config.custom_dimensions[].key`. The user
 *  never types the key, so anything the derivation can emit must satisfy this. */
const CORE_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

describe('toDimensionKey', () => {
  it('derives a snake_case key from a short description', () => {
    expect(toDimensionKey('Whether the customer agreed to pay')).toBe(
      'whether_the_customer_agreed_to_pay',
    );
  });

  it('drops the trailing underscore a mid-typed description leaves', () => {
    // `toSnakeCase` keeps this for a visible key input; a derived key never is.
    expect(toDimensionKey('agreed to ')).toBe('agreed_to');
  });

  it('caps an over-long description at 50 chars', () => {
    // The description from the bug report, which derived a
    // >50-char key and failed the save with a Zod path naming a hidden field.
    const key = toDimensionKey(
      "Date the caller wants to visit the store, as stated during a reservation, in DD/MM/YYYY format — relative terms like 'today' or 'tomorrow' should be resolved",
    );
    expect(key.length).toBeLessThanOrEqual(MAX_DIMENSION_KEY_LENGTH);
    expect(key).toMatch(CORE_KEY_PATTERN);
  });

  it('cuts at a word boundary rather than severing a word', () => {
    const key = toDimensionKey('alpha bravo charlie delta echo foxtrot golf hotel india juliet');
    expect(key).toBe('alpha_bravo_charlie_delta_echo_foxtrot_golf_hotel');
    expect(key.length).toBeLessThanOrEqual(MAX_DIMENSION_KEY_LENGTH);
  });

  it('hard-cuts a single word longer than the cap (no boundary to back off to)', () => {
    const key = toDimensionKey('a'.repeat(80));
    expect(key).toBe('a'.repeat(MAX_DIMENSION_KEY_LENGTH));
  });

  it('keeps a word that ends exactly on the cap', () => {
    // 50 chars exactly, then a boundary — nothing was severed, so no back-off.
    const key = toDimensionKey(`${'a'.repeat(50)} tail`);
    expect(key).toBe('a'.repeat(50));
  });

  it('drops leading non-letters so the key starts with a letter', () => {
    // The API requires a leading letter: `2nd_attempt` would be rejected.
    expect(toDimensionKey('2nd attempt outcome')).toBe('nd_attempt_outcome');
    expect(toDimensionKey('  !!! agreed')).toBe('agreed');
  });

  it('returns empty for a description with nothing usable', () => {
    expect(toDimensionKey('')).toBe('');
    expect(toDimensionKey('!!!')).toBe('');
    expect(toDimensionKey('123')).toBe('');
  });

  it('always emits a key the API would accept, or nothing', () => {
    const descriptions = [
      'Whether the customer agreed to pay',
      "Date of visit in DD/MM/YYYY — relative terms like 'today' resolved to a real date",
      '2nd attempt?',
      'a'.repeat(200),
      'Ünïcödé description with àccents',
      '   ',
      '...',
    ];
    for (const d of descriptions) {
      const key = toDimensionKey(d);
      if (key === '') continue;
      expect(key.length).toBeLessThanOrEqual(MAX_DIMENSION_KEY_LENGTH);
      expect(key).toMatch(CORE_KEY_PATTERN);
    }
  });
});

describe('uniqueDimensionKey', () => {
  it('returns the key unchanged when unclaimed', () => {
    expect(uniqueDimensionKey('agreed_to_pay', new Set())).toBe('agreed_to_pay');
  });

  it('suffixes a claimed key', () => {
    expect(uniqueDimensionKey('outcome', new Set(['outcome']))).toBe('outcome_2');
    expect(uniqueDimensionKey('outcome', new Set(['outcome', 'outcome_2']))).toBe('outcome_3');
  });

  it('keeps the suffixed key within the cap by shortening the stem', () => {
    const long = 'a'.repeat(MAX_DIMENSION_KEY_LENGTH);
    const key = uniqueDimensionKey(long, new Set([long]));
    expect(key.length).toBeLessThanOrEqual(MAX_DIMENSION_KEY_LENGTH);
    expect(key).toMatch(CORE_KEY_PATTERN);
    expect(key.endsWith('_2')).toBe(true);
  });
});
