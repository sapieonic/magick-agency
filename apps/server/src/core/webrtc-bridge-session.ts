// PORT NOTE (magick-agency): ported from magic-voice-core/src/core/webrtc-bridge-session.ts@4850d1d9.
// Removed: `sipConnectionId` (BYO SIP trunk egress, plan §5) and `telephonyCredentialId`
// (BYOC carrier credential; the baseline dropped `agency_calls.telephony_credential_id`).
// Imports re-pointed (logger → @magick-agency/observability, the call model →
// @magick-agency/db's agency-call model). Everything else verbatim, including the
// VoBiz/owned-socket vocabulary in comments, so a later core fix ports cleanly.
import type WebSocket from 'ws';
import { createChildLogger } from '@magick-agency/observability';
import type { WebRtcCallStatus } from '@magick-agency/db/models/agency-call.model';
import { VoicelinkTranscoder } from '../utils/audio-fir.js';

/**
 * In-memory state for a single WebRTC human-bridge call. Holds the two media
 * WebSockets (browser leg + VoBiz PSTN leg) and the lifecycle flags/timers, so
 * the bridge can relay audio between them and tear both down idempotently.
 *
 * Deliberately separate from {@link CallSession} (which carries the AI pipeline,
 * pre-warm, AMD and silence-nudge machinery a human↔human bridge does not need).
 * Concurrency accounting is NOT held here — it is shared with AI calls via
 * CallManager's guards (see {@link WebRtcBridgeManager}).
 */
export class WebRtcBridgeSession {
  readonly callId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly callerId: string;
  readonly destinationPhone: string;
  readonly provider: string;
  /** Session creation (≈ dial start), before the PSTN leg rings. */
  readonly startedAt: Date;

  /**
   * Correlation id we handed the provider at dial time (our own call id for
   * VoiceLink, since its real carrier id is async). NOT the carrier's id — see
   * {@link carrierCallId}. Persisted as `provider_call_id` for back-compat.
   */
  providerCallId: string | null = null;
  /**
   * The provider's REAL call id, learned asynchronously from the WS `start` frame
   * (`start.call_sid`) or a lifecycle webhook (`call.id`). Distinct from the
   * dial-time correlation id so CDR/hangup lookups can use the true carrier key.
   * Null until the carrier reveals it.
   */
  carrierCallId: string | null = null;
  /** Provider media stream id (`start.stream_sid`) — needed for `clear`/commands. */
  providerStreamId: string | null = null;
  status: WebRtcCallStatus = 'initiating';

  /**
   * For providers that negotiate the media stream via a `start` frame (VoiceLink):
   * relay is gated until a valid `start` (correct codec/rate) is seen. Providers
   * that stream immediately (VoBiz, whose readiness is the WS open + answer XML)
   * start ready. Set false at construction for VoiceLink in the manager.
   */
  providerMediaReady: boolean = true;

  /**
   * Idempotent teardown lifecycle:
   *  - 'ending' is entered when we initiate a local hangup for a provider whose
   *    carrier leg is torn down by closing our WS (VoiceLink): we close the WS and
   *    WAIT for the carrier's `call.ended`/`call.completed` (or a timeout) before
   *    settling, so we never settle while the PSTN leg may still be billable.
   *  - `endHandled` is the final, once-only terminal claim (persist + settle).
   */
  ending: boolean = false;
  /** The terminal intent captured when `ending` was entered, replayed at finalize. */
  pendingEnd: { status: WebRtcCallStatus; outcome?: string; errorCode?: string; errorMessage?: string } | null = null;
  private endConfirmationTimer: NodeJS.Timeout | null = null;

  /**
   * Answer anchor (billable connect moment) — set at the VoBiz answer webhook,
   * with the PSTN media-WS connect as a backstop if that webhook is dropped.
   * First-write-wins. Talk time is measured from here; 0 if never answered.
   */
  answeredAt: Date | null = null;

  /** Latched by {@link markBridged} the first time the bridge is announced. */
  private bridgeAnnounced: boolean = false;

  browserWs: WebSocket | null = null;
  pstnWs: WebSocket | null = null;

