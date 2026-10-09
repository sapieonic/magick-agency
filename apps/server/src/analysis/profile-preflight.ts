import { getFeatureFlagService } from '../feature-flags/index.js';
import { callAnalysisProfileRepository } from '@magick-agency/db/repositories/call-analysis-profile.repository';
import { analysisFlagFor } from '@magick-agency/db/repositories/agency-call.repository';
import type { WebRtcCallScope } from '@magick-agency/db/repositories/agency-call.repository';

/**
 * Ready-to-send rejection for an unusable `analysis_profile_id`.
 *
 * `code` is not decoration: the console reads refusals by `code`, and this is the
 * one refusal here an operator can fix in a single click by picking a different
 * profile. Every sibling refusal in `agency-campaigns.routes.ts` carries a code
 * (`feature_disabled`, `campaign_not_found`, `announcement_not_found`) for the
 * same reason.
 */
export interface AnalysisPreflightError {
  status: number;
  error: string;
  code: string;
  message: string;
}

/**
 * Request-time validation for an `analysis_profile_id`: checks the owning
 * product's analysis flag is on for this tenant/account, and that the profile
 * exists, is active, and is owned by them. Returns null when no profile was
 * selected or everything is valid.
 *
 * **The ownership check belongs at the write.** An agency call inherits its
 * profile id from `agency_campaigns.analysis_profile_id`, stamped onto the leg at
 * dial time, so a campaign write that skipped this check could point calls at
 * another tenant's profile. The end-of-call gate (`bridge-analysis-hooks.ts`)
 * also checks the owner before snapshotting, but only a refusal here tells the
 * operator.
 *
 * ── Why `scope` is a parameter, and required ───────────────────────────────
 *
 * Analysis *execution* is gated per product at the end-of-call gate
 * (`analysisFlagFor`), so the preflight resolves its flag through the same
 * mapping instead of hardcoding one. A preflight asking a different flag than the
 * gate refuses a campaign whose analysis is switched on and accepts one whose is
 * not — inconsistent in both directions. The writer knows which product it is, so
 * it says so.
 *
 * Required and undefaulted, for the reason the repository's `scope` is: a default
 * type-checks at every call site and audits none of them, and the wrong default
 * here is a silent 403 on a paid feature.
 */
export async function preflightAnalysisProfile(
  profileId: string | null | undefined,
  tenantId: string,
  accountId: string,
  scope: WebRtcCallScope,
): Promise<AnalysisPreflightError | null> {
  if (!profileId) return null;

  const enabled = await getFeatureFlagService().isEnabled(analysisFlagFor(scope), { tenantId, accountId });
  if (!enabled) {
    return {
      status: 403,
      error: 'Feature Not Enabled',
      code: 'analysis_not_enabled',
      // Naming the product the caller asked about, so the operator is sent to the
      // switch that actually controls it.
      message: scope === 'agency'
        ? 'Agency call analysis is not enabled for this account.'
        : 'Dialer call analysis is not enabled for this account.',
    };
  }
  const profile = await callAnalysisProfileRepository.findByIdScoped(profileId, tenantId, accountId);
  if (!profile) {
    return {
      status: 404,
      error: 'Not Found',
      code: 'analysis_profile_not_found',
      message: 'Analysis profile not found',
    };
  }
  return null;
}
