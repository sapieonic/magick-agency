/**
 * Live call listening (`docs/listening.md`, decisions LS1–LS14): a supervisor listens in silently
 * to a call in progress in their account, from the console. Listen only: no whisper, no barge.
 * The audio is forked from our own WebRTC bridge, in the process that owns the call; the carrier
 * is not involved, and a slow, failing or dropped listener never touches the agent's or the
 * customer's audio. Types and `as const` lists only, like the rest of this barrel.
 *
 * ── The listener socket ─────────────────────────────────────────────────────
 * `GET /proxy/agency/listen/:sessionId/:listenId?token=…` (WebSocket), opened with the `ws_url` of
 * an `AgencyListenGrant` (`../api/agency/live-calls.ts`). The token is single-use and short-lived
 * (`AGENCY_LISTEN_TOKEN_TTL_MS` on the server, 60 s by default); every reconnect mints a fresh grant,
 * and each attach is its own audited session (`agency_listen_sessions`, `0047_listen_sessions.sql`).
 *
 *  - **Binary** messages are audio, server → client only: one tag byte (an
 *    {@link AGENCY_LISTEN_LEG} value: which leg) followed by exactly
 *    {@link AGENCY_LISTEN_FRAME_BYTES} bytes of G.711 A-law, 8 kHz mono (20 ms). Both legs arrive
 *    as their own messages, interleaved; nothing is mixed on the server. A binary message from the
 *    client is ignored.
 *  - **Text** messages are JSON control frames with an `event` discriminant:
 *    {@link AgencyListenServerFrame} one way, {@link AgencyListenClientFrame} the other. A text
 *    frame that does not parse, or names an event this side does not know, is ignored.
 *
 * Every list here that a column stores is held equal to its CHECK by
 * `packages/db/test/integration/db/listen-sessions-migration.test.ts`.
 */

// ─── The call ────────────────────────────────────────────────────────────────

/**
 * Where a call came from: `agency_calls.origin` (`ck_agency_calls_origin`; `0005_softphone.sql`,
 * `0024_inbound.sql`), copied onto each listen session. `campaign`: a dialler call (its spine row
 * is an `agency_call_attempts` row); `manual`: a soft-phone call (`agency_manual_calls`);
 * `inbound`: a customer who rang a linked number (`agency_inbound_calls`).
 */
export const AGENCY_CALL_ORIGINS = ['campaign', 'manual', 'inbound'] as const;
export type AgencyCallOrigin = (typeof AGENCY_CALL_ORIGINS)[number];

// ─── Wire format ─────────────────────────────────────────────────────────────

/**
 * The leg an audio message carries, as its first byte: the customer (the carrier's media stream)
 * or the agent (their station socket). The browser plays each leg through its own gain and level
 * meter, so a supervisor can mute either.
 */
export const AGENCY_LISTEN_LEG = {
  customer: 1,
  agent: 2,
} as const;

/** A leg's name. */
export type AgencyListenLeg = keyof typeof AGENCY_LISTEN_LEG;

/** A leg's tag byte. */
export type AgencyListenLegTag = (typeof AGENCY_LISTEN_LEG)[AgencyListenLeg];

/** The audio format of every listener message (`ready.format`): G.711 A-law, 8 kHz mono. */
export type AgencyListenFormat = 'alaw8';

/** One 20 ms frame of A-law at 8 kHz: the audio after the tag byte (the station's `alaw8` frame). */
export const AGENCY_LISTEN_FRAME_BYTES = 160;

/** One binary listener message: the tag byte and one frame. */
export const AGENCY_LISTEN_MESSAGE_BYTES = 1 + AGENCY_LISTEN_FRAME_BYTES;

/** How often the console sends `ping` while it listens. */
export const AGENCY_LISTEN_PING_INTERVAL_MS = 10_000;

/**
 * No client frame for this long and the server ends the session `listener_disconnected`
 * ({@link AGENCY_LISTEN_CLOSE}.HEARTBEAT_TIMEOUT): three missed pings.
 */