  /**
   * An opaque id the CALLER supplied at dial time, echoed back on every lifecycle
   * event. Deliberately generic — the bridge neither parses nor interprets it.
   *
   * It exists because a call's own id is not known until the DB insert returns,
   * i.e. not until `createBridgedCall` resolves — so a caller that correlates on
   * `callId` cannot have registered its mapping yet if the carrier answers
   * *during* the dial. That is not hypothetical: it is the exact race a fast
   * carrier produces, and it silently drops the `bridged` event. A correlation id
   * the caller already holds before dialing closes it.
   */
  correlationId: string | null = null;

  /**
   * Whether this session OWNS its browser WebSocket.
   *
   * `true` (the default, and the whole of the existing browser dialer): the
   * socket is minted per call, exists only for this call, and is closed at
   * teardown.
   *
   * `false` — a **borrowed** socket supplied already-open by the caller. The
   * agency dialer's agent station socket is opened once at shift start and reused
   * across hundreds of attempts, so closing it at the end of one call would log
   * the agent out after their first conversation. A borrowed socket is
   * *detached*, never closed. See docs/agency-dialer-design.md §7.
   */
  browserWsOwned: boolean = true;

  /**
   * Whether a browser socket has EVER been attached to this call — set at the
   * first attach and never cleared.
   *
   * A monotonic fact, not a liveness one, and it exists because **`browserWs`
   * cannot answer this question**: the borrowed-socket close handler arms the
   * deferred-hangup window without nulling the reference (deliberately — the
   * reference is what `session.browserWs !== ws` compares against), so a dropped
   * socket and a bound one look identical through it, and a *never-bound* call
   * looks like neither only by accident of ordering.
   *
   * Two guards in {@link WebRtcBridgeManager} are unexpressible without it, and
   * they read it in opposite directions: a bind refuses a leg that IS bound (a
   * second bind would displace a live agent), and a re-attach refuses one that
   * is NOT (there is nothing to resume onto). Under late binding an unbound
   * session has `browserWsOwned === false`, `endHandled === false` and
   * `ending === false`, so every other guard a re-attach has passes.
   */
  browserLegBound: boolean = false;

  /**
   * Removes every listener this session attached to a **borrowed** browser
   * socket. Null for an owned socket, where closing the socket disposes of its
   * listeners anyway.
   *
   * This is the leak that matters: `attachBrowserLeg` registers
   * `message`/`close`/`error` per call, and a station socket carrying an 8-hour
   * shift would accumulate hundreds of live handler sets — inert at first, then a
   * `MaxListenersExceededWarning`, then genuinely ambiguous handling as a stale
   * session's `close` handler races the current one.
   */
  private browserLegTeardown: (() => void) | null = null;

  /**
   * The terminal outcome recorded when this call's browser leg closes mid-call,
   * captured at attach so a **re-attach** can restore exactly the same handling.
   * `browser_hangup` for the owned dialer; the caller's choice for a borrowed
   * socket. Held here rather than re-derived, because a re-attach that guessed
   * would settle a dropped agent's call under the wrong outcome.
   */
  browserHangupOutcome: string = 'browser_hangup';

  /**
   * How long this call is held open after a **borrowed** browser socket closes,
   * waiting for the same caller to re-attach (0 = no grace, close ⇒ hang up).
   *
   * The value is supplied by the caller at dial time and stored verbatim. The
   * bridge neither chooses it nor knows why it is what it is — that is the
   * agency dialer's `DEFERRED_HANGUP_MS`, and §7's one-way dependency means this
   * file must stay ignorant of it.
   */
  browserLegGraceMs: number = 0;

  /**
   * The in-process deferred-hangup timer, armed on a borrowed socket's close.
   *
   * **This cannot be a Redis TTL, and not merely by convention** (§6.1): the
   * thing it defers is resuming media onto *this in-memory session*. If the
   * process died there is no session left to resume onto, so a key that survived
   * the process would be describing a resumption that can never happen. It is a
   * timer for the same reason `maxDurationTimer` is one.
   */
  private browserGraceTimer: NodeJS.Timeout | null = null;

  /**
   * The concurrency key (this call's id) under which the global + per-account
   * slots were acquired, and whether they're still held. Release is driven purely
   * from this flag (idempotent), never from a DB read — mirrors CallSession.
   */
  concurrencyKey: string | null = null;
  slotsHeld: boolean = false;

