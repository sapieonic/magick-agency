// Send-side back-pressure for the server's WebSockets: what to do when a peer stops reading.
// Used by every path that writes to an agent's station socket (the station registry's `send`
// and `broadcast`, and the bridge's relay and status frames on the borrowed browser leg) and
// by the bridge's media relay to the carrier.
//
// `ws.send` never blocks and never refuses: a frame the kernel will not take is queued in
// process memory (`ws.bufferedAmount`), without limit. A console that stops draining its
// socket (a frozen tab, a laptop lid half shut, a path that has silently died) mid-call is
// written to at the media rate for as long as the call lasts, and the heartbeat sweep does not
// close a web console mid-call. So, measured on `bufferedAmount` before each write:
//
//  - **Media past a soft limit is dropped.** Audio is real time: a frame that would sit behind
//    seconds of backlog is heard late or never, so the backlog is capped at about 3 s of the
//    leg's own audio and the excess is thrown away (and counted). The limit is per format,
//    because a second of `pcm16` JSON is about five times a second of `alaw8` binary.
//  - **Control frames are never dropped.** `reserved`, `agent_state`, `wrapup`, `status`,
//    `ended` and the rest are sent whatever the backlog, so a console that resumes reading
//    receives every one, in order.
//  - **Past a hard cap the station socket is closed.** Media cannot reach it (it is dropped
//    at the soft limit), so only control frames a console has not read for a long time can:
//    the console is not reading. It is closed with 4408 (`AGENCY_STATION_CLOSE
//    .HEARTBEAT_TIMEOUT`, reason `station_send_backlog`): "the server stopped hearing from
//    this station; re-mint and retry", which both clients already do for 4408 and for any
//    code they do not know. The reconnect's `ready` frame carries the full state, so nothing
//    a control frame said is lost; a live call gets the bridge's usual station-close grace.
//    The close frame queues behind the backlog a stalled peer is not reading, so the socket
//    is terminated if it has not closed {@link BACKLOG_CLOSE_TERMINATE_MS} later (`ws` would
//    otherwise hold it, and its buffer, for its own 30 s close timeout).
//
// The carrier's socket has a soft limit and no hard cap: closing VoiceLink's media stream is
// its hang-up, so a slow carrier loses stale audio, never the call.
import type WebSocket from 'ws';
import { AGENCY_STATION_CLOSE } from '@magick-agency/contracts/agency';

/** `ws`'s `readyState` for an open socket. */
const OPEN = 1;
/** `ws`'s `readyState` for a closed socket. */
const CLOSED = 3;

export interface BackpressureLimits {
  /** Above this many buffered bytes a media frame is dropped. */
  readonly mediaSoftLimitBytes: number;
  /** Above this many buffered bytes the socket is over its cap (station: closed). Null: no cap. */
  readonly hardCapBytes: number | null;
}

/**
 * Hard cap for an agent's station socket: 1 MiB. A station's control frames are hundreds of
 * bytes and a console that reads is never more than a handful behind; media stops at its soft
 * limit (at most 128 KiB). Reaching 1 MiB takes thousands of unread control frames on top of
 * that. Bounds a stalled console at about 1 MiB of server memory, where it was unbounded.
 */
export const STATION_SEND_HARD_CAP_BYTES = 1024 * 1024;

/**
 * `pcm16` station socket: 128 KiB, about 3 s of audio. A 20 ms frame is 856 base64
 * characters plus the 40-character envelope and the frame header, ~900 bytes, 50 a second:
 * ~45 KB/s.
 */
export const STATION_PCM16_LIMITS: BackpressureLimits = {
  mediaSoftLimitBytes: 128 * 1024,
  hardCapBytes: STATION_SEND_HARD_CAP_BYTES,
};

/**
 * `alaw8` station socket: 24 KiB, about 3 s of audio. One 20 ms binary message is 160 bytes
 * plus a 2-byte header, 50 a second: ~8.1 KB/s.
 */
export const STATION_ALAW8_LIMITS: BackpressureLimits = {
  mediaSoftLimitBytes: 24 * 1024,
  hardCapBytes: STATION_SEND_HARD_CAP_BYTES,
};

/**
 * The carrier's media stream (VoiceLink, A-law 8 kHz as Twilio-shaped JSON): 40 KiB, about
 * 3 s. A 20 ms frame is 216 base64 characters plus ~40 of envelope and the header, ~260 bytes,
 * 50 a second: ~13 KB/s. No hard cap: closing the stream hangs up the call.
 */
export const CARRIER_MEDIA_LIMITS: BackpressureLimits = {
  mediaSoftLimitBytes: 40 * 1024,
  hardCapBytes: null,
};

/** How long a station closed for its backlog may take to close before it is terminated. */
export const BACKLOG_CLOSE_TERMINATE_MS = 5_000;

/** The close reason sent with 4408 when a station is closed for its send backlog. */
export const STATION_SEND_BACKLOG_REASON = 'station_send_backlog';

/**
 * What to do with the next frame for `ws`, from its current backlog. Decided before the
 * frame is serialised, so a dropped frame costs no `JSON.stringify`.
 *
 *  - `not_open`: the socket is closing or closed; send nothing.
 *  - `over_cap`: the backlog is past `hardCapBytes`; send nothing (a station is then closed
 *    with {@link closeForSendBacklog}).
 *  - `drop`: a media frame past `mediaSoftLimitBytes`; send nothing, count it.
 *  - `send`: write it.
 */
export type SendVerdict = 'send' | 'drop' | 'over_cap' | 'not_open';

export function sendVerdict(
  ws: Pick<WebSocket, 'readyState' | 'bufferedAmount'>,
  frame: { media: boolean },
  limits: BackpressureLimits,
): SendVerdict {
  if (ws.readyState !== OPEN) return 'not_open';
  // `?? 0`: a test double without the field is a socket with nothing queued.
  const buffered = ws.bufferedAmount ?? 0;
  if (limits.hardCapBytes !== null && buffered > limits.hardCapBytes) return 'over_cap';
  if (frame.media && buffered > limits.mediaSoftLimitBytes) return 'drop';
  return 'send';
}

/**
 * Close a station socket whose peer has stopped reading: 4408 with
 * {@link STATION_SEND_BACKLOG_REASON}, then `terminate` if it has not closed within
 * {@link BACKLOG_CLOSE_TERMINATE_MS}. Returns false when the socket was not open (another
 * path is already closing it), so a caller counts each close once. Never throws.
 */
export function closeForSendBacklog(ws: WebSocket): boolean {
  if (ws.readyState !== OPEN) return false;
  try {
    ws.close(AGENCY_STATION_CLOSE.HEARTBEAT_TIMEOUT, STATION_SEND_BACKLOG_REASON);
  } catch {
    // Fall through to the terminate.
  }
  const timer = setTimeout(() => {
    try {
      if (ws.readyState !== CLOSED) ws.terminate();
    } catch { /* already gone */ }
  }, BACKLOG_CLOSE_TERMINATE_MS);
  timer.unref?.();
  return true;
}
