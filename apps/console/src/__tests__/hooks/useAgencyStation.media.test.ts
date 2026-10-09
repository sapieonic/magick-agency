import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ mintStationToken: vi.fn() }));
vi.mock('../../api/agency', () => ({ mintStationToken: mocks.mintStationToken }));

import { useAgencyStation, type AgencyStationAudioSink } from '../../hooks/useAgencyStation';
import type { AgencySessionBootstrap } from '../../types/agency';

/**
 * **Audio on the station socket** — the half of the console that made every
 * agency call dead air on both ends.
 *
 * Two defects are pinned here and they are different in kind:
 *
 *  1. **Nothing carried audio.** The only frame the console ever sent was
 *     `{event:'ping'}`, and inbound `media` was never read. A call reserved,
 *     bridged, ran a talk timer and billed, with silence in both directions.
 *  2. **`media` fell into the diagnostic sink.** The server relays ~50 frames a second
 *     for the length of a conversation, and the sink is a `setDiagnostics` call
 *     — so the console was committing React state fifty times a second, for the
 *     audio it was simultaneously failing to play. Routing `media` to the sink
 *     would be a performance defect even if the audio worked.
 *
 * The second is why the sink assertions below check the diagnostics array and
 * not just "the sink got the payload": an implementation that plays the audio
 * *and* logs it would satisfy the first and reintroduce the second.
 */

