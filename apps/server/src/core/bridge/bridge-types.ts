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
  | 'station_socket_unavailable'
  // The rest are refusals before the carrier placed anything, each its own code so a
  // caller can tell them apart from a carrier refusal (`telephony_init_failed`, which
  // ends the call with an `ended`). None emits `ended`.
  //
  // The tenant carrier credential the dial names cannot dial: not `active` at the call
  // row's insert, or not resolvable for `dial` (disabled, revoked, shredded, another
  // tenant's or provider's). Never falls back to the service's own account (B20). Not a
  // keyring fault (no keyring, a secret that would not open): that is a bridge failure,
  // the credential being fine (`isCredentialUnavailable`).
  | 'telephony_credential_unavailable'
  // A calls-per-second limit gave the dial no slot: our own per-account gate, or the
  // carrier's 429. Nothing was placed; retryable, and says nothing about the contact.
  | 'carrier_rate_limited'
  // The carrier refused the credential itself (HTTP 401). Every further dial on it will
  // be refused too: the caller stops dialling on it.
  | 'carrier_auth_rejected'
  // The adapter refused the dial before sending anything to the carrier
  // (`CarrierDialNotSentError`): no webhook base, a malformed number or caller ID, the
  // carrier's API unreachable. Nothing was placed.
  | 'carrier_dial_not_sent';

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
  /**
   * The tenant carrier credential to dial on (BYOC, decisions B18–B20): pinned on the
   * call row at insert, which re-checks it is `active`, and resolved for `dial` to place
   * the leg. Null or absent: the service's own account for `provider`. A credential that
   * cannot dial refuses the leg (`telephony_credential_unavailable`); it never falls back.
   */
  telephonyCredentialId?: string | null;
  initiatedBy?: string | null;
  metadata?: Record<string, unknown>;
  record?: boolean;
  analysisProfileId?: string | null;
  analysisLanguage?: string | null;
  analysisConsent?: boolean | null;
}

/**
 * What a bridged leg belongs to, persisted as back-references on `agency_calls` so
 * the bridge itself stays free of agency concepts (docs/seams.md §3.1,
 * docs/softphone.md §4.3):
 *
 * - `attempt` — a campaign attempt: `agency_calls.campaign_id` and
 *   `agency_attempt_id`, `origin = 'campaign'`.
 * - `manual` — a soft-phone call (`agency_manual_calls`): `origin = 'manual'` and
 *   `manual_call_id`, with NO campaign or attempt id (a soft-phone call's campaign
 *   is a tag on the manual-call row, never a campaign leg; the database CHECK
 *   `ck_agency_calls_manual_correlation` refuses anything else).
 *
 * The session's `correlationId` — what lifecycle events carry and what
 * `bindBorrowedBrowserLeg` / `reattachBorrowedBrowserLeg` / `forceEndWithOutcome` /
 * `playClipToCarrierThenHangUp` are keyed on — is the attempt id or the manual
 * call id. The two id spaces are distinct UUIDs, so one map serves both.
 */
export type WebRtcCallCorrelation =
  | { kind: 'attempt'; campaignId: string; agencyAttemptId: string }
  | { kind: 'manual'; manualCallId: string };

/**
 * {@link WebRtcOutboundParams} plus the borrowed-socket contract: the caller
 * supplies an already-open media socket it continues to own, and the
 * {@link WebRtcCallCorrelation} this leg belongs to.
 */
