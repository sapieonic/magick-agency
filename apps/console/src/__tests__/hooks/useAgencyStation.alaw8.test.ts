import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { AgencyStationMediaFormat } from '@magick-agency/contracts/agency';

const mocks = vi.hoisted(() => ({ mintStationToken: vi.fn() }));
vi.mock('../../api/agency', () => ({ mintStationToken: mocks.mintStationToken }));

import { useAgencyStation, type AgencyStationAudioSink } from '../../hooks/useAgencyStation';
import type { AgencySessionBootstrap } from '../../types/agency';

/**
 * **`media=alaw8` on the station socket** (contracts `AgencyStationMediaFormat`).
 *
 * The socket's format is chosen at the upgrade and everything audio on it must agree
 * with it, because the server drops a mismatch without a word: a JSON `media` frame on
 * an `alaw8` socket, a binary one on `pcm16`, a binary message that is not a whole
 * number of 160-byte frames. Each of those is a call that connects and carries no
 * voice, so each is pinned here at the hook that owns the socket:
 *
 *  - the upgrade names the format, and binary arrives as `ArrayBuffer`;
 *  - `sendMedia` sends A-law as binary, and refuses anything the server would drop;
 *  - binary downlink reaches the sink, unlogged, and only on an `alaw8` socket;
 *  - a server that will not do `alaw8` (1008 `invalid_media`, or JSON media on an
 *    `alaw8` socket) turns the station to `pcm16` for good, which every server speaks.
 */

class FakeSocket {
  static instances: FakeSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = 0;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<string | ArrayBuffer> = [];

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  emitBinary(data: unknown): void {
    this.onmessage?.({ data });
  }
  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  /** What went out other than heartbeats. */
  get media(): Array<string | ArrayBuffer> {
    return this.sent.filter((f) => typeof f !== 'string' || !f.includes('"ping"'));
  }
}

const BOOTSTRAP: AgencySessionBootstrap = {
  session_id: 'sess-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  agent_user_id: 'u-1',
  state: 'offline',
  campaign_status: 'running',
  station_ws_url: '/proxy/agency/station/sess-1?token=t1',
  disposition_catalog: [],
  wrapup_seconds: 0,
  wrapup_auto_return: true,
  record_calls: false,
  break_reasons: [],
  context_display: {},
  intervals: {
    heartbeat_ms: 10_000,
    heartbeat_grace_ms: 30_000,
    reservation_lease_ms: 10_000,
    countdown_ms: 3000,
  },
};

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;
const frames = (n: number) => new Uint8Array(160 * n).fill(0xd5).buffer;

