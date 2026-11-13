import { describe, expect, it } from 'vitest';
import { reservedBreakReasonLabel } from '../../utils/agency/reservedBreakReason';

describe('reservedBreakReasonLabel', () => {
  it('labels the reserved codes from the contract', () => {
    expect(reservedBreakReasonLabel('soft_phone')).toBe('Soft phone');
    expect(reservedBreakReasonLabel('device_away')).toBe('Away (app in background)');
    // IQ51: the agent app's pause for a cellular call.
    expect(reservedBreakReasonLabel('phone_call')).toBe('On a phone call');
    // IQ58 (Mode B): away, and the phone rings for inbound calls.
    expect(reservedBreakReasonLabel('away_ring')).toBe('Away · rings for inbound');
  });

  it('is null for every other code, so the catalog label applies', () => {
    for (const code of ['lunch', 'break', '', null, undefined, 'toString', '__proto__', 'constructor']) {
      expect(reservedBreakReasonLabel(code), String(code)).toBeNull();
    }
  });
});
