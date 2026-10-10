/**
 * Campaign recording + call-summary opt-in.
 *
 * Two fields on an agency campaign — `record_calls` and `analysis_profile_id` —
 * were settable by nothing but curl. The server reads both,
 * the API's governance catalog has declared `agency.recording` / `agency.analytics`
 * since the catalog was written, and the API now actually
 * refuses them to a capability-off tenant. No UI offered either field to anyone,
 * so the two capabilities guarded a surface that did not exist.
 *
 * Pure, per the house pattern (`agencyCampaignConfigForm.ts`,
 * `analysisProfileForm.ts`) — no form library anywhere in this SPA.
 *
 * ── The rule that is easy to get backwards ───────────────────────────────────
 * **The API refuses only ENABLING.** `record_calls: false`, an absent
 * `record_calls`, and `analysis_profile_id: null` all pass **even with the
 * capability off** — deliberately, so a tenant that LOSES the capability can
 * still edit the campaign and, the case that matters, can still turn recording
 * OFF. {@link recordingGate} and {@link recordingPayload} preserve that: with
 * `agency.recording` off and recording currently on, the control stays usable in
 * the on→off direction only. Disabling or hiding it outright would trap the
 * tenant in exactly the state the capability exists to prevent, which is worse
 * than not shipping the control at all.
 */

import type { AgencyCampaign } from '../types/agency-campaign';
import type { CallAnalysisProfile } from '../types/call-analysis-profile';

/**
 * The two capability keys, mirrored exactly from the API's frozen governance
 * catalog and from the strings
 * `assertBehavioralCapabilitiesForConfig` checks in the server's
 * `agency/campaign-behavioral-settings.ts` (called from `proxy-agency-campaigns.routes.ts`).
 *
 * The server and this console cannot share a constant, so the unit test that pins these
 * against the same literals the API enforces is the only thing keeping them from
 * drifting into a gate that silently guards nothing.
 */
export const AGENCY_RECORDING_CAPABILITY = 'agency.recording';
export const AGENCY_ANALYTICS_CAPABILITY = 'agency.analytics';

/*
 * There is no separate capability for READING the profile list: the list is
 * gated on the
 * `agency.analysis_profiles.read` permission alone, so a tenant that may write
 * the field may always read the list.
 */

/**
 * The server's code for "that analysis profile isn't yours / doesn't exist"
 * (`profile-preflight.ts`). Mirrored exactly, like the capability keys above.
 *
 * It exists so this refusal can be identified rather than guessed at. Until
 * the API allow-lists it the body still arrives masked and codeless — which is
 * why {@link isProfile404} keeps the codeless fallback rather than switching to
 * the code alone.
 */
export const ANALYSIS_PROFILE_NOT_FOUND_CODE = 'analysis_profile_not_found';

/** Sentinel for "no summary" — maps to an explicit `null` on the wire. */
export const NO_ANALYSIS_PROFILE = '__none__';

export interface CampaignRecordingState {
  record: boolean;
  /** {@link NO_ANALYSIS_PROFILE} or a profile id. Never the empty string. */
  profileId: string;
}

/**
 * Seed the form from the campaign.
 *
 * `??`, not `||`, on `record_calls` for the same reason `wrapup_auto_return`
 * uses it: `false` is a real stored value, and the default is off.
 */
export function recordingStateFromCampaign(campaign: AgencyCampaign): CampaignRecordingState {
  return {
    record: campaign.record_calls ?? false,
    profileId: campaign.analysis_profile_id ?? NO_ANALYSIS_PROFILE,
  };
}

export interface CapabilityGate {
  /** Whether the control may be operated in the ON direction. */
  canEnable: boolean;
  /**
   * Why the control is limited, naming the capability — or null when there is
   * nothing to explain. A control that silently vanishes teaches an operator
   * that the platform is broken; one that names its gate teaches them who to ask.
   */
  notice: string | null;
}

/**
 * The recording toggle's state.
 *
 * `enabled` here is the governance capability, `current` is what the form holds
 * right now (not what was loaded) — so once an operator switches a grandfathered
 * campaign off, the control correctly locks, because switching it back on is the
 * thing the API refuses.
 */
export function recordingGate(args: { enabled: boolean; current: boolean }): CapabilityGate {
  if (args.enabled) return { canEnable: true, notice: null };
  if (args.current) {
    return {
      canEnable: false,
      notice:
        `Call recording is turned off for this account (${AGENCY_RECORDING_CAPABILITY}), but this ` +
        'campaign still has it on. You can switch it off here; you will not be able to switch it ' +
        'back on until an administrator enables recording.',
    };
  }
  return {
    canEnable: false,
    notice:
      `Call recording is turned off for this account (${AGENCY_RECORDING_CAPABILITY}). ` +
      'Ask an administrator to enable it before recording campaign calls.',
  };
}

