/**
 * SEAM: voice engine (lane C) → analysis (lane D). Lead-owned; lanes do not edit.
 *
 * In core, `WebRtcBridgeManager` enqueued post-call analysis itself
 * (`maybeEnqueueAnalysis` and `notifyDialerAnalysisRecordingReady`,
 * magic-voice-core/src/core/webrtc-bridge-manager.ts@4850d1d9 lines ~2190-2295),
 * importing the analysis job and profile repositories, the transcriber factory
 * and the worker handle. That welds the bridge to the analysis module, which here
 * is a different lane.
 *
 * The seam: the bridge calls these two hooks at exactly the points where core
 * called those two private methods, with the facts core read off the session.
 * Lane D moves the two method BODIES (verbatim, minus the softphone-only gate 3,
 * since every call here is an agency call) into its implementation and registers
 * it at boot with `setBridgeAnalysisHooks`. Until then the default is a no-op,
 * which is exactly core's behaviour with dialer analysis unconfigured
 * (`if (!config.dialerAnalysis?.enabled) return;`).
 *
 * Call sites in core (keep their shape exactly):
 *   :2073  `void this.maybeEnqueueAnalysis(session, callId).catch((err) => ...)`
 *          — fire-and-forget at finalize; the bridge never awaits analysis.
 *   :1830  `if (patch.recording_url) await this.notifyDialerAnalysisRecordingReady(callId);`
 *          — awaited, and the method swallowed its own errors.
 * Implementations must catch and log rather than throw into the bridge.
 */

export interface BridgeCallFinalizedFacts {
  /** agency_calls.id */
  callId: string;
  tenantId: string;
  accountId: string;
  /** Session's campaign id (core: `session.campaignId`); null only for a non-campaign call. */
  campaignId: string | null;
  /** Core: `session.answeredAt` — the answer anchor; null = never answered. */
  answeredAt: Date | null;
  /** Core: `session.getTalkTimeSeconds()` at finalize. */
  talkTimeSeconds: number;
}

export interface BridgeAnalysisHooks {
  /** Where core called `this.maybeEnqueueAnalysis(session, callId)`. */
  onCallFinalized(facts: BridgeCallFinalizedFacts): Promise<void>;
  /** Where core called `this.notifyDialerAnalysisRecordingReady(callId)`. */
  onRecordingReady(callId: string): Promise<void>;
}

const NOOP_HOOKS: BridgeAnalysisHooks = {
  async onCallFinalized() {},
  async onRecordingReady() {},
};

let hooks: BridgeAnalysisHooks = NOOP_HOOKS;

export function setBridgeAnalysisHooks(next: BridgeAnalysisHooks): void {
  hooks = next;
}

export function getBridgeAnalysisHooks(): BridgeAnalysisHooks {
  return hooks;
}

/** Tests only: restore the no-op default. */
export function resetBridgeAnalysisHooks(): void {
  hooks = NOOP_HOOKS;
}
