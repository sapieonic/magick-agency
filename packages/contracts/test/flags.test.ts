import { describe, expect, it } from 'vitest';
import { AGENCY_FLAGS, AGENCY_FLAG_KEYS, type AgencyClientFlagMap } from '../src/flags';

/** The expected flag definitions. */
const EXPECTED = {
  agency_dialer_enabled: { default: false, envVar: 'FF_AGENCY_DIALER', clientExposed: true },
  agency_late_binding: { default: false, envVar: 'FF_AGENCY_LATE_BINDING', clientExposed: undefined },
  agency_call_analysis: { default: false, envVar: 'FF_AGENCY_CALL_ANALYSIS', clientExposed: true },
} as const;

describe('agency flags', () => {
  it('are exactly the three keys', () => {
    expect(Object.keys(AGENCY_FLAGS).sort()).toEqual([...AGENCY_FLAG_KEYS].sort());
    expect(AGENCY_FLAG_KEYS).toHaveLength(3);
  });

  it.each(AGENCY_FLAG_KEYS)('%s keeps its key, type, default, scopes, envVar and exposure', (key) => {
    const def = AGENCY_FLAGS[key];
    expect(def.key).toBe(key);
    expect(def.type).toBe('boolean');
    expect(def.default).toBe(EXPECTED[key].default);
    expect(def.scopes).toEqual(['global', 'tenant', 'account']);
    expect(def.envVar).toBe(EXPECTED[key].envVar);
    expect((def as { clientExposed?: boolean }).clientExposed).toBe(EXPECTED[key].clientExposed);
    expect(def.owner).toBe('voice');
  });

  it('keeps late binding off the client', () => {
    const map: AgencyClientFlagMap = { agency_dialer_enabled: true, agency_call_analysis: false };
    expect(Object.keys(map)).not.toContain('agency_late_binding');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(AGENCY_FLAGS)).toBe(true);
  });
});