/**
 * The call-summary control's state. Same asymmetry as recording: a profile that
 * is already set can always be cleared, because `analysis_profile_id: null`
 * passes the API's guard with the capability off.
 */
export function analysisGate(args: { enabled: boolean; current: string }): CapabilityGate {
  if (args.enabled) return { canEnable: true, notice: null };
  if (args.current !== NO_ANALYSIS_PROFILE) {
    return {
      canEnable: false,
      notice:
        `Call summaries are turned off for this account (${AGENCY_ANALYTICS_CAPABILITY}), but this ` +
        'campaign still has a summary profile set. You can remove it here; you will not be able to ' +
        'set another until an administrator enables call summaries.',
    };
  }
  return { canEnable: false, notice: null };
}

/** The `analysis_profile_id` the form state resolves to on the wire. */
export function resolveProfileId(profileId: string): string | null {
  return profileId === NO_ANALYSIS_PROFILE || profileId === '' ? null : profileId;
}

/**
 * Whether the stored profile id is present in the fetched list — and, when it
 * is not, whether that absence means anything.
 *
 * `useCallAnalysisProfiles` initialises `profiles` to `[]`, which by itself is
 * indistinguishable from a list that genuinely does not contain the campaign's
 * profile. Reading the empty array alone therefore produced two wrong readings:
 * a "no longer listed" flash on every page load, while the fetch was still in
 * flight, and the same verdict rendered alongside a *fetch failure* — a load
 * that never happened relabelled as a deletion.
 *
 *  - `'found'` — nothing is stored, or the stored id IS in the list.
 *  - `'pending'` — a non-null stored id is missing from the list, but the list
 *    is not evidence of anything yet: the fetch is still in flight, or it
 *    failed. Render the stored id plainly, with no verdict.
 *  - `'unlisted'` — a non-null stored id is missing from a list that finished
 *    loading successfully. This is the one case the id is genuinely gone —
 *    deactivated, deleted, or on a page this fetch did not request.
 */
export type StoredProfileStatus = 'found' | 'pending' | 'unlisted';

export function storedProfileStatus(args: {
  storedProfileId: string | null;
  profiles: CallAnalysisProfile[];
  loading: boolean;
  error: string | null;
}): StoredProfileStatus {
  const { storedProfileId, profiles, loading, error } = args;
  if (storedProfileId === null) return 'found';
  if (profiles.some((p) => p.id === storedProfileId)) return 'found';
  if (loading || error !== null) return 'pending';
  return 'unlisted';
}

/**
 * The two fields' contribution to the PATCH body.
 *
 * A field is **omitted**, not sent, whenever sending it would be an *enabling*
 * write the capability forbids — the API answers 403 rather than stripping it, so
 * an unconditional send would make a capability-off tenant unable to save an
 * unrelated edit (a rename, a calling window) on a campaign that already had
 * recording on.
 */
export function recordingPayload(args: {
  recordingEnabled: boolean;
  analyticsEnabled: boolean;
  next: CampaignRecordingState;
}): { record_calls?: boolean; analysis_profile_id?: string | null } {
  const { recordingEnabled, analyticsEnabled, next } = args;
  const payload: { record_calls?: boolean; analysis_profile_id?: string | null } = {};

  // Sent unconditionally when the capability is on, INCLUDING `false` — the
  // column defaults to false, so omitting it looks harmless and is not: with the
  // field absent from every PATCH an operator who turned recording on could
  // never turn it back off.
  if (recordingEnabled || !next.record) payload.record_calls = next.record;

  const resolved = resolveProfileId(next.profileId);
  if (analyticsEnabled || resolved === null) payload.analysis_profile_id = resolved;

  return payload;
}

/** Whether a PATCH built by {@link recordingPayload} carried an enabling profile. */
export function payloadSetsProfile(payload: { analysis_profile_id?: string | null }): boolean {
  return typeof payload.analysis_profile_id === 'string';
}

interface ErrorShape {
  statusCode?: number;
  details?: unknown;
}

function errorBody(err: unknown): { status: number | null; body: Record<string, unknown> | null } {
  if (err === null || typeof err !== 'object') return { status: null, body: null };
  const shaped = err as ErrorShape;
  const status = typeof shaped.statusCode === 'number' ? shaped.statusCode : null;
  const details = shaped.details;
  const body =
    details !== null && typeof details === 'object' && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : null;
  return { status, body };
}

