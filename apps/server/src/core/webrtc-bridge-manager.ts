// The WebRTC bridge: VoiceLink PSTN leg ⇄ the agent's browser (station) socket, no AI
// pipeline. The constructor takes `TelephonyGuardHost` for capacity; analysis is reached
// only through the analysis seam (`getBridgeAnalysisHooks()`, docs/seams.md). Max
// duration comes from `account_settings.webrtc_max_duration_seconds`, and the default
// provider is `voicelink`. The members the dialer runtime calls (onLifecycle,
// createBridgedCall, createUnboundBridgedCall, bindBorrowedBrowserLeg,
// reattachBorrowedBrowserLeg, forceEndWithOutcome, playClipToCarrierThenHangUp,
// getActiveCallIds, gracefulShutdown) and the exported types are a fixed seam, pinned by
// `test/unit/core/webrtc-bridge-seam-contract.test.ts`.
import crypto from 'node:crypto';
import { acquireTelephonyConcurrency } from './telephony-concurrency.js';
import { releaseTelephonyLease } from './telephony-release.js';
import type Redis from 'ioredis';
import type WebSocket from 'ws';
import { config } from '../config/index.js';
import { createChildLogger } from '@magick-agency/observability';
import { TelephonyProviderRegistry } from '../telephony/factory.js';
import { WebhookUrlBuilder } from './webhook-url-builder.js';
import { readTtsPcm } from '../tts/tts-file-cache.js';
import { pcmToAlaw } from '../utils/audio.js';
import { PacedAudioStreamer, type PacedStreamSink } from './paced-audio-streamer.js';
import { WebRtcBridgeSession } from './webrtc-bridge-session.js';
import { webrtcCallRepository } from '@magick-agency/db/repositories/agency-call.repository';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { getBridgeAnalysisHooks } from '../seams/bridge-analysis-hooks.js';
import { auditLogger } from '../audit/audit-logger.js';
import {
  trackWebrtcCallInitiated, trackWebrtcCallRejected, trackWebrtcCallCompleted,
  type WebrtcCallEndedBy,
} from '../analytics/posthog.js';
import { canCancelRinging } from '../telephony/types.js';
import { classifyVoicelinkOutcome, normalizeVoicelinkWebhook } from '../telephony/voicelink/voicelink.webhook.js';
import type { VoicelinkWebhookBody } from '../telephony/voicelink/voicelink.types.js';
import type { TelephonyGuardHost } from './telephony-guard-host.js';
import type { CallEvent } from '../telephony/types.js';
import type { WebRtcCallRecord, WebRtcCallStatus } from '@magick-agency/db/models/agency-call.model';

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

const WS_TOKEN_MIN_TTL_SECONDS = 120;
/**
 * Q6 (Manas, 2026-10-09): how long a call's WEBHOOK token stays verifiable after the call
 * ends. VoiceLink keeps posting to `/webrtc-status/:callId` after our teardown — the
 * carrier's own terminal report lands at dial+45–75s and carries the recording URL that
 * `persistLateVoicelinkTerminal` saves for playback and analysis (which waits up to
 * `DIALER_ANALYSIS_RECORDING_WAIT_MINUTES`, default 30). A missing key is refused, so the
 * token is kept for this window instead of being deleted at teardown (a 122-bit secret
 * held in Redis two more hours, not an open door). Two hours is four times the default recording
 * wait.
 *
 * DEPLOYMENT INVARIANT (Q6): Redis must keep these keys for their TTL — persistence on
 * (AOF/RDB) and an eviction policy that cannot drop them (`noeviction`, or a `volatile-*`
 * policy only if nothing else with a TTL competes for memory). A key lost early is now a
 * REFUSAL: an evicted provider/webhook token cuts a live call's carrier leg and status
 * events, and a Redis restarted without persistence refuses every in-flight call's posts.
 */
const WEBHOOK_TOKEN_POST_END_GRACE_SECONDS = 2 * 60 * 60;
/** How long to wait for a VoiceLink `start` frame before tearing down a silent WS. */
const PROVIDER_START_TIMEOUT_SECONDS = 30;
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
/** Max accepted decoded media frame bytes (~1s of PCM16 16k) — abusive frames are dropped. */
const MAX_MEDIA_FRAME_BYTES = 64000;
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
 * Orchestrates WebRTC human-bridge calls: browser leg ⇄ this service ⇄ VoiceLink
 * PSTN leg, no AI pipeline.
 *
 * Concurrency goes through `TelephonyGuardHost`'s guards, so a tenant's
 * `account_settings.max_concurrent_calls` is enforced on one atomic Redis
 * counter. Media bridging and the call lifecycle live here.
 */
