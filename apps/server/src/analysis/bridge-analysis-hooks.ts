/**
 * Lane D's implementation of the `BridgeAnalysisHooks` seam
 * (`seams/bridge-analysis-hooks.ts`, docs/seams.md §3.2).
 *
 * The two method BODIES below are core's `WebRtcBridgeManager.maybeEnqueueAnalysis`
 * and `.notifyDialerAnalysisRecordingReady`
 * (magic-voice-core@4850d1d9 `src/core/webrtc-bridge-manager.ts:2190-2295`), moved
 * verbatim. Changes (PORTING.md):
 *  - gate 3 (the softphone's `analyze_dialer_calls` opt-out) is deleted, as the seam
 *    prescribes: every call here is an agency call, and core already skipped the gate
 *    for agency calls;
 *  - the `session` reads become the seam's `BridgeCallFinalizedFacts`
 *    (`session.tenantId/accountId/campaignId/answeredAt/getTalkTimeSeconds()`);
 *  - `analysisFlagFor(isAgencyCall ? 'agency' : 'dialer')` is `analysisFlagFor('agency')`
 *    (`'dialer'` is not a scope here);
 *  - the bridge's call site caught the enqueue's rejection and logged it
 *    (`.catch((err) => log.error(..., 'Dialer analysis enqueue failed'))`); the seam
 *    says implementations catch and log, so `onCallFinalized` does that itself.
 *
 * The §7 gate ladder, as it now reads:
 *   1. Feature configured (config + a constructible transcriber).
 *   2. `agency_call_analysis` on for {tenant, account}.
 *   4. The call was answered.
 *   5. Talk time >= minTalkTimeSeconds.
 *   6. Consent — recording implies opt-in (the row was recorded).
 * Failing 4/5/6 writes `analysis_status='skipped'`; failing 1/2 leaves it NULL
 * (feature absent, not "we chose not to"). On pass, the profile is resolved
 * (explicit row id -> account default -> common-only), snapshotted (M1), and the job
 * enqueued (queued vs awaiting_recording derived in-SQL from recording_url, B1);
 * a recording already present wakes the worker immediately.
 *
 * `agency_call_analysis` is the ONLY agency off switch: it is per tenant and per
 * account, turned off by a super-admin override, and is not self-service.
 * `agency_campaigns.analysis_profile_id` is NOT an opt-in: NULL is the ordinary case
 * and resolves to the account default.
 */
import { config } from '../config/index.js';
import { createChildLogger } from '@magick-agency/observability';
import { analysisFlagFor, webrtcCallRepository } from '@magick-agency/db/repositories/agency-call.repository';
import { callAnalysisProfileRepository } from '@magick-agency/db/repositories/call-analysis-profile.repository';
import { dialerAnalysisJobRepository } from '@magick-agency/db/repositories/dialer-analysis-job.repository';
import { getFeatureFlagService } from '../feature-flags/index.js';
import { createTranscriber } from '../transcription/index.js';
import { getDialerAnalysisWorker } from '../core/dialer-analysis-worker-handle.js';
import type { BridgeAnalysisHooks, BridgeCallFinalizedFacts } from '../seams/bridge-analysis-hooks.js';

const log = createChildLogger({ component: 'bridge-analysis-hooks' });