export const AGENCY_LISTEN_IDLE_TIMEOUT_MS = 30_000;

/**
 * How long the console keeps re-minting and reconnecting after a drop it may retry before it
 * shows "Connection lost". Each attach is its own session row and its own audit pair.
 */
export const AGENCY_LISTEN_RECONNECT_WINDOW_MS = 15_000;

// ─── Control frames ──────────────────────────────────────────────────────────

/** Frames the console sends on the listener socket. */
export type AgencyListenClientFrame = AgencyListenPingFrame | AgencyListenStopFrame;

/** Liveness, every {@link AGENCY_LISTEN_PING_INTERVAL_MS}. Answered with `pong`. */
export interface AgencyListenPingFrame {
  event: 'ping';
  /** Client clock, epoch ms. Echoed in `pong`. Optional. */
  ts?: number;
}

/** The supervisor stopped listening: the session ends `listener_stopped` and the socket closes 1000. */
export interface AgencyListenStopFrame {
  event: 'stop';
}

/** Frames the server sends on the listener socket. */
export type AgencyListenServerFrame = AgencyListenReadyFrame | AgencyListenEndedFrame | AgencyListenPongFrame;

/**
 * The session is open: its row is written, the tap is attached, and audio follows. Sent once,
 * first. Nothing is played before it.
 */
export interface AgencyListenReadyFrame {
  event: 'ready';
  /** The session (`agency_listen_sessions.id`), as in the grant. */
  listen_id: string;
  /** The call listened to (`agency_calls.id`). */
  call_id: string;
  format: AgencyListenFormat;
  /** Audio bytes after the tag byte in every binary message: {@link AGENCY_LISTEN_FRAME_BYTES}. */
  frame_bytes: number;
}

/**
 * The session ended, and why. Sent once, last, just before the server closes the socket with
 * {@link AGENCY_LISTEN_END_CLOSE}'s code for the reason. A socket that closes without it (a
 * network drop) ended `listener_disconnected`.
 */
export interface AgencyListenEndedFrame {
  event: 'ended';
  reason: AgencyListenEndReason;
}

/** The answer to `ping`. */
export interface AgencyListenPongFrame {
  event: 'pong';
  /** Echoed from `ping.ts` when the client sent one. */
  ts?: number;
  /** Server clock when the `ping` arrived, epoch ms. */
  server_ts: number;
}

// ─── How a session ends ──────────────────────────────────────────────────────

/**
 * Why a listen session ended (`agency_listen_sessions.end_reason`, CHECKed; the `ended` frame's
 * `reason`; `agency_listen_sessions_ended_total{reason}`):
 *
 *  - `call_ended`: the call ended (the bridge session was destroyed);
 *  - `listener_stopped`: the supervisor pressed Stop (a `stop` frame);
 *  - `listener_disconnected`: the socket closed without a `stop`, or sent nothing for
 *    {@link AGENCY_LISTEN_IDLE_TIMEOUT_MS};
 *  - `permission_revoked`: the supervisor's role changed or their membership was removed, or the
 *    periodic re-check found them below `agency.calls.listen`, or one of the flags off;
 *  - `superseded`: the same supervisor started another listen (one at a time per supervisor);
 *  - `send_backlog`: the supervisor's socket stopped reading (its unsent backlog passed the hard
 *    cap);
 *  - `tap_error`: the tap failed too many frames in a row and detached itself; the call carries on;
 *  - `server_shutdown`: the process that owned the call is stopping;
 *  - `server_restarted`: the session was still open when its process died; closed at the next
 *    boot (or when the primary reaped the dead media worker), never sent on a socket.
 */
export const AGENCY_LISTEN_END_REASONS = [
  'call_ended',
  'listener_stopped',
  'listener_disconnected',
  'permission_revoked',
  'superseded',
  'send_backlog',
  'tap_error',
  'server_shutdown',
  'server_restarted',
] as const;
export type AgencyListenEndReason = (typeof AGENCY_LISTEN_END_REASONS)[number];

