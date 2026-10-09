import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * New (magick-agency): core has no dedicated unit test for `profile-preflight.ts`
 * (it is exercised through `campaign-retry-route.test.ts` and the campaign routes,
 * which are lane B's). These cover its contract directly: no id -> null, the owning
 * product's flag (agency_call_analysis) gates it, and the profile must be active and
 * owned by the caller's tenant/account.
 */
const mocks = vi.hoisted(() => ({
  isEnabled: vi.fn(),
  findByIdScoped: vi.fn(),
}));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({ isEnabled: mocks.isEnabled }),
}));
vi.mock('@magick-agency/db/repositories/call-analysis-profile.repository', () => ({
  callAnalysisProfileRepository: { findByIdScoped: mocks.findByIdScoped },
}));

import { preflightAnalysisProfile } from '../../../src/analysis/profile-preflight.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isEnabled.mockResolvedValue(true);
  mocks.findByIdScoped.mockResolvedValue({ id: 'p1' });
});

describe('preflightAnalysisProfile', () => {
  it.each([null, undefined, ''])('no profile selected (%j) ⇒ null, nothing consulted', async (id) => {
    expect(await preflightAnalysisProfile(id, 't1', 'a1', 'agency')).toBeNull();
    expect(mocks.isEnabled).not.toHaveBeenCalled();
    expect(mocks.findByIdScoped).not.toHaveBeenCalled();
  });

  it('flag off ⇒ 403 with the agency wording and a code the console can read', async () => {
    mocks.isEnabled.mockResolvedValue(false);
    expect(await preflightAnalysisProfile('p1', 't1', 'a1', 'agency')).toEqual({
      status: 403,
      error: 'Feature Not Enabled',
      code: 'analysis_not_enabled',
      message: 'Agency call analysis is not enabled for this account.',
    });
    expect(mocks.isEnabled.mock.calls[0]![0]).toMatchObject({ key: 'agency_call_analysis' });
    expect(mocks.isEnabled.mock.calls[0]![1]).toEqual({ tenantId: 't1', accountId: 'a1' });
    expect(mocks.findByIdScoped).not.toHaveBeenCalled();
  });

  it('unknown, inactive or foreign profile ⇒ 404 analysis_profile_not_found (scoped lookup)', async () => {
    mocks.findByIdScoped.mockResolvedValue(null);
    expect(await preflightAnalysisProfile('p1', 't1', 'a1', 'agency')).toEqual({
      status: 404, error: 'Not Found', code: 'analysis_profile_not_found', message: 'Analysis profile not found',
    });
    expect(mocks.findByIdScoped).toHaveBeenCalledWith('p1', 't1', 'a1');
  });

  it('flag on and profile owned ⇒ null', async () => {
    expect(await preflightAnalysisProfile('p1', 't1', 'a1', 'agency')).toBeNull();
  });
});
