import { describe, it, expect } from 'vitest';
import { badgeText } from '../../utils/badgeText';

/** The text on the sidebar's Home and missed-calls badges. */
describe('badgeText', () => {
  it('shows the count, 99+ past it, and nothing for none or unknown', () => {
    expect(badgeText(null)).toBeNull();
    expect(badgeText(undefined)).toBeNull();
    expect(badgeText(0)).toBeNull();
    expect(badgeText(4)).toBe('4');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(120)).toBe('99+');
  });

  it('shows 99+ for a count the server capped, whatever the number', () => {
    expect(badgeText(40, true)).toBe('99+');
    expect(badgeText(0, true)).toBeNull();
  });
});
