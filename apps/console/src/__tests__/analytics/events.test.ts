import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as posthog from '../../analytics/posthog';
import {
  trackAuthAttempted,
  trackAuthSucceeded,
  trackAuthFailed,
  trackEmailVerificationRequired,
  trackSetupEvent,
  trackFeatureGateUnavailable,
  trackExportEvent,
  trackApiErrorEvent,
  trackAgencyWaitingForDialer,
  trackAgencyInviteClaimSucceeded,
  trackWorkspaceInviteViewed,
  trackWorkspaceInviteClaimAttempted,
  trackWorkspaceInviteClaimSucceeded,
  trackWorkspaceInviteClaimFailed,
  trackWorkspaceInviteAddressMismatch,
  track,
  type AnalyticsPath,
} from '../../analytics/events';

/**
 * The catalog's only responsibility is mapping each typed emitter to a stable
 * event name + the exact props it was given, via the shared captureEvent
 * wrapper. We spy on the wrapper and assert that contract.
 */
describe('analytics/events catalog', () => {
  let capture: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    capture = vi.spyOn(posthog, 'captureEvent').mockImplementation(() => {});
  });

  it('emits auth lifecycle events with enum-only payloads', () => {
    capture.mockClear();
    trackAuthAttempted({ action: 'signup', provider: 'email' });
    trackAuthSucceeded({ action: 'login', provider: 'google', is_new: false, needs_phone: false });
    trackAuthFailed({ action: 'password_reset', provider: 'email', reason: 'auth_error' });

    expect(capture).toHaveBeenNthCalledWith(1, 'auth_attempted', {
      action: 'signup',
      provider: 'email',
    });
    expect(capture).toHaveBeenNthCalledWith(2, 'auth_succeeded', {
      action: 'login',
      provider: 'google',
      is_new: false,
      needs_phone: false,
    });
    expect(capture).toHaveBeenNthCalledWith(3, 'auth_failed', {
      action: 'password_reset',
      provider: 'email',
      reason: 'auth_error',
    });
  });

  // Auth events only: there are no onboarding events, because there is no
  // `/onboarding` route (no self-serve sign-up).
  it('supports the broadened auth and onboarding enums from the shared catalog', () => {
    capture.mockClear();
    trackAuthFailed({ action: 'login', provider: 'google', reason: 'validation_error' });
    trackAuthFailed({ action: 'signup', provider: 'email', reason: 'session_error' });
    trackAuthFailed({ action: 'password_reset', provider: 'google', reason: 'unknown_error' });
    trackEmailVerificationRequired({ source: 'login' });

    expect(capture).toHaveBeenNthCalledWith(1, 'auth_failed', {
      action: 'login',
      provider: 'google',
      reason: 'validation_error',
    });
    expect(capture).toHaveBeenNthCalledWith(2, 'auth_failed', {
      action: 'signup',
      provider: 'email',
      reason: 'session_error',
    });
    expect(capture).toHaveBeenNthCalledWith(3, 'auth_failed', {
      action: 'password_reset',
      provider: 'google',
      reason: 'unknown_error',
    });
    expect(capture).toHaveBeenNthCalledWith(4, 'email_verification_required', {
      source: 'login',
    });
  });

  // Six emitters over what the catalog keeps: the team-invite setup event, an
  // agency capability gate, an agency export scope. There are no
  // messaging-connection or credit emitters.
  it('emits setup, monetization, gating, export, and reliability catalog events', () => {
    capture.mockClear();
    const typedPath = '/proxy/agency/campaigns' as AnalyticsPath;

    trackSetupEvent('team_invite_sent', { role: 'agent', account_scoped: true });
    trackFeatureGateUnavailable({ gate_type: 'capability', gate: 'agency' });
    trackExportEvent('csv_export_succeeded', { scope: 'agency_activity', field_count: 4 });
    trackApiErrorEvent({ status: 500, path: typedPath, request_id: 'req_1' });

    expect(capture).toHaveBeenNthCalledWith(1, 'team_invite_sent', {
      role: 'agent',
      account_scoped: true,
    });
    expect(capture).toHaveBeenNthCalledWith(2, 'feature_gate_unavailable', {
      gate_type: 'capability',
      gate: 'agency',
    });
    expect(capture).toHaveBeenNthCalledWith(3, 'csv_export_succeeded', {
      scope: 'agency_activity',
      field_count: 4,
    });
    expect(capture).toHaveBeenNthCalledWith(4, 'api_error', {
      status: 500,
      path: typedPath,
      request_id: 'req_1',
    });
  });

  // The broadened surface the catalog keeps: both team-invite events, the agency
  // feature-flag gate, an agency export failure (`incomplete_source`, the activity
  // trail's 424) and an api error. There are no contact-list, audio, API-key,
  // messaging or credit emitters.
  it('supports the broadened setup, messaging, credit, gate, export, and api-error catalog surface', () => {
    capture.mockClear();
    const typedPath = '/proxy/agency/campaigns' as AnalyticsPath;

    trackSetupEvent('team_invite_sent', {
      role: 'account_admin',
      account_scoped: true,
    });
    trackSetupEvent('team_invite_failed', {
      role: 'viewer',
      account_scoped: false,
      reason: 'unknown_error',
    });
    trackFeatureGateUnavailable({
      gate_type: 'feature_flag',
      gate: 'agency_dialer_enabled',
    });
    trackExportEvent('csv_export_failed', {
      scope: 'agency_activity',
      field_count: 8,
      reason: 'incomplete_source',
    });
    trackApiErrorEvent({ status: 503, path: typedPath });

    expect(capture).toHaveBeenNthCalledWith(1, 'team_invite_sent', {
      role: 'account_admin',
      account_scoped: true,
    });
    expect(capture).toHaveBeenNthCalledWith(2, 'team_invite_failed', {
      role: 'viewer',
      account_scoped: false,
      reason: 'unknown_error',
    });
    expect(capture).toHaveBeenNthCalledWith(3, 'feature_gate_unavailable', {
      gate_type: 'feature_flag',
      gate: 'agency_dialer_enabled',
    });
    expect(capture).toHaveBeenNthCalledWith(4, 'csv_export_failed', {
      scope: 'agency_activity',
      field_count: 8,
      reason: 'incomplete_source',
    });
    expect(capture).toHaveBeenNthCalledWith(5, 'api_error', {
      status: 503,
      path: typedPath,
    });
  });

  // The compile-time rejections, over the agency gate ids (`agency`,
  // `agency_dialer_enabled`).
  it('rejects arbitrary raw strings for branded API paths and feature gate ids at compile time', () => {
    // @ts-expect-error Analytics paths must come from a branded sanitizer/helper.
    trackApiErrorEvent({ status: 503, path: '/api/v1/messages' });

    // @ts-expect-error Arbitrary strings are not valid capability gate ids.
    trackFeatureGateUnavailable({ gate_type: 'capability', gate: 'campaigns unavailable copy' });

    // @ts-expect-error Arbitrary strings are not valid feature flag gate ids.
    trackFeatureGateUnavailable({ gate_type: 'feature_flag', gate: 'dashboard.export.csv' });

    // @ts-expect-error Capability gates cannot be passed with the feature_flag discriminator.
    trackFeatureGateUnavailable({ gate_type: 'feature_flag', gate: 'agency' });

    // @ts-expect-error Feature-flag gates cannot be passed with the capability discriminator.
    trackFeatureGateUnavailable({ gate_type: 'capability', gate: 'agency_dialer_enabled' });

    expect(true).toBe(true);
  });

  it('emits the workspace invite funnel under its own names, with the agency funnel’s shapes', () => {
    /*
      `/join/:token` runs the agency page's claim flow for every non-agent role.
      Its five events are separate NAMES so the agency funnel keeps counting only
      agents joining a calling floor — and the SAME property shapes, so the two
      funnels cannot come to measure different things. Both halves asserted.
    */
    capture.mockClear();
    trackWorkspaceInviteViewed({ status: 'pending', role: 'operator', has_inviter: true });
    trackWorkspaceInviteClaimAttempted({ method: 'google' });
    trackWorkspaceInviteClaimSucceeded({ method: 'google', address_matched: false });
    trackWorkspaceInviteClaimFailed({ method: 'create', reason: 'weak_password' });
    trackWorkspaceInviteAddressMismatch({ outcome: 'shown' });
    trackAgencyInviteClaimSucceeded({ method: 'google', address_matched: false });

    expect(capture.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      'workspace_invite_viewed',
      'workspace_invite_claim_attempted',
      'workspace_invite_claim_succeeded',
      'workspace_invite_claim_failed',
      'workspace_invite_address_mismatch',
      'agency_invite_claim_succeeded',
    ]);
    // One shape, two names.
    expect(capture.mock.calls[2]?.[1]).toEqual(capture.mock.calls[5]?.[1]);

    // @ts-expect-error — the funnel's reasons are a closed set on both families
    trackWorkspaceInviteClaimFailed({ method: 'create', reason: 'something_else' });
  });

  it('routes every emitter through the generic track, name and shape from the catalog', () => {
    capture.mockClear();
    track('agency_waiting_for_dialer', { campaign_id: 'camp-1' });
    trackAgencyWaitingForDialer({ campaign_id: 'camp-2' });
    expect(capture).toHaveBeenNthCalledWith(1, 'agency_waiting_for_dialer', { campaign_id: 'camp-1' });
    expect(capture).toHaveBeenNthCalledWith(2, 'agency_waiting_for_dialer', { campaign_id: 'camp-2' });

    // Compile-time half: an undeclared name, or another event's shape, does not type-check.
    // @ts-expect-error — not a catalogued event
    posthog.captureEvent('agency_not_an_event', {});
    // @ts-expect-error — `campaign_id` is this event's whole shape
    track('agency_waiting_for_dialer', { campaign: 'camp-1' });
  });
});
