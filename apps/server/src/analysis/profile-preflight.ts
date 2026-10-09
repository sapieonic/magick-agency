import { getFeatureFlagService } from '../feature-flags/index.js';
import { callAnalysisProfileRepository } from '@magick-agency/db/repositories/call-analysis-profile.repository';
import { analysisFlagFor } from '@magick-agency/db/repositories/agency-call.repository';
import type { WebRtcCallScope } from '@magick-agency/db/repositories/agency-call.repository';

/**
 * Ready-to-send rejection for an unusable `analysis_profile_id`.
 *
 * `code` is not decoration. magick-master's error mask rewrites any core 4xx that
 * is not "structured" into "contact support and quote this request id", and
 * structured means an allow-listed `code`, an allow-listed `error` label, or a
 * `details` object. A bare `{error, message}` 404 therefore never reaches the
 * browser — and this is the one refusal here an operator can fix in a single
 * click by picking a different profile, so it is precisely the wrong one to
 * lose. Every sibling refusal in `agency-campaigns.routes.ts` already carries a
 * code (`feature_disabled`, `campaign_not_found`, `announcement_not_found`) for
 * the same reason.
 */
export interface AnalysisPreflightError {
  status: number;
  error: string;
  code: string;
  message: string;
}

/**
 * Request-time validation for an `analysis_profile_id` (mirrors
 * `preflightSipConnection`): checks the owning product's analysis flag is on for
 * this tenant/account, and that the profile exists, is active, and is owned by
 * them. Returns null when no profile was selected or everything is valid.
 *
 * **This lives here, not in a route, because there are two writers.** A browser
 * dialer call carries the profile id per call (`POST /api/v1/webrtc-call`); an
 * agency call inherits it from `agency_campaigns.analysis_profile_id`, stamped
 * onto the leg at dial time. Both end up in the same column and are read back by
 * the same end-of-call gate — and that gate resolves the profile with the
 * UNSCOPED `callAnalysisProfileRepository.findById`, because by then the id is
 * treated as already-trusted. So the ownership check has to happen at every
 * write, or the one writer that skips it can point a call at another tenant's
 * profile and get that tenant's `context` and `custom_dimensions` snapshotted
 * into its analysis job. `AD-P4-C-03` (b) — "identical in shape to a dialer
 * call's" — is only true if both writers refuse the same ids.
 *
 * ── Why `scope` is a parameter, and required ───────────────────────────────
 *
 * Having two writers is also why the flag cannot be hardcoded here. Analysis
 * *execution* is gated per product at the end-of-call gate (`analysisFlagFor`),
 * so a preflight that asked `dialer_call_analysis` for both writers refused an
 * agency campaign whose analysis is switched on and enabled one whose is not —
 * inconsistent in both directions, and the 403 direction locked an agency-only
 * tenant out of the very feature the flag split exists to sell them
 * (`docs/agency-dialer-design.md` §7b). Each writer knows which product it is,
 * so each says so.
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
      // Naming the product the caller asked about, not the one that happens to
      // share the machinery: "Dialer call analysis is off" on an agency campaign
      // edit sends the operator to the softphone's settings page, which is not
      // where the switch is.
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
