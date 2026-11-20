/**
 * The station socket: its frames, intervals, token and close codes.
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the
 * contract's header (freeze rules, vocabulary).
 */

import type { AgencyStationWrapupFrame, AgencyWrapupState } from './actions';
import type { AgencyAgentState, AgencyAttemptOutcome, AgencyAttemptState, AgencyCampaignStatus } from './enums';
import type { AgencyStationCustomerWaitingFrame, AgencyStationInboundCallFrame } from './inbound';
import type { AgencyStationManualCallFrame } from './softphone';
import type { AgencyContactPromise } from './promise';
import type { AgencyCustomerFacts } from './customer-facts';
import type {
  AgencySessionHelp,
  AgencyStationHelpAnsweredFrame,
  AgencyStationHelpClearedFrame,
  AgencyStationSupervisorMessageFrame,
} from './floor-assist';
import type { AllListed } from '../primitives';

// ─── Which client is on the other end ───────────────────────────────────────

/**
 * Which app an agent is working from: the browser console (`web`) or the agent
 * mobile app (`mobile`).
 *
 * Declared by the client, never verified, so it is NEVER an auth input or a
 * rate-limit key. It tunes liveness (a mobile station is probed with protocol
 * pings and given `MOBILE_STATION_HEARTBEAT_GRACE_MS`), sets the station's inbound
 * default (a `web` station can always take inbound calls, a `mobile` one only when it
 * declares `caps=inbound`: {@link AgencyStationCapability}), labels logs and marks the
 * supervisor's floor. Over HTTP it is read from `X-Client`
 * (`magick-agency-mobile/<semver>+<build> (<ios|android> <osver>; <model>)`; anything
 * else, or no header, is `web`); on the station socket from the upgrade query
 * (`client=web|mobile`). Stored on `agency_agent_sessions.client_kind`, written by
 * every station attach (0006).
 */
export type AgencyClientKind = 'web' | 'mobile';

export const AGENCY_CLIENT_KINDS = ['web', 'mobile'] as const satisfies readonly AgencyClientKind[];

const _allClientKindsListed: AllListed<AgencyClientKind, typeof AGENCY_CLIENT_KINDS> = true;
void _allClientKindsListed;

/**
 * What a station socket says it can do beyond the dialer's own frames, declared on the upgrade
 * query as `caps=<capability>[,<capability>…]` (comma-separated; a repeated `caps` parameter is
 * the union). Absent or empty: none. A value this server does not know is IGNORED, never
 * refused: an app newer than the server must still get a station (a 1008 is terminal for the
 * app), so a capability is only ever something a client offers, never something it demands.
 *
 *  - `inbound`: the station decodes the inbound call frames ({@link AGENCY_STATION_INBOUND_EVENTS})
 *    and can be put through to an inbound caller (docs/inbound.md §4.3). A console station
 *    (`client=web`) can always take inbound calls, whatever it sends; a mobile station
 *    (`client=mobile`) only when it declares `caps=inbound`, so every older app build stays out
 *    of the inbound pool and is never sent the frames.
 *
 *  - `floor_assist`: the station shows the floor assist frames (`AGENCY_STATION_FLOOR_ASSIST_EVENTS`:
 *    a supervisor's message, and how the agent's Need help was answered or ended; decisions LF4,
 *    LF5, LF16). A console station always receives them; a mobile station only when it declares
 *    `caps=floor_assist`, so an app build that cannot show a message is never sent one, and a
 *    message to it is refused `409 agent_not_live` rather than shown to nobody. The same value as
 *    `AGENCY_STATION_FLOOR_ASSIST_CAPABILITY` (`./floor-assist.ts`).
 *
 * Like {@link AgencyClientKind}, declared by the client and never verified: it decides which frames
 * the socket is sent and whether it is offered a caller, never anything security-relevant. It
 * belongs to the socket, not the session: a reattach (from another device, or an older build)
 * states its own.
 */
export type AgencyStationCapability = 'inbound' | 'floor_assist';

export const AGENCY_STATION_CAPABILITIES = ['inbound', 'floor_assist'] as const satisfies readonly AgencyStationCapability[];

const _allStationCapabilitiesListed: AllListed<AgencyStationCapability, typeof AGENCY_STATION_CAPABILITIES> = true;
void _allStationCapabilitiesListed;

// ─── The station socket envelope ────────────────────────────────────────────
//
// One socket carries three multiplexed streams: agency control frames, the
// caller's heartbeat, and raw media relayed by the WebRTC bridge.
//
// **Consumers must not write an exhaustive switch that assumes only agency
// frames.** The bridge borrows this socket per attempt and emits its own
// `status` and `ended` frames onto it from `WebRtcBridgeManager.notifyBrowser` —
// the station handler does not intercept or rewrite them, so they arrive unchanged. This was
// found while implementing Phase 0 and is the single most likely thing to break a
// client written from the design alone, which does not mention it.
//
// Every **text** frame is JSON with an `event` discriminant; non-JSON text frames are
// ignored. **Binary** frames carry nothing but audio, and only on a socket that chose
// the compact media format at upgrade (`media=alaw8`, see
// {@link AgencyStationMediaFormat}); on the default `pcm16` socket a binary frame is
// ignored.

