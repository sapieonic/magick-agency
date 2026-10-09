import { describe, it, expect } from 'vitest';
import { normalizeE164 } from '../../utils/phone';

describe('normalizeE164', () => {
  it('accepts a full E.164 number unchanged', () => {
    expect(normalizeE164('+919876543210')).toBe('+919876543210');
  });

  it('adds a missing leading +', () => {
    expect(normalizeE164('919876543210')).toBe('+919876543210');
  });

  it('strips spaces, dashes, parentheses, and dots', () => {
    expect(normalizeE164('+91 98765 43210')).toBe('+919876543210');
    expect(normalizeE164('+1 (415) 555-2671')).toBe('+14155552671');
    expect(normalizeE164('+44.20.7946.0958')).toBe('+442079460958');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeE164('  +919876543210  ')).toBe('+919876543210');
  });

  it('rejects numbers starting with 0 after the +', () => {
    expect(normalizeE164('+0919876543210')).toBeNull();
  });

  it('rejects too-short and too-long inputs', () => {
    expect(normalizeE164('+123456')).toBeNull();
    expect(normalizeE164('+1234567890123456')).toBeNull();
  });

  it('rejects non-numeric input', () => {
    expect(normalizeE164('not a phone')).toBeNull();
    expect(normalizeE164('')).toBeNull();
    expect(normalizeE164('+91abc76543210')).toBeNull();
  });
});
