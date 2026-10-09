import { describe, it, expect } from 'vitest';

/**
 * Digest window arithmetic.
 *
 * This is the part of the feature most likely to be silently wrong: an
 * off-by-one here does not throw, it mails somebody yesterday's numbers under
 * today's heading, or counts a campaign in two consecutive digests, or — the
 * worst one — makes two runs of the same period compute different dedupe keys,
 * which turns the idempotency guarantee off without any symptom until a customer
 * reports duplicate mail.
 *
 * Everything is UTC and every assertion is written as an explicit instant, never
 * as a relative offset from `new Date()` — a test that computes its own expected
 * value with the same arithmetic it is testing asserts nothing.
 */

// `period.ts` holds only the cadence vocabulary, so only `isDigestFrequency` is covered.
import {
  DIGEST_FREQUENCIES,
  isDigestFrequency,
} from '../../../../src/notifications/engine/period.js';

describe('isDigestFrequency', () => {
  it('accepts the declared cadences and nothing else', () => {
    for (const frequency of DIGEST_FREQUENCIES) expect(isDigestFrequency(frequency)).toBe(true);
    for (const value of ['monthly', 'WEEKLY', '', null, undefined, 7, {}]) {
      expect(isDigestFrequency(value), String(value)).toBe(false);
    }
  });
});

describe('isDigestFrequency rejects everything else', () => {
  it('is not fooled by an inherited Object property', () => {
    // Same prototype hazard the catalog's `Map` lookup exists for: an
    // `includes` over an array is safe, and this is what proves it stayed one.
    for (const value of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(isDigestFrequency(value), value).toBe(false);
    }
  });

  it('rejects a padded or differently-cased cadence rather than trimming it', () => {
    // A stored row carrying ' weekly' must fall back to the catalog default,
    // not be repaired into a cadence. Trimming here would hide a bad write.
    for (const value of [' weekly', 'weekly ', 'Weekly', 'DAILY', 'week', 'dailyy']) {
      expect(isDigestFrequency(value), JSON.stringify(value)).toBe(false);
    }
  });

  it('rejects non-string values that an array `includes` would still match', () => {
    for (const value of [new String('weekly'), ['weekly'], { toString: () => 'weekly' }]) {
      expect(isDigestFrequency(value), String(value)).toBe(false);
    }
  });
});