  /** Set synchronously the first time end is claimed, so teardown is idempotent. */
  endHandled: boolean = false;

  /**
   * Whether this call opted into recording (the `record` flag at dial time). Drives
   * whether the answer XML emits VoBiz's <Record> element. Set at createCall.
   */
  recordEnabled: boolean = false;
  /**
   * Agency back-references, mirrored from the `webrtc_calls` row (migration 076) so
   * teardown can settle without re-reading it. Null for the browser dialer.
   *
   * **`campaignId` is a billing discriminator, not just provenance**: master prices a
   * settlement carrying `campaign_id` as a flat `agency_connected_call` (25mc) rather
   * than the 250mc/min `webrtc_call` talk-time rate. Held as its own field rather
   * than read off `correlationId` (which happens to be the attempt id today) because
   * that field is documented as an opaque value the bridge must not interpret —
   * pricing must not depend on a coincidence.
   */
  campaignId: string | null = null;
  agencyAttemptId: string | null = null;
  /** Finalized recording URL once the VoBiz recording callback lands (observability). */
  recordingUrl: string | null = null;
  /**
   * Resolved max call duration (seconds). Stored so the answer XML can cap the
   * <Record> length to it (avoids truncating long recordings) without re-resolving
   * the feature flag. Set at createCall.
   */
  maxDurationSeconds: number | null = null;

  /**
   * Relay instrumentation — counts of media frames forwarded each direction and
   * the worst-case in-process relay dwell (receive→forward) in microseconds.
   * Lets us confirm core's own relay overhead is sub-millisecond, so steady-state
   * mouth-to-ear latency can be attributed to the network/jitter buffers, not us.
   */
  browserToPstnFrames: number = 0;
  pstnToBrowserFrames: number = 0;
  maxRelayDwellMicros: number = 0;

  /**
   * Per-session stateful A-law⇄PCM transcoder (VoiceLink only) — retains FIR
   * history + decimation phase across frames so there are no boundary clicks.
   * Null for providers that pass audio through verbatim (VoBiz).
   */
  readonly transcoder: VoicelinkTranscoder | null;

  private maxDurationTimer: NodeJS.Timeout | null = null;
  private readonly log;

  constructor(params: {
    callId: string;
    tenantId: string;
    accountId: string;
    callerId: string;
    destinationPhone: string;
    provider: string;
  }) {
    this.callId = params.callId;
    this.tenantId = params.tenantId;
    this.accountId = params.accountId;
    this.callerId = params.callerId;
    this.destinationPhone = params.destinationPhone;
    this.provider = params.provider;
    this.transcoder = params.provider === 'voicelink' ? new VoicelinkTranscoder() : null;
    this.startedAt = new Date();
    this.log = createChildLogger({
      component: 'webrtc-bridge-session',
      callId: params.callId,
      tenantId: params.tenantId,
      accountId: params.accountId,
    });
  }

  /** True once both legs' WebSockets are open and audio can flow. */
  get bothLegsConnected(): boolean {
    return (
      this.browserWs?.readyState === 1 /* OPEN */ &&
      this.pstnWs?.readyState === 1
    );
  }

  /**
   * Idempotent answer anchor (first write wins).
   *
   * Returns **true only on the write that actually anchored**, so a caller can
   * emit a one-shot "the carrier answered" observation without tracking that
   * itself. Four separate call sites anchor (VoBiz answer webhook, VoiceLink
   * stream start, the normalized `answer` event, and the PSTN-socket backstop) and
   * on a given call several of them fire — an anchor observer keyed on anything
   * other than this return value would emit once per site.
   */
  markAnswered(): boolean {
    if (this.answeredAt === null) {
      this.answeredAt = new Date();
      return true;
    }
    return false;
  }