/**
 * Frames the agent console sends to the station handler.
 *
 * **Only `ping` and `media` are read.** `AgencyStationHangupFrame` is retained in
 * the union deliberately — it is what a client was told to send, so removing it
 * outright would turn a documented no-op into a type error with no explanation
 * attached. It carries its own `@deprecated` and the enumeration that proved it
 * dead.
 */
export type AgencyStationClientFrame =
  | AgencyStationPingFrame
  | AgencyStationMediaFrame
  | AgencyStationHangupFrame;

/** Liveness. Renews the agent's lease; three misses and the agent goes offline. */
export interface AgencyStationPingFrame {
  event: 'ping';
  /** Client clock, epoch ms. Echoed in `pong` for RTT measurement. Optional. */
  ts?: number;
}

/**
 * Outbound audio: base64 PCM16 @ 16kHz, matching the existing browser dialer's
 * frame exactly. The bridge transcodes per provider; the console does not.
 * Frames sent while no attempt is bridged are dropped by the dialer runtime, not an error.
 *
 * **`pcm16` sockets only** (the default {@link AgencyStationMediaFormat}). On an
 * `alaw8` socket the server neither sends this frame nor reads it: a JSON `media`
 * frame there is ignored, and audio travels as binary frames instead.
 */
export interface AgencyStationMediaFrame {
  event: 'media';
  media: { payload: string };
}

/**
 * The agent leg's audio format on one station socket, chosen by the upgrade query
 * `media=pcm16|alaw8` (absent ⇒ `pcm16`). Any other value, an empty one or a repeated
 * parameter is refused with close code 1008 before the socket is attached, and before
 * the single-use token is consumed.
 *
 *  - `pcm16` — {@link AgencyStationMediaFrame} JSON text frames both ways: base64
 *    PCM16, 16 kHz mono (~340 kbit/s each way on the wire). The browser console.
 *  - `alaw8` — **binary** WebSocket frames both ways carrying raw G.711 A-law, 8 kHz
 *    mono, one byte per sample, no header (64 kbit/s plus framing). The mobile app.
 *    - client → server: any whole number of 20 ms frames, i.e. a length that is a
 *      non-zero multiple of {@link AGENCY_STATION_ALAW8_FRAME_BYTES} and at most
 *      {@link AGENCY_STATION_ALAW8_MAX_FRAME_BYTES}; anything else is dropped.
 *    - server → client: exactly one 20 ms frame
 *      ({@link AGENCY_STATION_ALAW8_FRAME_BYTES} bytes) per binary message.
 *    - text frames stay JSON control frames (`ping`, and every server frame in
 *      {@link AgencyStationServerFrame} except `media`).
 *
 * In both formats audio sent while no attempt is bridged is dropped, not an error.
 * The format belongs to the socket: a reconnect may choose another, and the call it
 * resumes switches with it.
 */
export type AgencyStationMediaFormat = 'pcm16' | 'alaw8';

/** Every {@link AgencyStationMediaFormat}, default first. */
export const AGENCY_STATION_MEDIA_FORMATS = ['pcm16', 'alaw8'] as const satisfies readonly AgencyStationMediaFormat[];

const _allMediaFormatsListed: AllListed<AgencyStationMediaFormat, typeof AGENCY_STATION_MEDIA_FORMATS> = true;
void _allMediaFormatsListed;

/** One 20 ms frame of `alaw8` audio: 8000 samples/s × 0.02 s × 1 byte. */
export const AGENCY_STATION_ALAW8_FRAME_BYTES = 160;

/** Largest `alaw8` binary message the server accepts from a client: 1 s of audio. */
export const AGENCY_STATION_ALAW8_MAX_FRAME_BYTES = 8000;

/**
 * The largest WebSocket message, in bytes, the server takes on any route by default (its
 * `maxPayload`, `WS_MAX_PAYLOAD_DEFAULT_BYTES` in `apps/server/src/utils/ws-limits.ts`). A
 * message past it is not dropped: the server closes the socket with 1009, which takes a
 * station (and a live call's audio) down. Clients size their largest frame under it (the
 * console's `pcm16` uplink: this less the JSON envelope). Operators may raise the server's
 * bound (`WS_MAX_PAYLOAD_BYTES`), never below the largest legitimate frame.
 */
export const AGENCY_WS_MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * **WITHDRAWN. Do not send this frame; nothing reads it.**
 *
 * Kept as a named type only so the union below can document the gap rather than
 * quietly dropping a shape clients were told to build against.
 *
 * It was never implemented. Enumerated 2026-08-12: the station socket carries
 * exactly two `message` listeners while an attempt is live —
 * `agency.routes.ts`'s own, which acts only on `event === 'ping'`, and the
 * bridge's borrowed-leg listener (in `webrtc-bridge-manager.ts`, `onBrowserMessage`), which acts only on `event === 'media'`. A `hangup` frame
 * fell off the end of both, silently. No HTTP route existed either, so
 * the public API layer's forward 404'd and **an agent could not hang up by any advertised path.**
 *
 * The route is now real, and this stays withdrawn rather than being implemented
 * alongside it. Two surfaces for one action means two ownership checks to keep in
 * step, and this one cannot carry an actor at all: the socket authenticates the
 * *session*, so a supervisor's `on_behalf` hangup has nowhere to live. A control
 * frame also returns no status, which is why the console's HTTP call is the one the
 * console can actually act on.
 *
 * @deprecated Use `POST /api/v1/agency/attempts/:id/hangup`.
 */
