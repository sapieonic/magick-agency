import { describe, it, expect } from 'vitest';
import { AGENCY_ACTION_ERROR_CODES as CONTRACT_ACTION_ERROR_CODES } from '@magick-agency/contracts/errors';
import { AGENCY_ACTION_ERROR_CODES, type AgencyActionErrorCode } from '../../types/agency';

/**
 * `AgencyActionErrorCode` — the closed union of action error codes the server
 * raises, `AGENCY_ACTION_ERROR_CODES` in `@magick-agency/contracts/errors`.
 *
 * ── Why the console's list is checked for IDENTITY, not equality ────────────
 * The console's `types/agency.ts` re-exports the contract's list rather than
 * declaring a copy, and that is what keeps the two from drifting. Comparing the
 * contents would pass on a hand-made copy that happens to agree today, so the
 * test asserts it is the same array. The ordered 18-code snapshot lives in the
 * contracts package (`test/errors.test.ts`); the two-sided union-to-list guard in
 * its `src/errors.ts` fails `tsc` if a code is added to the union and not the list.
 */
describe('AgencyActionErrorCode — pinned against the API', () => {
  describe('vs the contract\'s one union', () => {
    it('is the contract\'s list itself, not a copy', () => {
      expect(AGENCY_ACTION_ERROR_CODES).toBe(CONTRACT_ACTION_ERROR_CODES);
    });

    it('includes the two that were missing until this sync', () => {
      // `session_on_other_campaign` was already handled here as a bare literal
      // (it discriminates `AgencySessionConflict`); `agent_on_live_call` was
      // absent from the console entirely. Both are listed now because the union
      // mirrors the API's wire, not the subset this console happens to render.
      expect(AGENCY_ACTION_ERROR_CODES).toContain('session_on_other_campaign');
      expect(AGENCY_ACTION_ERROR_CODES).toContain('agent_on_live_call');
    });
  });

  it('includes `invalid_dnc_scope` and `attempt_not_live`', () => {
    expect(AGENCY_ACTION_ERROR_CODES).toContain('invalid_dnc_scope');
    expect(AGENCY_ACTION_ERROR_CODES).toContain('attempt_not_live');
  });

  it('has no duplicate entries', () => {
    expect(new Set(AGENCY_ACTION_ERROR_CODES).size).toBe(AGENCY_ACTION_ERROR_CODES.length);
  });

  it('every listed code is a valid member of the union', () => {
    // `satisfies` proves this at compile time; asserted at runtime too so the
    // list cannot be widened via a cast without something going red.
    const listed: readonly AgencyActionErrorCode[] = AGENCY_ACTION_ERROR_CODES;
    expect(listed.every((c) => typeof c === 'string' && c.length > 0)).toBe(true);
  });
});
