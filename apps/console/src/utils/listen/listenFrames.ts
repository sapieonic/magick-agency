import {
  AGENCY_LISTEN_CLOSE,
  AGENCY_LISTEN_END_REASONS,
  AGENCY_LISTEN_ERROR_CODES,
  AGENCY_LISTEN_FRAME_BYTES,
  AGENCY_LISTEN_LEG,
  AGENCY_LISTEN_MESSAGE_BYTES,
  type AgencyListenClientFrame,
  type AgencyListenEndReason,
  type AgencyListenErrorCode,
  type AgencyListenLeg,
  type AgencyListenServerFrame,
} from '../../types/live-calls';

/**
 * The listener socket's wire, read (`docs/listening.md` §3, `packages/contracts/src/agency/
 * listen.ts`). Pure and allocation-light: an audio message is a view onto the message's own
 * buffer, never a copy, because fifty of them arrive every second per leg.
 */

/** One audio message: which leg and its 160 bytes of A-law. */
export interface ListenAudioMessage {
  kind: 'audio';
  leg: AgencyListenLeg;
  /** A view of the 160 A-law bytes after the tag byte. */
  frame: Uint8Array;
}

export interface ListenControlMessage {
  kind: 'control';
  frame: AgencyListenServerFrame;
}

export type ListenMessage = ListenAudioMessage | ListenControlMessage;

const LEG_BY_TAG = new Map<number, AgencyListenLeg>(
  (Object.entries(AGENCY_LISTEN_LEG) as [AgencyListenLeg, number][]).map(([leg, tag]) => [tag, leg]),
);

const END_REASONS = new Set<string>(AGENCY_LISTEN_END_REASONS);
const ERROR_CODES = new Set<string>(AGENCY_LISTEN_ERROR_CODES);

function bytesOf(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** An audio message, or null: wrong size, unknown leg. */
export function parseListenAudio(data: unknown): ListenAudioMessage | null {
  const bytes = bytesOf(data);
  if (!bytes || bytes.byteLength !== AGENCY_LISTEN_MESSAGE_BYTES) return null;
  const leg = LEG_BY_TAG.get(bytes[0]!);
  if (!leg) return null;
  return { kind: 'audio', leg, frame: bytes.subarray(1, 1 + AGENCY_LISTEN_FRAME_BYTES) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A text frame, or null. A frame that does not parse, or names an event this side does not know,
 * is ignored (the contract's rule), and so is one whose fields are not what the event needs.
 */
export function parseListenControl(text: string): AgencyListenServerFrame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  switch (raw.event) {
    case 'ready':
      if (typeof raw.listen_id !== 'string' || typeof raw.call_id !== 'string') return null;
      if (raw.format !== 'alaw8' || raw.frame_bytes !== AGENCY_LISTEN_FRAME_BYTES) return null;
      return { event: 'ready', listen_id: raw.listen_id, call_id: raw.call_id, format: 'alaw8', frame_bytes: raw.frame_bytes };
    case 'ended':
      if (typeof raw.reason !== 'string' || !END_REASONS.has(raw.reason)) return null;
      return { event: 'ended', reason: raw.reason as AgencyListenEndReason };
    case 'pong':
      if (typeof raw.server_ts !== 'number' || !Number.isFinite(raw.server_ts)) return null;
      return typeof raw.ts === 'number' ? { event: 'pong', ts: raw.ts, server_ts: raw.server_ts } : { event: 'pong', server_ts: raw.server_ts };
    default:
      return null;
  }
}

/** Any message on the socket: binary is audio, text is control. Null for anything else. */
export function parseListenMessage(data: unknown): ListenMessage | null {
  if (typeof data === 'string') {
    const frame = parseListenControl(data);
    return frame ? { kind: 'control', frame } : null;
  }
  return parseListenAudio(data);
}

/** A client frame, serialised. */
export function encodeListenClientFrame(frame: AgencyListenClientFrame): string {
  return JSON.stringify(frame);
}

/**
 * What the console does when the socket closes (`docs/listening.md` §3, the close table):
 *  - `call_ended`: the call ended, or the upgrade found it gone: "Call ended";
 *  - `stopped`: the supervisor stopped (our own `stop`);
 *  - `revoked`: "You no longer have access to listen to calls.";
 *  - `superseded`: "Listening moved to another call.";
 *  - `refused`: a cap or a malformed upgrade refused the attach; `code` says which;
 *  - `remint`: the token was refused: mint a fresh grant now;
 *  - `reconnect`: any other drop: re-mint and reconnect within the window;
 *  - `internal`: the tap detached or the session could not open: reconnect, bounded.
 */
export type ListenCloseOutcome =
  | { kind: 'call_ended' }
  | { kind: 'stopped' }
  | { kind: 'revoked' }
  | { kind: 'superseded' }
  | { kind: 'refused'; code: AgencyListenErrorCode | null }
  | { kind: 'remint' }
  | { kind: 'reconnect' }
  | { kind: 'internal' };

/** The close code and reason → what to do. Any code not in the contract is an ordinary drop. */
export function listenCloseOutcome(code: number, reason: string): ListenCloseOutcome {
  const errorCode = ERROR_CODES.has(reason) ? (reason as AgencyListenErrorCode) : null;
  switch (code) {
    case AGENCY_LISTEN_CLOSE.NORMAL:
      return reason === 'listener_stopped' ? { kind: 'stopped' } : { kind: 'call_ended' };
    case AGENCY_LISTEN_CLOSE.FORBIDDEN:
      return { kind: 'revoked' };
    case AGENCY_LISTEN_CLOSE.CALL_GONE:
      return { kind: 'call_ended' };
    case AGENCY_LISTEN_CLOSE.SUPERSEDED:
      return { kind: 'superseded' };
    case AGENCY_LISTEN_CLOSE.LIMIT:
      return { kind: 'refused', code: errorCode };
    case AGENCY_LISTEN_CLOSE.INVALID_UPGRADE:
      return { kind: 'refused', code: null };
    case AGENCY_LISTEN_CLOSE.TOKEN_REJECTED:
      return { kind: 'remint' };
    case AGENCY_LISTEN_CLOSE.INTERNAL_ERROR:
      return { kind: 'internal' };
    default:
      return { kind: 'reconnect' };
  }
}

/**
 * The `ended` frame's reasons that end the session for good, whatever close follows: the console
 * moves on them at once rather than waiting for the close. The others (`server_shutdown`,
 * `send_backlog`, `listener_disconnected`, `tap_error`) are drops it recovers from on the close.
 */
export function terminalEndReason(reason: AgencyListenEndReason): ListenCloseOutcome | null {
  switch (reason) {
    case 'call_ended':
      return { kind: 'call_ended' };
    case 'listener_stopped':
      return { kind: 'stopped' };
    case 'permission_revoked':
      return { kind: 'revoked' };
    case 'superseded':
      return { kind: 'superseded' };
    default:
      return null;
  }
}