  /**
   * One-shot latch for the `bridged` announcement, the sibling of
   * {@link markAnswered}: **true only on the write that actually latched**, so a
   * caller can fire it at every moment that could have completed the bridge and
   * still announce it once.
   *
   * Three sites can complete a bridge (both legs live + media negotiated) and on
   * a late-binding VoiceLink call two of them fire in the same synchronous turn:
   * `handleProviderStart` sets `providerMediaReady`, anchors the answer — whose
   * `answered` listener BINDS the station socket re-entrantly, which announces
   * the bridge — and then reaches its own announcement line with everything
   * already true. Without the latch that call is announced twice, and the second
   * one is not cosmetic: the agency dialer's handler rewrites
   * `agency_call_attempts.bridged_at` with the later instant, which is one half
   * of the SQL abandonment predicate (`MAG-137`). VoBiz escapes it only by
   * ordering — its `<Stream>` connects after the answer webhook, so the bind
   * finds one leg down — which is why a VoBiz-only test cannot see this.
   *
   * A boolean rather than a `bridgedAt` timestamp, deliberately: the agency
   * dialer owns `bridged_at` and measures compliance from it, and a second
   * timestamp here would be a second answer to a question that must have one.
   */
  markBridged(): boolean {
    if (this.bridgeAnnounced) return false;
    this.bridgeAnnounced = true;
    return true;
  }

  /** Connected talk time in whole seconds (0 if never answered) — what billing rounds. */
  getTalkTimeSeconds(): number {
    if (this.answeredAt === null) return 0;
    return Math.round((Date.now() - this.answeredAt.getTime()) / 1000);
  }

  /** Total call duration (create → now) in whole seconds. */
  getDurationSeconds(): number {
    return Math.round((Date.now() - this.startedAt.getTime()) / 1000);
  }

  /**
   * Arm the bounded fallback that finalizes teardown if the carrier never confirms
   * `call.ended` after a local hangup. Idempotent (clears any prior timer).
   */
  setEndConfirmationTimer(seconds: number, onTimeout: () => void): void {
    this.clearEndConfirmationTimer();
    this.endConfirmationTimer = setTimeout(() => {
      this.log.warn({ seconds }, 'WebRTC carrier end-confirmation timeout — finalizing');
      onTimeout();
    }, seconds * 1000);
  }

  clearEndConfirmationTimer(): void {
    if (this.endConfirmationTimer) {
      clearTimeout(this.endConfirmationTimer);
      this.endConfirmationTimer = null;
    }
  }

  setMaxDurationTimer(seconds: number, onTimeout: () => void): void {
    this.clearMaxDurationTimer();
    this.maxDurationTimer = setTimeout(() => {
      this.log.warn({ seconds }, 'WebRTC call max duration reached');
      onTimeout();
    }, seconds * 1000);
  }

  clearMaxDurationTimer(): void {
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
  }

  /**
   * Claim a borrowed browser socket for this call: release anything previously
   * attached, mark the leg not-owned, and hold the reference.
   *
   * Two steps, because the close-handler's `session.browserWs !== ws` guard must
   * already be satisfiable when the manager registers it — so the reference is
   * claimed here and {@link setBrowserLegTeardown} records how to undo the
   * registration afterwards.
   */
  adoptBorrowedBrowserLeg(ws: WebSocket): void {
    this.releaseBrowserLeg();
    this.browserWsOwned = false;
    this.browserWs = ws;
    // Every borrowed attach — dial-time, late bind, re-attach — comes through
    // here, so this is the one place {@link browserLegBound} cannot be forgotten.
    this.browserLegBound = true;
  }

  /**
   * Declare the browser leg **borrowed but not yet bound**: the caller will
   * supply its socket later — at the carrier answer — rather than at dial time.
   * `browserWs` stays null, so nothing is attached and nothing relays.
   *
   * This sets exactly what {@link adoptBorrowedBrowserLeg} sets apart from the
   * socket itself, and the reason it is a separate call rather than a null
   * argument to that one is that there is no listener registration to undo here.
   *
   * It deliberately leaves {@link browserLegBound} false, which is the other
   * half of the contract: a socket-less call is not merely un-relayed, it is a
   * call a **re-attach must refuse** (see
   * `WebRtcBridgeManager.reattachBorrowedBrowserLeg`), because resuming onto a
   * call that is still ringing is exactly the ringing-panel behaviour late
   * binding exists to remove.
   *
   * **`browserWsOwned = false` from birth is the load-bearing part**, because it
   * is what makes the two ownership guards correct for a call that has no socket
   * yet — both of them read ownership, neither reads the socket:
   *
   *  - `WebRtcBridgeManager.attachBrowserLeg` refuses a leg that is NOT owned, so
   *    nobody who learns the call id can join the agent's audio through the
   *    token-less `/browser-stream` route. That matters more here than on a
   *    bound borrowed call: an unbound call mints no browser token either, so
   *    `verifyWsToken`'s accept-on-missing-key fallback is exactly what an
   *    intruder would hit, and ownership is the only thing refusing them.
   *  - `WebRtcBridgeManager.reattachBorrowedBrowserLeg` refuses a leg that IS
   *    owned, so the wifi-blip path starts working on this call the instant a
   *    socket is bound, with no third state to teach it about.
   *
   * Leaving the default `true` until the bind would invert both of those for the
   * whole ring window — which is precisely the window this mode exists to cover.
   */
  markBorrowedUnbound(hangupOutcome: string, graceMs: number): void {
    this.browserWsOwned = false;
    this.browserHangupOutcome = hangupOutcome;
    this.browserLegGraceMs = graceMs;
  }