async function maybeEnqueueAnalysis(facts: BridgeCallFinalizedFacts): Promise<void> {
  const callId = facts.callId;

  // ── Gate 1: feature configured. Constructing a transcriber is the cheap proof
  //    the module can actually run (right keys, enabled). NULL analysis_status. ──
  if (!config.dialerAnalysis?.enabled) return;
  if (!createTranscriber(config)) return;

  const { tenantId, accountId } = facts;

  // ── Gate 2: tenant/account flag. NULL when off (feature absent). ──
  // Through `analysisFlagFor` rather than a literal here, so this gate and the
  // two request-time preflights cannot disagree about which flag owns a product.
  const analysisFlag = analysisFlagFor('agency');
  const flagOn = await getFeatureFlagService().isEnabled(analysisFlag, { tenantId, accountId });
  if (!flagOn) return;

  // (Gate 3, the softphone's account opt-out, is deleted: docs/seams.md §3.2.)

  // Load the persisted row: it carries the answer anchor, recording_url, and the
  // immutable analysis_profile_id / analysis_language set at intake.
  const call = await webrtcCallRepository.findById(callId);
  if (!call) return;

  // ── Gates 4/5/6: eligibility. Failing any of these is a deliberate skip. ──────
  const talkTime = facts.talkTimeSeconds;
  const skipReason =
    facts.answeredAt == null
      ? 'not_answered'
      : talkTime < config.dialerAnalysis.minTalkTimeSeconds
        ? 'too_short'
        : // Consent: recording implies opt-in. No recording requested ⇒ no consent.
          !call.recording_requested
          ? 'no_consent'
          : null;

  if (skipReason) {
    await webrtcCallRepository.update(callId, { analysis_status: 'skipped' }).catch((err) =>
      log.warn({ err, callId, skipReason }, 'Failed to mark call analysis skipped'));
    log.info(
      { callId, skipReason, talkTime, product: 'agency' },
      'Call analysis skipped',
    );
    return;
  }

  // ── Resolve + snapshot the profile (M1): explicit id → account default → none. ─
  let profile = null;
  if (call.analysis_profile_id) {
    profile = await callAnalysisProfileRepository.findById(call.analysis_profile_id);
    // PORT NOTE (magick-agency, Phase 8; lane D review hardening): core read the stamped id
    // unscoped (`webrtc-bridge-manager.ts:2254`), safe only while every campaign write runs
    // `preflightAnalysisProfile`. The owner is checked here, so a row of another tenant or
    // account can never be snapshotted into this call's job whatever wrote the id; it is
    // treated as an id that no longer resolves (→ the account default). Not
    // `findByIdScoped`: that one reads ACTIVE versions only, and a campaign's pinned profile
    // can be a retired version (copy-on-write), which core snapshotted as-is.
    if (profile && (profile.tenant_id !== tenantId || profile.account_id !== accountId)) {
      log.warn(
        { callId, profileId: call.analysis_profile_id },
        'Stamped analysis profile belongs to another tenant/account — ignored',
      );
      profile = null;
    }
  }
  if (!profile) {
    profile = await callAnalysisProfileRepository.findDefault(tenantId, accountId);
  }

  const snapshot = profile
    ? {
        context: profile.context,
        custom_dimensions: profile.custom_dimensions ?? [],
        language_hint: profile.language_hint,
      }
    : { custom_dimensions: [] };

  const job = await dialerAnalysisJobRepository.enqueueFromCall({
    call_id: callId,
    profile_id: profile?.id ?? null,
    profile_snapshot: snapshot,
    // Per-call language override wins over the profile's hint.
    analysis_language: call.analysis_language ?? profile?.language_hint ?? null,
  });

  log.info({ callId, jobId: job?.id, status: job?.status, profileId: profile?.id ?? null }, 'Dialer analysis enqueued');

  // If the recording already landed (webhook won the race), the job is `queued` —
  // wake the worker so it runs now instead of waiting for the next poll.
  if (job && job.status === 'queued') {
    getDialerAnalysisWorker()?.wake();
  }
}

/**
 * A recording URL landed (VoiceLink late-terminal path with no live session):
 * promote a waiting dialer-analysis job → queued and wake the worker. Guarded so
 * a duplicate is a no-op (C3). No-op when dialer analysis is unconfigured.
 */
async function notifyDialerAnalysisRecordingReady(callId: string): Promise<void> {
  if (!config.dialerAnalysis?.enabled) return;
  try {
    const promoted = await dialerAnalysisJobRepository.markRecordingReady(callId, config.dialerAnalysis.settleSeconds);
    if (promoted) getDialerAnalysisWorker()?.wake();
  } catch (err) {
    log.warn({ err, callId }, 'Failed to notify dialer analysis of VoiceLink recording readiness');
  }
}

export function createBridgeAnalysisHooks(): BridgeAnalysisHooks {
  return {
    async onCallFinalized(facts) {
      try {
        await maybeEnqueueAnalysis(facts);
      } catch (err) {
        log.error({ err, callId: facts.callId }, 'Dialer analysis enqueue failed');
      }
    },
    async onRecordingReady(callId) {
      await notifyDialerAnalysisRecordingReady(callId);
    },
  };
}