export interface AgencyStationHangupFrame {
  event: 'hangup';
  attempt_id: string;
}

/** Frames the dialer runtime sends to the agent console. */
export type AgencyStationServerFrame =
  | AgencyStationReadyFrame
  | AgencyStationReservedFrame
  | AgencyStationCountdownFrame
  | AgencyStationBridgedFrame
  | AgencyStationReleasedFrame
  | AgencyStationWrapupFrame
  | AgencyStationAgentStateFrame
  | AgencyStationCampaignStateFrame
  | AgencyStationPongFrame
  | AgencyStationErrorFrame
  | AgencyStationBridgeStatusFrame
  | AgencyStationBridgeEndedFrame
  | AgencyStationMediaFrame
  // SP: a soft-phone call's every state change (`./softphone.ts`).
  | AgencyStationManualCallFrame
  // Contact assignment: this agent's own queue (strict / preferred campaigns).
  | AgencyStationQueueFrame
  // A dial ringing for this agent that they are not shown until it is answered (late binding).
  | AgencyStationDialActivityFrame
  // Inbound calls (P2, docs/inbound.md §6): the call offered to or connected with this agent,
  // and a sticky caller waiting for them (`./inbound.ts`). Only to a station that can take inbound
  // calls (`AGENCY_STATION_INBOUND_EVENTS`).
  | AgencyStationInboundCallFrame
  | AgencyStationCustomerWaitingFrame
  // Floor assist (LF4, LF5, LF16): a supervisor's message, and how the agent's Need help was answered
  // or ended (`./floor-assist.ts`). Only to a station that can show them
  // (`AGENCY_STATION_FLOOR_ASSIST_EVENTS`): every console, a phone that declared `caps=floor_assist`.
  | AgencyStationSupervisorMessageFrame
  | AgencyStationHelpAnsweredFrame
  | AgencyStationHelpClearedFrame;

/**
 * The inbound call frames: sent only to a station that can take inbound calls
 * ({@link AgencyStationCapability} `inbound`): every console station, and a mobile station that
 * declared `caps=inbound` on its upgrade (docs/inbound.md §4.3, §6). The server drops them for any
 * other station in one place (`StationRegistry.send`), whoever asks, so an app build that cannot
 * decode them is never sent one.
 */
export const AGENCY_STATION_INBOUND_EVENTS = [
  'inbound_call',
  'customer_waiting',
] as const satisfies readonly AgencyStationServerFrame['event'][];

/**
 * Sent once, immediately on socket open, after session rehydration.
 *
 * **P2 — this frame is how a reconnect is explained.** A dropped socket that comes
 * back inside `intervals.deferred_hangup_ms` finds its call still live; one that
 * comes back after it finds the call settled. The console must be able to tell
 * those apart without guessing, so both cases are answered here: `active_attempt`
 * present ⇒ resumed, `missed_release` present ⇒ the attempt ended while the socket
 * was away and the agent never saw the `released` frame that said so.
 *
 * **The dialer runtime does NOT re-emit `bridged` after this frame, deliberately.** An earlier
 * draft of this contract said it would, so that a reconnecting console could
 * restore its live panel through the ordinary code path. That was wrong, and the
 * reason is a client concern that turns out to be binding on the dialer runtime: the `bridged`
 * handler schedules the audible connect cue. The cue is deduped per `attempt_id`,
 * but a reconnect that follows a full page load starts with an empty dedupe set —
 * so a re-emitted `bridged` would play a "customer connected" cue in the middle of
 * a conversation already in progress. {@link AgencyActiveAttempt.bridged_at} is the
 * authority for a resumed panel instead. `attempt_id` is present on both this
 * payload and the `reserved` frame's, so the client's dedupe key is stable across
 * the two either way.
 */
