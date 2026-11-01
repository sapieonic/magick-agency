import { describe, expect, it } from 'vitest';
import { reservedBreakReasonLabel } from '../../utils/agency/reservedBreakReason';

describe('reservedBreakReasonLabel', () => {
  it('labels the two reserved codes from the contract', () => {
    expect(reservedBreakReasonLabel('soft_phone')).toBe('Soft phone');
    expect(reservedBreakReasonLabel('device_away')).toBe('Away (app in background)');
  });

  it('is null for every other code, so the catalog label applies', () => {
    for (const code of ['lunch', 'break', '', null, undefined, 'toString', '__proto__', 'constructor']) {
      expect(reservedBreakReasonLabel(code), String(code)).toBeNull();
    }
  });
});
