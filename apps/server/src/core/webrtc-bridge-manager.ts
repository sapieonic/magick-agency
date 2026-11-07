// The WebRTC bridge: a carrier's PSTN leg (VoiceLink, or Plivo on a tenant's own
// account) ⇄ the agent's browser (station) socket, no AI pipeline. The constructor takes `TelephonyGuardHost` for capacity; analysis is reached
// only through the analysis seam (`getBridgeAnalysisHooks()`, docs/seams.md). Max
// duration comes from `account_settings.webrtc_max_duration_seconds`, and the default
// provider is `voicelink`. The members the dialer runtime calls (onLifecycle,
// createBridgedCall, createUnboundBridgedCall, bindBorrowedBrowserLeg,
// reattachBorrowedBrowserLeg, forceEndWithOutcome, playClipToCarrierThenHangUp,
// getActiveCallIds, gracefulShutdown) and the exported types are a fixed seam, pinned by
// `test/unit/core/webrtc-bridge-seam-contract.test.ts`.
import crypto from 'node:crypto';
import { releaseTelephonyLease } from './telephony-release.js';
import type Redis from 'ioredis';
import type WebSocket from 'ws';
import { config } from '../config/index.js';
import { createChildLogger } from '@magick-agency/observability';
import { TelephonyProviderRegistry } from '../telephony/factory.js';
import { getTelephonyCredentialService } from '../telephony/credentials/index.js';
import { WebhookUrlBuilder } from './webhook-url-builder.js';
import { readTtsPcm } from '../tts/tts-file-cache.js';
import { PacedAudioStreamer, type PacedStreamSink } from './paced-audio-streamer.js';
import { WebRtcBridgeSession } from './webrtc-bridge-session.js';
import { webrtcCallRepository } from '@magick-agency/db/repositories/agency-call.repository';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { getBridgeAnalysisHooks } from '../seams/bridge-analysis-hooks.js';
import { auditLogger } from '../audit/audit-logger.js';
import {
  trackWebrtcCallInitiated, trackWebrtcCallCompleted,
  type WebrtcCallEndedBy,
} from '../analytics/posthog.js';
import { canCancelRinging } from '../telephony/types.js';
import { findCarrierModule } from '../telephony/carrier-modules.js';
import type { CarrierEventFacts } from '../telephony/carrier-module.js';
import type { TelephonyGuardHost } from './telephony-guard-host.js';
import type { CallEvent, TelephonyProvider } from '../telephony/types.js';
import type { WebRtcCallRecord, WebRtcCallStatus } from '@magick-agency/db/models/agency-call.model';
import {
  WebRtcCallError,
  type WebRtcBridgedCallParams,
  type WebRtcCallCorrelation,
  type WebRtcLifecycleEvent,
  type WebRtcLifecycleListener,
  type WebRtcOutboundParams,
} from './bridge/bridge-types.js';
import { BridgeWsTokens, type WsTokenPurpose } from './bridge/ws-tokens.js';
import { admitBridgeCall } from './bridge/admission.js';
import { isAcceptableAlawMessage, rawDataToBuffer } from './bridge/browser-leg-media.js';
import { trackWebsocketSendBackpressure } from '@magick-agency/observability/metrics/voice';
import { carrierAuthRejectionReason, isCarrierDialAborted, isDialOutcomeUnknown } from '../telephony/carrier-errors.js';
import {
  CARRIER_MEDIA_LIMITS, closeForSendBacklog, sendVerdict, STATION_ALAW8_LIMITS, STATION_PCM16_LIMITS,
} from '../utils/ws-backpressure.js';
import { buildCarrierUrls, type CarrierUrls } from './bridge/carrier-urls.js';
import {
  carrierUnplacedRefusal, CREDENTIAL_UNAVAILABLE, isCredentialUnavailable, unplacedRefusalError, type UnplacedRefusal,
} from './bridge/dial-refusals.js';

/**
 * What a carrier that streams via its answer response (`mediaUrlInDialRequest: false`)
 * is answered with when the far end picks up: the stream to open, and the recording to
 * run (`WebRtcBridgeManager.answerCarrierCall`). The route renders it with the adapter.
 */
export interface CarrierAnswerPlan {
  streamUrl: string;
  enableRecording: boolean;
  recordingCallbackUrl?: string;
  maxDurationSeconds?: number;
}

/** One call's telephony slots, held under its concurrency key (`WebRtcBridgeManager.heldLeases`). */
export interface HeldLease { callId: string; concurrencyKey: string; tenantId: string; accountId: string; provider: string }

/** A change in the telephony slots this process holds (`WebRtcBridgeManager.observeLeases`). */
export type LeaseChange =
  | { op: 'held'; lease: HeldLease }
  | { op: 'released'; concurrencyKey: string };

export {
  WebRtcCallError,
  type WebRtcBridgedCallParams,
  type WebRtcCallCorrelation,
  type WebRtcLifecycleEvent,
  type WebRtcLifecycleListener,
  type WebRtcOutboundParams,
  type WebRtcRejectReason,
} from './bridge/bridge-types.js';
export { UNSTORED_WS_TOKEN_CAP } from './bridge/ws-tokens.js';

const log = createChildLogger({ component: 'webrtc-bridge-manager' });

/** Map a terminal teardown to the analytics "who ended it" dimension. */
function webrtcEndedBy(opts: { status: WebRtcCallStatus; outcome?: string; errorCode?: string }): WebrtcCallEndedBy {
  if (opts.errorCode || opts.outcome === 'telephony_init_failed') return 'error';
  switch (opts.outcome) {
    case 'ended_by_user':
    case 'browser_hangup':
    // An agency agent's station socket dropping mid-call is the human end of the
    // call going away — the same dimension as a browser hangup, not an error.
    case 'agent_disconnected':
      return 'user';
    case 'max_duration_reached':
    case 'service_shutdown':
    case 'system_rebooted':
    case 'stuck_active_call':
      return 'system';
    case 'pstn_stream_closed':
    case 'remote_hangup':
      return 'remote';
  }
  if (opts.status === 'no_answer' || opts.status === 'busy') return 'remote';
  if (opts.status === 'failed') return 'error';
  return 'remote';
}

// The exported types and `WebRtcCallError` live in `bridge/bridge-types.ts` and are
// re-exported here unchanged: this module path is the seam (docs/seams.md §3.1).

/** How long to wait for a carrier's media `start` frame before tearing down a silent WS. */
const PROVIDER_START_TIMEOUT_SECONDS = 30;
/**
 * Most carrier frames held while the provider token is checked
 * ({@link WebRtcBridgeManager.attachPstnLegVerified}). The carrier sends `start` the moment
 * its socket opens, so the first frame is the one that matters; the rest would be 20 ms
 * media frames. The cap bounds what an unauthenticated socket can make us hold (each frame
 * is already bounded by the transport's `maxPayload`); frames past it are dropped and
 * counted in the log.
 */
export const PSTN_EARLY_FRAME_CAP = 16;
/**
 * How long to wait for the carrier's `call.ended` after a local hangup of an
 * **answered** call before finalizing anyway.
 *
 * 45s, sized against a measurement rather than a preference: VoiceLink reports
 * terminal state at dial+45–75s, so a 20s bound would retire essentially every
 * answered VoiceLink teardown on our own clock and throw the carrier's
 * disposition away. What the wait buys is the carrier's own view of a leg that
 * **connected** — talk time, hangup cause, recording URL.
 *
 * An **unanswered** call gets no wait at all (the other half of this split, in
 * {@link WebRtcBridgeManager.localHangup}): nothing connected, so there is
 * nothing to confirm, and an `ending` limbo would hold a concurrency slot for a
 * call that has already been given up on. Zero is the honest number there, not a
 * shorter timeout.
 */
const CARRIER_END_CONFIRM_TIMEOUT_SECONDS = 45;
/**
 * Max accepted decoded media frame bytes (~1s of PCM16 16k) — abusive frames are dropped.
 * An `alaw8` leg's binary frames have their own 1 s ceiling (`ALAW8_MAX_FRAME_BYTES`).
 */
const MAX_MEDIA_FRAME_BYTES = 64000;

/**
 * Is a base64 media payload too big to decode? Checked BEFORE decoding, so an
 * abusive frame cannot drive an allocation on the event loop. (Base64 is ~4/3 of
 * the bytes; twice the byte bound is a deliberately loose ceiling.)
 */
function isOversizedMediaPayload(payloadBase64: string): boolean {
  return payloadBase64.length > MAX_MEDIA_FRAME_BYTES * 2;
}

/** Close a socket on a teardown or refusal path, where a throw has nowhere useful to go. */
function closeQuietly(ws: WebSocket): void {
  try { ws.close(); } catch { /* ignore */ }
}

/**
 * Seconds a call's concurrency slots and carrier tokens outlive its max duration,
 * so neither expires under a call that runs to the cap. See `placeOutboundLeg`.
 */
const SLOT_TTL_GRACE_SECONDS = 60;
/**
 * Slack added to a clip's own duration before hanging up on it.
 *
 * Providers buffer playback, so "we finished sending" is not "the customer
 * finished hearing". Without a tail the apology loses its last syllable — and a
 * truncated apology reads as a fault rather than a courtesy.
 */
const CLIP_TAIL_GRACE_MS = 500;
/**
 * Wire frame size for clip playback, in ms of audio.
 *
 * 20ms because that is what a telephony media socket expects. It is not a free
 * parameter: {@link PacedAudioStreamer}'s own header records that dumping a clip
 * faster than real time overruns the carrier's jitter buffer and the audio is
 * dropped or garbled — which for this caller means the apology is *sent* and not
 * *heard*, the one failure we cannot see from our side.
 */
const CLIP_FRAME_MS = 20;
/**
 * Wall-clock ceiling on paced clip playback, over and above the clip's own length.
 *
 * A carrier can hold the socket open with a permanently full send buffer; the
 * pacer would then back off forever and the customer would sit on an open line.
 * Bounded here rather than left to the max-duration timer, which is measured in
 * half-hours.
 */
const CLIP_STREAM_GRACE_MS = 2000;
/**
 * Max duration of a bridged human call (30 min hard cap) when the account's
 * `account_settings.webrtc_max_duration_seconds` is NULL or cannot be read.
 */
const DEFAULT_WEBRTC_MAX_DURATION_SECONDS = 1800;

/**
 * Orchestrates WebRTC human-bridge calls: browser leg ⇄ this service ⇄ the carrier's
 * PSTN leg, no AI pipeline.
 *
 * Concurrency goes through `TelephonyGuardHost`'s guards, so a tenant's
 * `account_settings.max_concurrent_calls` is enforced on one atomic Redis
 * counter. Media bridging and the call lifecycle live here.
 */
/** How many calls {@link WebRtcBridgeManager}'s carrier-leg memo remembers; the oldest is forgotten first. */
const CARRIER_LEGS_SETTLED_MAX = 10_000;

export class WebRtcBridgeManager {
  private readonly sessions = new Map<string, WebRtcBridgeSession>();
  /**
   * Calls whose carrier leg needs nothing more sent from this process: the carrier has
   * reported the call's terminal (`terminal`), or a hangup or cancel for it has gone out
   * (`hung_up`). It makes the hangup of a stray leg ({@link hangupStrayCarrierLeg}) at
   * most once per call, and never after the carrier said the call ended. Process-local
   * and bounded ({@link CARRIER_LEGS_SETTLED_MAX}, oldest first): a call it no longer
   * remembers, or one another process saw end, costs at most one more hangup by id,
   * which the carrier answers "already gone".
   */
  private readonly carrierLegsSettled = new Map<string, 'terminal' | 'hung_up'>();
  private readonly telephonyRegistry: TelephonyProviderRegistry;
  private readonly webhookUrls = new WebhookUrlBuilder();
  private readonly keyPrefix: string;
  private readonly startTimeoutSeconds = PROVIDER_START_TIMEOUT_SECONDS;

  /**
   * The guard host supplies the concurrency guards (`acquireTelephonyConcurrency`,
   * `releaseTelephonyLease`, `wakeSelfHeal`).
   */
  constructor(
    private readonly guardHost: TelephonyGuardHost,
    private readonly redis: Redis | null,
    /**
     * `carrierRouteHint`: this media worker's slot, written into the carrier's media and
     * webhook URLs (`bridge/carrier-urls.ts`). Absent in a single process.
     */
    private readonly options: { carrierRouteHint?: string } = {},
  ) {
    this.telephonyRegistry = new TelephonyProviderRegistry(config, { credentials: getTelephonyCredentialService });
    this.keyPrefix = config.redis.keyPrefix;
    this.tokens = new BridgeWsTokens(redis, this.keyPrefix);
  }

  /** The per-call credentials — `bridge/ws-tokens.ts`. */
  private readonly tokens: BridgeWsTokens;

  /**
   * Told the moment this process takes or gives back a call's telephony slots
   * (`docs/scaling.md` §6.1): a media worker forwards each change to the primary, so a
   * worker that dies has its slots released exactly, including a call admitted a moment
   * before. `held` is told right after admission, before the call has a row, so its
   * `callId` is the concurrency key until then (log correlation only); `released` after
   * the release went out. One observer; null clears it.
   */
  private leaseObserver: ((change: LeaseChange) => void) | null = null;
  /**
   * Every slot set this process holds, by concurrency key: added where `held` is told and
   * removed where `released` is, in the same synchronous step. So it holds a call from its
   * admission (before it has a row or a session) until its release went out (after its
   * session is gone), and {@link heldLeases} always agrees with the deltas told so far.
   */
  private readonly leases = new Map<string, HeldLease>();

  observeLeases(observer: ((change: LeaseChange) => void) | null): void {
    this.leaseObserver = observer;
  }

  private noteLease(change: LeaseChange): void {
    if (change.op === 'held') this.leases.set(change.lease.concurrencyKey, change.lease);
    else this.leases.delete(change.concurrencyKey);
    if (!this.leaseObserver) return;
    try { this.leaseObserver(change); } catch { /* an observer never fails a call */ }
  }

  /**
   * The telephony slots this process holds: what the primary must release if it dies with
   * them (`docs/scaling.md` §6.1). Exactly the `held` deltas told and not yet `released`,
   * including a call admitted but not yet registered and one whose release is in flight.
   * Not part of the dialer's seam.
   */
  heldLeases(): HeldLease[] {
    return [...this.leases.values()].map((l) => ({ ...l }));
  }

  /**
   * Check a carrier-presented per-call token (`provider` for the PSTN media socket,
   * `webhook` for status posts). The webhook route and {@link attachPstnLegVerified}
   * call it here; the rules are `BridgeWsTokens.verifyWsToken`'s.
   */
  verifyWsToken(callId: string, token: string | undefined, purpose: WsTokenPurpose): Promise<boolean> {
    return this.tokens.verifyWsToken(callId, token, purpose);
  }

  private readonly lifecycleListeners = new Set<WebRtcLifecycleListener>();

