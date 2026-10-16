/**
 * The bridge's exported types and its refusal error — the vocabulary of the
 * docs/seams.md §3.1 seam. Re-exported unchanged from `webrtc-bridge-manager.ts`,
 * which is the module path the seam (and its type-level test) names.
 */
import type WebSocket from 'ws';
import type { WebRtcCallStatus } from '@magick-agency/db/models/agency-call.model';

/** Reason a call was refused before any provider work — drives the HTTP status. */
export type WebRtcRejectReason =
  | 'global_concurrency_limit'
  | 'account_concurrency_limit'
  | 'provider_concurrency_limit'
  | 'provider_concurrency_unavailable'
  | 'telephony_init_failed'
  // Bridged (borrowed-socket) calls only: the caller's socket was not open at
  // dial time. Deliberately absent from the PostHog `WebrtcCallRejectionReason`
  // union — that is a published analytics contract with dashboards behind it, and
  // this reason belongs to the agency funnel.
  | 'station_socket_unavailable';

export class WebRtcCallError extends Error {
  constructor(
    message: string,
    readonly code: WebRtcRejectReason,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'WebRtcCallError';
  }
}

/** Dial-time inputs shared by both entry points into the bridge. */
export interface WebRtcOutboundParams {
  tenantId: string;
  accountId: string;
  callerId: string;
  destinationPhone: string;
  provider?: string;
  initiatedBy?: string | null;
  metadata?: Record<string, unknown>;
  record?: boolean;
  analysisProfileId?: string | null;
  analysisLanguage?: string | null;
  analysisConsent?: boolean | null;
}

/**
 * {@link WebRtcOutboundParams} plus the borrowed-socket contract: the caller
 * supplies an already-open media socket it continues to own, and the campaign /
 * attempt this leg belongs to (persisted as back-references on `agency_calls` so
 * the bridge itself stays free of agency concepts).
 */
export interface WebRtcBridgedCallParams extends WebRtcOutboundParams {
  /**
   * The caller's live media socket — the agent's station socket. **Borrowed:**
   * attached for this attempt, detached at teardown, never closed by the bridge.
   */
  browserSocket: WebSocket;
  campaignId: string;
  agencyAttemptId: string;
  /**
   * How long to hold the call open after the borrowed socket closes, waiting for
   * {@link WebRtcBridgeManager.reattachBorrowedBrowserLeg}. Omitted or 0 ⇒ a
   * close hangs up immediately.
   *
   * **The value is the caller's, deliberately.** A wifi blip is survivable and a
   * genuine departure is not, and where that line falls is a property of the
   * caller's product — how long its customer will hold on hearing silence —
   * never of the bridge. Naming a default here would put a dialer trade-off
   * inside the bridge.
   */
  browserCloseGraceMs?: number;
}

/**
 * A terminal or media-ready moment on a bridge call.
 *
 * Deliberately GENERIC. The agency dialer consumes it, but nothing here knows
 * that: the rule is that the agency module depends on the bridge and the bridge
 * never depends on the agency module, so this is a plain observation hook
 * any subsystem may subscribe to, carrying only bridge vocabulary.
 */
export interface WebRtcLifecycleEvent {
  callId: string;
  /**
   * The opaque id the caller supplied at dial time (see
   * `WebRtcBridgeSession.correlationId`). Present only for calls that supplied
   * one; correlate on this rather than `callId` if you need to match an event
   * that can fire *during* the dial.
   */
  correlationId?: string | null;
  /**
   * `answered` = the carrier answered; media may not be bridged yet, and on a lost
   * call never will be. `bridged` = both legs live and media negotiated.
   * `ended` = terminal.
   *
   * **`answered` and `bridged` are each emitted at most once per call**, and
   * `answered` strictly precedes `bridged`. A listener must not treat "not
   * `bridged`" as "`ended`" — switch on the value.
   *
   * `bridged` is latched because re-emitting it whenever a completing condition
   * is re-observed would announce a second bridge on a mid-call PSTN re-connect,
   * and — with late binding running the bind re-entrantly inside the `answered`
   * listener — two in one synchronous turn on a VoiceLink `start` frame. Both
   * write a later `bridged_at` over the real one, and `bridged_at` is half of the
   * SQL abandonment predicate (a late `bridged` write resurrects an ended attempt
   * and the reaper then rewrites its outcome). The latch lives on the
   * session (`WebRtcBridgeSession.markBridged`), the sibling of `markAnswered`.
   * The browser's `in_progress` status frame is NOT latched — see
   * {@link WebRtcBridgeManager.emitBridgedIfLive}.
   */
  phase: 'answered' | 'bridged' | 'ended';
  status?: WebRtcCallStatus;
  outcome?: string;
  errorCode?: string;
  errorMessage?: string;
  /** Whether the call was ever answer-anchored. */
  answered: boolean;
  /**
   * The **carrier answer instant**, present on every phase once anchored.
   *
   * A timestamp rather than only the `answered` boolean, because the interval
   * between answer and bridge is itself the signal a caller may need: it is what
   * separates a normally-connected call from one that answered and reached nobody.
   * Flattening it to a boolean makes that interval unrecoverable downstream —
   * every consumer can then only re-timestamp at its own observation point, which
   * measures its own latency rather than the call's.
   */
  answeredAt?: Date;
  talkTimeSeconds?: number;
}

export type WebRtcLifecycleListener = (event: WebRtcLifecycleEvent) => void;
