import { describe, it, expect } from 'vitest';
import { AGENCY_ACTION_ERROR_CODES } from '../../types/agency';
import { PERMANENT_REDIAL_REFUSALS, REDIAL_REFUSAL_CODES } from '../../utils/agencyRedialCopy';

/**
 * Wrap-up redial's codes. The words the agent reads for each refusal are the station's
 * (`redialRefusedLine`, pinned in `stationCopy.test.ts`).
 */
describe('wrap-up redial codes', () => {
  it('lists only real action error codes', () => {
    for (const code of REDIAL_REFUSAL_CODES) expect(AGENCY_ACTION_ERROR_CODES).toContain(code);
  });

  it('holds only the refusals that cannot change within the wrap-up as permanent', () => {
    expect([...PERMANENT_REDIAL_REFUSALS].sort()).toEqual(
      ['disposition_already_submitted', 'redial_blocked_dnc', 'redial_not_allowed'].sort(),
    );
    for (const code of PERMANENT_REDIAL_REFUSALS) expect(REDIAL_REFUSAL_CODES).toContain(code);
  });
});
