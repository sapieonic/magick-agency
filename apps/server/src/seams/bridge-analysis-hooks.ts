/**
 * SEAM: voice engine → analysis (decision B11: seams are fixed files).
 *
 * The bridge does not import the analysis job and profile repositories, the transcriber
 * factory or the worker handle; it calls these two hooks with the facts it read off the
 * session, and `bootstrap/analysis.ts` registers the implementation at boot with
 * `setBridgeAnalysisHooks`. Until then the default is a no-op, the same behaviour as
 * dialer analysis being unconfigured.
 *
 * Call sites in `core/webrtc-bridge-manager.ts` (keep their shape exactly):
 *   `void getBridgeAnalysisHooks().onCallFinalized({...})`
 *          — fire-and-forget at finalize; the bridge never awaits analysis.
 *   `if (patch.recording_url) await getBridgeAnalysisHooks().onRecordingReady(callId);`
 *          — awaited, so the implementation must swallow its own errors.
 * Implementations must catch and log rather than throw into the bridge.
 */

export interface BridgeCallFinalizedFacts {
  /** agency_calls.id */
  callId: string;
  tenantId: string;
  accountId: string;
  /** `session.campaignId`; null only for a non-campaign call. */
  campaignId: string | null;
  /** `session.answeredAt` — the answer anchor; null = never answered. */
  answeredAt: Date | null;
  /** `session.getTalkTimeSeconds()` at finalize. */
  talkTimeSeconds: number;
}

export interface BridgeAnalysisHooks {
  /** Called once at finalize, fire-and-forget: enqueue post-call analysis if it applies. */
  onCallFinalized(facts: BridgeCallFinalizedFacts): Promise<void>;
  /** Called when a recording URL lands on the call. */
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