export interface AgencyStationReadyFrame {
  event: 'ready';
  session_id: string;
  /**
   * The agent's state as their screen should show it. One difference from the server's own
   * record: an agent held `reserved` only by a dial they have not been shown (late binding,
   * {@link AgencyDialActivity}) is said to be `available`, as they were last told; the
   * `reserved` frame of an answer moves them on as usual.
   */
  state: AgencyAgentState;
  /**
   * The break's code when `state` is `break`, with the same meaning as
   * {@link AgencyStationAgentStateFrame.break_reason}. Absent when not on break, or on a
   * break with no recorded reason (a rehydrate after a restart).
   *
   * Without it a reconnect could say only "on break": the `agent_state` frame that named
   * the reason is gone by then. That matters most for the mobile app, which is paused
   * with `device_away` when it leaves the foreground and is often killed by the OS while
   * paused: on relaunch this is how it knows to say "you left the app" rather than show
   * a generic break.
   */
  break_reason?: string;
  /** Set when the socket reconnected onto an attempt that is still live. */
  active_attempt?: AgencyActiveAttempt;
  /**
   * This agent's queue now. On a `strict` or `preferred` campaign, their own queue; on a `pool`
   * campaign (agent station BE-5) the campaign's shared one. Absent from a server that does not
   * compute it for this campaign (before BE-5, every `pool` campaign).
   */
  queue?: AgencyQueueState;
  /**
   * The hidden dials for this agent now ({@link AgencyDialActivity}): present when one is ringing
   * or the count is above 0, absent otherwise (read absence as not ringing, count 0). Never
   * present beside `active_attempt`.
   */
  dial_activity?: AgencyDialActivity;
  /**
   * **P2.** Set when the reconnecting socket is in `wrapup` — the console needs the
   * absolute deadline to resume the countdown, and a wrap-up that survived a
   * reconnect is the common case, not an edge one.
   */
  active_wrapup?: AgencyWrapupState;
  /**
   * **P2.** The `released` this session missed while it was disconnected. Without
   * it, an agent who drops mid-call and reconnects sees an empty console and no
   * account of the call they were just on — which reads as data loss.
   */
  missed_release?: AgencyMissedRelease;
  /**
   * **P2.** A transition the agent asked for that is accepted but not yet applied —
   * the same field, with the same meaning and type, as on
   * {@link AgencyStationAgentStateFrame}. `undefined` means nothing is queued.
   *
   * **Why it has to be here too.** A queued break is announced exactly twice: once
   * on the HTTP response that queued it, once on the `agent_state` frame that
   * accompanies it. Both are gone by the time a dropped socket comes back, and the
   * next authoritative `agent_state` for that agent is the one `releaseAgent`
   * emits at the *end* of wrap-up — by which point the break has already been
   * applied. So a socket that reconnects mid-wrap-up used to be told its state and
   * its countdown and nothing about the break waiting behind them, while
   * `releaseAgent` went on to apply it anyway: the agent is pulled out of the pool
   * by a request their console has forgotten making.
   *
   * Carried on `ready` rather than answered with a synthetic `agent_state` after
   * attach, because that frame's `since` is the instant of a transition and a
   * reconnect is not one — nothing records when the break was queued, so the
   * timestamp would have to be invented, and `ready` already reports the state this
   * would repeat.
   */
  pending_state?: AgencyAgentState;
  /** **P2.** Present when `pending_state` is `break`. */
  pending_break_reason?: string;
  /**
   * The session's open Need help request (LF4, `./floor-assist.ts`), so a reloaded console or a
   * relaunched app still shows "Help requested"; absent when none is open. Only to a station that
   * can receive the floor assist frames (`AGENCY_STATION_FLOOR_ASSIST_CAPABILITY`), which are what
   * end it.
   */
  help?: AgencySessionHelp;
}

/**
 * An attempt a reconnecting socket was found still holding (P2).
 *
 * A superset of {@link AgencyReservedAttempt} — everything the panel needs, plus
 * the two fields that only mean anything when you are re-joining an attempt in
 * progress rather than being handed a fresh one. They live here instead of on
 * `AgencyReservedAttempt` precisely so the `reserved` frame cannot carry them: on
 * that frame `bridged_at` would be null by construction, and a nullable field that
 * is always null is a field someone eventually reads as meaningful.
 *
 * **`bridged_at` is the ringing-vs-live discriminator, and it has to come from the
 * authoritative side.** Without it a reconnected console can only guess, and both
 * guesses are bad: show "connected" and the agent starts talking to a phone that is
 * still ringing, or show "ringing" and they sit silent through a live customer's
 * hello. This is the same seam the deferred-hangup timer works across.
 */
export interface AgencyActiveAttempt extends AgencyReservedAttempt {
  /**
   * ISO-8601 answer anchor, or `null` while the attempt is still pre-answer.
   * Non-null ⇒ media is live and the customer may already be speaking. Matches the
   * `bridged` frame's `bridged_at` for the same attempt.
   */
  bridged_at: string | null;
  /**
   * The attempt's authoritative state, for finer copy than `bridged_at` alone
   * supports — `dialing` and `ringing` are both pre-answer but read differently to
   * an agent watching a panel appear out of nowhere.
   */
  state: AgencyAttemptState;
}

/**
 * A `released` the agent's socket was not present to receive (P2).
 *
 * Deliberately a subset of {@link AgencyStationReleasedFrame} plus `ended_at`: it
 * is history, not a live transition, and a console that fed it through the same
 * handler as a live `released` would re-run whatever that handler does on arrival
 * (stop timers, clear audio) against an attempt that is already long gone.
 */
export interface AgencyMissedRelease {
  attempt_id: string;
  reason: AgencyReleaseReason;
  requires_disposition: boolean;
  message: string;
  /** ISO-8601. */
  ended_at: string;
}

/**
 * **The context push.** The ordering guarantee lives entirely in this frame.
 *
 * Emitted synchronously at reservation — in the same tick, before the dial is
 * placed and therefore before the carrier can possibly answer. It is not emitted
 * on answer, and not from an async continuation: the decisive test answers the
 * carrier synchronously within the dial tick, which a 3-second ring would
 * otherwise hide. The ordering is structural, not a race we usually win.
 *
 * The console renders the panel immediately in a "connecting" visual state. The
 * agent therefore reads the contact *while it rings* — strictly better than the
 * "before or simultaneously with audio connect" requirement.
 */
export interface AgencyStationReservedFrame {
  event: 'reserved';
  attempt: AgencyReservedAttempt;
}

