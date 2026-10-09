import { describe, expect, it } from 'vitest';
import { AGENCY_FLAGS, AGENCY_FLAG_KEYS } from '@magick-agency/contracts/flags';
import { analysisFlagFor } from '@magick-agency/db/repositories/agency-call.repository';
import { FLAGS, allFlags, clientExposedFlags, getFlag } from '../../../src/feature-flags/registry.js';

/**
 * The registry `defineFlag`s each agency flag
 * FROM `AGENCY_FLAGS` in `@magick-agency/contracts/flags` rather than restating
 * it, and `analysisFlagFor` (in `@magick-agency/db`, which cannot import the
 * server) returns the contracts' definition directly. These pin that the three
 * statements of one catalog agree, so the console's flag map, the server's
 * resolver and the bridge's analysis gate can never name different flags.
 */
describe('feature-flag registry ⇄ @magick-agency/contracts/flags', () => {
  it('registers exactly the contract keys', () => {
    expect(allFlags().map((f) => f.key).sort()).toEqual([...AGENCY_FLAG_KEYS].sort());
    expect(Object.keys(FLAGS).sort()).toEqual(Object.keys(AGENCY_FLAGS).sort());
  });

  it('each registered definition equals the contract definition field for field', () => {
    for (const key of AGENCY_FLAG_KEYS) {
      expect(getFlag(key)).toEqual(AGENCY_FLAGS[key]);
      expect(FLAGS[key]).toEqual(AGENCY_FLAGS[key]);
      expect(Object.isFrozen(FLAGS[key])).toBe(true);
    }
  });

  it('client exposure matches the contracts (ClientExposedAgencyFlagKey)', () => {
    const exposed = AGENCY_FLAG_KEYS.filter((k) => (AGENCY_FLAGS[k] as { clientExposed?: boolean }).clientExposed === true);
    expect(clientExposedFlags().map((f) => f.key).sort()).toEqual([...exposed].sort());
  });

  it("analysisFlagFor('agency') is the registry's agency_call_analysis", () => {
    expect(analysisFlagFor('agency')).toEqual(FLAGS.agency_call_analysis);
    expect(analysisFlagFor('agency').key).toBe('agency_call_analysis');
  });
});
