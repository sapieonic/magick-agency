import { describe, expect, it } from 'vitest';
import { plivoNumberToE164 } from '../../../src/plivo-number.js';

/*
 * One rule for a number synced from a Plivo account and for an inbound call's From / To
 * (docs/inbound.md §3): both are matched against the same stored phone_numbers rows.
 */
describe('plivoNumberToE164', () => {
  it.each([
    // Plivo's own form: digits with the country code, no `+`.
    ['18135401302', '+18135401302'],
    ['919876543210', '+919876543210'],
    ['442079460018', '+442079460018'],
    // A `+` already there is kept; surrounding whitespace is trimmed.
    ['+918000000001', '+918000000001'],
    [' 14155550100 ', '+14155550100'],
    // E.164's bounds: 2 to 15 digits, no leading zero.
    ['12', '+12'],
    ['123456789012345', '+123456789012345'],
  ])('%j → %j', (raw, want) => {
    expect(plivoNumberToE164(raw)).toBe(want);
  });

  it.each([
    // A withheld or anonymous inbound caller: the call is answered, its Missed row has no number.
    'anonymous', 'Anonymous', 'restricted', 'unknown', 'Unavailable', 'private',
    'sip:alice@phone.plivo.com', '',
    '   ',
    // Not a number Plivo would send: a leading zero, too long, too short, punctuation inside.
    '0123456789', '1234567890123456', '1', '+', '1-415-555-0100', '+1 415 555 0100', '(415)5550100', '++14155550100',
  ])('%j → null', (raw) => {
    expect(plivoNumberToE164(raw)).toBeNull();
  });

  it.each([12345, null, undefined, {}, ['14155550100']])('a non-string (%j) → null', (raw) => {
    expect(plivoNumberToE164(raw)).toBeNull();
  });
});