  /**
   * Observe bridge lifecycle moments. Returns an unsubscribe function.
   *
   * Listeners are called synchronously and their throws are swallowed — a
   * subscriber must never be able to break call teardown, which is the one path
   * that releases concurrency slots.
   */
  onLifecycle(listener: WebRtcLifecycleListener): () => void {
    this.lifecycleListeners.add(listener);
    return () => this.lifecycleListeners.delete(listener);
  }

  /**
   * Anchor the carrier answer and emit the one-shot `answered` observation.
   *
   * Every `session.markAnswered()` call site in this class goes through here, so
   * the observation cannot drift from the anchor. It fires **only** on the write
   * that actually anchored — several sites anchor on one call (answer event,
   * stream start, socket backstop) and each would otherwise emit.
   *
   * Bridge vocabulary only; nothing here knows what a subscriber does with it.
   */
  private anchorAnswer(session: WebRtcBridgeSession): void {
    if (!session.markAnswered()) return;
    this.emitLifecycle({
      callId: session.callId,
      correlationId: session.correlationId,
      phase: 'answered',
      answered: true,
      answeredAt: session.answeredAt ?? undefined,
    });
  }

  /**
   * Announce the bridge — browser `in_progress` plus the `bridged` lifecycle
   * event — but only once both legs are actually live and the carrier's media is
   * negotiated. A no-op otherwise, so a caller can fire it at every moment that
   * could have completed the bridge without repeating the condition.
   *
   * Three sites reach it, and they are the three orderings the two legs can
   * arrive in: the PSTN leg connecting last ({@link attachPstnLeg}), the
   * carrier's `start` frame negotiating media last ({@link handleProviderStart} —
   * where `providerMediaReady` was set true on the line above, so that half of
   * the condition is implied), and the browser leg being bound last
   * ({@link bindBorrowedBrowserLeg}, i.e. late binding).
   *
   * **The lifecycle event is latched to once per call** (`markBridged`), and the
   * browser notification deliberately is NOT. They are different promises: a
   * PSTN leg that re-connects mid-call genuinely should tell the browser media
   * is live again, whereas `bridged` names a moment, and a subscriber that acts
   * on it — the agency dialer writes `bridged_at`, moves the agent to `on_call`
   * and re-sends the console's connect cue — must see that moment once.
   *
   * Latching it here rather than at the sites is what makes the re-entrant case
   * safe, and that case is the reason the latch exists rather than a hypothetical:
   * on a late-binding VoiceLink call `handleProviderStart` marks media ready,
   * anchors the answer — whose listener binds the station socket synchronously,
   * which lands here and announces the bridge — and then reaches its own call to
   * this method with both legs live and media ready. Two announcements, one
   * bridge, and the second rewrites `bridged_at` later than the truth.
   * See {@link reattachBorrowedBrowserLeg} for the same corruption arriving
   * through the other door; keeping that path out of here remains the primary
   * guard, with this latch behind it.
   */
  private emitBridgedIfLive(session: WebRtcBridgeSession): void {
    if (!session.bothLegsConnected || !session.providerMediaReady) return;
    this.notifyBrowser(session, { event: 'status', status: 'in_progress' });
    if (!session.markBridged()) return;
    this.emitLifecycle({
      callId: session.callId,
      correlationId: session.correlationId,
      phase: 'bridged',
      answered: session.answeredAt != null,
      answeredAt: session.answeredAt ?? undefined,
    });
  }