/** A wrap-up redial, as the station panel carries it. */
export interface AgencyRedialInfo {
  of_attempt_id: string;
  number: number;
  remaining: number;
}

export interface AgencyReservedAttempt {
  attempt_id: string;
  campaign_id: string;
  campaign_name: string;
  contact_id: string;
  /** E.164, as dialed. */
  phone_e164: string;
  /** The caller ID this attempt dials from, for agent reference. */
  caller_id: string;
  /** 1-based. */
  attempt_number: number;
  /**
   * Every non-phone CSV column unchanged, original headers as keys. Render it with
   * `AgencyContextDisplay`. Values are whatever the CSV held — always treat as
   * untrusted display text, never as markup.
   */
  context: Record<string, unknown>;
  /** Prior attempts on this contact, newest first. Empty on a first dial. */
  prior_attempts: AgencyPriorAttempt[];
  /**
   * The contact's latest promise to pay (PT9), so the agent sees "Promised 18 Nov · 12,500"
   * when they next reach the customer; null or absent without one.
   */
  promise?: AgencyContactPromise | null;
  /**
   * Set when this call is a wrap-up redial (`POST /sessions/:id/redial`): the attempt it
   * redials, its number (1, 2) and how many redials are left after it. Absent on a call
   * the pacing engine placed.
   */
  redial?: AgencyRedialInfo;
  /**
   * Agent station (BE-4): set when this dial is a booked call-later coming due, so the station
   * can tag it "Call later · You said you will call at 3:00 PM". Absent on every other dial, on a
   * wrap-up redial, and from a server older than the field. Built at dial time with the rest of
   * the panel (late binding delivers it at the answer); a resumed call carries it through
   * `ready.active_attempt`.
   */
  callback?: AgencyAttemptCallback;
  /**
   * Agent station (BE-6, `./customer-facts.ts`): the customer's name, place and fact tiles, parsed
   * by the server from `context` by the campaign's `context_display.roles` / `.types`. Absent from
   * an older server: read `context` through `context_display` as before. `context` is still sent
   * whole beside it.
   */
  facts?: AgencyCustomerFacts;
}

/**
 * Where a booked call-later came from (`AgencyAttemptCallback.source`):
 *  - `outcome`: an agent's outcome booked it (a `requires_datetime` outcome, `callback`);
 *  - `promise`: a promise to pay's follow-up (PT2, `promise_follow_up_days`);
 *  - `inbound`: the customer rang in and reached nobody (docs/inbound.md §7, `callback_source`).
 */
export type AgencyAttemptCallbackSource = 'outcome' | 'promise' | 'inbound';

export const AGENCY_ATTEMPT_CALLBACK_SOURCES = [
  'outcome',
  'promise',
  'inbound',
] as const satisfies readonly AgencyAttemptCallbackSource[];

const _allCallbackSourcesListed: AllListed<AgencyAttemptCallbackSource, typeof AGENCY_ATTEMPT_CALLBACK_SOURCES> = true;
void _allCallbackSourcesListed;

/** A dial that is a booked call-later ({@link AgencyReservedAttempt.callback}, BE-4). */
export interface AgencyAttemptCallback {
  /** ISO-8601. The time that was booked (the contact's due time when the dial was claimed). */
  due_at: string;
  /**
   * Whether this agent booked it (`agency_contacts.callback_booked_by_user_id`, 0057, is the
   * session's agent): the station says "You said you will call at …" only when true. False for a
   * call-later another agent booked, one booked before the booker was recorded, and every
   * `inbound` one.
   */
  booked_by_me: boolean;
  source: AgencyAttemptCallbackSource;
}

/**
 * One earlier dial of the same person, as the agent's panel renders it.
 *
 * ── The set this is drawn from is the LINEAGE, not the contact row ──────────
 *
 * Since retry campaigns landed, `prior_attempts` spans every campaign in the
 * contact's chain (`agency_contacts.root_contact_id`), newest
 * first, capped at `PRIOR_ATTEMPT_LIMIT`. That is what makes the last three
 * fields necessary rather than decorative:
 *
 *  - `attempt_number` is PER CONTACT ROW and **resets in every retry campaign**
 *    (a retry is a fresh allowance, which is the point of authoring one).
 *    So "attempt 2" means nothing once attempts come from two campaigns, and the
 *    repository orders by `ended_at` rather than by this number for the same
 *    reason. It stays on the payload because it is still the honest answer to
 *    "which dial of this roster row was it".
 *  - `campaign_id` / `campaign_name` are what make the list readable: the console
 *    groups by campaign, this one first, then ancestors.
 *  - `dialed_at` exists because `attempt_number` is no longer a global ordering
 *    and `ended_at` is NULL on an attempt that never ended (reaped, orphaned) —
 *    so without it a row can carry no time at all.
 *
 * ⚠️ `disposition_code` is resolved against the CURRENT campaign's
 * `disposition_catalog`, which a parent's code may not appear in. The console
 * must fall back to the raw code beside the campaign name rather than rendering
 * it unlabelled — and must NOT be shipped the parent's catalog to fix it (see
 * `AgencySessionBootstrap.retry_context`).
 */