describe('the station socket in media=alaw8', () => {
  let alaw: ArrayBuffer[];
  let json: string[];
  let sink: AgencyStationAudioSink;
  // Unmounted by hand: this repo runs Vitest without globals, so RTL's auto-cleanup
  // does not, and a station left mounted opens sockets inside the next test.
  const mounted_: Array<{ unmount: () => void }> = [];

  beforeEach(() => {
    FakeSocket.instances = [];
    mocks.mintStationToken.mockReset();
    mocks.mintStationToken.mockResolvedValue({
      session_id: 'sess-1',
      station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
      expires_at: 'x',
    });
    alaw = [];
    json = [];
    sink = { onMedia: (p) => json.push(p), onAlaw: (b) => alaw.push(b) };
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    mounted_.splice(0).forEach((view) => view.unmount());
    vi.unstubAllGlobals();
  });

  async function mounted(mediaFormat?: AgencyStationMediaFormat) {
    const view = renderHook(() =>
      useAgencyStation(BOOTSTRAP, mediaFormat ? { audio: sink, mediaFormat } : { audio: sink }),
    );
    mounted_.push(view);
    await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    act(() => latest().open());
    await waitFor(() => expect(view.result.current.connection).toBe('open'));
    return view;
  }

  describe('the upgrade', () => {
    it('names media=alaw8 next to the token, and reads binary as ArrayBuffer', async () => {
      const view = await mounted('alaw8');
      expect(latest().url).toMatch(/\/proxy\/agency\/station\/sess-1\?token=t1&media=alaw8$/);
      expect(latest().binaryType).toBe('arraybuffer');
      expect(view.result.current.mediaFormat).toBe('alaw8');
    });

    it('names media=pcm16 when asked for pcm16 (the flag off), and by default', async () => {
      const off = await mounted('pcm16');
      expect(latest().url).toMatch(/\?token=t1&media=pcm16$/);
      expect(off.result.current.mediaFormat).toBe('pcm16');
      off.unmount();

      FakeSocket.instances = [];
      const unset = await mounted();
      expect(latest().url).toMatch(/\?token=t1&media=pcm16$/);
      expect(unset.result.current.mediaFormat).toBe('pcm16');
    });

    it('keeps the format on every reconnect, with each fresh token', async () => {
      await mounted('alaw8');
      act(() => latest().serverClose(1006, ''));
      await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 3000 });
      expect(latest().url).toMatch(/\?token=FRESH&media=alaw8$/);
    });
  });

  describe('uplink', () => {
    it('sends A-law as a binary message, the very buffer it was given', async () => {
      const view = await mounted('alaw8');
      const frame = frames(1);
      act(() => {
        expect(view.result.current.sendMedia(frame)).toBe(true);
      });
      expect(latest().media).toEqual([frame]);
    });

    it('accepts any whole number of frames up to one second', async () => {
      const view = await mounted('alaw8');
      expect(view.result.current.sendMedia(frames(2))).toBe(true);
      expect(view.result.current.sendMedia(frames(50))).toBe(true);
      expect(latest().media.map((f) => (f as ArrayBuffer).byteLength)).toEqual([320, 8000]);
    });

    it.each([
      ['empty', 0],
      ['a partial frame', 100],
      ['a frame and a bit', 161],
      ['over one second', 8160],
    ])('refuses %s instead of shipping it into the server’s drop', async (_label, bytes) => {
      const view = await mounted('alaw8');
      expect(view.result.current.sendMedia(new ArrayBuffer(bytes))).toBe(false);
      expect(latest().media).toEqual([]);
    });

    it('never sends a JSON media frame on an alaw8 socket (the server drops them)', async () => {
      const view = await mounted('alaw8');
      expect(view.result.current.sendMedia('QUJD')).toBe(false);
      expect(latest().media).toEqual([]);
    });

    it('never sends binary on a pcm16 socket (the server ignores it)', async () => {
      const view = await mounted('pcm16');
      expect(view.result.current.sendMedia(frames(1))).toBe(false);
      expect(view.result.current.sendMedia('QUJD')).toBe(true);
      expect(latest().media).toEqual(['{"event":"media","media":{"payload":"QUJD"}}']);
    });

    it('reports false while the socket is down', async () => {
      const view = await mounted('alaw8');
      act(() => latest().serverClose(1006, ''));
      await waitFor(() => expect(view.result.current.connection).toBe('reconnecting'));
      expect(view.result.current.sendMedia(frames(1))).toBe(false);
    });
  });

  describe('downlink', () => {
    it('hands each binary frame to the sink, and logs none of them', async () => {
      const view = await mounted('alaw8');
      const sent = Array.from({ length: 50 }, () => frames(1));
      act(() => sent.forEach((f) => latest().emitBinary(f)));
      expect(alaw).toEqual(sent);
      // 50 frames a second: the same rule as JSON media, nothing in the diagnostics.
      expect(view.result.current.diagnostics).toEqual([]);
    });

    it('still parses text frames as JSON control frames', async () => {
      const view = await mounted('alaw8');
      act(() => latest().emit({ event: 'status', status: 'answered' }));
      expect(view.result.current.diagnostics.at(-1)?.event).toBe('status');
    });

    it('drops an empty or oversized binary message, and anything that is not an ArrayBuffer', async () => {
      const view = await mounted('alaw8');
      act(() => {
        latest().emitBinary(new ArrayBuffer(0));
        latest().emitBinary(new ArrayBuffer(8001));
        latest().emitBinary(new Blob([new Uint8Array(160)]));
      });
      expect(alaw).toEqual([]);
      expect(view.result.current.connection).toBe('open');
    });

    it('ignores binary on a pcm16 socket', async () => {
      await mounted('pcm16');
      act(() => latest().emitBinary(frames(1)));
      expect(alaw).toEqual([]);
    });
  });

  describe('a server that will not do alaw8', () => {
    it('1008 invalid_media: reconnects as pcm16 and stays pcm16 for this station', async () => {
      const view = await mounted('alaw8');
      act(() => latest().serverClose(1008, 'invalid_media'));
      await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 3000 });

      expect(latest().url).toMatch(/\?token=FRESH&media=pcm16$/);
      expect(view.result.current.mediaFormat).toBe('pcm16');
      expect(view.result.current.diagnostics.some((d) => d.detail.includes('invalid_media'))).toBe(true);

      act(() => latest().open());
      await waitFor(() => expect(view.result.current.connection).toBe('open'));
      expect(view.result.current.sendMedia('QUJD')).toBe(true);
      expect(view.result.current.sendMedia(frames(1))).toBe(false);

      // Sticky: a later ordinary drop does not try alaw8 again.
      act(() => latest().serverClose(1006, ''));
      await waitFor(() => expect(FakeSocket.instances.length).toBe(3), { timeout: 3000 });
      expect(latest().url).toMatch(/media=pcm16$/);
    });

    it('any other 1008 leaves the format alone', async () => {
      const view = await mounted('alaw8');
      act(() => latest().serverClose(1008, 'invalid_client'));
      await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 3000 });
      expect(latest().url).toMatch(/media=alaw8$/);
      expect(view.result.current.mediaFormat).toBe('alaw8');
    });

    it('JSON media on an alaw8 socket: plays it, and switches this socket to pcm16', async () => {
      // A server that ignored `media=alaw8` treats the socket as pcm16: it sends JSON
      // media and would drop binary uplink. The console follows it rather than going
      // one-way silent.
      const view = await mounted('alaw8');
      act(() => latest().emit({ event: 'media', media: { payload: 'QUJD' } }));

      expect(json).toEqual(['QUJD']);
      expect(view.result.current.mediaFormat).toBe('pcm16');
      expect(view.result.current.sendMedia(frames(1))).toBe(false);
      expect(view.result.current.sendMedia('QUJD')).toBe(true);
      expect(FakeSocket.instances).toHaveLength(1);
      expect(view.result.current.diagnostics.at(-1)?.event).toBe('media_format');
    });
  });
});
