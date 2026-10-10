import { describe, it, expect } from 'vitest';
import {
  AGENCY_ANALYTICS_CAPABILITY,
  AGENCY_RECORDING_CAPABILITY,
  NO_ANALYSIS_PROFILE,
  analysisGate,
  campaignSaveRefusal,
  payloadSetsProfile,
  recordingGate,
  recordingPayload,
  recordingStateFromCampaign,
  resolveProfileId,
  storedProfileStatus,
} from '../../utils/agencyCampaignRecording';
import type { AgencyCampaign } from '../../types/agency-campaign';
import type { CallAnalysisProfile } from '../../types/call-analysis-profile';

function campaign(over: Partial<AgencyCampaign> = {}): AgencyCampaign {
  return { id: 'camp-1', name: 'C', status: 'paused', ...over };
}

function profile(over: Partial<CallAnalysisProfile> = {}): CallAnalysisProfile {
  return {
    id: 'prof-1',
    tenant_id: 't-1',
    account_id: 'a-1',
    name: 'QA',
    description: null,
    context: null,
    custom_dimensions: [],
    language_hint: null,
    is_default: false,
    is_active: true,
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

/**
 * The console cannot import the server's constants, so these literals are the only thing
 * keeping the console's gate pointed at the capability the API actually enforces. A
 * rename on either side turns the gate into decoration: `useGovernance`
 * fails OPEN, so a key nobody publishes reads as "enabled" and the control is
 * offered to a tenant the server will 403.
 */
describe('capability keys — pinned against the API', () => {
  it('mirrors the two keys `assertCampaignBehavioralCapabilities` passes to `assertCapability`', () => {
    // The campaign routes on the server:
    //   assertCapability(request, reply, 'agency.recording')   ← record_calls
    //   assertCapability(request, reply, 'agency.analytics')   ← analysis_profile_id
    // and the server's governance catalog declares both with
    // `parent: 'agency', default: false, enforcement: ['nav','behavioral']`.
    expect(AGENCY_RECORDING_CAPABILITY).toBe('agency.recording');
    expect(AGENCY_ANALYTICS_CAPABILITY).toBe('agency.analytics');
  });

  // There is no separate profile-LIST capability: agency has no
  // `calls.dialer.analytics`, so only the profile-WRITE capability is pinned.
});

describe('recordingStateFromCampaign', () => {
  it('defaults to off / no profile', () => {
    expect(recordingStateFromCampaign(campaign())).toEqual({
      record: false,
      profileId: NO_ANALYSIS_PROFILE,
    });
  });

  it('uses `??` so a stored `false` is not re-seeded as the default', () => {
    // `||` would be indistinguishable here today, and would silently break the
    // day the default flips — the same trap `wrapup_auto_return` documents.
    expect(recordingStateFromCampaign(campaign({ record_calls: false })).record).toBe(false);
    expect(recordingStateFromCampaign(campaign({ record_calls: true })).record).toBe(true);
  });

  it('carries a stored profile id through unchanged', () => {
    expect(recordingStateFromCampaign(campaign({ analysis_profile_id: 'p-1' })).profileId).toBe(
      'p-1',
    );
    expect(recordingStateFromCampaign(campaign({ analysis_profile_id: null })).profileId).toBe(
      NO_ANALYSIS_PROFILE,
    );
  });
});

describe('recordingGate — only ENABLING is refused', () => {
  it('is unconstrained with the capability on', () => {
    expect(recordingGate({ enabled: true, current: false })).toEqual({
      canEnable: true,
      notice: null,
    });
    expect(recordingGate({ enabled: true, current: true }).canEnable).toBe(true);
  });

  it('refuses turning recording ON, and names the capability rather than going silent', () => {
    const gate = recordingGate({ enabled: false, current: false });
    expect(gate.canEnable).toBe(false);
    expect(gate.notice).toContain('agency.recording');
  });

  /**
   * THE case this whole asymmetry exists for. With the capability off and
   * recording already on, the tenant must still be able to turn it off —
   * disabling the control would trap them in exactly the state the capability
   * exists to prevent, which is worse than not shipping the control at all.
   */
  it('still explains the on→off path when recording is already on', () => {
    const gate = recordingGate({ enabled: false, current: true });
    expect(gate.canEnable).toBe(false);
    expect(gate.notice).toContain('switch it off');
    expect(gate.notice).toContain('agency.recording');
  });
});

describe('analysisGate', () => {
  it('is unconstrained with the capability on', () => {
    expect(analysisGate({ enabled: true, current: NO_ANALYSIS_PROFILE })).toEqual({
      canEnable: true,
      notice: null,
    });
  });

  it('says nothing when the capability is off and nothing is set', () => {
    expect(analysisGate({ enabled: false, current: NO_ANALYSIS_PROFILE })).toEqual({
      canEnable: false,
      notice: null,
    });
  });

  it('offers the clearing path when the capability is off but a profile is set', () => {
    const gate = analysisGate({ enabled: false, current: 'p-1' });
    expect(gate.canEnable).toBe(false);
    expect(gate.notice).toContain('remove it');
    expect(gate.notice).toContain('agency.analytics');
  });
});

describe('resolveProfileId', () => {
  it('maps the sentinel and the empty string to an explicit null', () => {
    expect(resolveProfileId(NO_ANALYSIS_PROFILE)).toBeNull();
    expect(resolveProfileId('')).toBeNull();
    expect(resolveProfileId('p-1')).toBe('p-1');
  });
});

/**
 * `useCallAnalysisProfiles` initialises `profiles` to `[]`, which is
 * indistinguishable from a list that genuinely does not carry the campaign's
 * profile unless `loading`/`error` are consulted too. Distinguishing pending,
 * failed and settled-and-absent — not just the last of the three — is the
 * acceptance criterion.
 */
describe('storedProfileStatus', () => {
  const LISTED = [profile({ id: 'prof-1' }), profile({ id: 'prof-2' })];

  it('is `found` when nothing is stored', () => {
    expect(
      storedProfileStatus({ storedProfileId: null, profiles: [], loading: true, error: null }),
    ).toBe('found');
  });

  it('is `found` when the stored id IS in a settled list', () => {
    expect(
      storedProfileStatus({
        storedProfileId: 'prof-1',
        profiles: LISTED,
        loading: false,
        error: null,
      }),
    ).toBe('found');
  });

  /**
   * Bug #1: the transient flash. `profiles` is `[]` while the fetch is in
   * flight — the same shape as a genuinely empty account — so a stored id must
   * NOT be declared missing until the fetch has actually answered.
   */
  it('is `pending`, not `unlisted`, while the fetch is in flight — even against an empty list', () => {
    expect(
      storedProfileStatus({
        storedProfileId: 'prof-1',
        profiles: [],
        loading: true,
        error: null,
      }),
    ).toBe('pending');
  });

  /**
   * Bug #2: a load failure worded as a deletion. The list is `[]` because the
   * fetch never returned anything, not because the account has no profiles —
   * that is not evidence the stored profile is gone.
   */
  it('is `pending`, not `unlisted`, when the fetch failed', () => {
    expect(
      storedProfileStatus({
        storedProfileId: 'prof-1',
        profiles: [],
        loading: false,
        error: 'network error',
      }),
    ).toBe('pending');
  });

  it('is `unlisted` only once the fetch has SETTLED SUCCESSFULLY and the id is genuinely absent', () => {
    expect(
      storedProfileStatus({
        storedProfileId: 'prof-gone',
        profiles: LISTED,
        loading: false,
        error: null,
      }),
    ).toBe('unlisted');
  });

  it('prefers `found` over `pending`/`unlisted` if the id turns up mid-error somehow', () => {
    // Defensive: a stale error alongside a list that does carry the id should
    // not blank out a profile that IS there.
    expect(
      storedProfileStatus({
        storedProfileId: 'prof-1',
        profiles: LISTED,
        loading: false,
        error: 'stale error',
      }),
    ).toBe('found');
  });
});

describe('recordingPayload — what actually goes on the wire', () => {
  it('sends both fields when both capabilities are on', () => {
    expect(
      recordingPayload({
        recordingEnabled: true,
        analyticsEnabled: true,
        next: { record: true, profileId: 'p-1' },
      }),
    ).toEqual({ record_calls: true, analysis_profile_id: 'p-1' });
  });

  it('sends `record_calls: false` rather than omitting it', () => {
    // The column defaults to false, so omitting looks harmless and is not: with
    // the field absent from every PATCH, an operator who turned recording on
    // could never turn it back off.
    expect(
      recordingPayload({
        recordingEnabled: true,
        analyticsEnabled: true,
        next: { record: false, profileId: NO_ANALYSIS_PROFILE },
      }),
    ).toEqual({ record_calls: false, analysis_profile_id: null });
  });

  it('OMITS `record_calls` when the capability is off and the value would enable', () => {
    // The API answers 403 rather than stripping, so sending the unchanged `true`
    // would make a capability-off tenant unable to save an unrelated edit.
    const payload = recordingPayload({
      recordingEnabled: false,
      analyticsEnabled: false,
      next: { record: true, profileId: NO_ANALYSIS_PROFILE },
    });
    expect('record_calls' in payload).toBe(false);
  });

  it('SENDS `record_calls: false` with the capability off — the on→off path', () => {
    const payload = recordingPayload({
      recordingEnabled: false,
      analyticsEnabled: false,
      next: { record: false, profileId: NO_ANALYSIS_PROFILE },
    });
    expect(payload.record_calls).toBe(false);
  });

  it('OMITS a non-null profile when `agency.analytics` is off', () => {
    const payload = recordingPayload({
      recordingEnabled: true,
      analyticsEnabled: false,
      next: { record: true, profileId: 'p-1' },
    });
    expect('analysis_profile_id' in payload).toBe(false);
  });

  it('SENDS `analysis_profile_id: null` with the capability off — the clearing path', () => {
    const payload = recordingPayload({
      recordingEnabled: true,
      analyticsEnabled: false,
      next: { record: true, profileId: NO_ANALYSIS_PROFILE },
    });
    expect(payload.analysis_profile_id).toBeNull();
  });

  it('reports whether the payload carried an ENABLING profile', () => {
    expect(payloadSetsProfile({ analysis_profile_id: 'p-1' })).toBe(true);
    expect(payloadSetsProfile({ analysis_profile_id: null })).toBe(false);
    expect(payloadSetsProfile({})).toBe(false);
  });
});

/** Shaped like the `ApiError` the client throws: `statusCode` + parsed `details`. */
function apiError(statusCode: number, details: unknown) {
  return Object.assign(new Error('ignored'), { statusCode, details });
}

describe('campaignSaveRefusal — the five refusals, in the shape they actually arrive', () => {
  const noProfile = { sentAnalysisProfile: false };
  const withProfile = { sentAnalysisProfile: true };

  it('names `agency.recording` on the API’s capability 403', () => {
    // The server raises this BEFORE reaching the dialer runtime, so `sawCoreErrorStatus` is false
    // and the body reaches the browser unchanged. `ApiError` reduces it to the
    // message `'capability_disabled'` — a wire token, not an explanation.
    const message = campaignSaveRefusal(
      apiError(403, { error: 'capability_disabled', capability: 'agency.recording' }),
      noProfile,
    );
    expect(message).toContain('agency.recording');
    expect(message).toContain('Switching recording off is always allowed.');
    expect(message).not.toContain('capability_disabled');
  });

  it('names `agency.analytics` on the profile capability 403', () => {
    const message = campaignSaveRefusal(
      apiError(403, { error: 'capability_disabled', capability: 'agency.analytics' }),
      withProfile,
    );
    expect(message).toContain('agency.analytics');
    expect(message).toContain('Removing a summary profile is always allowed.');
  });

  it('names an unknown capability rather than falling back to the bare token', () => {
    const message = campaignSaveRefusal(
      apiError(403, { error: 'capability_disabled', capability: 'agency.something_new' }),
      noProfile,
    );
    expect(message).toContain('agency.something_new');
  });

  it('forwards the API’s `Feature Not Enabled` message and adds the way out', () => {
    // `Feature Not Enabled` is the one 4xx label on the API's
    // FORWARDABLE_ERROR_LABELS allow-list, so its message survives masking.
    const message = campaignSaveRefusal(
      apiError(403, {
        error: 'Feature Not Enabled',
        message: 'Dialer call analysis is not enabled for this account.',
      }),
      withProfile,
    );
    expect(message).toContain('Dialer call analysis is not enabled for this account.');
    expect(message).toContain('No summary');
  });

  it('forwards `Feature Not Enabled` without the summary advice when no profile was sent', () => {
    const message = campaignSaveRefusal(
      apiError(403, { error: 'Feature Not Enabled', message: 'Agency dialer is not enabled for this account.' }),
      noProfile,
    );
    expect(message).toBe('Agency dialer is not enabled for this account.');
  });

  /**
   * ⚠️ The API's `{ error: 'Not Found', message: 'Analysis profile not found' }`
   * NEVER reaches the browser: `'Not Found'` is not on the API's allow-list and
   * the body carries no `details`, so the error-mask hook rewrites it to the
   * generic "contact support and quote the request ID". The only evidence left
   * is that WE sent a profile id — which is why the refusal takes that as
   * context instead of reading the body.
   */
  it('explains a masked 404 when the save carried a profile id', () => {
    const masked = apiError(404, {
      error: 'Request Failed',
      message: 'Something went wrong while processing your request.',
      statusCode: 404,
      requestId: 'req-1',
    });
    expect(campaignSaveRefusal(masked, withProfile)).toContain('no longer available');
  });

  it('does NOT claim a profile problem on a 404 the save could not have caused', () => {
    const masked = apiError(404, { error: 'Request Failed', message: 'gone' });
    expect(campaignSaveRefusal(masked, noProfile)).toBeNull();
  });

  it('claims the profile outright when the API NAMES it, masked or not', () => {
    const named = apiError(404, {
      error: 'Not Found',
      code: 'analysis_profile_not_found',
      message: 'Analysis profile not found',
    });
    expect(campaignSaveRefusal(named, withProfile)).toContain('no longer available');
  });

  /**
   * The case the codeless-only guess gets wrong, and the reason this is not
   * `status === 404 && sentAnalysisProfile`.
   *
   * `campaign_not_found` is on the server's error allow-list, so it arrives UNMASKED with a
   * real message. The settings page sits under a persistent account switcher, so
   * switching account mid-edit and saving produces exactly this — while a
   * profile is still selected. Blaming the profile sends the operator to pick a
   * different one; they pick "No summary", save, and get the identical 404 with
   * nothing naming the real problem. Falling through lets the true message show.
   */
  it('does NOT blame the profile for a 404 that names a DIFFERENT cause', () => {
    for (const code of ['campaign_not_found', 'announcement_not_found']) {
      const other = apiError(404, { error: 'Not Found', code, message: 'Campaign not found' });
      expect(campaignSaveRefusal(other, withProfile), code).toBeNull();
    }
  });

  it('leaves the 400 to the existing field-error path', () => {
    // `{ details: { analysis_profile_id } }` survives masking and
    // `fieldErrorsFromResponse` lands it on the field. A banner too would say it
    // twice, in two places, about one mistake.
    const validation = apiError(400, {
      error: 'Validation failed',
      details: { analysis_profile_id: 'must be a call-analysis profile id, or null to clear it' },
    });
    expect(campaignSaveRefusal(validation, withProfile)).toBeNull();
  });

  it('returns null for anything it does not recognise', () => {
    expect(campaignSaveRefusal(new Error('boom'), noProfile)).toBeNull();
    expect(campaignSaveRefusal(null, noProfile)).toBeNull();
    expect(campaignSaveRefusal(apiError(500, { error: 'Internal Error' }), withProfile)).toBeNull();
  });
});