export interface AgencyPriorAttempt {
  attempt_number: number;
  outcome: AgencyAttemptOutcome | null;
  disposition_code: string | null;
  /** As `AgencyAttemptRow.auto_disposition_code` (`agency/spine.ts`). */
  auto_disposition_code?: string | null;
  notes: string | null;
  /** The promise to pay recorded on this attempt (PT9), as `AgencyAttemptRow`'s; absent: none. */
  promise_date?: string | null;
  promise_amount?: string | null;
  /** ISO-8601. */
  ended_at: string | null;
  /** The campaign this attempt was placed on — not necessarily the current one. */
  campaign_id: string;
  /** That campaign's name, resolved dialer-runtime-side; the console has no way to. */
  campaign_name: string;
  /** ISO-8601, or null if the attempt never dialled (refused a pre-dial gate, reaped). */
  dialed_at: string | null;
}

/** The 3-2-1 auto-connect countdown. Emitted once per remaining second. */
export interface AgencyStationCountdownFrame {
  event: 'countdown';
  attempt_id: string;
  seconds_remaining: number;
}

/** Audio is live. The console switches the panel to its live state. */
export interface AgencyStationBridgedFrame {
  event: 'bridged';
  attempt_id: string;
  /** ISO-8601 answer anchor — the console's talk timer should count from here. */
  bridged_at: string;
}

/**
 * The attempt is over and the agent is free. **Always carries a `reason`.**
 *
 * Without a
 * reason the console can only blank the panel, and an agent whose screen clears
 * with no explanation concludes the app is broken — which is a support ticket per
 * unanswered call, at volume. Every field below exists so the console can say
 * something true.
 */
export interface AgencyStationReleasedFrame {
  event: 'released';
  attempt_id: string;
  reason: AgencyReleaseReason;
  /**
   * Whether the dialer runtime expects a disposition for this attempt. True only when the call
   * actually reached the agent; a `no_answer` needs no disposition. When true the
   * console must keep the panel up and prompt.
   */
  requires_disposition: boolean;
  /** Human-readable fallback copy. The console should prefer its own per-reason
   *  copy and use this only for a reason it does not recognise. */
  message: string;
}

/**
 * Why an attempt released the agent. Exhaustive by construction: the console
 * must render copy for each, and an unrecognised value must fall back to
 * `message` rather than blanking.
 */
export type AgencyReleaseReason =
  /** Conversation happened and ended normally. Disposition expected. */
  | 'completed'
  /** Rang out. No disposition expected. */
  | 'no_answer'
  /** Carrier reported busy. */
  | 'busy'
  /** Carrier rejected or the dial errored. */
  | 'failed'
  /** Number is not dialable — the contact is suppressed, not retried. */
  | 'invalid'
  /** Answered with no agent to bridge to. Near-unreachable while answering-machine detection is out of scope. */
  | 'abandoned'
  /** The agent's own socket dropped mid-call and the carrier leg was torn down. */
  | 'agent_disconnected'
  /** The 10s reserve→dial lease lapsed before the dial went out. */
  | 'reservation_expired'
  /** The agent hung up. */
  | 'agent_hangup'
  /** The customer hung up. */
  | 'remote_hangup'
  /** A supervisor or the campaign lifecycle took the attempt away. */
  | 'campaign_paused'
  | 'campaign_stopped'
  | 'supervisor_released'
  /** The reaper found the attempt stranded by a crash. */
  | 'orphaned'
  /**
   * The customer rang in while the dial still rang them (docs/inbound.md §5.4): the dial was
   * cancelled, the contact goes back uncharged, and this agent, who had the contact's panel, is
   * offered the inbound call. No disposition expected.
   */
  | 'inbound_call';

/** Authoritative agent-state transition. The console must not infer state. */
export interface AgencyStationAgentStateFrame {
  event: 'agent_state';
  state: AgencyAgentState;
  /** Present when `state` is `break`. */
  break_reason?: string;
  /** ISO-8601. */
  since: string;
  /**
   * **P2.** A transition the agent asked for that has been accepted but not yet
   * applied — a break requested while `on_call` takes effect at the end of wrap-up
   *, never mid-conversation.
   *
   * This exists on the *frame* and not only on the HTTP response that queued it
   * because the queue outlives the request: an agent who queues a break and then
   * loses their socket must still see "break pending" when they come back, and a
   * supervisor action could queue one console never issued. `undefined` means
   * nothing is queued — a console that only ever reads the HTTP response will show
   * a stale badge after any reconnect.
   */
  pending_state?: AgencyAgentState;
  /** **P2.** Present when `pending_state` is `break`. */
  pending_break_reason?: string;
}

/**
 * The campaign this agent is working changed state.
 *
 * **Why this is a push frame and not just a field on bootstrap.** `campaign_status`
 * in {@link AgencySessionBootstrap} is delivered once, at join. An agent sitting
 * `available` with no attempt is outside every other frame's reach: `released`
 * only reaches an agent who *had* an attempt taken away. Without this frame, the
 * moment a campaign drains, every idle agent keeps staring at a screen that will
 * never produce another call, believing the engine is still dialing for them.
 *
 * That is not an edge case — **list exhaustion is the normal end of every run**,
 * including a 50-row test list, and it happens with or without a supervisor UI.
 *
 * Emitted by the pacing leader, which is the only thing that knows a campaign has
 * drained, and broadcast to every agent on that campaign.
 */