/**
 * Turn one of the five documented refusals into a sentence that names the reason.
 *
 * Ordered by how the platform actually answers, which is NOT how the delivery
 * brief tabulates it — the difference is load-bearing and is why this function
 * exists at all:
 *
 *  1. **403 `{ error: 'capability_disabled', capability }`** — the API's own
 *     refusal, raised BEFORE it calls the server, so `sawCoreErrorStatus` is false and
 *     the error-mask hook passes it through unchanged. `ApiError` reduces that
 *     body to the message `'capability_disabled'`, which is a wire token, not
 *     something to show an operator.
 *  2. **403 `{ error: 'Feature Not Enabled', message }`** — from the server, and the
 *     one dialer-runtime 4xx whose label is on the server's `FORWARDABLE_ERROR_LABELS`
 *     allow-list, so its message survives masking and is already legible.
 *  3. **404 `{ error: 'Not Found', message: 'Analysis profile not found' }`** —
 *     ⚠️ **this body never reaches the browser.** `'Not Found'` is not on the
 *     allow-list and the payload carries no `details`, so the API's error-mask
 *     hook rewrites it to `{ error: 'Request Failed', message: 'Something went
 *     wrong … quote the request ID' }`. The only thing left to reason from is
 *     that WE sent a profile id, which is why this takes `sentAnalysisProfile`
 *     rather than reading the body. Without it, the one refusal an operator can
 *     fix in a single click renders as a support ticket.
 *  4. **400 `{ error: 'Validation failed', details: { analysis_profile_id } }`** —
 *     deliberately NOT handled here: it carries `details`, so it survives masking
 *     and the page's existing `fieldErrorsFromResponse` lands it on the field
 *     that caused it. Returning a banner for it too would say it twice.
 */
export function campaignSaveRefusal(
  err: unknown,
  ctx: { sentAnalysisProfile: boolean },
): string | null {
  const { status, body } = errorBody(err);
  const label = body && typeof body['error'] === 'string' ? body['error'] : null;

  if (label === 'capability_disabled') {
    const capability = typeof body?.['capability'] === 'string' ? body['capability'] : null;
    if (capability === AGENCY_RECORDING_CAPABILITY) {
      return (
        `Call recording is turned off for this account (${AGENCY_RECORDING_CAPABILITY}), so it ` +
        'cannot be switched on here. Ask an administrator to enable it, then save again. ' +
        'Switching recording off is always allowed.'
      );
    }
    if (capability === AGENCY_ANALYTICS_CAPABILITY) {
      return (
        `Call summaries are turned off for this account (${AGENCY_ANALYTICS_CAPABILITY}), so a ` +
        'summary profile cannot be set here. Ask an administrator to enable it, then save again. ' +
        'Removing a summary profile is always allowed.'
      );
    }
    // A capability the API gates on that this build does not know by name. Say
    // which one rather than falling through to the bare `capability_disabled`.
    return capability
      ? `This change needs the ‘${capability}’ capability, which is turned off for this account. Ask an administrator to enable it.`
      : 'This change needs a capability that is turned off for this account. Ask an administrator to enable it.';
  }

  if (status === 403 && label === 'Feature Not Enabled' && typeof body?.['message'] === 'string') {
    // "No summary" is a way out only when this save set one; the same label also
    // answers a save on an account whose dialer flag went off.
    return ctx.sentAnalysisProfile
      ? `${body['message']} Choose “No summary” to save without one.`
      : body['message'];
  }

  if (status === 404 && isProfile404(body, ctx.sentAnalysisProfile)) {
    return (
      'That call-summary profile is no longer available on this account — it may have been ' +
      'renamed or deleted. Pick another one, or choose “No summary”, and save again.'
    );
  }

  return null;
}

/**
 * Is this 404 actually about the analysis profile?
 *
 * **The naive test — `status === 404 && sentAnalysisProfile` — is wrong, and
 * wrong in the direction that costs the most.** This PATCH has other 404s, and
 * they are the *legible* ones: `requireOwned` answers `campaign_not_found` and
 * the apology guard answers `announcement_not_found`, both of which the API
 * ALLOW-LISTS and forwards unchanged with a real message. Claiming the profile
 * whenever one happens to be in the payload throws that message away and
 * replaces it with advice that cannot work.
 *
 * The concrete case: the settings page sits under a persistent account switcher,
 * so an operator can change active account without navigating away. Save now,
 * and `requireOwned` 404s `campaign_not_found` — correct and actionable. The
 * naive test would tell them to pick a different summary profile; they pick “No
 * summary”, save, and get the identical 404, with nothing anywhere naming the
 * real problem. That is a worse outcome than the masked 404 this branch exists
 * to rescue, because here a good message existed and we discarded it.
 *
 * So: claim it only when the server NAMED it, or when the body carries no code at all
 * — the masked shape, which is the only case where guessing from what we sent is
 * all anyone has. A 404 carrying some *other* code is somebody else's, and
 * falling through lets the real message through.
 */
function isProfile404(body: Record<string, unknown> | null, sentAnalysisProfile: boolean): boolean {
  const code = body && typeof body['code'] === 'string' ? body['code'] : null;
  if (code === ANALYSIS_PROFILE_NOT_FOUND_CODE) return true;
  return code === null && sentAnalysisProfile;
}