  /** Record how to remove the listeners just attached to a borrowed socket. */
  setBrowserLegTeardown(teardown: () => void): void {
    this.browserLegTeardown = teardown;
  }

  /** True while a dropped borrowed socket is inside its re-attach window. */
  get browserLegGraceArmed(): boolean {
    return this.browserGraceTimer !== null;
  }

  /**
   * Arm the deferred hangup: hold the call open for `ms` waiting for a re-attach.
   * Idempotent — a second close inside an armed window restarts nothing, because
   * the window is anchored on the FIRST drop. A flapping socket that re-armed on
   * every close could hold a customer on silence indefinitely, which is precisely
   * the bound the window exists to impose.
   */
  armBrowserLegGrace(ms: number, onExpiry: () => void): void {
    if (this.browserGraceTimer) return;
    this.browserGraceTimer = setTimeout(() => {
      this.browserGraceTimer = null;
      this.log.warn({ graceMs: ms }, 'Borrowed browser leg did not re-attach — hanging up');
      onExpiry();
    }, ms);
    // Never hold the event loop open for a grace window.
    this.browserGraceTimer.unref?.();
  }

  /** Disarm the deferred hangup. Returns whether one was actually armed. */
  clearBrowserLegGrace(): boolean {
    if (!this.browserGraceTimer) return false;
    clearTimeout(this.browserGraceTimer);
    this.browserGraceTimer = null;
    return true;
  }

  /**
   * Detach the browser leg WITHOUT closing it: run the per-attempt listener
   * teardown and drop our reference. Idempotent, and a no-op for an owned socket
   * (which registers no teardown). This is the counterpart of
   * {@link setBorrowedBrowserLeg} and the reason a station socket survives an
   * attempt — after it, the socket has exactly the listeners it had before the
   * attempt began.
   */
  releaseBrowserLeg(): void {
    const teardown = this.browserLegTeardown;
    this.browserLegTeardown = null;
    if (teardown) {
      try {
        teardown();
      } catch (err) {
        this.log.error({ err }, 'Error detaching borrowed WebRTC browser leg');
      }
    }
  }

  /**
   * Close the WebSockets we own and clear timers. Safe to call more than once.
   *
   * A **borrowed** browser socket is detached rather than closed (§7): it belongs
   * to the caller, outlives this call, and closing it would end the agent's shift.
   */
  destroy(): void {
    this.clearMaxDurationTimer();
    this.clearEndConfirmationTimer();
    // A call that ends for any other reason while a dropped socket is still
    // inside its window must not fire a hangup afterwards.
    this.clearBrowserLegGrace();
    // Capture before releaseBrowserLeg() clears the reference; a borrowed browser
    // socket is deliberately absent from the close list.
    const owned: (WebSocket | null)[] = [this.browserWsOwned ? this.browserWs : null, this.pstnWs];
    this.releaseBrowserLeg();
    for (const ws of owned) {
      if (ws) {
        try {
          if (ws.readyState === ws.OPEN) ws.close();
        } catch (err) {
          this.log.error({ err }, 'Error closing WebRTC bridge WebSocket');
        }
      }
    }
    this.browserWs = null;
    this.pstnWs = null;
    this.log.info({ browserWsOwned: this.browserWsOwned }, 'WebRTC bridge session destroyed');
  }
}