export interface AgencyStationCampaignStateFrame {
  event: 'campaign_state';
  campaign_id: string;
  status: AgencyCampaignStatus;
  reason: AgencyCampaignChangeReason;
  /**
   * Whether the engine will produce further calls for this agent. The single
   * boolean the console should drive its idle state from — `status` alone forces
   * every client to re-derive the same predicate, and they will disagree.
   */
  dialing: boolean;
  /** Fallback copy for a reason the console does not recognise. */
  message: string;
}

/**
 * Why an agent has nothing to dial right now, so the station can say "Nothing due now" and why
 * instead of a silent wait. On `strict` and `preferred` campaigns it reads the agent's own queue;
 * on `pool` campaigns (agent station BE-5) the campaign's shared one, computed once per campaign:
 *
 *  - `queue_empty`: nothing open is assigned to them (and, in `preferred` mode, nothing in the
 *    pool); on `pool`, nothing open in the campaign;
 *  - `waiting_for_retry`: their open contacts are all scheduled later by the retry policy;
 *  - `callbacks_later`: their open contacts are all callbacks booked for later;
 *  - `outside_calling_hours`: the campaign's calling window is closed now.
 */
export type AgencyQueueIdleReason =
  | 'queue_empty'
  | 'waiting_for_retry'
  | 'callbacks_later'
  | 'outside_calling_hours';

/** An agent's own queue on a `strict` or `preferred` campaign; the campaign's queue on `pool` (BE-5). */
export interface AgencyQueueState {
  /** Whether a contact is due for this agent now. When `true`, `reason` is null. */
  due: boolean;
  reason: AgencyQueueIdleReason | null;
  /** ISO-8601: when this agent's next contact falls due, or null when none is scheduled. */
  next_due_at: string | null;
}

/**
 * This agent's queue changed between due and nothing due (or the reason changed). Sent only on a
 * change, by the pacing leader, which is the only thing that knows: on `strict` and `preferred`
 * campaigns, and (agent station BE-5) on `pool` campaigns too, where it is computed once per
 * campaign per tick and sent to each of its agents. An existing frame, so no capability: every app
 * build already decodes it. The bootstrap's `queue` and the `ready` frame's `queue` carry the
 * state at join and at reconnect.
 */
export interface AgencyStationQueueFrame extends AgencyQueueState {
  event: 'queue';
  campaign_id: string;
}

/**
 * What the dialer is doing for an agent that their screen cannot otherwise show: the campaign
 * dials placed for them that they are not shown unless the customer answers (late binding,
 * `FF_AGENCY_LATE_BINDING`).
 *
 * Without it an idle agent on a late-binding account sees the same "Waiting for a call" whether a
 * customer's phone is ringing for them, nothing is due, or something is stuck. It carries no
 * contact, number or attempt id on purpose: the call is shown only if it is answered (the
 * `reserved` frame), so all this may say is that a dial is ringing and how the recent ones went.
 *
 * The console and the app need not know whether late binding is on. A dial the agent is shown from
 * the start (early binding, every wrap-up redial) never produces this frame, and its panel already
 * says it is ringing.
 */
export interface AgencyDialActivity {
  /**
   * A campaign dial placed for this agent is ringing now (the carrier has taken it), and they
   * will see it only if it is answered. False once it ends unseen (the agent is told nothing
   * else about it). A dial refused before or by the carrier is never announced.
   */
  ringing: boolean;
  /**
   * How many of this agent's hidden dials in a row ended without being answered (rang out, busy,
   * failed or unreachable once the carrier had it), counted since the last campaign call they
   * were shown, which is a `reserved` frame: a client clears it there, and the next frame the
   * server sends starts again from 0. An inbound or soft-phone call does not reset it. Not
   * counted: a dial refused before or by the carrier (never announced at all), one ended because
   * the agent's station stayed gone, and one the customer cancelled by ringing in themselves
   * (docs/inbound.md §5.4). Held in the server's memory only, so a restart starts it from 0.
   */
  unanswered_in_a_row: number;
}

/**
 * A hidden dial for this agent started (`ringing: true`) or ended unanswered (`ringing: false`).
 * Sent by the dialer to that agent's socket only, never broadcast: two frames at most per dial.
 * The `ready` frame's `dial_activity` carries the same state at reconnect.
 */
export interface AgencyStationDialActivityFrame extends AgencyDialActivity {
  event: 'dial_activity';
  campaign_id: string;
}

/**
 * Why the campaign changed state. `status` alone is not enough: `paused` by a
 * supervisor and `paused` by the Phase 4 abandonment guardrail are the same status
 * and very different messages to a human, and they will coexist.
 */
export type AgencyCampaignChangeReason =
  /** Every contact is done. The normal end of a run. */
  | 'list_exhausted'
  | 'paused_by_supervisor'
  | 'stopped_by_supervisor'
  /** Phase 4: the rolling abandonment ceiling tripped. */
  | 'auto_paused'
  | 'resumed'
  | 'started';