/**
 * Close codes on the listener socket: the private-use codes, as the station's mirror HTTP
 * (401, 403, 404, 408, 409, 429), and the RFC 6455 ones it also sends. The one declaration: the
 * server closes with these names and the console switches on them. The distinction that matters
 * to the console is **reconnect** (re-mint a grant, within {@link AGENCY_LISTEN_RECONNECT_WINDOW_MS})
 * versus **stop** (say why and offer nothing to retry). Any code not listed here is an ordinary
 * drop: reconnect.
 *
 * A refusal at the upgrade (before `ready`) closes with the code and a `reason` that is the
 * refusal's error code (`../errors.ts` §7: `listen_call_not_live`, `listen_limit_call`, …), so the
 * listening bar can say why. After `ready`, the `reason` is the end reason.
 */
export const AGENCY_LISTEN_CLOSE = {
  /** The session ended: the call ended (`call_ended`), or the supervisor stopped (`listener_stopped`). Do not reconnect. */
  NORMAL: 1000,
  /** The process is stopping (`server_shutdown`). Reconnect: a fresh grant reaches whichever process owns the call. */
  GOING_AWAY: 1001,
  /** Token missing, expired, already used, or not this listen's. Re-mint and retry. */
  TOKEN_REJECTED: 4401,
  /** The supervisor may no longer listen (`permission_revoked`), or may not open this listen. Do not retry. */
  FORBIDDEN: 4403,
  /** At the upgrade: the call is no longer live and bridged in this process, or its agent's session is gone (`listen_call_not_live`). Do not retry. */
  CALL_GONE: 4404,
  /** No client frame for {@link AGENCY_LISTEN_IDLE_TIMEOUT_MS} (`listener_disconnected`), or the socket stopped reading (`send_backlog`). Reconnect. */
  HEARTBEAT_TIMEOUT: 4408,
  /** The same supervisor started another listen (`superseded`). Do not retry. */
  SUPERSEDED: 4409,
  /** At the upgrade: a cap refused the attach (`listen_limit_call`, `listen_limit_server`). Do not retry. */
  LIMIT: 4429,
  /** RFC 6455 policy violation: the upgrade itself was malformed (an id that is not a UUID). Do not retry. */
  INVALID_UPGRADE: 1008,
  /**
   * RFC 6455 internal error: the tap detached itself (`tap_error`), or the server could not open
   * the session (`listen_unavailable`: no row, no audio). Reconnect, but bound the retries.
   */
  INTERNAL_ERROR: 1011,
} as const;

/** One of {@link AGENCY_LISTEN_CLOSE}'s codes. */
export type AgencyListenCloseCode = (typeof AGENCY_LISTEN_CLOSE)[keyof typeof AGENCY_LISTEN_CLOSE];

/**
 * The code the server closes with after `ended { reason }`, for every reason sent on a socket
 * (the `satisfies` makes a reason added to the list without a code a type error).
 * `server_restarted` is never sent (its process is gone); a `listener_disconnected` socket the
 * client closed itself is not closed again.
 */
export const AGENCY_LISTEN_END_CLOSE = {
  call_ended: AGENCY_LISTEN_CLOSE.NORMAL,
  listener_stopped: AGENCY_LISTEN_CLOSE.NORMAL,
  listener_disconnected: AGENCY_LISTEN_CLOSE.HEARTBEAT_TIMEOUT,
  permission_revoked: AGENCY_LISTEN_CLOSE.FORBIDDEN,
  superseded: AGENCY_LISTEN_CLOSE.SUPERSEDED,
  send_backlog: AGENCY_LISTEN_CLOSE.HEARTBEAT_TIMEOUT,
  tap_error: AGENCY_LISTEN_CLOSE.INTERNAL_ERROR,
  server_shutdown: AGENCY_LISTEN_CLOSE.GOING_AWAY,
} as const satisfies Record<Exclude<AgencyListenEndReason, 'server_restarted'>, AgencyListenCloseCode>;