class FakeSocket {
  static instances: FakeSocket[] = [];
  // The full set the production code compares against. With only `OPEN`, every
  // `readyState === WebSocket.CONNECTING` test in the hook evaluated
  // `0 === undefined` — so `abandon()`'s CONNECTING arm, which is what stops a
  // still-upgrading socket from leaking past its generation, was dead in the
  // entire suite. `useWebRtcCall.test.ts` already declares these.
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
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
  emitRaw(data: string): void {
    this.onmessage?.({ data });
  }
  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
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

describe('the station socket carries audio', () => {
  let heard: string[];
  let sink: AgencyStationAudioSink;
  /**
   * **Unmounted by hand, because nothing else will.**
   *
   * `@testing-library/react` registers its auto-`cleanup` only when `afterEach`
   * is a *global*, and this repo runs Vitest with `globals` off (`vite.config.ts`
   * declares only `environment` and `include`). So every `renderHook` in a hook
   * test file stays mounted for the rest of the file — station socket, heartbeat
   * interval and pending reconnect timer included.
   *
   * That is not a tidiness point here. A test that leaves a station in
   * `reconnecting` leaves a `setTimeout` that opens a socket **inside the next
   * test's window**, where `latest()` then returns a socket the test never made.
   * The reconnect case below caught it: `FakeSocket.instances.length` was 3.
   */
  const mounted_: Array<{ unmount: () => void }> = [];

  beforeEach(() => {
    FakeSocket.instances = [];
    mocks.mintStationToken.mockReset();
    heard = [];
    // A stable object, exactly as the console must supply one — a fresh sink per
    // render re-opens the socket (see `AgencyStationAudioSink`).
    sink = { onMedia: (payload) => heard.push(payload) };
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    mounted_.splice(0).forEach((view) => view.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function mounted() {
    const view = renderHook(() => useAgencyStation(BOOTSTRAP, { audio: sink }));
    mounted_.push(view);
    await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    act(() => latest().open());
    await waitFor(() => expect(view.result.current.connection).toBe('open'));
    return view;
  }

  describe('downlink — the customer’s voice', () => {
    it('delivers the payload to the audio sink', async () => {
      await mounted();
      act(() => latest().emit({ event: 'media', media: { payload: 'QUJD' } }));
      expect(heard).toEqual(['QUJD']);
    });

    it('does NOT route media into the diagnostic sink', async () => {
      /**
       * The performance half. Fifty frames is one second of one call; the sink is
       * bounded at 200 entries, so a single second of audio would consume a
       * quarter of a shift's diagnostic budget — and commit React state fifty
       * times doing it.
       *
       * Asserting `diagnostics` is **empty** rather than "does not contain
       * media": a counter, a sampled log, or a one-in-ten entry would all pass a
       * containment check and all reintroduce the commit.
       */
      const view = await mounted();
      act(() => {
        for (let i = 0; i < 50; i++) {
          latest().emit({ event: 'media', media: { payload: 'QUJD' } });
        }
      });

      expect(heard).toHaveLength(50);
      expect(view.result.current.diagnostics).toEqual([]);
    });

    it('leaves the OTHER bridge frames in the diagnostic sink', async () => {
      // The rule is "`media` is not diagnostic", not "bridge frames are not
      // diagnostic". `status`/`ended` must still land there.
      const view = await mounted();
      act(() => latest().emit({ event: 'status', status: 'answered' }));
      expect(view.result.current.diagnostics.at(-1)?.event).toBe('status');
    });

    it('survives a malformed media frame without dropping the socket', async () => {
      // The union promises `media.payload`; the socket does not. An unguarded
      // read here throws out of `onmessage` and takes the shift's session down.
      const view = await mounted();
      act(() => latest().emit({ event: 'media' }));
      act(() => latest().emit({ event: 'media', media: { payload: 7 } }));
      act(() => latest().emitRaw('{"event":"media","media":'));

      expect(heard).toEqual([]);
      expect(view.result.current.connection).toBe('open');
      // And a real frame still gets through afterwards.
      act(() => latest().emit({ event: 'media', media: { payload: 'QUJD' } }));
      expect(heard).toEqual(['QUJD']);
    });

    it('is silent, not broken, when no sink was supplied', async () => {
      // Every pre-existing caller and test passes no `audio`. They must keep
      // working — and must still not log media.
      const view = renderHook(() => useAgencyStation(BOOTSTRAP));
      mounted_.push(view);
      await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
      act(() => latest().open());
      act(() => latest().emit({ event: 'media', media: { payload: 'QUJD' } }));

      expect(view.result.current.connection).toBe('open');
      expect(view.result.current.diagnostics).toEqual([]);
    });
  });

  describe('uplink — the agent’s voice', () => {
    it('writes exactly the envelope the server reads', async () => {
      const view = await mounted();
      act(() => {
        expect(view.result.current.sendMedia('QUJD')).toBe(true);
      });
      // The literal, not a round-trip through our own encoder.
      //
      // Heartbeat frames are filtered rather than the whole buffer compared: an
      // open socket now sends one `ping` immediately, because the `pong` it
      // answers with is what resets the reconnect backoff and
      // waiting a full `heartbeat_ms` for that proof made a session that blipped
      // in its first 10 s carry backoff it had not earned. The assertion that
      // matters here is that the media envelope is byte-exact, not that this
      // socket has sent nothing else.
      const media = latest().sent.filter((frame) => !frame.includes('"ping"'));
      expect(media).toEqual(['{"event":"media","media":{"payload":"QUJD"}}']);
    });

    it('reports false and sends nothing while the socket is down', async () => {
      // A dropped 20ms frame is inaudible; a throw inside an AudioWorklet port
      // handler is unattributable. So this returns rather than throws.
      const view = await mounted();
      act(() => latest().serverClose(1006, ''));
      await waitFor(() => expect(view.result.current.connection).toBe('reconnecting'));

      expect(view.result.current.sendMedia('QUJD')).toBe(false);
    });

    it('sends nothing into a replacement socket that has not opened yet', async () => {
      /**
       * The `readyState` clause specifically, which the case above does **not**
       * reach: `onclose` nulls the socket ref, so a `!socket` guard alone covers
       * that window. This is the *next* window — the reconnect has constructed a
       * socket and put it in the ref, and it is still `CONNECTING`.
       *
       * `WebSocket.send` on a socket that has not opened throws
       * `InvalidStateError`, and it would throw ~50 times a second from inside an
       * `AudioWorkletNode` port handler, where nothing attributes it to the
       * reconnect that caused it.
       */
      mocks.mintStationToken.mockResolvedValue({
        session_id: 'sess-1',
        station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
        expires_at: 'x',
      });
      const view = await mounted();
      act(() => latest().serverClose(1006, ''));
      await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 3000 });

      // Constructed, in the ref, and deliberately NOT opened.
      expect(latest().readyState).toBe(0);
      expect(view.result.current.sendMedia('QUJD')).toBe(false);
      expect(latest().sent).toEqual([]);
    });

    it('refuses a payload over the server’s ceiling instead of shipping it into a drop', async () => {
      const view = await mounted();
      const before = latest().sent.length;
      expect(view.result.current.sendMedia('a'.repeat(128001))).toBe(false);
      expect(latest().sent).toHaveLength(before);
    });

    it('resumes onto the NEW socket after a mid-call reconnect', async () => {
      /**
       * The reconnect requirement, and the reason `sendMedia` reads the socket
       * ref at call time. The capture graph is handed this callback once when the
       * call connects and keeps it for the conversation — a version that closed
       * over the socket would keep writing into the dead one for the rest of the
       * call, with every frame "sent" and nobody hearing anything.
       */
      mocks.mintStationToken.mockResolvedValue({
        session_id: 'sess-1',
        station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
        expires_at: 'x',
      });
      const view = await mounted();
      const send = view.result.current.sendMedia;
      const dropped = latest();

      act(() => dropped.serverClose(1006, ''));
      await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 3000 });
      act(() => latest().open());
      await waitFor(() => expect(view.result.current.connection).toBe('open'));

      // The SAME callback the capture graph is still holding.
      act(() => {
        expect(send('QUJD')).toBe(true);
      });

      expect(latest()).not.toBe(dropped);
      expect(latest().sent).toContain('{"event":"media","media":{"payload":"QUJD"}}');
      expect(dropped.sent).not.toContain('{"event":"media","media":{"payload":"QUJD"}}');
    });
  });
});