export interface AgencyStationPongFrame {
  event: 'pong';
  /** Echoed from `ping.ts` when the client sent one. */
  ts?: number;
  /**
   * Server clock at the instant the `ping` ARRIVED, epoch ms — not when the pong
   * was sent. The console derives its clock offset as `server_ts - (ts + rtt/2)`
   * with `rtt` measured entirely client-side, so anything stamped later than
   * arrival over-states the offset by however long the server took to answer. That
   * is a primary-key read plus a Redis read on the ordinary path, and the whole
   * station setup for the ping a console fires the moment its socket opens.
   */
  server_ts: number;
}

/** A control frame was rejected. Never fatal on its own; the socket stays open. */
export interface AgencyStationErrorFrame {
  event: 'error';
  code: AgencyStationErrorCode;
  message: string;
}

export type AgencyStationErrorCode =
  | 'unauthorized'
  | 'unknown_attempt'
  /** The caller is not the reserved agent for that attempt. */
  | 'not_your_attempt'
  | 'invalid_frame'
  | 'campaign_not_running';

/**
 * ── Bridge-originated. NOT generated by the agency layer. ──
 *
 * `WebRtcBridgeManager` emits these onto the borrowed station socket for the
 * duration of an attempt (`notifyBrowser`). They are relayed unchanged. Treat them
 * as diagnostic: `bridged` / `released` above are the authoritative agency
 * signals, and a console that drives its UI from `status`/`ended` will be subtly
 * wrong, because they describe the *media leg*, not the *attempt*.
 */
export interface AgencyStationBridgeStatusFrame {
  event: 'status';
  status:
    | 'initiating' | 'ringing' | 'in_progress' | 'completed'
    | 'failed' | 'no_answer' | 'busy' | 'canceled'
    | 'answered' | 'ending';
}

/** Bridge-originated media teardown. See the note on the status frame. */
export interface AgencyStationBridgeEndedFrame {
  event: 'ended';
  reason: string;
}

/**
 * `POST /api/v1/agency/sessions/:id/station-token` — mint a fresh upgrade token.
 *
 * Deliberately cheap and separate from bootstrap: a reconnect needs a new token,
 * not the whole campaign config again. Safe to call before every connect attempt.
 */
export interface AgencyStationTokenResponse {
  session_id: string;
  /** RELATIVE path with the token appended, as on `AgencySessionBootstrap.station_ws_url`. */
  station_ws_url: string;
  /** ISO-8601. Single-use, and short — see `station_token_expires_at`. */
  expires_at: string;
}

/**
 * Close codes the dialer runtime uses on the station socket: its own in the private-use
 * range, and the two standard ones it also sends. The one declaration: the server
 * closes with these names and the clients switch on them.
 *
 * The distinction that matters to the console is **re-mint and retry** versus
 * **re-bootstrap**: retrying a dead session forever looks identical to a network
 * problem from the agent's side, and gives them nothing to act on.
 *
 * The two RFC 6455 codes the station also closes with (1008, 1011) are listed too, so a
 * client can tell them from an ordinary drop. Any code not listed here is an ordinary
 * drop: re-mint and retry.
 */
export const AGENCY_STATION_CLOSE = {
  /** Token missing, expired, already used, or wrong. Re-mint and retry. */
  TOKEN_REJECTED: 4401,
  /** Session unknown or already left. Re-bootstrap; do not retry this session. */
  SESSION_GONE: 4404,
  /**
   * No client `ping` for `heartbeat_grace_ms`. Re-mint and retry.
   *
   * Mirrors HTTP 408 as the neighbours mirror 401/404/409. It is the enforcement
   * of a field this contract has always advertised, and it exists so that an
   * orphaned socket has a recovery path: a console whose heartbeat timer died
   * while its socket stayed open is, from the station handler's side, indistinguishable from an
   * agent who walked away — and until something closed it, nothing made the
   * console notice. A client that does not recognise the code must fall through to
   * its ordinary retry, which is what makes this safe to ship ahead of any console
   * change.
   *
   * Also sent, with reason `station_send_backlog`, when the station has stopped READING:
   * its unread backlog of server frames passed the server's cap (1 MiB; media past ~3 s
   * of backlog is dropped first, control frames never). The same "the server stopped
   * hearing from this station" in the other direction, with the same answer: re-mint and
   * reconnect, and `ready` carries the state again.
   */
  HEARTBEAT_TIMEOUT: 4408,
  /** Superseded by a newer socket for the same session. Do not retry. */
  SUPERSEDED: 4409,
  /**
   * RFC 6455 policy violation: the upgrade itself was refused before the station
   * handler ran. A `client=` or `media=` this server does not speak (the close reason
   * says which: `invalid_client` / `invalid_media`), or a session id that would escape
   * the station path. **Do not retry**: the same upgrade is refused again, and a fresh
   * token does not change it (the token is not consumed).
   */
  INVALID_UPGRADE: 1008,
  /**
   * RFC 6455 internal error: the server could not run the station handler (no agency
   * runtime). Retryable, but a client should BOUND its retries on this code: unlike a
   * network drop it says the server is up and broken, and retrying forever hides that.
   */
  INTERNAL_ERROR: 1011,
} as const;

/** One of {@link AGENCY_STATION_CLOSE}'s codes. */
export type AgencyStationCloseCode = (typeof AGENCY_STATION_CLOSE)[keyof typeof AGENCY_STATION_CLOSE];
