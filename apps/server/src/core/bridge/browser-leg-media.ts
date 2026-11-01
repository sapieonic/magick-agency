// The browser leg's media format: what the agent's socket speaks, and the small pieces
// the bridge needs to relay `alaw8` (contracts `AgencyStationMediaFormat`). Part of the
// voice engine → dialer runtime seam (docs/seams.md §3.1): the station socket tags its
// socket here at upgrade, and the bridge reads the tag at every attach.
import type WebSocket from 'ws';
import {
  AGENCY_STATION_ALAW8_FRAME_BYTES,
  AGENCY_STATION_ALAW8_MAX_FRAME_BYTES,
  type AgencyStationMediaFormat,
} from '@magick-agency/contracts/agency';

/** The agent leg's audio format. One vocabulary with the station contract. */
export type BrowserLegMediaFormat = AgencyStationMediaFormat;

export const ALAW8_FRAME_BYTES = AGENCY_STATION_ALAW8_FRAME_BYTES;
export const ALAW8_MAX_FRAME_BYTES = AGENCY_STATION_ALAW8_MAX_FRAME_BYTES;

/**
 * Each socket's format, keyed by the socket itself.
 *
 * On the socket rather than threaded through `createBridgedCall` / `bindBorrowedBrowserLeg`
 * / `reattachBorrowedBrowserLeg` because it IS a property of the socket — fixed by its
 * upgrade query for its whole life — and every attach path already holds the socket. A
 * parameter would be one more thing each caller could pair with the wrong socket; the
 * tag cannot disagree with the socket it describes, and a re-attach onto a reconnected
 * socket picks up that socket's format with no extra step. A read is a synchronous map
 * lookup, so the late-binding bind path stays synchronous. Weak, so a closed socket
 * takes its entry with it.
 */
const formats = new WeakMap<WebSocket, BrowserLegMediaFormat>();

/** Record a socket's media format. Called once, at the upgrade that chose it. */
export function setBrowserLegMediaFormat(ws: WebSocket, format: BrowserLegMediaFormat): void {
  formats.set(ws, format);
}

/** A socket's media format; `pcm16` for a socket nobody tagged (the contract default). */
export function browserLegMediaFormatOf(ws: WebSocket): BrowserLegMediaFormat {
  return formats.get(ws) ?? 'pcm16';
}

/**
 * Is `bytes` an acceptable client → server `alaw8` message: a non-zero whole number of
 * 20 ms frames, at most 1 s? The ceiling is checked on the length alone, before any
 * work, so an abusive frame drives no allocation.
 */
export function isAcceptableAlawMessage(bytes: number): boolean {
  return bytes > 0 && bytes <= ALAW8_MAX_FRAME_BYTES && bytes % ALAW8_FRAME_BYTES === 0;
}

/**
 * Normalize a `ws` binary message to one Buffer. The station socket keeps `ws`'s default
 * `binaryType` ('nodebuffer'), so this is the identity in practice; the other shapes are
 * handled rather than assumed away.
 */
export function rawDataToBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Cuts server → client `alaw8` audio into exactly-20 ms messages (the contract's framing).
 *
 * The carrier's frames are already 20 ms in practice, so the usual case emits the input
 * as is and allocates nothing; a larger frame is emitted as `subarray` views of it (no
 * copy). Only a carrier frame that is not a whole number of 20 ms frames leaves a
 * remainder, which waits for the next frame — the one case that copies.
 */
export class AlawFramer {
  private carry: Buffer | null = null;

  push(alaw: Buffer, emit: (frame: Buffer) => void): void {
    let buf = alaw;
    if (this.carry) {
      buf = Buffer.concat([this.carry, alaw]);
      this.carry = null;
    }
    const whole = buf.length - (buf.length % ALAW8_FRAME_BYTES);
    if (whole === buf.length && whole === ALAW8_FRAME_BYTES) {
      emit(buf);
      return;
    }
    for (let off = 0; off < whole; off += ALAW8_FRAME_BYTES) emit(buf.subarray(off, off + ALAW8_FRAME_BYTES));
    // A copy, so a sub-frame tail does not pin the whole source buffer until the next frame.
    if (whole < buf.length) this.carry = Buffer.from(buf.subarray(whole));
  }

  /** Bytes held back for the next frame (always fewer than one frame). */
  get pending(): number {
    return this.carry?.length ?? 0;
  }

  /** Drop any held-back tail: a new socket starts on a frame boundary. */
  reset(): void {
    this.carry = null;
  }
}