  private emitLifecycle(event: WebRtcLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event);
      } catch (err) {
        log.error({ err, callId: event.callId, phase: event.phase }, 'WebRTC lifecycle listener threw');
      }
    }
  }

  getSession(callId: string): WebRtcBridgeSession | undefined {
    return this.sessions.get(callId);
  }

  getActiveCount(): number {
    return this.sessions.size;
  }

  /** Call ids this replica is actively bridging — excluded from the stale-call sweep. */
  getActiveCallIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * End every active bridge call on shutdown: hang up the carrier leg, persist the
   * terminal row, and release the shared slots. Without this a deploy during a
   * live call would strand the carrier leg (up to maxDuration of live audio),
   * leave the row non-terminal, and leak a concurrency slot until its Redis lock
   * TTL expires.
   * Call from the process SIGTERM handler before closing Redis/the DB pool.
   */
  async gracefulShutdown(): Promise<void> {
    const ids = this.getActiveCallIds();
    if (ids.length === 0) return;
    log.info({ count: ids.length }, 'Ending active WebRTC bridge calls for shutdown');
    await Promise.allSettled(
      ids.map((id) => {
        const session = this.sessions.get(id);
        return this.endCall(id, {
          status: session?.localEndStatus() ?? 'canceled',
          outcome: 'service_shutdown',
          hangupProvider: true,
        });
      }),
    );
  }

  // ─── Creation ────────────────────────────────────────────────────────────

  /**
   * Place an outbound leg that bridges to a **borrowed** media socket — one the
   * caller already has open and will keep open after this call ends.
   *
   * This is the dialer runtime's entry point. The agent's station socket is
   * opened once at shift start and reused across hundreds of attempts, so the
   * bridge **attaches and detaches it per attempt and never closes it**.
   * Concretely:
   *
   *  - no browser WS token is minted (there is no socket for the caller to open);
   *  - the socket is attached BEFORE the dial, so no early carrier event is missed;
   *  - `session.destroy()` detaches rather than closes it, and every listener this
   *    attempt registered is removed at detach — otherwise an 8-hour shift
   *    accumulates hundreds of live handler sets on one socket;
   *  - a mid-call close is recorded as `agent_disconnected` rather than
   *    `browser_hangup`; the carrier leg is still hung up, because the station
   *    socket IS the agent's media path and there is no "let the call finish".
   *
   * The caller keeps ownership throughout: closing the socket, and deciding when a
   * shift is over, are the caller's business and never the bridge's. Returns the
   * persisted call record (no token). Throws {@link WebRtcCallError} on a closed
   * socket, exhausted capacity, or a provider rejection.
   */
  async createBridgedCall(params: WebRtcBridgedCallParams): Promise<WebRtcCallRecord> {
    // Pre-flight: dialing a customer with a dead agent socket manufactures exactly
    // the abandoned call reserve-before-dial exists to prevent. Fail before we
    // touch a concurrency slot or a carrier.
    if (params.browserSocket.readyState !== 1 /* OPEN */) {
      throw new WebRtcCallError(
        'Station socket is not open',
        'station_socket_unavailable',
        409,
      );
    }
    const { record } = await this.placeOutboundLeg({
      ...params,
      borrowedBrowserLeg: true,
      browserHangupOutcome: 'agent_disconnected',
    });
    return record;
  }

  /**
   * Place an outbound leg whose **borrowed** media socket is supplied later —
   * at the carrier answer — instead of before the dial. The bridge half of late
   * binding (`FF_AGENCY_LATE_BINDING`).
   *
   * For contrast, {@link createBridgedCall} borrows a socket that is already open
   * and attaches it before the dial. This one dials with **no browser leg at all**
   * and waits for {@link bindBorrowedBrowserLeg}.
   *
   * Why the caller wants that is not the bridge's business, but the shape it
   * forces on this method is: with no socket at dial time there is
   *
   *  - **no pre-flight socket check.** `createBridgedCall` refuses a dead station
   *    socket before touching a slot or a carrier; here there is nothing to
   *    check, so re-checking the agent at the bind is the caller's job and the
   *    bind is the only place it can be done. The bind refuses a closed socket.
   *  - **no browser token**, exactly as for a bound borrowed socket: there is no
   *    browser-stream route to gate. The leg is marked borrowed-unbound at dial
   *    time so the ownership guards treat it as borrowed during the ring window
   *    too — see `WebRtcBridgeSession.markBorrowedUnbound`.
   *  - **no `bridged` event at the answer.** Both legs are never live until the
   *    bind, so the emission sites simply do not fire; the bind emits it.
   *
   * Everything else — concurrency, persistence, the agency back-references,
   * recording, the max-duration guard, analysis — is the shared
   * {@link placeOutboundLeg} path, identical to {@link createBridgedCall}.
   */
  async createUnboundBridgedCall(params: Omit<WebRtcBridgedCallParams, 'browserSocket'>): Promise<WebRtcCallRecord> {
    const { record } = await this.placeOutboundLeg({
      ...params,
      borrowedBrowserLeg: true,
      browserHangupOutcome: 'agent_disconnected',
    });
    return record;
  }

  /**
   * The shared dial path behind both entry points: resolve the recording ceiling,
   * reserve the shared concurrency slots, persist the row, register the session,
   * arm the max-duration guard, attach a borrowed socket if one was supplied, mint
   * the carrier's per-call credentials, and place the outbound leg.
   *
   * Every leg is borrowed (both entry points), so no browser WS token is minted:
   * there is no browser connect to gate.
   */
  private async placeOutboundLeg(params: WebRtcOutboundParams & {
    /** What the leg belongs to; persisted as back-references and as the correlation id. */
    correlation: WebRtcCallCorrelation;
    /** Supplied ⇒ borrowed AND bound now: attached here, detached (never closed) at teardown. */
    browserSocket?: WebSocket;
    /**
     * True ⇒ the browser leg belongs to the CALLER, whether or not a socket has
     * been supplied yet.
     *
     * Separate from `browserSocket` because late binding has no socket at dial
     * time and must still be marked borrowed (`markBorrowedUnbound`), so the
     * ownership guards treat the leg as the caller's for the whole ring window.
     */
    borrowedBrowserLeg?: boolean;
    /** Terminal outcome recorded when the browser leg closes mid-call. */
    browserHangupOutcome: string;
    /** Borrowed sockets only: re-attach window on close. 0/absent ⇒ hang up now. */
    browserCloseGraceMs?: number;
  }): Promise<{ record: WebRtcCallRecord; session: WebRtcBridgeSession }> {
    // No provider named: the service's own VoiceLink account.
    const provider = params.provider || 'voicelink';
    // Per-account recording ceiling: an account with allow_recording=false cannot
    // record a human-bridge call even if record:true was requested. NULL (no row, or
    // never set) ⇒ NOT allowed: the same default the campaign-write check applies
    // (`DEFAULT_ALLOW_RECORDING` in `settings/agency-account-settings.ts`; a test pins
    // the two together). The baseline migration's SQL comment saying NULL inherits
    // `true` predates this and is superseded. A plain account_settings column read;
    // the voice engine knows nothing of why it's false.
    const allowRecording =
      (await accountSettingsRepository.getAllowRecording(params.tenantId, params.accountId)) ?? false;
    const recordEnabled = params.record === true && allowRecording;
    // Concurrency key — unique per call, used purely as the Redis lock id (the
    // DB row id isn't known until after insert).
    const concurrencyKey = crypto.randomUUID();

    // Resolve the max duration up front (reused for the slot TTL, the session
    // field, and the max-duration timer below). A WebRTC bridge can run up to
    // `maxDuration`s — far longer than the guards' default lock TTL
    // (`callTimeoutSeconds+30`≈330s) — so we override the lock TTL to
    // `maxDuration + 60` on BOTH acquires. Otherwise the lock expires mid-call
    // and the release can't decrement the counter (permanent +1 leak), while
    // reconcile would wrongly zero a live call's counter.
    const maxDuration = await this.resolveMaxDuration(params.tenantId, params.accountId);
    const slotTtlSeconds = maxDuration + SLOT_TTL_GRACE_SECONDS;

    await admitBridgeCall(this.guardHost, {
      concurrencyKey, tenantId: params.tenantId, accountId: params.accountId, provider, slotTtlSeconds,
    });
    this.noteLease({ op: 'held', lease: { callId: concurrencyKey, concurrencyKey, tenantId: params.tenantId, accountId: params.accountId, provider } });

    // 2. Persist the call (status initiating), pinned to the tenant carrier credential it
    // dials on (null: the service's own account). The insert re-checks that credential is
    // `active` in the same statement and writes nothing otherwise. The INSERT stays inside
    // the same try so a failure still releases the slots it just took.
    const credentialId = params.telephonyCredentialId ?? null;
    let record: WebRtcCallRecord;
    try {
      record = await webrtcCallRepository.create({
        ...(credentialId ? { telephony_credential_id: credentialId } : {}),
        tenant_id: params.tenantId,
        account_id: params.accountId,
        caller_id: params.callerId,
        destination_phone: params.destinationPhone,
        provider,
        initiated_by: params.initiatedBy ?? null,
        metadata: params.metadata ?? {},
        recording_requested: recordEnabled,
        // Immutable analysis intake fields. Stamp consent_at now when consent was
        // given so the durable record is captured at dial time.
        analysis_profile_id: params.analysisProfileId ?? null,
        analysis_language: params.analysisLanguage ?? null,
        analysis_consent: params.analysisConsent ?? null,
        analysis_consent_at: params.analysisConsent === true ? new Date() : null,
        // Agency back-references: the only thing on this row that knows the dialer
        // runtime exists. A soft-phone leg carries its manual call and NO campaign or
        // attempt id (`ck_agency_calls_manual_correlation`), so no campaign
        // aggregation over `agency_calls` ever counts it (docs/softphone.md §2).
        ...(params.correlation.kind === 'attempt'
          ? {
            campaign_id: params.correlation.campaignId,
            agency_attempt_id: params.correlation.agencyAttemptId,
            origin: 'campaign' as const,
            manual_call_id: null,
          }
          : {
            campaign_id: null,
            agency_attempt_id: null,
            origin: 'manual' as const,
            manual_call_id: params.correlation.manualCallId,
          }),
      });
    } catch (err) {
      await this.releaseSlotsByKey(concurrencyKey, params.tenantId, params.accountId, provider);
      // A credential that is not `active` at the insert: refused as a leg never placed,
      // with its own code (no row, no session, nothing at the carrier).
      if (isCredentialUnavailable(err)) {
        log.warn({ err, provider, telephonyCredentialId: credentialId }, 'WebRTC dial refused: its carrier credential is not active');
        throw unplacedRefusalError(CREDENTIAL_UNAVAILABLE, err);
      }
      throw err;
    }

    // 3. Register session + hold slots on it.
    const session = new WebRtcBridgeSession({
      callId: record.id,
      tenantId: params.tenantId,
      accountId: params.accountId,
      callerId: params.callerId,
      destinationPhone: params.destinationPhone,
      provider,
    });
    session.concurrencyKey = concurrencyKey;
    session.slotsHeld = true;
    session.recordEnabled = recordEnabled;
    session.correlationId = params.correlation.kind === 'attempt'
      ? params.correlation.agencyAttemptId
      : params.correlation.manualCallId;
    // Before answer a manual leg's close hangs up at once (`browserCloseGraceMs`).
    session.browserLegGraceAfterAnswerOnly = params.correlation.kind === 'manual';
    // Read back off the persisted row, not off `params`, so the value handed on at
    // finalize is the one that was durably recorded.
    session.campaignId = record.campaign_id ?? null;
    session.agencyAttemptId = record.agency_attempt_id ?? null;
    session.manualCallId = record.manual_call_id ?? null;
    session.telephonyCredentialId = record.telephony_credential_id ?? null;
    // A carrier that negotiates the media stream via a `start` frame (VoiceLink)
    // holds the relay until a valid `start` (correct codec/rate) arrives.
    if (session.carrier?.media.negotiatesOnStart) session.providerMediaReady = false;
    this.sessions.set(record.id, session);
    // The lease now names its call (log correlation in a slot reap); still the same slots.
    const lease = this.leases.get(concurrencyKey);
    if (lease) this.leases.set(concurrencyKey, { ...lease, callId: record.id });

    // 4–5b run with the session registered, the slots held, and (from 4) the max-duration
    // timer armed, but with no carrier leg placed. A throw anywhere in them must tear all of
    // that down here: before this guard a throw (a token store, say) escaped with the
    // session, its slots, its lease entry, its timer and the borrowed station socket's
    // listeners all left in place until the max-duration timer fired, 30 minutes on.
    // See `abortUnplacedLeg` for why that teardown emits no `ended`.
    let adapter: TelephonyProvider;
    let carrierUrls: CarrierUrls;
    try {
      // 4. Max-duration guard (resolved above, reused for the slot TTL).
      session.maxDurationSeconds = maxDuration;
      session.setMaxDurationTimer(maxDuration, () => {
        // Answer-anchored, matching every other teardown path here (browser-close,
        // shutdown): a call that hit the ceiling mid-conversation is `completed`,
        // but one that was never answered never connected, so it settles `canceled`.
        // Hardcoding `completed` would record an unanswered call as a success.
        this.inBackground(this.localHangup(record.id, {
          status: session.localEndStatus(),
          outcome: 'max_duration_reached',
        }), record.id, 'Error ending call on max duration');
      });

      // 4b. Borrowed socket (agency): attach BEFORE the dial so no early carrier
      // event (`ringing`, or a fast `answer`) is notified into a null browser leg.
      // Relay is safe this early — media is dropped until the PSTN leg is live.
      if (params.browserSocket) {
        this.attachBorrowedBrowserLeg(
          session, params.browserSocket, params.browserHangupOutcome, params.browserCloseGraceMs ?? 0,
        );
      } else if (params.borrowedBrowserLeg) {
        // Late binding: no socket yet. Record the borrowed contract now anyway —
        // the outcome and grace window the bind will need, and `browserWsOwned =
        // false`, so the ownership guards treat it as borrowed during the ring.
        session.markBorrowedUnbound(params.browserHangupOutcome, params.browserCloseGraceMs ?? 0);
      }

      // 5. The carrier connects the provider WS + posts webhooks itself, so those two
      // legs get their own purpose-bound tokens (embedded only in the URLs we send
      // the carrier). No browser token: every leg is borrowed.
      const tokenTtl = maxDuration + SLOT_TTL_GRACE_SECONDS;
      let providerToken: string | undefined;
      let webhookToken: string | undefined;
      if (session.carrier) {
        providerToken = crypto.randomUUID();
        webhookToken = crypto.randomUUID();
        await Promise.all([
          this.tokens.storeWsToken(record.id, providerToken, tokenTtl, 'provider'),
          this.tokens.storeWsToken(record.id, webhookToken, tokenTtl, 'webhook'),
        ]);
      }

      // 5b. Everything the carrier request is built from. None of it asks the carrier
      // anything, so a throw here (no webhook base configured, a provider with no adapter,
      // a credential that cannot dial) is a failure before the carrier, torn down by the
      // catch below. Inside the carrier request's own try it was reported as the carrier
      // refusing the dial (`TELEPHONY_INIT_FAILED`, with an `ended`), and the dialer
      // charged the contact's `failed` allowance for a dial that never left this process.
      //
      // `base` is the provider's own webhook namespace (…/webhooks/voicelink,
      // …/webhooks/plivo), so `${base}/webrtc-status/${id}` resolves to its own route.
      const base = this.webhookUrls.baseUrl(provider);
      // The account the leg is placed on: the tenant credential pinned on the row,
      // resolved for `dial` (active only, and of this tenant and provider), or, when it
      // is null, the service's own account through the synchronous lookup (which knows
      // no BYOC carrier: a Plivo dial with no credential throws here). An unresolvable
      // credential is a leg never placed; it never falls back (B20).
      adapter = session.telephonyCredentialId
        ? await this.telephonyRegistry.getForCredentialId(
          provider, session.telephonyCredentialId, 'dial', params.tenantId,
        )
        : this.telephonyRegistry.get(provider);
      // The stream URL goes in the dial (VoiceLink, no answer XML) or is kept for our
      // answer response (Plivo). Every callback embeds the webhook token so forged
      // lifecycle events (which drive status/concurrency) are rejected. A provider with
      // no carrier module gets untokenized URLs.
      carrierUrls = buildCarrierUrls({
        base,
        callId: record.id,
        mediaUrlInDialRequest: Boolean(session.carrier?.mediaUrlInDialRequest),
        providerToken,
        webhookToken,
        routeHint: this.options.carrierRouteHint ?? null,
      });
      session.answerStreamUrl = carrierUrls.answerStreamUrl ?? null;
      session.recordingCallbackUrl = session.carrier ? carrierUrls.recordingCallbackUrl : null;

      auditLogger.log({
        callId: record.id,
        tenantId: params.tenantId,
        accountId: params.accountId,
        eventType: 'webrtc_call.initiating',
        eventCategory: 'call',
        severity: 'info',
        eventData: { provider, destination: params.destinationPhone, caller_id: params.callerId },
      });
    } catch (err) {
      if (isCredentialUnavailable(err)) {
        await this.abortUnplacedLeg(record.id, err, CREDENTIAL_UNAVAILABLE);
        throw unplacedRefusalError(CREDENTIAL_UNAVAILABLE, err);
      }
      await this.abortUnplacedLeg(record.id, err);
      throw err;
    }

    // A teardown that ran while 4–5 awaited (the agent's station socket closed during the
    // token store, a supervisor's force-end) has already claimed the call terminal, said
    // `ended` and released everything. Dialling now would ring a customer for a call that
    // no longer exists, only for the race check after the dial to hang it straight up.
    if (session.endHandled) {
      log.warn({ callId: record.id }, 'WebRTC call was torn down before its carrier leg was placed — not dialling');
      return { record, session };
    }

    // 6. Place the outbound telephony leg. Only the carrier request is inside this try:
    // its catch reports a dial the carrier refused (or may have queued) and hangs nothing
    // up. A step before it (5b) asks the carrier nothing and is torn down as unplaced; a
    // step after `initiateCall` resolved runs with the leg placed and must not land here
    // either (see the `provider_call_id` write below).
    // The teardown aborts it (`endCall`), so a dial still waiting to be sent is never sent.
    const dialAbort = new AbortController();
    session.dialAbort = dialAbort;
    try {
      const result = await adapter.initiateCall({
        signal: dialAbort.signal,
        callId: record.id,
        to: params.destinationPhone,
        from: params.callerId,
        webhookUrl: carrierUrls.answerUrl,
        statusCallbackUrl: carrierUrls.statusCallbackUrl,
        mediaStreamUrl: carrierUrls.mediaStreamUrl,
        maxDuration,
        // The VoiceLink adapter does not send this flag; the carrier's recording URL
        // arrives on its terminal webhook. Plivo records from our answer XML (`<Record>`,
        // `answerCarrierCall`), its URL on the recording callback.
        enableRecording: recordEnabled,
        machineDetection: false,
      });
      session.providerCallId = result.providerCallId || null;
      session.providerRequestId = result.providerRequestId || null;
    } catch (err) {
      // Torn down while the dial waited to be sent, and the adapter sent nothing: the leg
      // was never placed. The teardown has already settled the call (terminal row, `ended`,
      // slots), exactly as for a teardown just before the dial (above), so this returns
      // the same way and there is nothing to hang up.
      if (isCarrierDialAborted(err)) {
        if (session.endHandled) {
          log.info({ callId: record.id }, 'WebRTC call was torn down while its dial waited to be sent — the dial was not sent');
          return { record, session };
        }
        // Aborted by something other than the teardown (nothing else aborts it today):
        // still a leg never placed.
        await this.abortUnplacedLeg(record.id, err);
        throw err;
      }
      // Refused with nothing placed (a calls-per-second limit, or the carrier refusing the
      // credential): torn down as unplaced, no `ended`, its own code, so the caller neither
      // charges the contact a carrier refusal nor waits on an `ended` that never comes.
      const unplaced = carrierUnplacedRefusal(err);
      if (unplaced) {
        log.warn({ err, callId: record.id, code: unplaced.code }, 'WebRTC outbound dial refused before the carrier placed it');
        // The carrier refused the credential itself: every further dial on it would be
        // refused too, so the verdict goes on the credential (`invalid`), as a verify's
        // would, against the secret version this adapter holds. Nothing for the service's
        // own account (its adapter holds no credential). Never throws.
        const refusedCredential = carrierAuthRejectionReason(err);
        if (refusedCredential && session.telephonyCredentialId) {
          await this.telephonyRegistry.recordCredentialRefused(adapter, refusedCredential, {
            tenantId: params.tenantId, accountId: params.accountId, callId: record.id,
          });
        }
        await this.abortUnplacedLeg(record.id, err, unplaced);
        throw unplacedRefusalError(unplaced, err);
      }
      // (rejection of telephony init is reported as a completed `failed` call via
      // endCall below — not a pre-flight rejection.)
      //
      // A dial whose outcome is unknown (an `add_lead` that timed out, or a 2xx whose body
      // could not be read: the carrier may have queued the lead) fails the same way, so the
      // agent and the slots are released and the media token is cleared (a late carrier
      // connect is refused and closed, which hangs it up). Its own error code, and the
      // adapter's error as `cause`, let the caller defer the contact's redial
      // (`carrier-errors.ts`).
      const outcomeUnknown = isDialOutcomeUnknown(err);
      log.error({ err, callId: record.id, outcomeUnknown }, 'WebRTC outbound initiation failed');
      await this.endCall(record.id, {
        status: 'failed',
        outcome: 'telephony_init_failed',
        errorCode: outcomeUnknown ? 'TELEPHONY_INIT_OUTCOME_UNKNOWN' : 'TELEPHONY_INIT_FAILED',
        errorMessage: err instanceof Error ? err.message : String(err),
        hangupProvider: false,
      });
      const refusal = new WebRtcCallError(
        err instanceof Error ? err.message : 'Telephony initiation failed',
        'telephony_init_failed',
        502,
      );
      refusal.cause = err;
      throw refusal;
    } finally {
      session.dialAbort = null;
    }

    // The teardown-during-dial race, closed here because this is the first
    // instant it can be closed. `endCall`'s hangup needs a carrier handle (the call
    // id, or the dial request id it cancels by), which does not exist until the line
    // above — so a
    // teardown that ran while the dial was in flight (a borrowed socket is
    // attached BEFORE the dial, so an agent who dismisses a ringing call is
    // squarely inside this window) claimed the terminal state, found no carrier
    // handle, and left the leg dialling with nothing left to hang it up. The
    // session is already destroyed and out of the map at that point; we still
    // hold the reference, which is all the hangup needs.
    if (session.endHandled) {
      log.warn(
        { callId: record.id, providerCallId: session.providerCallId, providerRequestId: session.providerRequestId },
        'WebRTC call was torn down mid-dial — hanging up the carrier leg now that it has an id',
      );
      await this.hangupProviderLeg(session);
    }
    // The carrier's REAL id wins when it is already known: a carrier that dials (its
    // `start` frame or a webhook) before its own add_lead response reaches us has
    // already backfilled `provider_call_id` (`persistCarrierCallId`), and this
    // dial-time placeholder — our own call id, for VoiceLink — would overwrite it.
    //
    // The leg is placed: a failed write here is a correlation gap, never a failed dial.
    // It used to sit inside the dial's try, whose catch ended the call `failed` with
    // `telephony_init_failed` and without hanging up the leg it had just placed: the
    // customer was rung by a call with no session behind it, the dialer charged the
    // contact a carrier refusal and scheduled its redial, and the soft phone recorded
    // the call as never placed. The carrier's own events backfill the id
    // (`persistCarrierCallId`).
    //
    // The dial request id (Plivo's `request_uuid`) is written with it: the only handle on
    // the call before the carrier names it.
    await webrtcCallRepository.update(record.id, {
      provider_call_id: session.carrierCallId ?? session.providerCallId,
      ...(session.providerRequestId ? { provider_request_id: session.providerRequestId } : {}),
    })
      .catch((err: unknown) => log.error(
        { err, callId: record.id, providerCallId: session.providerCallId },
        'Could not persist the carrier call id — the call is placed and carries on',
      ));

    trackWebrtcCallInitiated(record);
    return { record, session };
  }

  // ─── Browser leg ───────────────────────────────────────────────────────────
  //
  // Every leg is borrowed: the caller's station socket. The refusals below that
  // read `browserWsOwned` turn away a session that was not dialled through a
  // borrowed entry point (the session default is owned).

  /**
   * Attach a **borrowed** browser socket for one attempt. There is no token to
   * verify — the caller handed us a socket it already authenticated and already
   * owns — and the listener teardown is *kept*, so `session.destroy()` can detach
   * cleanly instead of closing.
   *
   * Nagle is disabled here. It is idempotent per socket, so doing it once per
   * attempt on a shift-long socket is harmless.
   */
  private attachBorrowedBrowserLeg(
    session: WebRtcBridgeSession,
    ws: WebSocket,
    hangupOutcome: string,
    graceMs: number,
  ): void {
    const callId = session.callId;
    // Claim the socket first: the close handler's `session.browserWs !== ws` guard
    // must be satisfiable the instant it is registered.
    session.adoptBorrowedBrowserLeg(ws);
    session.browserHangupOutcome = hangupOutcome;
    session.browserLegGraceMs = graceMs;
    session.setBrowserLegTeardown(this.registerBrowserLegHandlers(session, ws, hangupOutcome, graceMs));
    this.disableNagle(ws, callId);
    log.info(
      { callId, status: session.status, mediaFormat: session.browserMediaFormat, passthrough: session.browserMediaPassthrough },
      'Borrowed browser leg attached',
    );
    this.notifyBrowser(session, { event: 'status', status: session.status });
  }

  /**
   * Bind the caller's media socket to a call dialled by
   * {@link createUnboundBridgedCall} — the answer-time half of late binding.
   * Returns false when the call cannot take it, in which case the customer is on
   * the line with no agent and the caller must deal with that (the abandoned-call
   * path).
   *
   * **Synchronous, deliberately and non-negotiably.** The abandonment predicate
   * gives the whole bind path a 1000ms budget (`ABANDONMENT_BRIDGE_GRACE_MS`),
   * measured from the carrier answer, and every connected call would otherwise
   * count against a 3% regulatory ceiling. So there is no `await` here, nothing
   * is read from Redis or the DB, and everything the caller needs to send its
   * panel was pre-fetched at dial time.
   *
   * **Keyed on the correlation id, not the call id**, for the same reason
   * {@link reattachBorrowedBrowserLeg} is: the answer can precede the resolution
   * of the dial that would have told the caller the call id — a fast carrier
   * answers while `createUnboundBridgedCall` is still awaiting its INSERT — and
   * that is the exact race late binding makes ordinary rather than rare.
   *
   * The refusals, and what each one prevents:
   *  - `endHandled`/`ending`: the call is over or settling; a socket bound now
   *    would relay onto a session about to be destroyed.
   *  - an OWNED leg (`browserWsOwned`, the session default): no entry point here
   *    creates one, so reaching this with one means the call was not dialled
   *    unbound.
   *  - a leg that **has ever been bound** (`session.browserLegBound`): a second
   *    bind would silently displace a live agent mid-conversation —
   *    `adoptBorrowedBrowserLeg` drops the previous reference without closing or
   *    notifying it, so the first agent would simply go quiet. A socket that was
   *    bound and then DROPPED is this same case and is also refused: it is
   *    `reattachBorrowedBrowserLeg`'s job, which is the path that disarms the
   *    grace window. The flag rather than `browserWs` because the close handler
   *    leaves the reference in place, so the reference cannot tell "dropped"
   *    from "never bound" — and those two need opposite answers here.
   *  - a closed socket: the agent went away between the caller's check and here.
   *
   * On success it attaches through the same {@link attachBorrowedBrowserLeg} the
   * dial-time path uses — so listener teardown, Nagle and the status frame are
   * identical — and then emits `bridged` if both legs are live, which they are
   * whenever the carrier's media is already negotiated.
   */
  bindBorrowedBrowserLeg(correlationId: string, ws: WebSocket): boolean {
    const session = this.findByCorrelationId(correlationId);
    if (!session || session.isTearingDown) return false;
    if (session.browserWsOwned) {
      log.warn({ callId: session.callId, correlationId }, 'Bind refused: browser leg is bridge-owned');
      return false;
    }
    if (session.browserLegBound) {
      log.warn(
        { callId: session.callId, correlationId, graceArmed: session.browserLegGraceArmed },
        'Bind refused: this call already has a bound browser leg (a re-attach is the route for a dropped one)',
      );
      return false;
    }
    if (ws.readyState !== 1 /* OPEN */) return false;

    this.attachBorrowedBrowserLeg(session, ws, session.browserHangupOutcome, session.browserLegGraceMs);
    log.info(
      { callId: session.callId, correlationId, status: session.status, answered: session.answeredAt != null },
      'Borrowed browser leg bound',
    );
    this.emitBridgedIfLive(session);
    return true;
  }

  /**
   * Re-attach a **borrowed** media socket to a call whose previous socket dropped
   * — the wifi-blip path. Disarms the deferred hangup and resumes
   * relay onto the new socket; returns false when there is nothing to resume onto.
   *
   * Keyed on the caller's own `correlationId`, not the call id, for the same
   * reason the lifecycle events are: the call id is only knowable once
   * `createBridgedCall` has resolved, and a socket can drop before that — during
   * the dial, which is exactly the network-drop-during-ring case. A caller that
   * could only re-attach by call id would be unable to re-attach at all in the
   * window it most needs to.
   *
   * A `false` return is not an error and must be treated as "the call is over":
   * either the window lapsed and the call already settled, or the id names no
   * live call. Deliberately refuses an OWNED browser leg — no borrowed entry point
   * creates one, so there is nothing of the caller's to resume.
   *
   * **This path deliberately does NOT emit `bridged`, and
   * {@link bindBorrowedBrowserLeg} deliberately does.** They look alike — both
   * end in `attachBorrowedBrowserLeg` on a live call — but a subscriber reads the
   * two as different facts. The agency dialer's `bridged` handler writes
   * `bridged_at` and re-sends the console's connect cue, and `bridged_at` is one
   * of the two columns the SQL abandonment predicate is built on: re-emitting it
   * for a wifi blip would move the recorded bridge instant minutes past the
   * answer and corrupt the compliance measurement of a call that was in fact
   * bridged on time. A re-attach resumes a bridge; it does not create one. Keep
   * the two paths distinct — `emitBridgedIfLive`'s once-per-call latch would now
   * swallow such an emission anyway, but that is a backstop, not the reason.
   *
   * **A leg that has NEVER been bound is refused**, and that guard is
   * load-bearing rather than tidy. Under late binding an unbound session has
   * `browserWsOwned === false`, `endHandled === false` and `ending === false`,
   * so every other refusal above passes and a reconnecting station socket would
   * be joined to a call that is still RINGING — defeating late binding and
   * putting the ringing panel back on the console, which is the popup late binding
   * exists to remove. `session.browserLegBound` is the test rather than
   * `session.browserWs`, because the close handler arms the grace window without
   * clearing the reference: a dropped socket and a never-bound one are
   * indistinguishable through it and need opposite answers.
   *
   * The agency dialer's `AgencyDialer.reattachStation` relies on the refusal:
   * it reads a `false` as "nothing live to resume", returns null, and the
   * console renders the reconnect from `takeMissedRelease` instead. That is the
   * correct outcome for an unbound attempt and not a lost reconnection — the
   * attempt binds at the ANSWER to whatever socket the station registry holds by
   * then, so a socket that reconnects during the ring needs no resumption at
   * all; it simply has to be registered before the carrier answers.
   */
  reattachBorrowedBrowserLeg(correlationId: string, ws: WebSocket): boolean {
    const session = this.findByCorrelationId(correlationId);
    if (!session || session.isTearingDown) return false;
    if (session.browserWsOwned) {
      log.warn({ callId: session.callId }, 'Re-attach refused: browser leg is bridge-owned');
      return false;
    }
    if (!session.browserLegBound) {
      log.warn(
        { callId: session.callId, correlationId, status: session.status },
        'Re-attach refused: this attempt has never been bound (late binding — it binds at the answer)',
      );
      return false;
    }
    if (ws.readyState !== 1 /* OPEN */) return false;

    const wasArmed = session.clearBrowserLegGrace();
    // `adoptBorrowedBrowserLeg` inside the attach runs the previous attempt's
    // listener teardown, so the dead socket's handlers go with it — including the
    // `close` handler that armed the window we just disarmed.
    this.attachBorrowedBrowserLeg(session, ws, session.browserHangupOutcome, session.browserLegGraceMs);
    log.info(
      { callId: session.callId, correlationId, wasArmed, status: session.status },
      'Borrowed browser leg re-attached',
    );
    return true;
  }

  /**
   * End a call by the caller's correlation id, under an outcome the caller names.
   *
   * The counterpart to {@link playClipToCarrierThenHangUp} for the cases where no
   * clip can be played — and, like it, keyed on the correlation id because a
   * caller that needs to end a call during the dial does not yet know its call id.
   * Returns false when there is no live call by that id.
   */
  async forceEndWithOutcome(correlationId: string, outcome: string): Promise<boolean> {
    const session = this.findByCorrelationId(correlationId);
    if (!session || session.endHandled) return false;
    await this.localHangup(session.callId, { status: session.localEndStatus(), outcome });
    return true;
  }

  /**
   * Play a cached clip to the **carrier** leg, then hang up.
   *
   * The abandoned-call path needs this: a customer has answered and there is no
   * agent, so they must hear an apology rather than silence or a dead line. It
   * lives here because it is entirely bridge vocabulary — a clip hash, a wire
   * format and a terminal outcome — and the bridge stays ignorant of *why* a
   * caller wants it. The clip hash comes from the shared content-addressed
   * clip cache (`tts/tts-file-cache.ts`), so the caller resolves it however it
   * likes.
   *
   * **The first frame goes out before the first await**, because the whole
   * requirement is that the customer hears nothing longer than the clip's own
   * latency; {@link PacedAudioStreamer} sends frame 0 at the top of its loop and
   * only then sleeps to the schedule.
   *
   * **Playback is paced at real time, not blasted.** The clip is streamed in 20ms
   * frames against a monotonic schedule: a carrier's jitter buffer discards audio pushed faster than it plays, so a
   * burst-then-sleep would satisfy "we sent the whole apology" while the customer
   * heard a fragment of it. Pacing also means the hangup lands naturally after the
   * audio rather than being timed against it — the only wait left is
   * {@link CLIP_TAIL_GRACE_MS}, which covers the provider's own buffering, and it
   * is skipped when playback aborted because then there is nothing left to drain.
   *
   * Returns false when there is nothing to play onto (no session, already
   * ending, carrier leg gone, or the clip is not on this replica's disk). A
   * `false` obliges the caller to hang up by its own route: the customer is live
   * either way, and the clip is the courtesy, not the mechanism. A clip that
   * started and then aborted — the carrier hung up mid-apology — returns **true**:
   * the call is settled here under the caller's outcome, so a second hangup would
   * be a no-op at best and a second terminal write at worst.
   */
  async playClipToCarrierThenHangUp(
    correlationId: string,
    opts: { clipHash: string; outcome: string; status?: WebRtcCallStatus },
  ): Promise<boolean> {
    const session = this.findByCorrelationId(correlationId);
    if (!session || session.isTearingDown) return false;
    if (session.pstnWs?.readyState !== 1 /* OPEN */) return false;

    const clip = this.convertClipForCarrier(session, opts.clipHash);
    if (!clip) {
      log.warn({ callId: session.callId, clipHash: opts.clipHash }, 'Abandon clip unavailable — cannot play');
      return false;
    }

    const clipMs = Math.ceil((clip.buffer.length / clip.byteRate) * 1000);
    log.info(
      { callId: session.callId, outcome: opts.outcome, clipMs },
      'Playing clip to carrier leg before hangup',
    );

    const streamer = new PacedAudioStreamer({
      frameBytes: Math.max(2, Math.round((clip.byteRate * CLIP_FRAME_MS) / 1000)),
      frameMs: CLIP_FRAME_MS,
      maxDurationMs: clipMs + CLIP_STREAM_GRACE_MS,
      callId: session.callId,
    });
    const result = await streamer.stream(clip.buffer, this.makeClipSink(session));

    // Let the provider drain what it has buffered. Only on a clean finish: an
    // abort means the socket closed or the deadline lapsed, and holding the
    // customer half a second longer for audio nobody is receiving is the opposite
    // of the courtesy this exists for.
    if (result === 'completed') {
      await new Promise<void>((resolve) => { setTimeout(resolve, CLIP_TAIL_GRACE_MS); });
    } else {
      log.warn(
        { callId: session.callId, framesSent: streamer.sentFrames, clipMs },
        'Abandon clip playback aborted before the end — hanging up now',
      );
    }

    await this.localHangup(session.callId, {
      status: opts.status ?? session.localEndStatus(),
      outcome: opts.outcome,
    });
    return true;
  }

  /**
   * Convert a cached clip to this session's carrier wire format (the carrier module's
   * `encodeClip`).
   */
  private convertClipForCarrier(
    session: WebRtcBridgeSession,
    clipHash: string,
  ): { buffer: Buffer; byteRate: number } | null {
    const clip = readTtsPcm(clipHash);
    if (!clip) return null;

    // A session with no carrier module has no wire format, so there is nothing to
    // play.
    return session.carrier ? session.carrier.media.encodeClip(clip.pcm16, clip.sampleRate) : null;
  }

  /**
   * The pacer's sink for the carrier leg, framed exactly as the browser→carrier
   * relay frames it. Kept identical on purpose: a clip that reached the customer in
   * a different envelope than live audio would be a second format to keep working.
   *
   * `isOpen` is what stops a clip mid-word when the customer hangs up, and
   * `bufferedAmount` is what stops us out-running a slow carrier — both read live
   * off the socket rather than being captured, because the socket is replaced on
   * neither path but *closed* on both.
   */
  private makeClipSink(session: WebRtcBridgeSession): PacedStreamSink {
    return {
      isOpen: () => session.pstnWs?.readyState === 1 && !session.isTearingDown,
      bufferedAmount: () => (session.pstnWs as unknown as { bufferedAmount?: number } | null)?.bufferedAmount ?? 0,
      send: (payloadBase64: string) => {
        if (!session.pstnWs || !session.carrier) return;
        this.send(session.pstnWs, session.carrier.media.frameOutbound(payloadBase64, session.providerStreamId));
      },
    };
  }

  /**
   * The live session a caller-supplied correlation id names, if any.
   *
   * A scan rather than a second index: `sessions` is bounded by live concurrency
   * (tens), and an index would be a second thing to keep in step with teardown —
   * a stale entry here would hand a re-attach a session that has already settled.
   */
  private findByCorrelationId(correlationId: string): WebRtcBridgeSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.correlationId === correlationId) return session;
    }
    return undefined;
  }

  /**
   * Register this attempt's `message`/`close`/`error` handlers on a browser socket
   * and return a teardown that removes exactly those three.
   *
   * Named handler references (rather than inline closures) are the point: on a
   * borrowed socket reused across an 8-hour shift, un-removable listeners
   * accumulate one set per call — inert at first, then a
   * `MaxListenersExceededWarning`, then a stale session's close handler racing the
   * live one. This is a real leak, not a theoretical one.
   */
  private registerBrowserLegHandlers(
    session: WebRtcBridgeSession,
    ws: WebSocket,
    hangupOutcome: string,
    graceMs: number = 0,
  ): () => void {
    const callId = session.callId;

    // Routed on `isBinary`, never by trying `JSON.parse`: on an `alaw8` leg every audio
    // frame is binary, and parsing raw A-law as text 50 times a second costs a thrown
    // exception per frame and can, by chance, succeed. Only `ws`'s own `true` means
    // binary: a caller that emits a bare string or Buffer is speaking JSON text.
    const onMessage = (data: Buffer | ArrayBuffer | Buffer[] | string, isBinary?: boolean): void => {
      if (isBinary === true && typeof data !== 'string') {
        this.onBrowserBinary(session, rawDataToBuffer(data));
        return;
      }
      this.onBrowserMessage(session, typeof data === 'string' ? data : data.toString());
    };
    const hangUpForBrowserClose = (): void => {
      this.inBackground(
        this.localHangup(callId, { status: session.localEndStatus(), outcome: hangupOutcome }),
        callId, 'Error ending call on browser close',
      );
    };
    const onClose = (): void => {
      // Only the *current* browser socket ending should end the call (a superseded
      // socket from a reconnect must not). For a borrowed socket this is belt and
      // braces: the teardown has already removed this listener by the time the
      // attempt is over, so a station socket closing BETWEEN attempts never
      // reaches a finished call's handler.
      //
      // **This guard is NOT the grace window** and never was. It resolves which of
      // two *simultaneously open* sockets owns the call; it says nothing about a
      // socket that is simply gone, which is every real network drop. Conflating
      // them hides where the window actually is: the branch below.
      if (session.browserWs !== ws) return;

      // A caller that supplied a grace window gets the call held open rather than
      // hung up: the agent's media path has dropped, but a wifi roam or DHCP
      // re-acquire lands well inside it and the customer is still on the line.
      // Nothing is written anywhere for this — it is a `setTimeout` and nothing
      // else, and it cannot become a Redis TTL even in principle, because what it
      // defers is resuming media onto this in-memory session.
      // A manual (soft-phone) leg holds the window only once answered — see
      // `WebRtcBridgedCallParams.browserCloseGraceMs`.
      const graceApplies = !session.browserLegGraceAfterAnswerOnly || session.answeredAt != null;
      if (graceMs > 0 && graceApplies && !session.browserWsOwned && !session.isTearingDown) {
        log.info({ callId, graceMs, outcome: hangupOutcome }, 'Borrowed browser leg closed — holding for re-attach');
        session.armBrowserLegGrace(graceMs, hangUpForBrowserClose);
        return;
      }

      log.info({ callId, outcome: hangupOutcome }, 'Browser leg closed');
      hangUpForBrowserClose();
    };
    const onError = (err: Error): void => log.warn({ err, callId }, 'Browser leg WebSocket error');

    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);

    return () => {
      ws.off('message', onMessage);
      ws.off('close', onClose);
      ws.off('error', onError);
    };
  }

  // ─── PSTN leg (carrier media stream) ────────────────────────────────────────

  /**
   * Verify the provider-WSS token then attach the PSTN leg.
   *
   * Q6 (Manas, 2026-10-09): the check runs for every live session on a carrier,
   * and a missing provider key is refused unless its SET failed (`verifyWsToken`).
   * An unknown call id skips the check and is refused by `attachPstnLeg` itself.
   */
  async attachPstnLegVerified(callId: string, ws: WebSocket, token: string | undefined): Promise<boolean> {
    const session = this.sessions.get(callId);
    if (!session?.carrier) return this.attachPstnLeg(callId, ws);

    // ── HOLD WHAT THE CARRIER SENDS WHILE THE TOKEN IS CHECKED ──────────────
    //
    // `ws` buffers nothing for an event with no listener, and the carrier sends its
    // `start` frame as soon as the socket opens. `attachPstnLeg` registers the real
    // listener only after the token check's Redis round trip, so a `start` that landed
    // inside it was dropped: the call then sat open until the start timeout and ended
    // `provider_start_timeout` (or, under load, a refusal that should have been
    // `unsupported_media_format` became a timeout). The frames are held here, unread,
    // and replayed in order once the leg is attached; on a refused token they are
    // discarded with the socket.
    const early: Array<Buffer | string> = [];
    let dropped = 0;
    const hold = (data: Buffer | string): void => {
      if (early.length < PSTN_EARLY_FRAME_CAP) early.push(data);
      else dropped++;
    };
    ws.on('message', hold);
    let ok: boolean;
    try {
      ok = await this.verifyWsToken(callId, token, 'provider');
    } finally {
      // Nothing is awaited between here and `attachPstnLeg` registering its own
      // listener, so no frame can fall between the two.
      ws.off('message', hold);
    }
    if (!ok) {
      log.warn({ callId }, 'PSTN leg connect with invalid provider token — rejecting');
      closeQuietly(ws);
      return false;
    }
    if (dropped > 0) {
      log.warn({ callId, held: early.length, dropped }, 'PSTN frames past the hold cap during the token check — dropped');
    }
    return this.attachPstnLeg(callId, ws, early);
  }

  /**
   * Attach the provider media WebSocket (VoiceLink's lead WS, Plivo's `<Stream>`). `early` is what the
   * socket sent before this ran ({@link attachPstnLegVerified}); it is handled first, in
   * order, as though it had arrived after.
   */
  attachPstnLeg(callId: string, ws: WebSocket, early: ReadonlyArray<Buffer | string> = []): boolean {
    const session = this.sessions.get(callId);
    if (!session) {
      log.warn({ callId }, 'PSTN leg connect for unknown WebRTC call');
      closeQuietly(ws);
      return false;
    }

    // ── The terminal flags, not just the map ─────────────────────────────────
    //
    // `endCall` claims the call terminal (`endHandled = true`) and only removes it
    // from `this.sessions` ~100 lines later, AFTER awaiting `hangupProviderLeg` and
    // the repository write. Under ordinary loaded-Postgres latency that window is
    // wide, and a session inside it is still `this.sessions.get`-able — so
    // `!session` alone accepts a carrier leg for a call we have already finalized.
    //
    // The window matters because an unanswered VoiceLink cancel finalizes
    // immediately, so the terminal claim can land exactly when the carrier is
    // bringing the leg up. Accepting there would open the relay onto a dismissed
    // console, land a phantom `answered` entry in the compliance DENOMINATOR, and
    // let the `ended` arm see `bridged: true` and classify `connected` — which is
    // `max_attempts: 0`, permanently retiring a contact nobody ever spoke to.
    //
    // `ending` is refused alongside it: that flag is entered only on the ANSWERED
    // VoiceLink teardown, where we have deliberately closed `pstnWs` and are
    // awaiting `call.ended`. A fresh media connect there would reopen audio on a
    // call being torn down. It cannot starve the confirmation, which arrives on the
    // webhook path (`handleVoicelinkStatus`), never through here.
    if (session.isTearingDown) {
      log.warn(
        { callId, endHandled: session.endHandled, ending: session.ending, answered: session.answeredAt != null },
        'PSTN leg connect for a call already tearing down — refusing so the relay cannot reopen',
      );
      closeQuietly(ws);
      return false;
    }

    const prior = session.pstnWs;
    if (prior && prior !== ws) {
      if (prior.readyState === prior.OPEN) closeQuietly(prior);
    }
    session.pstnWs = ws;
    this.disableNagle(ws, callId);
    if (session.providerMediaReady) {
      // Media already negotiated (a provider that streams immediately, or a
      // mid-call re-connect): the socket connecting IS the media-ready signal.
      // Media flowing ⇒ the call is live — backstop the answer anchor in case the
      // answer event was dropped, so we never record 0 talk time / misclassify a
      // talked call as no_answer. First-write-wins, so a prior anchor is preserved.
      this.anchorAnswer(session);
    } else {
      // VoiceLink, Plivo: the socket opens BEFORE the carrier `start` frame. Do NOT anchor
      // answer here (an open-but-silent WS is not a connected call) — wait for a
      // valid `start` (handled in onPstnMessage). Arm a timeout so a WS that never
      // sends `start` is torn down instead of hanging as answered.
      session.setEndConfirmationTimer(this.startTimeoutSeconds, () => {
        if (!session.providerMediaReady && !session.endHandled) {
          log.warn({ callId }, 'Carrier media WS never sent a valid start — ending');
          this.inBackground(
            this.endCall(callId, { status: 'failed', outcome: 'provider_start_timeout', hangupProvider: false }),
            callId, 'Error ending call on start timeout',
          );
        }
      });
    }
    log.info({ callId, bothLegs: session.bothLegsConnected, mediaReady: session.providerMediaReady }, 'PSTN leg connected');
    this.emitBridgedIfLive(session);

    ws.on('message', (data: Buffer | string) => {
      this.onPstnMessage(session, typeof data === 'string' ? data : data.toString());
    });
    ws.on('close', () => {
      if (session.pstnWs !== ws) return;
      log.info({ callId }, 'PSTN leg closed');
      // If WE closed the WS as part of a local hangup (VoiceLink `ending`), do NOT
      // finalize here — we're deliberately waiting for the carrier's `call.ended`
      // confirmation (or the bounded timeout). A stray close otherwise finalizes.
      if (session.ending) return;
      this.inBackground(this.endCall(callId, {
        status: session.remoteEndStatus(),
        outcome: 'pstn_stream_closed',
        hangupProvider: false,
      }), callId, 'Error ending call on PSTN close');
    });
    ws.on('error', (err) => log.warn({ err, callId }, 'PSTN leg WebSocket error'));
    // Before the closed-socket check below: a socket's frames come before its close.
    for (const data of early) this.onPstnMessage(session, typeof data === 'string' ? data : data.toString());
    if (ws.readyState !== 1 /* OPEN */) {
      this.inBackground(this.endCall(callId, {
        status: session.remoteEndStatus(),
        outcome: 'pstn_stream_closed',
        hangupProvider: false,
      }), callId, 'Error ending call (PSTN closed during attach)');
    }
    return true;
  }

  // ─── Media relay ─────────────────────────────────────────────────────────

  private onBrowserMessage(session: WebRtcBridgeSession, raw: string): void {
    const t0 = process.hrtime.bigint();
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return; // non-JSON control frame
    }
    if (data?.event === 'media' && typeof data.media?.payload === 'string') {
      // An `alaw8` leg's audio is binary; a JSON media frame on it is not its format.
      if (session.browserMediaFormat !== 'pcm16') {
        this.noteIgnoredBrowserMedia(session, 'json media frame on an alaw8 leg');
        return;
      }
      // Drop until both legs are live AND the provider stream is negotiated — no
      // one to hear it yet (avoids buffering / sending before VoiceLink `start`).
      if (session.pstnWs?.readyState !== 1 || !session.providerMediaReady) return;
      // Bound the frame: reject an oversized base64 payload before decoding so a
      // compromised browser token can't drive unbounded allocation on the loop.
      if (isOversizedMediaPayload(data.media.payload)) {
        log.warn({ callId: session.callId, len: data.media.payload.length }, 'Dropped oversized browser media frame');
        return;
      }
      // Guard the decode/transcode: Buffer.from(payload,'base64') throws on a
      // non-string payload, and this runs in a ws 'message' listener — an uncaught
      // throw here would crash the replica (there is no global uncaughtException
      // handler). Drop the bad frame instead.
      try {
        if (session.carrier && session.codec) {
          // Browser PCM16 16kHz → carrier wire audio (stateful transcode), framed
          // the way the carrier expects.
          const pcm = Buffer.from(data.media.payload, 'base64');
          const wire = session.codec.pcm16kToCarrier(pcm);
          if (this.mayRelayToPstn(session)) {
            this.send(session.pstnWs, session.carrier.media.frameOutbound(wire.toString('base64'), session.providerStreamId));
            this.recordRelayFrame(session, 'b2p', t0);
          }
        }
      } catch (err) {
        log.warn({ err, callId: session.callId }, 'Dropped malformed browser media frame');
      }
    }
    // 'start'/'connected'/'stop' from the browser are informational here.
  }

  /**
   * A binary frame from the browser leg: raw A-law 8 kHz on an `alaw8` leg
   * (contracts `AgencyStationMediaFormat`), ignored on a `pcm16` one.
   *
   * Passthrough when the carrier's wire audio is A-law too (VoiceLink): the bytes go
   * out as they came, base64 inside the carrier's frame — no decode, no resample, no
   * encode. Any other carrier transcodes A-law → PCM16 16 kHz → its codec, the same
   * path a `pcm16` leg takes from the middle on. Same gates as the JSON path, in the
   * same order: nothing is relayed before the carrier stream is live, and a bad frame
   * is dropped before any work is done on it.
   */
  private onBrowserBinary(session: WebRtcBridgeSession, alaw: Buffer): void {
    const t0 = process.hrtime.bigint();
    if (session.browserMediaFormat !== 'alaw8') {
      this.noteIgnoredBrowserMedia(session, 'binary frame on a pcm16 leg');
      return;
    }
    if (session.pstnWs?.readyState !== 1 || !session.providerMediaReady) return;
    if (!isAcceptableAlawMessage(alaw.length)) {
      this.noteIgnoredBrowserMedia(session, 'alaw8 frame not a whole number of 20 ms frames, or over 1 s', alaw.length);
      return;
    }
    const carrier = session.carrier;
    if (!carrier) return;
    try {
      const wire = session.browserMediaPassthrough
        ? alaw
        : session.codec!.pcm16kToCarrier(session.browserAlawCodec().alawToPcm16k(alaw));
      if (this.mayRelayToPstn(session)) {
        this.send(session.pstnWs, carrier.media.frameOutbound(wire.toString('base64'), session.providerStreamId));
        this.recordRelayFrame(session, 'b2p', t0);
      }
    } catch (err) {
      log.warn({ err, callId: session.callId }, 'Dropped malformed browser media frame');
    }
  }

  /**
   * Carrier wire audio → an `alaw8` browser leg, as binary 20 ms messages. Passthrough
   * when the carrier speaks A-law (the decoded payload IS the audio); otherwise the
   * carrier codec to PCM16 16 kHz, then A-law. The caller has already gated on both legs
   * being live and bounded the payload.
   */
  private relayCarrierToAlawBrowser(session: WebRtcBridgeSession, payloadBase64: string, t0: bigint): void {
    const browserWs = session.browserWs;
    if (!browserWs) return;
    const wire = Buffer.from(payloadBase64, 'base64');
    let alaw: Buffer;
    if (session.browserMediaPassthrough) {
      alaw = wire;
    } else if (session.codec) {
      alaw = session.browserAlawCodec().pcm16kToAlaw(session.codec.carrierToPcm16k(wire));
    } else {
      return;
    }
    session.browserAlawFramer.push(alaw, (frame) => {
      if (this.mayRelayToBrowser(session, browserWs)) this.sendBinary(browserWs, frame);
    });
    this.recordRelayFrame(session, 'p2b', t0);
  }

  /**
   * Count a browser media frame this leg does not take, logging only the first per call
   * (at debug): a client in the wrong mode sends 50 a second, and one line says it.
   */
  private noteIgnoredBrowserMedia(session: WebRtcBridgeSession, why: string, bytes?: number): void {
    if (session.ignoredBrowserMediaFrames++ === 0) {
      log.debug({ callId: session.callId, mediaFormat: session.browserMediaFormat, why, bytes },
        'Ignoring browser media frame not in this leg\'s format (further ones counted, not logged)');
    }
  }

  private onPstnMessage(session: WebRtcBridgeSession, raw: string): void {
    const t0 = process.hrtime.bigint();
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (data?.event === 'start') {
      // A carrier that negotiates the media stream via `start` (VoiceLink):
      // validate the format, capture the real carrier ids + stream id, then open
      // the relay.
      //
      // Only such a carrier negotiates here. A `start` on another socket is a
      // no-op: its media is ready on connect, and a format check meant for a
      // negotiating carrier would tear down a working call.
      if (session.carrier?.media.negotiatesOnStart) this.handleProviderStart(session, data);
      return;
    }
    if (data?.event === 'media' && typeof data.media?.payload === 'string') {
      if (session.browserWs?.readyState !== 1 || !session.providerMediaReady) return;
      if (isOversizedMediaPayload(data.media.payload)) {
        log.warn({ callId: session.callId, len: data.media.payload.length }, 'Dropped oversized PSTN media frame');
        return;
      }
      // Guard the decode/transcode (see onBrowserMessage): a malformed payload from
      // the PSTN leg must never throw out of this ws listener and crash the replica.
      try {
        if (session.browserMediaFormat === 'alaw8') {
          this.relayCarrierToAlawBrowser(session, data.media.payload, t0);
        } else if (session.codec) {
          // Carrier wire audio → browser PCM16 16kHz (stateful transcode).
          const wire = Buffer.from(data.media.payload, 'base64');
          const pcm = session.codec.carrierToPcm16k(wire);
          if (this.mayRelayToBrowser(session, session.browserWs)) {
            this.send(session.browserWs, { event: 'media', media: { payload: pcm.toString('base64') } });
            this.recordRelayFrame(session, 'p2b', t0);
          }
        }
      } catch (err) {
        log.warn({ err, callId: session.callId }, 'Dropped malformed PSTN media frame');
      }
    } else if (data?.event === 'stop') {
      this.inBackground(this.endCall(session.callId, {
        status: session.remoteEndStatus(),
        outcome: 'pstn_stream_stopped',
        hangupProvider: false,
      }), session.callId, 'Error ending call on PSTN stop');
    }
    // 'playedStream'/'clearedAudio' are acks — ignored.
  }

  /**
   * Handle a carrier WS `start` frame: validate the media format against the
   * carrier module (VoiceLink: A-law 8kHz, the only format its codec supports),
   * capture the real carrier call id / stream id, mark the stream media-ready
   * (which opens the relay and anchors answer), and cancel the start-timeout. An
   * unsupported/malformed start ends the call rather than decoding garbage.
   */
  private handleProviderStart(session: WebRtcBridgeSession, data: any): void {
    // A media `start` on a call we have already torn down. Reachable on a leg that
    // was attached BEFORE the terminal claim (`attachPstnLeg`'s own guard only
    // refuses new connects), and it is the exact sequence behind the pilot
    // defect: anchor the answer, mark media ready, `emitBridgedIfLive` — so
    // `answered` lands a phantom entry in the compliance denominator and `bridged`
    // classifies the attempt `connected`, which is `max_attempts: 0` and retires
    // the contact. `ending` is included because it implies the call was answered
    // and we have deliberately closed `pstnWs`; the carrier's confirmation arrives
    // on the webhook path, never here.
    if (session.isTearingDown) {
      log.warn(
        { callId: session.callId, endHandled: session.endHandled, ending: session.ending },
        'Provider media start for a call already tearing down — ignoring',
      );
      return;
    }
    const media = session.carrier?.media;
    if (!media) return;
    const parsed = media.parseStart(data);
    if (!parsed.ok) {
      log.error(
        { callId: session.callId, provider: session.provider, encoding: parsed.encoding, rate: parsed.rate },
        'Carrier start with unsupported media format — ending call',
      );
      this.inBackground(this.endCall(session.callId, {
        status: 'failed',
        outcome: 'unsupported_media_format',
        errorCode: 'UNSUPPORTED_MEDIA_FORMAT',
        hangupProvider: false,
      }), session.callId, 'Error ending call on bad start');
      return;
    }

    // Capture the carrier's real ids (distinct from our dial-time correlation id).
    const { carrierCallId, streamId } = parsed;
    if (carrierCallId && !session.carrierCallId) {
      session.carrierCallId = carrierCallId;
      void this.persistCarrierCallId(session.callId, carrierCallId);
    }
    if (streamId) session.providerStreamId = streamId;

    session.clearEndConfirmationTimer(); // cancel the start-timeout
    session.providerMediaReady = true;
    // The negotiated stream is the connect/answer moment for such a carrier.
    this.anchorAnswer(session);
    log.info(
      { callId: session.callId, provider: session.provider, carrierCallId, streamId },
      `Carrier stream started (${media.formatLabel}) — relay open`,
    );
    this.emitBridgedIfLive(session);
  }

  // ─── Carrier callbacks ───────────────────────────────────────────────────

  /**
   * A VoiceLink status webhook: {@link handleCarrierStatus} for `voicelink`. VoiceLink has
   * no answer XML — the PSTN leg is established when VoiceLink dials into the pstn-stream
   * WS (URL baked into the dial request), so `answer` arrives here as a status event and
   * anchors talk-time.
   */
  async handleVoicelinkStatus(callId: string, event: CallEvent): Promise<void> {
    await this.handleCarrierStatus(callId, event, 'voicelink');
  }

  /**
   * A carrier's lifecycle event (ringing, answer, terminal), parsed by that carrier's own
   * route into a `CallEvent`. The carrier module's `lifecycle` reads it (the carrier's
   * real call id, the recording URL, the terminal classification: no_answer / busy /
   * canceled / failed rather than a generic telephony error), so nothing here branches
   * on the carrier. Terminal events are handled even when the live session is already
   * gone (a late completion, or the carrier confirming a local hangup).
   *
   * `provider` is the carrier whose route received the event. An event for a call placed
   * on another carrier is ignored: each carrier's events are read only by its own module.
   */
  async handleCarrierStatus(callId: string, event: CallEvent, provider: string): Promise<void> {
    const lifecycle = findCarrierModule(provider)?.lifecycle;
    if (!lifecycle) {
      log.warn({ callId, provider }, 'Status event from a carrier with no lifecycle reader — ignoring');
      return;
    }
    // The carrier's own reading of the event: its real call id, recording URL, classifier.
    const facts = lifecycle.readEvent(event);
    const session = this.sessions.get(callId);

    // ── No live session: a late/terminal event (e.g. call.completed after we
    // already tore down, or carrier confirming our hangup). Persist final data
    // (recording URL, real carrier id, terminal outcome) idempotently and return.
    if (!session) {
      // Progress for a call that is no longer here: the carrier is still connecting a leg
      // nobody will take (a dismissal whose cancel came too late, a teardown that had no
      // handle to send). The event names the call: hang it up by that id.
      if (event.eventType === 'ringing' || event.eventType === 'answer') {
        this.inBackground(
          this.hangupStrayCarrierLeg(callId, provider, facts.carrierCallId, event.eventType, 'no live session'),
          callId, 'Error hanging up a carrier leg with no live session',
        );
        return;
      }
      await this.persistLateCarrierTerminal(callId, event, facts, provider);
      return;
    }
    if (session.provider !== provider) {
      log.warn({ callId, provider, callProvider: session.provider }, 'Status event from another carrier than the call was placed on — ignoring');
      return;
    }

    // Learn the carrier's real id even if a dial-time placeholder is present.
    if (facts.carrierCallId && facts.carrierCallId !== session.carrierCallId) {
      session.carrierCallId = facts.carrierCallId;
      await this.persistCarrierCallId(callId, facts.carrierCallId);
    }

    // ── Progress events for a call already tearing down ─────────────────────
    //
    // `answer` and `ringing` are PROGRESS, and progress on a settled call is not
    // information — it is corruption. `endCall` claims a call terminal
    // (`endHandled`) roughly a hundred lines before `sessions.delete`, awaiting a
    // carrier hangup and a repository write in between, so the session is still
    // `sessions.get`-able for that whole window.
    //
    // This is the same window `attachPstnLeg` refuses, and it is the one that
    // matters MOST here, because VoiceLink has no answer XML: `case 'answer'` IS
    // the answer path for that carrier. Left unguarded it would do three things to
    // a cancelled dial the customer then picked up: `anchorAnswer` emits
    // `answered`, which lands a phantom entry in the compliance DENOMINATOR and
    // (with the bind refused) drives `abandonAnsweredCall`; the `in_progress` write
    // lands on top of a terminal row; and `endCall`'s own `ended` then reads
    // `answered: true`, so the classifier's `canceled` arm records `abandoned` —
    // against the 3% ceiling — for a dial nobody had reached.
    //
    // Terminal events are deliberately NOT guarded here: `hangup`/`error` during
    // `ending` are the carrier confirmation `finalizeEnding` is waiting for, and
    // refusing them would strand the deferred teardown for its full 45s. That is
    // why this sits inside the switch's progress arms rather than at the top of
    // the method.
    if ((event.eventType === 'answer' || event.eventType === 'ringing')
      && session.isTearingDown) {
      log.warn(
        { callId, provider, eventType: event.eventType, endHandled: session.endHandled, ending: session.ending },
        'Carrier progress event for a call already tearing down — ignoring so it cannot resurrect the row or emit a phantom answer',
      );
      // Ignored for the call, but the leg it reports is real: the teardown's own hangup may
      // have had no call id to send (a cancel the carrier no longer held), and this event
      // names it. At most once with that teardown's hangup (the memo).
      this.inBackground(
        this.hangupStrayCarrierLeg(callId, provider, facts.carrierCallId || session.carrierCallId || '', event.eventType, 'tearing down'),
        callId, 'Error hanging up the carrier leg of a call tearing down',
      );
      return;
    }

    switch (event.eventType) {
      case 'answer':
        this.anchorAnswer(session);
        if (session.status !== 'in_progress') {
          session.status = 'in_progress';
          // Tracked: the terminal write in `endCall` must not overtake it.
          await session.trackProgressWrite(
            webrtcCallRepository.update(callId, { status: 'in_progress', answered_at: session.answeredAt }),
          );
          this.notifyBrowser(session, { event: 'status', status: 'answered' });
        }
        return;
      case 'ringing':
        if (session.status === 'initiating') {
          session.status = 'ringing';
          await session.trackProgressWrite(webrtcCallRepository.update(callId, { status: 'ringing' }));
          this.notifyBrowser(session, { event: 'status', status: 'ringing' });
        }
        return;
      case 'hangup':
      case 'error': {
        this.noteCarrierLegSettled(callId, 'terminal');
        // A second terminal while the first one's teardown is still in flight
        // (`endHandled` is claimed ~100 lines before `sessions.delete`, across the
        // terminal write). VoiceLink posts `call.ended` and then `call.completed`, and
        // only the second carries the recording URL; delivered concurrently (or
        // retried), it lands in this window. Routed through `endCall` it would set
        // `session.recordingUrl` after the terminal write was composed and then return
        // at `endHandled` — the recording silently lost, and the analysis job left
        // waiting for one that never comes. It is a late terminal in all but name, so
        // it takes the late path, which fills the recording and carrier id idempotently.
        if (session.endHandled) {
          await this.persistLateCarrierTerminal(callId, event, facts, provider);
          return;
        }
        // Terminal. If we're already awaiting carrier confirmation of a local
        // hangup, THIS is that confirmation — finalize with the pending intent.
        if (session.ending) {
          await this.finalizeEnding(callId, facts);
          return;
        }
        // Otherwise classify the remote outcome precisely (no_answer/busy/…).
        // A real VoiceLink `call.ended` payload carries NO `callStatus` (only
        // `status`, `hangupCause`, `answeredAt`), so `facts.wasAnswered` is false even
        // for a call we already anchored as answered on `call.answered`. Fold in the
        // session's own answer state so a normal remote hangup of an answered call
        // classifies as `completed`, not `failed`. `session.answeredAt` is the
        // authoritative first-write-wins anchor.
        const answered = facts.wasAnswered || session.answeredAt != null;
        const { status, outcome, rawCause } = facts.classify(answered);
        if (facts.recordingUrl) session.recordingUrl = facts.recordingUrl;
        await this.endCall(callId, {
          status,
          outcome,
          ...(status === 'failed' && !answered
            ? { errorCode: 'TELEPHONY_ERROR', errorMessage: rawCause || undefined }
            : {}),
          recordingUrl: facts.recordingUrl,
          hangupProvider: false,
        });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Persist final data from a terminal carrier event that arrived with no live
   * session (late `call.completed`, or a carrier confirmation after teardown).
   * Idempotent: only fills recording/provider-id and, if the row wasn't already
   * terminal, records the classified outcome. Never runs teardown a second time
   * (it already ran).
   */
  private async persistLateCarrierTerminal(
    callId: string,
    event: CallEvent,
    facts: CarrierEventFacts,
    provider: string,
  ): Promise<void> {
    if (event.eventType !== 'hangup' && event.eventType !== 'error') return;
    this.noteCarrierLegSettled(callId, 'terminal');
    await this.persistLateCarrierData(callId, provider, facts, 'terminal');
  }

  /** Remember that `callId`'s carrier leg needs nothing more sent ({@link carrierLegsSettled}). */
  private noteCarrierLegSettled(callId: string, how: 'terminal' | 'hung_up'): void {
    if (this.carrierLegsSettled.has(callId)) return;
    if (this.carrierLegsSettled.size >= CARRIER_LEGS_SETTLED_MAX) {
      this.carrierLegsSettled.delete(this.carrierLegsSettled.keys().next().value!);
    }
    this.carrierLegsSettled.set(callId, how);
  }

  /**
   * Claim the one hangup of `callId`'s carrier leg: false when the carrier has reported
   * its terminal or a hangup or cancel has already gone out. Synchronous, so two paths
   * racing to hang one leg up (the teardown and a late progress event) send one request.
   */
  private claimCarrierLegHangup(callId: string): boolean {
    if (this.carrierLegsSettled.has(callId)) return false;
    this.noteCarrierLegSettled(callId, 'hung_up');
    return true;
  }

  /**
   * Hang up a carrier leg that is still being connected for a call that has ended here,
   * or is ending: the carrier reported progress (`ringing`, `answer`) for a call with no
   * live session, or one tearing down. That leg reaches a customer nobody will take: a
   * dial the agent dismissed after the carrier had stopped holding its request (the
   * cancel answered "not found") but before the carrier named the call, so the teardown
   * had no id to hang up by. The event names it now.
   *
   * Sent, through the carrier's own adapter on the account the call was placed on (its
   * pinned credential resolved for `call_control`, {@link carrierCallbackAdapter}), only:
   *  - for a carrier whose adapter hangs a call up by its id (`answeredHangup: 'rest'`); a
   *    carrier whose only lever is closing our media socket has nothing to send here;
   *  - with a non-empty call id (an empty one may address every call on the account);
   *  - at most once per call, and never once the carrier has reported the call's terminal
   *    ({@link claimCarrierLegHangup}).
   * Never throws.
   */
  private async hangupStrayCarrierLeg(
    callId: string,
    provider: string,
    carrierCallId: string,
    eventType: string,
    why: 'no live session' | 'tearing down',
  ): Promise<void> {
    if (findCarrierModule(provider)?.answeredHangup !== 'rest') return;
    if (!carrierCallId) {
      log.warn({ callId, provider, eventType, why }, 'Carrier progress for a call that has ended here names no call id — nothing can be hung up');
      return;
    }
    if (!this.claimCarrierLegHangup(callId)) return;
    const adapter = await this.carrierCallbackAdapter(callId, provider);
    if (!adapter) {
      log.error(
        { callId, provider, carrierCallId, eventType, why },
        'Cannot resolve the carrier account to hang up a leg still connecting for a call that has ended — it may reach the customer',
      );
      return;
    }
    try {
      await adapter.endCall(carrierCallId);
      log.warn(
        { callId, provider, carrierCallId, eventType, why },
        'Carrier was still connecting a call that has ended here — hung its leg up by the call id',
      );
    } catch (err) {
      log.error({ err, callId, provider, carrierCallId, eventType, why }, 'Hanging up a carrier leg still connecting for a call that has ended failed');
    }
  }

  /**
   * Fill a call row's recording URL and carrier id from a carrier event that has no live
   * session to go to, and wake a dialer-analysis job waiting on the recording. Idempotent:
   * a recording URL already on the row is kept. A row placed on another carrier is left
   * alone. Never throws.
   */
  private async persistLateCarrierData(
    callId: string,
    provider: string,
    facts: Pick<CarrierEventFacts, 'carrierCallId' | 'recordingUrl'>,
    what: 'terminal' | 'recording',
  ): Promise<void> {
    try {
      const existing = await webrtcCallRepository.findById(callId);
      if (!existing) return;
      // `provider` is absent only on a hand-built row; a real row always names its carrier.
      if (existing.provider && existing.provider !== provider) {
        log.warn({ callId, provider, callProvider: existing.provider }, 'Late carrier event from another carrier than the call was placed on — ignoring');
        return;
      }
      const patch: Record<string, unknown> = {};
      if (facts.recordingUrl && !existing.recording_url) patch.recording_url = facts.recordingUrl;
      if (facts.carrierCallId && facts.carrierCallId !== existing.provider_call_id) {
        patch.provider_call_id = facts.carrierCallId;
      }
      if (Object.keys(patch).length > 0) {
        await webrtcCallRepository.update(callId, patch);
        log.info({ callId, provider, patch: Object.keys(patch) }, `Persisted late carrier ${what} data`);
      }
      // A late recording_url may satisfy a dialer-analysis job still awaiting one.
      if (patch.recording_url) await getBridgeAnalysisHooks().onRecordingReady(callId);
    } catch (err) {
      log.error({ err, callId, provider }, `Failed to persist late carrier ${what} data`);
    }
  }

  /**
   * A carrier's recording-ready callback (Plivo's `<Record callbackUrl>`), carrying the
   * recording URL. On a live call it is kept for the terminal write (which hands it to
   * analysis at finalize); once the call has ended or is ending, it is written to the row
   * at once and recording-ready fires, as for a late VoiceLink completion.
   */
  async handleCarrierRecording(
    callId: string,
    provider: string,
    recording: { recordingUrl: string; carrierCallId?: string },
  ): Promise<void> {
    if (!recording.recordingUrl) return;
    const session = this.sessions.get(callId);
    if (session && session.provider === provider && !session.endHandled) {
      session.recordingUrl = recording.recordingUrl;
      return;
    }
    await this.persistLateCarrierData(
      callId, provider, { carrierCallId: recording.carrierCallId ?? '', recordingUrl: recording.recordingUrl }, 'recording',
    );
  }

  /**
   * The adapter that checks a carrier callback for `callId`: the account the call was
   * placed on (the tenant credential pinned on it, resolved for `call_control`, or the
   * service's own account). Read off the live session, else off the call row (a callback
   * after teardown). Null when the call is unknown, was placed on another carrier, or
   * its credential cannot be resolved: the callback is then refused.
   */
  async carrierCallbackAdapter(callId: string, provider: string): Promise<TelephonyProvider | null> {
    const session = this.sessions.get(callId);
    let pin: { provider: string; credentialId: string | null; tenantId: string };
    if (session) {
      pin = { provider: session.provider, credentialId: session.telephonyCredentialId, tenantId: session.tenantId };
    } else {
      let row: WebRtcCallRecord | null;
      try {
        row = await webrtcCallRepository.findById(callId);
      } catch (err) {
        log.error({ err, callId, provider }, 'Could not read the call a carrier callback names');
        return null;
      }
      if (!row) return null;
      pin = { provider: row.provider, credentialId: row.telephony_credential_id ?? null, tenantId: row.tenant_id };
    }
    if (pin.provider !== provider) {
      log.warn({ callId, provider, callProvider: pin.provider }, 'Carrier callback for a call placed on another carrier — refusing');
      return null;
    }
    try {
      return await this.telephonyRegistry.getForCredentialId(provider, pin.credentialId, 'call_control', pin.tenantId);
    } catch (err) {
      log.error(
        { err, callId, provider, telephonyCredentialId: pin.credentialId },
        'Cannot resolve the carrier account a callback must be checked against — refusing it',
      );
      return null;
    }
  }

  /**
   * The far end answered a call whose carrier fetches the media stream from our answer
   * response (`mediaUrlInDialRequest: false`). Runs the answer as a status event (learns
   * the carrier's call id, anchors the answer, writes `in_progress`) and returns what the
   * answer response is built from: the stream URL kept at dial time and the recording.
   *
   * Null — the route answers with a hangup — for a call that is unknown here, placed on
   * another carrier, or tearing down (its teardown found no call to hang up: this is
   * where that customer's phone is put down), or that has no stream URL.
   */
  async answerCarrierCall(callId: string, event: CallEvent, provider: string): Promise<CarrierAnswerPlan | null> {
    const session = this.sessions.get(callId);
    // The answer for a call that has ended here (or is ending) is answered with a hangup,
    // and its leg is hung up by the id the answer names too (`hangupStrayCarrierLeg`): the
    // answer XML is one lever, the REST hangup the one the carrier always honours.
    const stray = (why: 'no live session' | 'tearing down'): void => {
      const carrierCallId = findCarrierModule(provider)?.lifecycle?.readEvent(event).carrierCallId ?? '';
      this.inBackground(
        this.hangupStrayCarrierLeg(callId, provider, carrierCallId, 'answer', why),
        callId, 'Error hanging up the carrier leg of an answer for a call that has ended',
      );
    };
    if (!session || session.provider !== provider) {
      log.warn({ callId, provider }, 'Answer callback for a call with no live session here — answering with a hangup');
      if (!session) stray('no live session');
      return null;
    }
    if (session.isTearingDown) {
      log.warn({ callId, provider, endHandled: session.endHandled }, 'Answer callback for a call already tearing down — answering with a hangup');
      stray('tearing down');
      return null;
    }
    if (!session.answerStreamUrl) {
      log.error({ callId, provider }, 'Answer callback for a call with no stream URL — answering with a hangup');
      return null;
    }
    await this.handleCarrierStatus(callId, event, provider);
    // The answer may have been the last straw (a teardown that ran meanwhile).
    if (session.isTearingDown || this.sessions.get(callId) !== session) return null;
    return {
      streamUrl: session.answerStreamUrl,
      enableRecording: session.recordEnabled,
      ...(session.recordEnabled && session.recordingCallbackUrl ? { recordingCallbackUrl: session.recordingCallbackUrl } : {}),
      ...(session.maxDurationSeconds ? { maxDurationSeconds: session.maxDurationSeconds } : {}),
    };
  }

  // ─── Termination ─────────────────────────────────────────────────────────

  /**
   * A locally-initiated hangup (user, max-duration, browser close, an agency
   * agent dismissing a ringing dial). For a provider whose carrier leg is torn
   * down by an API call, this finalizes immediately. For a provider whose ONLY
   * teardown is closing our WS (VoiceLink), an **answered** call must NOT
   * finalize before the carrier confirms `call.ended` — otherwise we'd finalize
   * while the PSTN leg may still be live. So we enter an `ending` state: close the
   * provider WS, notify the browser, and wait for `call.ended` (or
   * {@link CARRIER_END_CONFIRM_TIMEOUT_SECONDS}) before the real `endCall`.
   * Idempotent.
   *
   * **An UNANSWERED call never enters `ending`** (the ring-cancel case; pilot
   * 2026-09-08, callId `064836f1-8915-49f8-9c5a-c741f3cdd2af`). Deferring it is
   * wrong twice. The cheap way: nothing connected and the carrier has nothing to
   * confirm, so the call would sit in limbo for the whole confirm window holding
   * a concurrency slot. The way that reaches customers: `ending` keeps the
   * session in `this.sessions`, so when the carrier answers *after* the agent has
   * dismissed the dial, the PSTN leg's `pstn-stream` connect finds a live session
   * and {@link attachPstnLeg} bridges it — into a console nobody is watching (16
   * seconds in the pilot). Finalizing now drops the session from the map, so that
   * same connect hits `attachPstnLeg`'s unknown-call branch and is closed, the
   * relay never opens, and the late `call.answered`/`call.ended` land in
   * {@link persistLateCarrierTerminal} where they belong. The point is the
   * *removal from the map*, not the status we write.
   */
  private async localHangup(
    callId: string,
    intent: { status: WebRtcCallStatus; outcome?: string; errorCode?: string; errorMessage?: string },
  ): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session || session.endHandled) return;

    // A provider with a real hangup API → finalize now.
    if (session.carrier?.answeredHangup !== 'close_media') {
      await this.endCall(callId, { ...intent, hangupProvider: true });
      return;
    }

    // VoiceLink, never answered → finalize now (see the header). `hangupProvider`
    // is true so the attempt is made and, where it cannot succeed,
    // `hangupProviderLeg` says so at WARN with the call id an operator can grep.
    if (session.answeredAt === null) {
      log.info({ callId, intent: intent.outcome }, 'VoiceLink local hangup before answer — finalizing now, not deferring');
      await this.endCall(callId, { ...intent, hangupProvider: true });
      return;
    }

    // VoiceLink, answered → deferred, carrier-confirmed teardown.
    if (session.ending) return; // already awaiting confirmation
    session.ending = true;
    session.pendingEnd = intent;
    session.clearMaxDurationTimer();
    log.info({ callId, intent: intent.outcome }, 'VoiceLink local hangup — closing WS, awaiting call.ended');
    // Deliberately close the provider WS: this is VoiceLink's only hangup mechanism.
    try {
      if (session.pstnWs && session.pstnWs.readyState === 1) session.pstnWs.close();
    } catch (err) {
      log.warn({ err, callId }, 'Error closing VoiceLink PSTN WS on local hangup');
    }
    // Tell the browser the call is ending (audio stops now); the row is finalized
    // on carrier confirmation. The browser leg is closed at finalize.
    this.notifyBrowser(session, { event: 'status', status: 'ending' });
    // Bounded fallback: finalize even if `call.ended` never arrives.
    session.setEndConfirmationTimer(CARRIER_END_CONFIRM_TIMEOUT_SECONDS, () => {
      log.warn({ callId }, 'VoiceLink call.ended not received — finalizing on timeout');
      this.inBackground(this.finalizeEnding(callId, null), callId, 'Error finalizing VoiceLink call on timeout');
    });
  }

  /**
   * Finalize a VoiceLink call that was in the `ending` state, once the carrier
   * confirmed `call.ended`/`call.completed` (or the confirmation timed out).
   * Merges any final recording/outcome data into the pending intent and runs the
   * real terminal teardown exactly once.
   */
  private async finalizeEnding(
    callId: string,
    facts: CarrierEventFacts | null,
  ): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session || session.endHandled) return;
    session.clearEndConfirmationTimer();
    const intent = session.pendingEnd ?? { status: 'completed', outcome: 'ended_by_user' };
    if (facts?.recordingUrl) session.recordingUrl = facts.recordingUrl;
    await this.endCall(callId, {
      ...intent,
      recordingUrl: facts?.recordingUrl ?? session.recordingUrl ?? undefined,
      // WS already closed in localHangup; nothing more to hang up.
      hangupProvider: false,
    });
  }

  /**
   * Hang up the carrier leg, best effort. Never throws — every caller is on a
   * teardown path, and a carrier that will not answer must not be able to skip
   * terminal persistence or slot release.
   *
   * Its own method because two callers need it: {@link endCall} and the dial race
   * in {@link placeOutboundLeg}. A call tears down on the carrier account it was
   * PLACED on: the tenant credential pinned on its row (`telephony_credential_id`,
   * resolved for `call_control` and checked against the call's tenant), or, when
   * that is null, the service's own account. A null id takes the synchronous
   * `get(provider)` lookup directly, so a call on the service's own account tears
   * down exactly as it did before credentials existed.
   *
   * A pinned credential that does not resolve is logged at ERROR and the hangup is
   * skipped: there is no other account to hang the leg up on, and the leg may still
   * be live. It never falls back to the service's own account (decision B20).
   *
   * Which handle reaches the carrier, and never an empty one (a Plivo hangup with no id
   * disconnects every call on the account):
   *  - before the answer, with a dial request id (Plivo's `request_uuid`) and an adapter
   *    that cancels by it: the dial is cancelled by that id. If the carrier no longer
   *    holds the request (`not_found`: it has connected, or is ringing past the queue),
   *    or the cancel itself failed (a 5xx, a network error, a timeout: it says nothing
   *    about the leg), and the carrier has named the call (read again after the cancel:
   *    a ring callback may have named it meanwhile), the call is hung up by its id. If it
   *    has not, nothing more can be sent now: the carrier's next ring or answer callback
   *    names the call and hangs it up ({@link hangupStrayCarrierLeg}), and an answer
   *    callback is answered with a hangup besides;
   *  - otherwise the carrier's call id (`carrierCallId`, learned from its callbacks or
   *    stream), else the dial-time id (`providerCallId`), through `endCall`;
   *  - with neither, nothing is sent.
   *
   * The adapter is resolved even when there is no handle to send, because that
   * combination — a teardown with no carrier handle — is exactly the case the
   * capability warning below exists to report.
   */
  private async hangupProviderLeg(session: WebRtcBridgeSession): Promise<void> {
    const callId = session.callId;
    let hangupAdapter: TelephonyProvider;
    try {
      hangupAdapter = session.telephonyCredentialId
        ? await this.telephonyRegistry.getForCredentialId(
          session.provider, session.telephonyCredentialId, 'call_control', session.tenantId,
        )
        : this.telephonyRegistry.get(session.provider);
    } catch (err) {
      log.error(
        {
          err, callId, correlationId: session.correlationId, provider: session.provider,
          telephonyCredentialId: session.telephonyCredentialId,
        },
        'Cannot resolve the carrier account this call was placed on — the carrier leg was NOT hung up and may still be live',
      );
      return;
    }
    try {
      // A teardown while the far end is still RINGING, against a carrier whose
      // `endCall` cannot recall such a leg. WARN rather than a metric because
      // this file deliberately imports no metrics (suites mock that module with
      // explicit factories); this is the line an operator greps in Loki when
      // a customer reports a call from nobody. `canCancelRinging` fails closed, so
      // an adapter that has not declared the capability lands here too.
      if (session.answeredAt === null && !canCancelRinging(hangupAdapter)) {
        log.warn(
          { callId, correlationId: session.correlationId, provider: session.provider },
          'Pre-answer teardown on a carrier that cannot cancel a ringing leg — '
          + 'the customer may still be ringing and we have no lever to recall it',
        );
      }

      let carrierCallId = session.carrierCallId || session.providerCallId || null;
      if (session.answeredAt === null && session.providerRequestId && hangupAdapter.cancelDialRequest) {
        let cancelled: 'canceled' | 'not_found' | 'failed';
        try {
          cancelled = await hangupAdapter.cancelDialRequest(session.providerRequestId);
        } catch (err) {
          // A 5xx, a network error or a timeout says nothing about the leg: it may still
          // be ringing. Go on to the hangup by the call id, as for `not_found`.
          log.warn(
            { err, callId, correlationId: session.correlationId, provider: session.provider, providerRequestId: session.providerRequestId },
            'Cancelling the dial request failed — hanging up by the call id if the carrier has named it',
          );
          cancelled = 'failed';
        }
        if (cancelled === 'canceled') {
          this.noteCarrierLegSettled(callId, 'hung_up');
          return;
        }
        // The carrier may have named the call while the cancel was out (its ring callback).
        carrierCallId = session.carrierCallId || session.providerCallId || null;
        if (!carrierCallId) {
          log.warn(
            { callId, correlationId: session.correlationId, provider: session.provider, providerRequestId: session.providerRequestId, cancelled },
            'Carrier no longer holds the dial request (or the cancel failed) and has not named the call — '
            + 'its next ring or answer callback names it and is hung up then',
          );
          return;
        }
      }
      if (!carrierCallId) return;
      // A late progress event may already have hung this leg up (or the carrier ended it).
      if (!this.claimCarrierLegHangup(callId)) return;
      await hangupAdapter.endCall(carrierCallId);
    } catch (err) {
      log.warn({ err, callId }, 'Error hanging up provider leg (already ended?)');
    }
  }

  /**
   * Tear down a registered session whose carrier leg was never placed: a throw in
   * {@link placeOutboundLeg} between registering the session and the carrier request.
   * The full {@link endCall} (terminal row, timers, the borrowed socket detached, slots,
   * lease entry, tokens), with no carrier hangup because there is no leg, and with **no
   * `ended` lifecycle event**: the dial's rejection, thrown next, is the one signal.
   *
   * Why no `ended`: a dial that never reached the carrier is settled by the caller's
   * catch, exactly as a refused admission or a failed INSERT already is (neither ever
   * has a session). Both dial-side consumers settle on whichever signal comes first,
   * and an `ended` here would be settled as a call that was placed: the agency
   * dialer's `ended` arm (`live.placing`, an error code other than outcome-unknown)
   * would charge the contact's `failed` allowance and schedule the campaign's retry for
   * a dial that never left this process, and the soft phone would settle the manual
   * call there as well as in its own catch (`abandonUnplaced`), which a rejection that
   * is not `telephony_init_failed` sends it to. Nothing else was told about this call:
   * no carrier event can precede the carrier request, so no `answered` or `bridged`
   * was emitted for it.
   *
   * Never throws: the caller rethrows the original error.
   */
  private async abortUnplacedLeg(
    callId: string,
    err: unknown,
    /** A refusal with its own code (`bridge/dial-refusals.ts`); absent: a bridge setup failure. */
    refusal?: UnplacedRefusal,
  ): Promise<void> {
    if (refusal) log.warn({ err, callId, code: refusal.code }, 'WebRTC call refused before its carrier leg was placed — tearing it down');
    else log.error({ err, callId }, 'WebRTC call failed before its carrier leg was placed — tearing it down');
    try {
      await this.endCall(callId, {
        status: 'failed',
        outcome: refusal?.outcome ?? 'bridge_setup_failed',
        errorCode: refusal?.errorCode ?? 'BRIDGE_SETUP_FAILED',
        errorMessage: err instanceof Error ? err.message : String(err),
        hangupProvider: false,
        announce: false,
      });
    } catch (teardownErr) {
      log.error({ err: teardownErr, callId }, 'Teardown of a call that was never placed failed');
    }
  }

  /**
   * Idempotent teardown: persist the terminal row, close both legs, and release
   * the shared slots. `announce: false` skips the `ended` lifecycle event (only
   * {@link abortUnplacedLeg} passes it); everything else runs.
   */
  private async endCall(
    callId: string,
    opts: {
      status: WebRtcCallStatus;
      outcome?: string;
      errorCode?: string;
      errorMessage?: string;
      recordingUrl?: string;
      hangupProvider: boolean;
      announce?: boolean;
    },
  ): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) return;
    if (session.endHandled) return;
    session.endHandled = true;
    session.clearMaxDurationTimer();
    // A dial still waiting to be sent is called off (`OutboundCallRequest.signal`).
    session.dialAbort?.abort();

    const talkTime = session.getTalkTimeSeconds();
    const duration = session.getDurationSeconds();

    // Hang up the carrier leg if it's still up (best effort, never throws).
    if (opts.hangupProvider) await this.hangupProviderLeg(session);

    const recordingUrl = opts.recordingUrl ?? session.recordingUrl ?? undefined;
    // A `ringing`/`in_progress` write still in flight would otherwise be free to land
    // after this one (two pool connections, no order between them) and leave a live
    // status on a terminal row. None can start from here on: every progress path
    // refuses once `endHandled` is set above.
    await session.progressWritesSettled();
    try {
      await webrtcCallRepository.update(callId, {
        status: opts.status,
        outcome: opts.outcome ?? null,
        error_code: opts.errorCode ?? null,
        error_message: opts.errorMessage ?? null,
        ended_at: new Date(),
        duration_seconds: duration,
        talk_time_seconds: talkTime,
        ...(recordingUrl ? { recording_url: recordingUrl } : {}),
      });
    } catch (err) {
      log.error({ err, callId }, 'Failed to persist terminal WebRTC call row');
    }

    // Product analytics — terminal funnel event (best-effort, PII-free).
    trackWebrtcCallCompleted({
      callId,
      tenantId: session.tenantId,
      accountId: session.accountId,
      provider: session.provider,
      status: opts.status,
      outcome: opts.outcome,
      connected: session.answeredAt != null,
      durationSeconds: duration,
      talkTimeSeconds: talkTime,
      errorCode: opts.errorCode,
      endedBy: webrtcEndedBy(opts),
    });

    // No settlement step: there is no billing in v1 (decision S6); the terminal row
    // above carries the usage facts for metering later.

    // Post-call analysis enqueue (agency_call_analysis), through the analysis seam
    // with the facts read off the session. Fire-and-forget so a gate/enqueue failure
    // can never affect teardown.
    void getBridgeAnalysisHooks().onCallFinalized({
      callId,
      tenantId: session.tenantId,
      accountId: session.accountId,
      campaignId: session.campaignId,
      answeredAt: session.answeredAt,
      talkTimeSeconds: session.getTalkTimeSeconds(),
    }).catch((err) =>
      log.error({ err, callId }, 'Dialer analysis enqueue failed'));

    auditLogger.log({
      callId,
      tenantId: session.tenantId,
      accountId: session.accountId,
      eventType: 'webrtc_call.ended',
      eventCategory: 'call',
      severity: 'info',
      eventData: { status: opts.status, outcome: opts.outcome, talk_time_seconds: talkTime },
    });

    // Observers (e.g. the agency dialer) see the terminal moment BEFORE teardown,
    // while the session is still readable. Listener throws are swallowed — nothing
    // a subscriber does may interrupt slot release below.
    if (opts.announce !== false) this.emitLifecycle({
      callId,
      correlationId: session.correlationId,
      phase: 'ended',
      status: opts.status,
      outcome: opts.outcome,
      errorCode: opts.errorCode,
      errorMessage: opts.errorMessage,
      answered: session.answeredAt != null,
      answeredAt: session.answeredAt ?? undefined,
      talkTimeSeconds: talkTime,
    });

    // Notify the browser then tear down both legs.
    this.notifyBrowser(session, { event: 'ended', reason: opts.outcome ?? opts.status });
    session.destroy();
    this.sessions.delete(callId);

    // Release the shared slots.
    await this.releaseSlots(session);
    // Slot accounting changed — keep the self-heal poll armed so any drift left by
    // a partial release (or a lock that expired mid-call) is caught before dormancy.
    this.guardHost.wakeSelfHeal();
    await this.tokens.clearWsToken(callId);

    log.info({
      callId, status: opts.status, talkTime, duration,
      browserToPstnFrames: session.browserToPstnFrames,
      pstnToBrowserFrames: session.pstnToBrowserFrames,
      maxRelayDwellMicros: Math.round(session.maxRelayDwellMicros),
      browserMediaFormat: session.browserMediaFormat,
      ignoredBrowserMediaFrames: session.ignoredBrowserMediaFrames,
      droppedBrowserMediaFrames: session.droppedBrowserMediaFrames,
      droppedPstnMediaFrames: session.droppedPstnMediaFrames,
    }, 'WebRTC call ended');
  }

  // ─── Concurrency ─────────────────────────────────────────────────────────────
  private async releaseSlots(session: WebRtcBridgeSession): Promise<void> {
    if (!session.slotsHeld || !session.concurrencyKey) return;
    session.slotsHeld = false;
    await this.releaseSlotsByKey(
      session.concurrencyKey,
      session.tenantId,
      session.accountId,
      session.provider,
      session.callId,
    );
  }

  /**
   * A bridge holds three telephony scopes (global, account, provider) and hands
   * them back through the shared helper: one Redis transaction where that is
   * safe, per scope otherwise. The helper keeps its failure isolation (a throw on
   * one scope cannot skip another) and reports the outcome as
   * `telephony_lease_release_total{source="webrtc"}`.
   *
   * Does not wake the self-heal sweep. `releaseSlots` (end-of-call) wakes it
   * unconditionally right after; the dial-rollback caller does not wake it.
   */
  private async releaseSlotsByKey(
    key: string,
    tenantId: string,
    accountId: string,
    provider: string,
    callId?: string,
  ): Promise<void> {
    // `key` is a random uuid that appears in no other log line, so the bridge
    // call id is threaded through purely for correlation.
    await releaseTelephonyLease(this.guardHost, {
      concurrencyKey: key, tenantId, accountId, provider, source: 'webrtc',
      ...(callId ? { callId } : {}),
    });
    this.noteLease({ op: 'released', concurrencyKey: key });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /**
   * The per-account max duration (`account_settings.webrtc_max_duration_seconds`),
   * or {@link DEFAULT_WEBRTC_MAX_DURATION_SECONDS} on NULL or on a throw.
   */
  private async resolveMaxDuration(tenantId: string, accountId: string): Promise<number> {
    try {
      return (await accountSettingsRepository.getWebrtcMaxDurationSeconds(tenantId, accountId))
        ?? DEFAULT_WEBRTC_MAX_DURATION_SECONDS;
    } catch {
      return DEFAULT_WEBRTC_MAX_DURATION_SECONDS;
    }
  }

  private send(ws: WebSocket, payload: unknown): void {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    } catch (err) {
      log.warn({ err }, 'Error sending WebRTC frame');
    }
  }

  /**
   * Send one binary message. The Buffer goes to `ws` as is — server frames are not
   * masked, so `ws` writes the header and this payload without copying it.
   */
  private sendBinary(ws: WebSocket, frame: Buffer): void {
    try {
      if (ws.readyState === 1) ws.send(frame, { binary: true });
    } catch (err) {
      log.warn({ err }, 'Error sending WebRTC binary frame');
    }
  }

  /** Tally a relayed media frame and track the worst-case in-process dwell. */
  private recordRelayFrame(session: WebRtcBridgeSession, dir: 'b2p' | 'p2b', startedAt: bigint): void {
    if (dir === 'b2p') session.browserToPstnFrames++;
    else session.pstnToBrowserFrames++;
    const dwellMicros = Number(process.hrtime.bigint() - startedAt) / 1000;
    if (dwellMicros > session.maxRelayDwellMicros) session.maxRelayDwellMicros = dwellMicros;
  }

  /**
   * Disable Nagle's algorithm on the WebSocket's underlying TCP socket so small
   * L16 audio frames are flushed immediately instead of being coalesced (Nagle
   * can add up to ~40ms before a packet leaves). `ws` exposes the raw socket as
   * `_socket`; guard defensively since it isn't part of the public type.
   */
  private disableNagle(ws: WebSocket, callId: string): void {
    try {
      const socket = (ws as unknown as { _socket?: { setNoDelay?: (b: boolean) => void } })._socket;
      socket?.setNoDelay?.(true);
    } catch (err) {
      log.warn({ err, callId }, 'Failed to set TCP_NODELAY on WebRTC leg');
    }
  }

  /**
   * Run a teardown step without awaiting it (timers and socket handlers have no
   * caller to hand a rejection to), logging rather than dropping a failure.
   */
  private inBackground(work: Promise<unknown>, callId: string, failure: string): void {
    work.catch((err) => log.error({ err, callId }, failure));
  }

  /** Record the carrier's own call id on the row. Best effort: logged, never thrown. */
  private persistCarrierCallId(callId: string, carrierCallId: string): Promise<void> {
    return webrtcCallRepository.update(callId, { provider_call_id: carrierCallId }).then(
      () => undefined,
      (err) => log.error({ err, callId }, 'Error persisting carrier call id'),
    );
  }

  /**
   * A control frame for the browser leg (`status`, `ended`): never dropped for back-pressure,
   * but a station whose backlog is past its hard cap is closed instead (see
   * {@link mayRelayToBrowser}).
   */
  private notifyBrowser(session: WebRtcBridgeSession, payload: unknown): void {
    const ws = session.browserWs;
    if (!ws) return;
    if (sendVerdict(ws, { media: false }, this.browserLegLimits(session)) === 'over_cap') {
      this.closeBrowserForBacklog(session, ws);
      return;
    }
    this.send(ws, payload);
  }

  // ─── Send back-pressure (`utils/ws-backpressure.ts`) ─────────────────────

  /** The browser leg's limits: its own format's soft limit, the station's hard cap. */
  private browserLegLimits(session: WebRtcBridgeSession) {
    return session.browserMediaFormat === 'alaw8' ? STATION_ALAW8_LIMITS : STATION_PCM16_LIMITS;
  }

  /**
   * May one more carrier → browser media frame be written? No when the station console
   * has stopped reading: past the soft limit (about 3 s of this leg's audio) the frame is
   * dropped and counted, because audio heard that late is worthless; past the hard cap
   * the station is closed 4408 `station_send_backlog`, and the call gets the usual
   * station-close grace while the console reconnects.
   */
  private mayRelayToBrowser(session: WebRtcBridgeSession, ws: WebSocket): boolean {
    switch (sendVerdict(ws, { media: true }, this.browserLegLimits(session))) {
      case 'send': return true;
      case 'drop':
        session.droppedBrowserMediaFrames++;
        trackWebsocketSendBackpressure('station', 'media_dropped');
        return false;
      case 'over_cap':
        this.closeBrowserForBacklog(session, ws);
        return false;
      case 'not_open': return false;
    }
  }

  /**
   * May one more browser → carrier media frame be written? Past the carrier's soft limit
   * the frame is dropped and counted. There is no hard cap: closing the carrier's media
   * stream would hang the call up.
   */
  private mayRelayToPstn(session: WebRtcBridgeSession): boolean {
    const ws = session.pstnWs;
    if (!ws) return false;
    const verdict = sendVerdict(ws, { media: true }, CARRIER_MEDIA_LIMITS);
    if (verdict === 'drop') {
      session.droppedPstnMediaFrames++;
      trackWebsocketSendBackpressure('carrier', 'media_dropped');
    }
    return verdict === 'send';
  }

  private closeBrowserForBacklog(session: WebRtcBridgeSession, ws: WebSocket): void {
    if (!closeForSendBacklog(ws)) return;
    trackWebsocketSendBackpressure('station', 'closed');
    log.warn({ callId: session.callId, bufferedAmount: ws.bufferedAmount, mediaFormat: session.browserMediaFormat },
      'Station console stopped reading mid-call: send backlog past its cap, closing 4408');
  }
}