export interface WebRtcBridgedCallParams extends WebRtcOutboundParams {
  /**
   * The caller's live media socket — the agent's station socket. **Borrowed:**
   * attached for this attempt, detached at teardown, never closed by the bridge.
   */
  browserSocket: WebSocket;
  correlation: WebRtcCallCorrelation;
  /**
   * How long to hold the call open after the borrowed socket closes, waiting for
   * {@link WebRtcBridgeManager.reattachBorrowedBrowserLeg}. Omitted or 0 ⇒ a
   * close hangs up immediately.
   *
   * **A `manual` correlation honours it only once the carrier has answered**; a
   * close before the answer hangs up at once, as if it were 0. A soft-phone dial
   * is placed by the agent pressing Call: a console that closes while the phone
   * still rings is an agent who left, and holding the dial open would let the
   * customer answer into nobody. Campaign attempts keep the window on both sides
   * of the answer (their pre-answer close is the deferred-hangup/late-binding
   * machinery's to resolve).
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

/**
 * A call a customer placed to one of a tenant's numbers, already answered by the inbound answer
 * webhook (docs/inbound.md §3): its media leg is the `agency_calls` row the webhook wrote
 * (`origin = 'inbound'`), and the bridge holds the caller on our stream (principle 2). The
 * bridge places nothing: it registers the session, takes the shared slots and hands back the
 * stream the answer XML names.
 */
export interface WebRtcInboundCallParams {
  /** The `agency_calls` leg the answer webhook wrote: the session's call id. */
  callId: string;
  /** What lifecycle events carry and the correlation-keyed members take: the inbound call's id. */
  correlationId: string;
  tenantId: string;
  accountId: string;
  provider: string;
  /** The tenant carrier credential the call arrived on (resolved for `call_control` to hang it up). */
  telephonyCredentialId: string | null;
  /** The number rung. */
  callerId: string;
  /** The caller's number, '' when withheld. */
  destinationPhone: string;
  /** The carrier's own call id (Plivo's `CallUUID`). */
  carrierCallId: string;
  /**
   * Take the shared slots (global, account, provider). False when the caller has already turned the
   * call away (its route is at its own `max_concurrent`): it is streamed only to hear why, and
   * holds no slot.
   */
  takeSlots: boolean;
  /**
   * The call may be put through to an agent (docs/inbound.md §5, P2): its browser leg is borrowed
   * and unbound, so `bindBorrowedBrowserLeg` (keyed on {@link correlationId}) can put the agent's
   * station socket on it later. False: the caller only ever hears messages (P1), and a bind is
   * refused.
   */
  connectable: boolean;
  /**
   * Connectable calls only: how long the call is held after the bound station socket drops,
   * waiting for `reattachBorrowedBrowserLeg` (0: a drop hangs up at once). The caller's value, as
   * {@link WebRtcBridgedCallParams.browserCloseGraceMs} is, and for the same reason.
   */
  browserCloseGraceMs: number;
  /**
   * Connectable calls only (ignored, and 0 by convention, otherwise): the longest the call may be
   * held before an agent is put through, in seconds: the caller's messages, the queue's maximum
   * wait, and anything played or recorded after it (an overflow message, a voicemail). The call's
   * whole budget is `parkedSeconds` + the account's maximum duration: the answer's
   * `maxDurationSeconds` (and so the stream's own timeout) and the slot and token lifetimes are
   * that sum, while the bridge's own timer ends a call still unbound after `parkedSeconds`, as a
   * backstop, and is re-armed with the full maximum duration at the bind.
   */
  parkedSeconds: number;
  /**
   * Record the conversation once an agent is put through (the route's `record_calls`). The bridge
   * still ANDs it with the account's recording ceiling (`allow_recording`), and starts it at the
   * `bridged` moment through the carrier's record-on-demand API (`recordsOnDemand`); a carrier
   * without one records nothing. Ignored for a call that is not {@link connectable}.
   */
  record: boolean;
}

/** What `WebRtcBridgeManager.playInboundHold` plays: the preamble once, then the hold on a loop. */
export interface InboundHoldOptions {
  /** Played once, in order (a greeting, a recording notice); a clip not on this replica's disk is skipped. */
  preambleClipHashes: readonly string[];
  /**
   * Looped after the preamble until the hold is stopped. Null (the route has no hold clip), or a
   * clip not on this replica's disk: the built-in generated hold tone instead (Q24), never silence.
   */
  holdClipHash: string | null;
}

/**
 * How `WebRtcBridgeManager.playInboundHold` ended. It never hangs up:
 *  - `released`: the hold was stopped with the leg still up: an agent was bound
 *    (`bindBorrowedBrowserLeg`), or `stopInboundHold`, or a recording took the line
 *    (`recordInboundAudio`), or a later `playInboundHold` replaced it;
 *  - `aborted`: the caller went (the stream closed, the call ended) while it played;
 *  - `no_media`: the call ended before the carrier's media was negotiated;
 *  - `not_found`: no live call by that correlation id.
 */
export type InboundHoldResult = 'released' | 'aborted' | 'no_media' | 'not_found';

/** What `WebRtcBridgeManager.recordInboundAudio` records, and what it plays first. */
export interface InboundRecordOptions {
  /** The longest recording, in seconds of the caller's audio (and of wall clock from its start). */
  maxSeconds: number;
  /** Played once before recording, in order (the prompt); a clip not on this replica's disk is skipped. */
  promptClipHashes?: readonly string[];
  /** Play the built-in 400 ms beep after the prompt, just before recording starts (Q14). */
  beep?: boolean;
}

/**
 * The caller's audio `WebRtcBridgeManager.recordInboundAudio` captured. `result`:
 *  - `completed`: `maxSeconds` reached with the caller still on; the call is NOT hung up (the
 *    caller ends it, e.g. `forceEndWithOutcome`);
 *  - `caller_left`: the caller hung up (during the prompt, or while recording): what was captured
 *    until then;
 *  - `no_media`: the call ended before the carrier's media was negotiated; nothing captured;
 *  - `not_found`: no live call by that correlation id; nothing captured.
 */
export interface InboundAudioRecording {
  result: 'completed' | 'caller_left' | 'no_media' | 'not_found';
  /** PCM16 little-endian mono at {@link sampleRate}, decoded from the carrier's wire audio. */
  pcm16: Buffer;
  sampleRate: number;
  /** Seconds of audio in {@link pcm16}. */
  seconds: number;
}

/**
 * How an inbound call was taken in. `capacity` says what the caller hears next:
 *  - `admitted`: the slots are held;
 *  - `account_full`: the account's own limit refused a slot, and the call is held anyway, with no
 *    slot (decision IB5: an inbound call is never refused for the account limit; its live row
 *    counts in the account's live total instead);
 *  - `no_capacity`: the global or the carrier's scope is full (or cannot be read): the caller is to
 *    hear "all lines are busy" and be put down (`overflow_no_capacity`), on a session with no slot;
 *  - `not_requested`: `takeSlots` was false.
 * `accepted: false`: no stream can be offered (no webhook base configured), or the leg has
 * already ended here; the caller answers the call another way.
 */
export type WebRtcInboundAcceptance =
  | {
    accepted: true;
    streamUrl: string;
    maxDurationSeconds: number;
    capacity: 'admitted' | 'account_full' | 'no_capacity' | 'not_requested';
  }
  | { accepted: false; reason: 'stream_unavailable' | 'ended' };

/**
 * How `WebRtcBridgeManager.playClipSequenceThenHangUp` ended:
 *  - `completed`: every clip played (or was skipped as unavailable) and the call was hung up under
 *    the caller's outcome;
 *  - `aborted`: the far end went (the stream closed or the call ended) before the last clip
 *    finished; the call ends by its own path, never under the caller's outcome;
 *  - `no_media`: the call ended before the carrier's media was negotiated;
 *  - `not_found`: no live call by that correlation id.
 */
export type ClipSequenceResult = 'completed' | 'aborted' | 'no_media' | 'not_found';