export class WebRtcBridgeManager {
  private readonly sessions = new Map<string, WebRtcBridgeSession>();
  /**
   * Q6 (Manas, 2026-10-09): tokens this process MINTED but could not store (Redis errored
   * on the SET), keyed `${purpose}:${callId}` → expiry (epoch ms). `verifyWsToken` refuses a
   * missing key only when it knows the key should exist; for these it cannot, so it
   * accepts (never hard-fail a live call over an outage). Process-local, which is
   * enough: one replica and a bridged call does not survive a restart.
   */
  private readonly unstoredWsTokens = new Map<string, number>();
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
  ) {
    this.telephonyRegistry = new TelephonyProviderRegistry(config);
    this.keyPrefix = config.redis.keyPrefix;
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
          status: session?.answeredAt ? 'completed' : 'canceled',
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
   * the per-call credentials, and place the outbound leg.
   *
   * Returns the browser WS token only when the browser leg is ours to mint — a
   * borrowed socket needs none, and deliberately gets none. Both entry points
   * borrow, so in practice it is always null.
   */
  private async placeOutboundLeg(params: WebRtcOutboundParams & {
    campaignId?: string | null;
    agencyAttemptId?: string | null;
    /** Supplied ⇒ borrowed AND bound now: attached here, detached (never closed) at teardown. */
    browserSocket?: WebSocket;
    /**
     * True ⇒ the browser leg belongs to the CALLER, whether or not a socket has
     * been supplied yet.
     *
     * Separate from `browserSocket` because late binding has no socket at dial
     * time and must still mint no token — keying the token decision on the
     * socket's presence would hand a browser token to an unbound call for the
     * whole ring window.
     */
    borrowedBrowserLeg?: boolean;
    /** Terminal outcome recorded when the browser leg closes mid-call. */
    browserHangupOutcome: string;
    /** Borrowed sockets only: re-attach window on close. 0/absent ⇒ hang up now. */
    browserCloseGraceMs?: number;
  }): Promise<{ record: WebRtcCallRecord; session: WebRtcBridgeSession; browserToken: string | null }> {
    // VoiceLink is the only carrier.
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
    const slotTtlSeconds = maxDuration + 60;

    const admission = await acquireTelephonyConcurrency(this.guardHost,
      concurrencyKey, params.tenantId, params.accountId, provider, slotTtlSeconds,
    );
    if (admission.result === 'global_full') {
      trackWebrtcCallRejected({ tenantId: params.tenantId, accountId: params.accountId, reason: 'global_concurrency_limit', provider });
      throw new WebRtcCallError('Global concurrency limit reached', 'global_concurrency_limit', 429);
    }
    if (admission.result === 'account_full') {
      trackWebrtcCallRejected({ tenantId: params.tenantId, accountId: params.accountId, reason: 'account_concurrency_limit', provider });
      throw new WebRtcCallError('Account concurrency limit reached', 'account_concurrency_limit', 429);
    }
    if (admission.result !== 'acquired') {
      const unavailable = admission.result === 'redis_unavailable' || admission.result === 'allocation_unavailable';
      const unallocated = admission.result === 'provider_unallocated';
      trackWebrtcCallRejected({
        tenantId: params.tenantId,
        accountId: params.accountId,
        reason: unavailable ? 'provider_concurrency_unavailable' : 'provider_concurrency_limit',
        provider,
      });
      throw new WebRtcCallError(
        unavailable
          ? 'Provider concurrency admission is temporarily unavailable'
          : unallocated
            ? `No concurrency is allocated to telephony provider '${provider}'`
            : `Concurrency limit reached for telephony provider '${provider}'`,
        unavailable ? 'provider_concurrency_unavailable' : 'provider_concurrency_limit',
        unavailable ? 503 : unallocated ? 422 : 429,
      );
    }

    // 2. Persist the call (status initiating). Every call dials on the service's own
    // VoiceLink account. The INSERT stays inside the same try so a failure still
    // releases the slots it just took.
    let record: WebRtcCallRecord;
    try {
      record = await webrtcCallRepository.create({
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
        // runtime exists.
        campaign_id: params.campaignId ?? null,
        agency_attempt_id: params.agencyAttemptId ?? null,
      });
    } catch (err) {
      await this.releaseSlotsByKey(concurrencyKey, params.tenantId, params.accountId, provider);
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
    session.correlationId = params.agencyAttemptId ?? null;
    // Read back off the persisted row, not off `params`, so the value handed on at
    // finalize is the one that was durably recorded.
    session.campaignId = record.campaign_id ?? null;
    session.agencyAttemptId = record.agency_attempt_id ?? null;
    // VoiceLink negotiates the media stream via a `start` frame — hold relay until
    // a valid `start` (correct codec/rate) arrives.
    if (provider === 'voicelink') session.providerMediaReady = false;
    this.sessions.set(record.id, session);

    // 4. Max-duration guard (resolved above, reused for the slot TTL).
    session.maxDurationSeconds = maxDuration;
    session.setMaxDurationTimer(maxDuration, () => {
      // Answer-anchored, matching every other teardown path here (browser-close,
      // shutdown): a call that hit the ceiling mid-conversation is `completed`,
      // but one that was never answered never connected, so it settles `canceled`.
      // Hardcoding `completed` would record an unanswered call as a success.
      this.localHangup(record.id, {
        status: session.answeredAt ? 'completed' : 'canceled',
        outcome: 'max_duration_reached',
      }).catch((e) => log.error({ err: e, callId: record.id }, 'Error ending call on max duration'));
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

    // 5. Issue the browser WS token (best-effort). A borrowed leg has no browser
    // connect to gate, so no token is minted. Read from the flag AND the socket,
    // so a caller that supplies a socket without the flag still cannot mint one.
    const borrowedBrowserLeg = params.borrowedBrowserLeg === true || params.browserSocket !== undefined;
    const token = borrowedBrowserLeg ? null : crypto.randomUUID();
    if (token) await this.storeWsToken(record.id, token, maxDuration + 60);
    // VoiceLink connects the provider WS + posts webhooks itself, so those two
    // legs get their own purpose-bound tokens (embedded only in the URLs we send
    // VoiceLink).
    const tokenTtl = maxDuration + 60;
    let providerToken: string | undefined;
    let webhookToken: string | undefined;
    if (provider === 'voicelink') {
      providerToken = crypto.randomUUID();
      webhookToken = crypto.randomUUID();
      await Promise.all([
        this.storeWsToken(record.id, providerToken, tokenTtl, 'provider'),
        this.storeWsToken(record.id, webhookToken, tokenTtl, 'webhook'),
      ]);
    }

    auditLogger.log({
      callId: record.id,
      tenantId: params.tenantId,
      accountId: params.accountId,
      eventType: 'webrtc_call.initiating',
      eventCategory: 'call',
      severity: 'info',
      eventData: { provider, destination: params.destinationPhone, caller_id: params.callerId },
    });

    // 6. Place the outbound telephony leg.
    try {
      // `base` is the provider's own webhook namespace (…/webhooks/voicelink), so
      // `${base}/webrtc-status/${id}` resolves to the per-provider route.
      const base = this.webhookUrls.baseUrl(provider);
      // The service's own carrier account only: the synchronous registry lookup.
      const adapter = this.telephonyRegistry.get(provider);
      // VoiceLink has no answer XML — it dials OUT to a stream URL baked into the
      // dial request, so hand it the bridge's dedicated PSTN leg explicitly.
      const mediaStreamUrl =
        provider === 'voicelink'
          ? `wss://${new URL(base).host}/api/v1/webrtc-call/${record.id}/pstn-stream?token=${providerToken}`
          : undefined;
      // For VoiceLink, embed the webhook token so forged lifecycle events (which
      // drive status/concurrency) are rejected. Another provider would get an
      // untokenized URL.
      const statusCallbackUrl =
        provider === 'voicelink'
          ? `${base}/webrtc-status/${record.id}?token=${webhookToken}`
          : `${base}/webrtc-status/${record.id}`;
      const result = await adapter.initiateCall({
        callId: record.id,
        to: params.destinationPhone,
        from: params.callerId,
        webhookUrl: `${base}/webrtc-answer/${record.id}`,
        statusCallbackUrl,
        mediaStreamUrl,
        maxDuration,
        // The VoiceLink adapter does not send this flag; the carrier's recording URL
        // arrives on its terminal webhook.
        enableRecording: recordEnabled,
        machineDetection: false,
      });
      session.providerCallId = result.providerCallId || null;
      // The teardown-during-dial race, closed here because this is the first
      // instant it can be closed. `endCall`'s hangup is gated on
      // `providerCallId`, which does not exist until the line above — so a
      // teardown that ran while the dial was in flight (a borrowed socket is
      // attached BEFORE the dial, so an agent who dismisses a ringing call is
      // squarely inside this window) claimed the terminal state, found no carrier
      // handle, and left the leg dialling with nothing left to hang it up. The
      // session is already destroyed and out of the map at that point; we still
      // hold the reference, which is all the hangup needs.
      if (session.endHandled) {
        log.warn(
          { callId: record.id, providerCallId: session.providerCallId },
          'WebRTC call was torn down mid-dial — hanging up the carrier leg now that it has an id',
        );
        await this.hangupProviderLeg(session);
      }
      await webrtcCallRepository.update(record.id, { provider_call_id: session.providerCallId });
    } catch (err) {
      // (rejection of telephony init is reported as a completed `failed` call via
      // endCall below — not a pre-flight rejection.)
      log.error({ err, callId: record.id }, 'WebRTC outbound initiation failed');
      await this.endCall(record.id, {
        status: 'failed',
        outcome: 'telephony_init_failed',
        errorCode: 'TELEPHONY_INIT_FAILED',
        errorMessage: err instanceof Error ? err.message : String(err),
        hangupProvider: false,
      });
      throw new WebRtcCallError(
        err instanceof Error ? err.message : 'Telephony initiation failed',
        'telephony_init_failed',
        502,
      );
    }

    trackWebrtcCallInitiated(record);
    return { record, session, browserToken: token };
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
    log.info({ callId, status: session.status }, 'Borrowed browser leg attached');
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
    if (!session || session.endHandled || session.ending) return false;
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
    if (!session || session.endHandled || session.ending) return false;
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
    await this.localHangup(session.callId, {
      status: session.answeredAt ? 'completed' : 'canceled',
      outcome,
    });
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
    if (!session || session.endHandled || session.ending) return false;
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
      status: opts.status ?? (session.answeredAt ? 'completed' : 'canceled'),
      outcome: opts.outcome,
    });
    return true;
  }

  /**
   * Convert a cached 8 kHz clip to this session's carrier wire format.
   *
   * Only VoiceLink has a carrier format here.
   */
  private convertClipForCarrier(
    session: WebRtcBridgeSession,
    clipHash: string,
  ): { buffer: Buffer; byteRate: number } | null {
    const clip = readTtsPcm(clipHash);
    if (!clip) return null;

    if (session.provider === 'voicelink') {
      // A-law: always 8 kHz, 1 byte per sample. `pcmToAlaw` resamples for us.
      const alaw = pcmToAlaw(clip.pcm16, clip.sampleRate);
      return alaw.length > 0 ? { buffer: alaw, byteRate: 8000 } : null;
    }

    // A session on any other provider has no carrier format here, so there is
    // nothing to play.
    return null;
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
      isOpen: () => session.pstnWs?.readyState === 1 && !session.endHandled && !session.ending,
      bufferedAmount: () => (session.pstnWs as unknown as { bufferedAmount?: number } | null)?.bufferedAmount ?? 0,
      send: (payloadBase64: string) => {
        if (!session.pstnWs) return;
        if (session.provider === 'voicelink') {
          this.send(session.pstnWs, { event: 'media', media: { payload: payloadBase64 } });
          return;
        }
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

    const onMessage = (data: Buffer | string): void => {
      this.onBrowserMessage(session, typeof data === 'string' ? data : data.toString());
    };
    const hangUpForBrowserClose = (): void => {
      this.localHangup(callId, {
        status: session.answeredAt ? 'completed' : 'canceled',
        outcome: hangupOutcome,
      }).catch((e) => log.error({ err: e, callId }, 'Error ending call on browser close'));
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
      if (graceMs > 0 && !session.browserWsOwned && !session.endHandled && !session.ending) {
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
   * Verify the provider-WSS token (VoiceLink) then attach the PSTN leg.
   *
   * Q6 (Manas, 2026-10-09): the check runs for every live session (all VoiceLink),
   * and a missing provider key is refused unless its SET failed (`verifyWsToken`).
   * An unknown call id skips the check and is refused by `attachPstnLeg` itself.
   */
  async attachPstnLegVerified(callId: string, ws: WebSocket, token: string | undefined): Promise<boolean> {
    const session = this.sessions.get(callId);
    if (session?.provider === 'voicelink') {
      const ok = await this.verifyWsToken(callId, token, 'provider');
      if (!ok) {
        log.warn({ callId }, 'PSTN leg connect with invalid provider token — rejecting');
        try { ws.close(); } catch { /* ignore */ }
        return false;
      }
    }
    return this.attachPstnLeg(callId, ws);
  }

  /** Attach the provider media WebSocket (the VoiceLink lead WS). */
  attachPstnLeg(callId: string, ws: WebSocket): boolean {
    const session = this.sessions.get(callId);
    if (!session) {
      log.warn({ callId }, 'PSTN leg connect for unknown WebRTC call');
      try { ws.close(); } catch { /* ignore */ }
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
    if (session.endHandled || session.ending) {
      log.warn(
        { callId, endHandled: session.endHandled, ending: session.ending, answered: session.answeredAt != null },
        'PSTN leg connect for a call already tearing down — refusing so the relay cannot reopen',
      );
      try { ws.close(); } catch { /* ignore */ }
      return false;
    }

    const prior = session.pstnWs;
    if (prior && prior !== ws) {
      try { if (prior.readyState === prior.OPEN) prior.close(); } catch { /* ignore */ }
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
      // VoiceLink: the socket opens BEFORE the carrier `start` frame. Do NOT anchor
      // answer here (an open-but-silent WS is not a connected call) — wait for a
      // valid `start` (handled in onPstnMessage). Arm a timeout so a WS that never
      // sends `start` is torn down instead of hanging as answered.
      session.setEndConfirmationTimer(this.startTimeoutSeconds, () => {
        if (!session.providerMediaReady && !session.endHandled) {
          log.warn({ callId }, 'VoiceLink WS never sent a valid start — ending');
          this.endCall(callId, { status: 'failed', outcome: 'provider_start_timeout', hangupProvider: false })
            .catch((e) => log.error({ err: e, callId }, 'Error ending call on start timeout'));
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
      this.endCall(callId, {
        status: session.answeredAt ? 'completed' : 'no_answer',
        outcome: 'pstn_stream_closed',
        hangupProvider: false,
      }).catch((e) => log.error({ err: e, callId }, 'Error ending call on PSTN close'));
    });
    ws.on('error', (err) => log.warn({ err, callId }, 'PSTN leg WebSocket error'));
    if (ws.readyState !== 1 /* OPEN */) {
      this.endCall(callId, {
        status: session.answeredAt ? 'completed' : 'no_answer',
        outcome: 'pstn_stream_closed',
        hangupProvider: false,
      }).catch((e) => log.error({ err: e, callId }, 'Error ending call (PSTN closed during attach)'));
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
      // Drop until both legs are live AND the provider stream is negotiated — no
      // one to hear it yet (avoids buffering / sending before VoiceLink `start`).
      if (session.pstnWs?.readyState !== 1 || !session.providerMediaReady) return;
      // Bound the frame: reject an oversized base64 payload before decoding so a
      // compromised browser token can't drive unbounded allocation on the loop.
      if (data.media.payload.length > MAX_MEDIA_FRAME_BYTES * 2) {
        log.warn({ callId: session.callId, len: data.media.payload.length }, 'Dropped oversized browser media frame');
        return;
      }
      // Guard the decode/transcode: Buffer.from(payload,'base64') throws on a
      // non-string payload, and this runs in a ws 'message' listener — an uncaught
      // throw here would crash the replica (there is no global uncaughtException
      // handler). Drop the bad frame instead.
      try {
        if (session.provider === 'voicelink' && session.transcoder) {
          // Browser PCM16 16kHz → VoiceLink G.711 A-law 8kHz (stateful transcode).
          // VoiceLink uses the plain {event:'media',media:{payload}} frame (no
          // contentType/sampleRate/stream_sid).
          const pcm = Buffer.from(data.media.payload, 'base64');
          const alaw = session.transcoder.pcm16kToAlaw(pcm);
          this.send(session.pstnWs, { event: 'media', media: { payload: alaw.toString('base64') } });
          this.recordRelayFrame(session, 'b2p', t0);
        }
      } catch (err) {
        log.warn({ err, callId: session.callId }, 'Dropped malformed browser media frame');
      }
    }
    // 'start'/'connected'/'stop' from the browser are informational here.
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
      // VoiceLink negotiates the media stream via `start`: validate the format,
      // capture the real carrier ids + stream id, then open the relay.
      //
      // Only VoiceLink negotiates here. A `start` on another provider's socket is
      // a no-op: it would fail handleProviderStart's A-law-8kHz format check and
      // tear down a working call.
      if (session.provider === 'voicelink') this.handleProviderStart(session, data);
      return;
    }
    if (data?.event === 'media' && typeof data.media?.payload === 'string') {
      if (session.browserWs?.readyState !== 1 || !session.providerMediaReady) return;
      if (data.media.payload.length > MAX_MEDIA_FRAME_BYTES * 2) {
        log.warn({ callId: session.callId, len: data.media.payload.length }, 'Dropped oversized PSTN media frame');
        return;
      }
      // Guard the decode/transcode (see onBrowserMessage): a malformed payload from
      // the PSTN leg must never throw out of this ws listener and crash the replica.
      try {
        if (session.provider === 'voicelink' && session.transcoder) {
          // VoiceLink G.711 A-law 8kHz → browser PCM16 16kHz (stateful transcode).
          const alaw = Buffer.from(data.media.payload, 'base64');
          const pcm = session.transcoder.alawToPcm16k(alaw);
          this.send(session.browserWs, { event: 'media', media: { payload: pcm.toString('base64') } });
          this.recordRelayFrame(session, 'p2b', t0);
        }
      } catch (err) {
        log.warn({ err, callId: session.callId }, 'Dropped malformed PSTN media frame');
      }
    } else if (data?.event === 'stop') {
      this.endCall(session.callId, {
        status: session.answeredAt ? 'completed' : 'no_answer',
        outcome: 'pstn_stream_stopped',
        hangupProvider: false,
      }).catch((e) => log.error({ err: e, callId: session.callId }, 'Error ending call on PSTN stop'));
    }
    // 'playedStream'/'clearedAudio' are acks — ignored.
  }

  /**
   * Handle a VoiceLink WS `start` frame: validate `media_format` (must be A-law
   * 8kHz — the only format the transcoder supports), capture the real carrier
   * `call_sid`/`stream_sid`, mark the stream media-ready (which opens the relay
   * and anchors answer), and cancel the start-timeout. An unsupported/malformed
   * start ends the call rather than decoding garbage.
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
    if (session.endHandled || session.ending) {
      log.warn(
        { callId: session.callId, endHandled: session.endHandled, ending: session.ending },
        'Provider media start for a call already tearing down — ignoring',
      );
      return;
    }
    const start = data?.start ?? {};
    const fmt = start.media_format ?? {};
    const encoding = String(fmt.encoding ?? '').toLowerCase();
    const rate = String(fmt.sample_rate ?? '');
    if (encoding !== 'audio/alaw' || rate !== '8000') {
      log.error(
        { callId: session.callId, encoding, rate },
        'VoiceLink start with unsupported media format — ending call',
      );
      this.endCall(session.callId, {
        status: 'failed',
        outcome: 'unsupported_media_format',
        errorCode: 'UNSUPPORTED_MEDIA_FORMAT',
        hangupProvider: false,
      }).catch((e) => log.error({ err: e, callId: session.callId }, 'Error ending call on bad start'));
      return;
    }

    // Capture the carrier's real ids (distinct from our dial-time correlation id).
    const carrierCallId = start.call_sid || data.call_sid || null;
    const streamId = start.stream_sid || data.stream_sid || null;
    if (carrierCallId && !session.carrierCallId) {
      session.carrierCallId = carrierCallId;
      webrtcCallRepository
        .update(session.callId, { provider_call_id: carrierCallId })
        .catch((e) => log.error({ err: e, callId: session.callId }, 'Error persisting carrier call id'));
    }
    if (streamId) session.providerStreamId = streamId;

    session.clearEndConfirmationTimer(); // cancel the start-timeout
    session.providerMediaReady = true;
    // The negotiated stream is the connect/answer moment for VoiceLink.
    this.anchorAnswer(session);
    log.info(
      { callId: session.callId, carrierCallId, streamId },
      'VoiceLink stream started (A-law 8kHz) — relay open',
    );
    this.emitBridgedIfLive(session);
  }


  // ─── VoiceLink webhooks ──────────────────────────────────────────────────

  /**
   * VoiceLink status webhook. VoiceLink has no answer XML — the PSTN leg is
   * established when VoiceLink dials into the pstn-stream WS (URL baked into the
   * dial request), so `answer` arrives here as a status event and anchors
   * talk-time (no XML returned). Terminal events use a VoiceLink-specific
   * classifier (no_answer/busy/canceled/failed) rather than a generic
   * telephony_error, and are handled even when the live session is already gone
   * (late `call.completed` / carrier confirmation of a local hangup).
   */
  async handleVoicelinkStatus(callId: string, event: CallEvent): Promise<void> {
    // Re-normalize the raw body (the parser spread it into metadata) so we can run
    // the VoiceLink-specific classifier + capture the real carrier id / recording.
    const norm = normalizeVoicelinkWebhook((event.metadata ?? {}) as VoicelinkWebhookBody);
    const session = this.sessions.get(callId);

    // ── No live session: a late/terminal event (e.g. call.completed after we
    // already tore down, or carrier confirming our hangup). Persist final data
    // (recording URL, real carrier id, terminal outcome) idempotently and return.
    if (!session) {
      await this.persistLateVoicelinkTerminal(callId, event, norm);
      return;
    }

    // Learn the carrier's real id even if a dial-time placeholder is present.
    if (norm.providerCallId && norm.providerCallId !== session.carrierCallId) {
      session.carrierCallId = norm.providerCallId;
      await webrtcCallRepository.update(callId, { provider_call_id: norm.providerCallId })
        .catch((e) => log.error({ err: e, callId }, 'Error persisting carrier call id'));
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
    // the answer path for this carrier. Left unguarded it would do three things to
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
      && (session.endHandled || session.ending)) {
      log.warn(
        { callId, eventType: event.eventType, endHandled: session.endHandled, ending: session.ending },
        'VoiceLink progress event for a call already tearing down — ignoring so it cannot resurrect the row or emit a phantom answer',
      );
      return;
    }

    switch (event.eventType) {
      case 'answer':
        this.anchorAnswer(session);
        if (session.status !== 'in_progress') {
          session.status = 'in_progress';
          await webrtcCallRepository.update(callId, { status: 'in_progress', answered_at: session.answeredAt });
          this.notifyBrowser(session, { event: 'status', status: 'answered' });
        }
        return;
      case 'ringing':
        if (session.status === 'initiating') {
          session.status = 'ringing';
          await webrtcCallRepository.update(callId, { status: 'ringing' });
          this.notifyBrowser(session, { event: 'status', status: 'ringing' });
        }
        return;
      case 'hangup':
      case 'error': {
        // Terminal. If we're already awaiting carrier confirmation of a local
        // hangup, THIS is that confirmation — finalize with the pending intent.
        if (session.ending) {
          await this.finalizeEnding(callId, norm);
          return;
        }
        // Otherwise classify the remote outcome precisely (no_answer/busy/…).
        // The real `call.ended` payload carries NO `callStatus` (only `status`,
        // `hangupCause`, `answeredAt`), so `norm.wasAnswered` is false even for a
        // call we already anchored as answered on `call.answered`. Fold in the
        // session's own answer state so a normal remote hangup of an answered call
        // classifies as `completed`, not `failed`. `session.answeredAt` is the
        // authoritative first-write-wins anchor.
        const answered = norm.wasAnswered || session.answeredAt != null;
        const { status, outcome, rawCause } = classifyVoicelinkOutcome({
          ...norm,
          wasAnswered: answered,
        });
        if (norm.recordingUrl) session.recordingUrl = norm.recordingUrl;
        await this.endCall(callId, {
          status,
          outcome,
          ...(status === 'failed' && !answered
            ? { errorCode: 'TELEPHONY_ERROR', errorMessage: rawCause || undefined }
            : {}),
          recordingUrl: norm.recordingUrl,
          hangupProvider: false,
        });
        return;
      }
      default:
        return;
    }
  }

  /**
   * Persist final data from a terminal VoiceLink event that arrived with no live
   * session (late `call.completed`, or a carrier confirmation after teardown).
   * Idempotent: only fills recording/provider-id and, if the row wasn't already
   * terminal, records the classified outcome. Never runs teardown a second time
   * (it already ran).
   */
  private async persistLateVoicelinkTerminal(
    callId: string,
    event: CallEvent,
    norm: ReturnType<typeof normalizeVoicelinkWebhook>,
  ): Promise<void> {
    if (event.eventType !== 'hangup' && event.eventType !== 'error') return;
    try {
      const existing = await webrtcCallRepository.findById(callId);
      if (!existing) return;
      const patch: Record<string, unknown> = {};
      if (norm.recordingUrl && !existing.recording_url) patch.recording_url = norm.recordingUrl;
      if (norm.providerCallId && norm.providerCallId !== existing.provider_call_id) {
        patch.provider_call_id = norm.providerCallId;
      }
      if (Object.keys(patch).length > 0) {
        await webrtcCallRepository.update(callId, patch);
        log.info({ callId, patch: Object.keys(patch) }, 'Persisted late VoiceLink completion data');
      }
      // A late recording_url may satisfy a dialer-analysis job still awaiting one.
      if (patch.recording_url) await getBridgeAnalysisHooks().onRecordingReady(callId);
    } catch (err) {
      log.error({ err, callId }, 'Failed to persist late VoiceLink terminal data');
    }
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
   * {@link persistLateVoicelinkTerminal} where they belong. The point is the
   * *removal from the map*, not the status we write.
   */
  private async localHangup(
    callId: string,
    intent: { status: WebRtcCallStatus; outcome?: string; errorCode?: string; errorMessage?: string },
  ): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session || session.endHandled) return;

    // A provider with a real hangup API → finalize now.
    if (session.provider !== 'voicelink') {
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
      this.finalizeEnding(callId, null).catch((e) =>
        log.error({ err: e, callId }, 'Error finalizing VoiceLink call on timeout'));
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
    norm: ReturnType<typeof normalizeVoicelinkWebhook> | null,
  ): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session || session.endHandled) return;
    session.clearEndConfirmationTimer();
    const intent = session.pendingEnd ?? { status: 'completed', outcome: 'ended_by_user' };
    if (norm?.recordingUrl) session.recordingUrl = norm.recordingUrl;
    await this.endCall(callId, {
      ...intent,
      recordingUrl: norm?.recordingUrl ?? session.recordingUrl ?? undefined,
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
   * PLACED on — the service's own VoiceLink account, the only one there is.
   *
   * The adapter is resolved even when there is no `providerCallId` to hang up,
   * because that combination — a teardown with no carrier handle — is exactly the
   * case the capability warning below exists to report.
   */
  private async hangupProviderLeg(session: WebRtcBridgeSession): Promise<void> {
    const callId = session.callId;
    try {
      const hangupAdapter = this.telephonyRegistry.get(session.provider);

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

      if (!session.providerCallId) return;
      await hangupAdapter.endCall(session.providerCallId);
    } catch (err) {
      log.warn({ err, callId }, 'Error hanging up provider leg (already ended?)');
    }
  }

  /**
   * Idempotent teardown: persist the terminal row, close both legs, and release
   * the shared slots.
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
    },
  ): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) return;
    if (session.endHandled) return;
    session.endHandled = true;
    session.clearMaxDurationTimer();

    const talkTime = session.getTalkTimeSeconds();
    const duration = session.getDurationSeconds();

    // Hang up the carrier leg if it's still up (best effort, never throws).
    if (opts.hangupProvider) await this.hangupProviderLeg(session);

    const recordingUrl = opts.recordingUrl ?? session.recordingUrl ?? undefined;
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
    this.emitLifecycle({
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
    await this.clearWsToken(callId);

    log.info({
      callId, status: opts.status, talkTime, duration,
      browserToPstnFrames: session.browserToPstnFrames,
      pstnToBrowserFrames: session.pstnToBrowserFrames,
      maxRelayDwellMicros: Math.round(session.maxRelayDwellMicros),
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

  private notifyBrowser(session: WebRtcBridgeSession, payload: unknown): void {
    if (session.browserWs) this.send(session.browserWs, payload);
  }

  // ── Purpose-bound per-call credentials ─────────────────────────────────────
  // Random nonces in Redis (replica-safe). Separate high-entropy tokens per purpose
  // keep the browser, provider-WSS and webhook trust domains distinct: the provider +
  // webhook tokens live only in the URLs we send VoiceLink, so a leaked browser token
  // can't forge a provider socket or a webhook. (A borrowed leg mints no browser
  // token; see `verifyWsToken`.)
  private wsTokenKey(callId: string, purpose: 'browser' | 'provider' | 'webhook' = 'browser'): string {
    return `${this.keyPrefix}webrtc:ws-token:${purpose}:${callId}`;
  }

  private async storeWsToken(
    callId: string,
    token: string,
    ttlSeconds: number,
    purpose: 'browser' | 'provider' | 'webhook' = 'browser',
  ): Promise<void> {
    if (!this.redis) return;
    const ttl = Math.max(WS_TOKEN_MIN_TTL_SECONDS, ttlSeconds);
    try {
      // TTL spans the whole call (cleared on end) so the token never expires
      // mid-call — keeping verifyWsToken a real comparison rather than the
      // degraded accept-on-missing-key fallback while the call is live.
      await this.redis.set(this.wsTokenKey(callId, purpose), token, 'EX', ttl);
    } catch (err) {
      log.warn({ err, callId, purpose }, 'Failed to store WebRTC WS token');
      // Q6: remember that this key will be missing for a reason that is not forgery, so the
      // live call keeps working (`verifyWsToken`). Held as long as the key would have lived
      // plus the post-end webhook grace.
      this.noteUnstoredWsToken(callId, purpose, (ttl + WEBHOOK_TOKEN_POST_END_GRACE_SECONDS) * 1000);
    }
  }

  private unstoredWsTokenKey(callId: string, purpose: 'browser' | 'provider' | 'webhook'): string {
    return `${purpose}:${callId}`;
  }

  private noteUnstoredWsToken(callId: string, purpose: 'browser' | 'provider' | 'webhook', forMs: number): void {
    const now = Date.now();
    // Bounded: prune expired entries before growing (a sustained Redis outage adds two
    // entries per call, each dropped once its window passes).
    if (this.unstoredWsTokens.size >= 1000) {
      for (const [key, expiresAt] of this.unstoredWsTokens) if (expiresAt <= now) this.unstoredWsTokens.delete(key);
    }
    this.unstoredWsTokens.set(this.unstoredWsTokenKey(callId, purpose), now + forMs);
  }

  private wasUnstored(callId: string, purpose: 'browser' | 'provider' | 'webhook'): boolean {
    const key = this.unstoredWsTokenKey(callId, purpose);
    const expiresAt = this.unstoredWsTokens.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= Date.now()) {
      this.unstoredWsTokens.delete(key);
      return false;
    }
    return true;
  }

  async verifyWsToken(
    callId: string,
    token: string | undefined,
    purpose: 'browser' | 'provider' | 'webhook' = 'browser',
  ): Promise<boolean> {
    // Q6 (Manas, 2026-10-09) — the middle option. A present-but-wrong token is refused, and
    // so is a missing key while Redis ANSWERS, because every token this bridge verifies is
    // minted and stored before the leg it guards can exist:
    //  - `provider` / `webhook`: stored in `placeOutboundLeg` (step 5) BEFORE the dial
    //    (step 6) that hands them to VoiceLink, for the whole call (maxDuration + 60s), and
    //    the webhook token is kept WEBHOOK_TOKEN_POST_END_GRACE_SECONDS past the end
    //    (`clearWsToken`) for the carrier's late terminal posts;
    //  - `browser`: no caller verifies it (borrowed legs never mint or check one), so
    //    refusing changes nothing live.
    // A key can still be missing legitimately when its SET failed (Redis errored at dial
    // time and recovered since): that is remembered in `unstoredWsTokens` and still
    // accepted. Redis absent or erroring here still accepts — never hard-fail a live call
    // on an outage; the unguessable callId is then the guard.
    if (!this.redis) return true; // degraded — unguessable callId is the guard
    try {
      const stored = await this.redis.get(this.wsTokenKey(callId, purpose));
      if (stored === null) {
        if (this.wasUnstored(callId, purpose)) {
          log.warn({ callId, purpose }, 'WebRTC WS token was never stored (Redis failed at mint) — allowing (degraded)');
          return true;
        }
        // Never minted, cleared at teardown, or past its post-end grace: there is no
        // credential this caller can match, so nothing is accepted on the call id alone.
        // Logged: a burst of these for LIVE calls means the keys vanished (eviction, a flushed
        // or non-persistent Redis), not forgery — see WEBHOOK_TOKEN_POST_END_GRACE_SECONDS.
        log.warn({ callId, purpose }, 'WebRTC WS token missing while Redis answered — rejecting');
        return false;
      }
      if (!token) return false;
      const a = Buffer.from(token);
      const b = Buffer.from(stored);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (err) {
      log.warn({ err, callId, purpose }, 'WebRTC WS token verify failed — allowing (degraded)');
      return true;
    }
  }

  private async clearWsToken(callId: string): Promise<void> {
    // Q6: the media legs' tokens die with the call; the WEBHOOK token (and a remembered
    // unstored one) outlives it by the grace window, because the carrier's terminal report
    // and recording URL arrive after teardown and a missing key is refused.
    this.unstoredWsTokens.delete(this.unstoredWsTokenKey(callId, 'browser'));
    this.unstoredWsTokens.delete(this.unstoredWsTokenKey(callId, 'provider'));
    if (this.unstoredWsTokens.has(this.unstoredWsTokenKey(callId, 'webhook'))) {
      this.unstoredWsTokens.set(this.unstoredWsTokenKey(callId, 'webhook'), Date.now() + WEBHOOK_TOKEN_POST_END_GRACE_SECONDS * 1000);
    }
    if (!this.redis) return;
    try {
      await Promise.all([
        this.redis.del(this.wsTokenKey(callId, 'browser')),
        this.redis.del(this.wsTokenKey(callId, 'provider')),
        // Q6: kept for the post-end grace rather than deleted. `EXPIRE` on a missing key is
        // a no-op, so a call that never stored one gains nothing here.
        this.redis.expire(this.wsTokenKey(callId, 'webhook'), WEBHOOK_TOKEN_POST_END_GRACE_SECONDS),
      ]);
    } catch {
      /* TTLs out anyway */
    }
  }
}
