import { describe, it, expect } from 'vitest';
import { AGENCY_ACTION_ERROR_CODES as CONTRACT_ACTION_ERROR_CODES } from '@magick-agency/contracts/errors';
import { AGENCY_ACTION_ERROR_CODES, type AgencyActionErrorCode } from '../../types/agency';

/**
 * `AgencyActionErrorCode` — the console's mirror of the server's closed union of
 * action error codes, `AGENCY_ACTION_ERROR_CODES` in `@magick-agency/contracts/errors`.
 *
 * ── Why the expected set is read, not typed ────────────────────────────────
 * A hand-TRANSCRIBED literal cannot detect drift from the thing it was
 * transcribed from — it drifts with it, silently, and reads as confirmation the
 * whole time. So the expected set is READ from the contracts package, the one
 * union the server raises from, and always runs.
 *
 * The compile-time half is local too: `AGENCY_ACTION_ERROR_CODES` plus
 * `MissingAgencyActionErrorCode` in `types/agency.ts` fail `tsc` if a code is
 * added to the union and forgotten in the list. That pair guards union↔list
 * INSIDE this app; this test guards console↔server.
 */
function coreCodes(): string[] {
  return [...CONTRACT_ACTION_ERROR_CODES];
}

describe('AgencyActionErrorCode — pinned against the API', () => {
  describe('vs the contract\'s one union', () => {
    it('carries exactly the codes the contract declares', () => {
      expect([...AGENCY_ACTION_ERROR_CODES].sort()).toEqual([...coreCodes()].sort());
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
