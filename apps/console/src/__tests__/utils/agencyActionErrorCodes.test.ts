import { describe, it, expect } from 'vitest';
import { AGENCY_ACTION_ERROR_CODES as CONTRACT_ACTION_ERROR_CODES } from '@magick-agency/contracts/errors';
import { AGENCY_ACTION_ERROR_CODES, type AgencyActionErrorCode } from '../../types/agency';

/**
 * `AgencyActionErrorCode` (`MAG-154`) — cusui's mirror of core's closed union
 * (`magic-voice-core/src/agency/contracts.ts`), which master also mirrors
 * (`magick-master/src/agency/agency-action-errors.ts`).
 *
 * ── This test used to be unable to do the job it claimed ────────────────────
 * Its previous docstring said it catches "a code core adds to its wire and
 * cusui never adds to the union at all". It could not, and the proof is that it
 * did not: core and master went to 18 members while this copy sat at 16, and
 * this test stayed green throughout, because the expected set was a
 * hand-TRANSCRIBED literal that nobody updated either. A transcription cannot
 * detect drift from the thing it was transcribed from — it drifts with it,
 * silently, and reads as confirmation the whole time.
 *
 * So the expected set is now READ from the sibling checkout rather than typed
 * out here. The source is
 * `magic-voice-core/src/agency/agency-s2s-contract.fixture.json`, which is the
 * right authority for three reasons: it enumerates the codes as machine-readable
 * JSON (no TypeScript parsing), it is committed BYTE-IDENTICALLY in core and
 * master so agreeing with it means agreeing with both, and its own comment names
 * this exact seam — "core raises it, master must forward it, cusui renders it".
 *
 * ── Why it skips instead of failing when core is absent ─────────────────────
 * cusui's own CI checks out only cusui. Reading a sibling that is not there must
 * not red the build, so this `skipIf`s — the same convention core's and master's
 * `s2s-contract.test.ts` use for their cross-repo halves. The consequence is the
 * one the platform CLAUDE.md states plainly: **this check only runs from the
 * superproject root**, and a green standalone run has not verified it. That is
 * a weaker guarantee than a local assertion, and still strictly better than a
 * transcription that cannot fail.
 *
 * The compile-time half is unaffected and still local: `AGENCY_ACTION_ERROR_CODES`
 * plus `MissingAgencyActionErrorCode` in `types/agency.ts` fail `tsc` if a code
 * is added to the union and forgotten in the list. That pair guards union↔list
 * INSIDE this repo; this test is the only thing guarding cusui↔core.
 */
/*
 * PORT NOTE (magick-agency): the authority moved. In MagickVoice the closed union
 * lived in core and was mirrored by master and cusui, so this read core's S2S
 * fixture from a sibling checkout and skipped without one. Magick Agency has ONE
 * union, `@magick-agency/contracts/errors` (`AGENCY_ACTION_ERROR_CODES`, "one
 * union; the fixture retires", plan §1), which the server raises from. So the two
 * fixture cases now read that list and always run, instead of skipping.
 */
function coreCodes(): string[] {
  return [...CONTRACT_ACTION_ERROR_CODES];
}

describe('AgencyActionErrorCode — pinned against core and master', () => {
  describe('vs the contract\'s one union (was: core\'s S2S contract fixture)', () => {
    it('carries exactly the codes core declares and master mirrors', () => {
      expect([...AGENCY_ACTION_ERROR_CODES].sort()).toEqual([...coreCodes()].sort());
    });

    it('includes the two that were missing until this sync', () => {
      // `session_on_other_campaign` was already handled here as a bare literal
      // (it discriminates `AgencySessionConflict`); `agent_on_live_call` was
      // absent from cusui entirely. Both are listed now because the union
      // mirrors core's wire, not the subset this console happens to render.
      expect(AGENCY_ACTION_ERROR_CODES).toContain('session_on_other_campaign');
      expect(AGENCY_ACTION_ERROR_CODES).toContain('agent_on_live_call');
    });
  });

  it('includes the two that were missing until MAG-154', () => {
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
