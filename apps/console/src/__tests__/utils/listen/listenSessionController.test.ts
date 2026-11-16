import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LISTEN_ENDED_DISMISS_MS,
  LISTEN_RECONNECT_DELAYS_MS,
  ListenSessionController,
  type ListenSocket,
} from '../../../utils/listen/listenSessionController';
import type { ListenGrantResult } from '../../../api/liveCalls';
import type { ListenTarget } from '../../../utils/listen/listenSessionReducer';
import { AGENCY_LISTEN_PING_INTERVAL_MS, AGENCY_LISTEN_RECONNECT_WINDOW_MS } from '../../../types/live-calls';

/**
 * The listen's side effects (`ListenSessionController`, driven by the reducer): a grant opens
 * the socket, `ready` makes it live, audio goes to the playback only while live, `ping` every
 * 10 s, `stop` on Stop, a drop re-mints and reconnects within 15 s, and the bar dismisses itself
 * 6 s after the call ends.
 */

class FakeListenSocket implements ListenSocket {
  static all: FakeListenSocket[] = [];
  binaryType: BinaryType = 'blob';
  readyState = 0;
  onopen: ListenSocket['onopen'] = null;
  onmessage: ListenSocket['onmessage'] = null;
  onclose: ListenSocket['onclose'] = null;
  onerror: ListenSocket['onerror'] = null;
  sent: string[] = [];
  closedWith: number | null = null;
  constructor(public url: string) {
    FakeListenSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code ?? 1005;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  text(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
  binary(tag: number) {
    const bytes = new Uint8Array(161);
    bytes[0] = tag;
    this.onmessage?.({ data: bytes.buffer } as MessageEvent);
  }
  serverClose(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

const TARGET: ListenTarget = {
  callId: 'call-1',
  origin: 'campaign',
  campaignId: 'camp-1',
  campaignLabel: 'Renewals',
  agentName: 'Priya Sharma',
  customerMasked: '****4321',
  connectedAt: '2026-11-16T10:00:00Z',
  clockOffsetMs: 0,
};

let grants: ListenGrantResult[];
let grantCalls: string[];
let audio: string[];
let attaches: number;

function grantOk(n: number): ListenGrantResult {
  return { ok: true, grant: { listen_id: `l-${n}`, ws_url: `/proxy/agency/listen/s-1/l-${n}?token=t${n}`, expires_at: '2026-11-16T10:01:00Z' } };
}

function controller() {
  return new ListenSessionController({
    grant: async (callId) => {
      grantCalls.push(callId);
      return grants.shift() ?? grantOk(grantCalls.length);
    },
    openSocket: (url) => new FakeListenSocket(url),
    onAudio: (leg, frame) => audio.push(`${leg}:${frame.byteLength}`),
    onAttach: () => {
      attaches += 1;
    },
  });
}

const last = () => FakeListenSocket.all[FakeListenSocket.all.length - 1]!;
const flush = () => vi.advanceTimersByTimeAsync(0);

async function goLive(c: ListenSessionController) {
  c.start(TARGET);
  await flush();
  const socket = last();
  socket.open();
  socket.text({ event: 'ready', listen_id: 'l-1', call_id: 'call-1', format: 'alaw8', frame_bytes: 160 });
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T10:05:00Z'));
  FakeListenSocket.all = [];
  grants = [];
  grantCalls = [];
  audio = [];
  attaches = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a listen, start to stop', () => {
  it('mints a grant for the call, opens its ws_url in binary mode, and goes live on ready', async () => {
    const c = controller();
    c.start(TARGET);
    expect(c.getState().phase).toBe('connecting');
    await flush();
    expect(grantCalls).toEqual(['call-1']);
    expect(FakeListenSocket.all).toHaveLength(1);
    expect(last().url).toBe('/proxy/agency/listen/s-1/l-1?token=t1');
    expect(last().binaryType).toBe('arraybuffer');
    expect(attaches).toBe(1);
    last().open();
    expect(c.getState().phase).toBe('connecting');
    last().text({ event: 'ready', listen_id: 'l-1', call_id: 'call-1', format: 'alaw8', frame_bytes: 160 });
    expect(c.getState().phase).toBe('live');
  });

  it('hands audio to the playback only once live, and ignores malformed frames', async () => {
    const c = controller();
    c.start(TARGET);
    await flush();
    last().open();
    last().binary(1);
    expect(audio).toEqual([]);
    last().text({ event: 'ready', listen_id: 'l-1', call_id: 'call-1', format: 'alaw8', frame_bytes: 160 });
    last().binary(1);
    last().binary(2);
    last().binary(9);
    expect(audio).toEqual(['customer:160', 'agent:160']);
  });

  it('pings every 10 s while live, and keeps the pong as a clock sample', async () => {
    const c = controller();
    const socket = await goLive(c);
    expect(socket.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(AGENCY_LISTEN_PING_INTERVAL_MS);
    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([{ event: 'ping', ts: Date.now() }]);
    const ts = JSON.parse(socket.sent[0]!).ts as number;
    socket.text({ event: 'pong', ts, server_ts: ts + 5_000 });
    expect(c.getState().clock.sampleCount).toBe(1);
    await vi.advanceTimersByTimeAsync(AGENCY_LISTEN_PING_INTERVAL_MS);
    expect(socket.sent).toHaveLength(2);
  });

  it('Stop sends `stop`, closes the socket and stops pinging', async () => {
    const c = controller();
    const socket = await goLive(c);
    c.stop();
    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([{ event: 'stop' }]);
    expect(socket.closedWith).toBe(1000);
    expect(c.getState().phase).toBe('idle');
    await vi.advanceTimersByTimeAsync(AGENCY_LISTEN_PING_INTERVAL_MS * 2);
    expect(socket.sent).toHaveLength(1);
  });

  it('a second start stops the first: one listen at a time', async () => {
    const c = controller();
    const first = await goLive(c);
    c.start({ ...TARGET, callId: 'call-2' });
    expect(first.sent.map((s) => JSON.parse(s))).toEqual([{ event: 'stop' }]);
    expect(first.closedWith).toBe(1000);
    await flush();
    expect(grantCalls).toEqual(['call-1', 'call-2']);
  });

  it('destroy (leaving the shell or the account) stops the listen', async () => {
    const c = controller();
    const socket = await goLive(c);
    c.destroy();
    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([{ event: 'stop' }]);
    expect(c.getState().phase).toBe('idle');
    c.destroy();
  });

  it('a refused first grant opens nothing', async () => {
    grants = [{ ok: false, status: 409, code: 'listen_limit_call' }];
    const c = controller();
    c.start(TARGET);
    await flush();
    expect(FakeListenSocket.all).toEqual([]);
    expect(c.getState()).toMatchObject({ phase: 'idle', refusal: { status: 409, code: 'listen_limit_call' } });
  });

  it('a grant that throws is a refusal with no answer, not a crash', async () => {
    const c = new ListenSessionController({
      grant: () => Promise.reject(new Error('offline')),
      openSocket: (url) => new FakeListenSocket(url),
      onAudio: () => {},
    });
    c.start(TARGET);
    await flush();
    expect(c.getState().refusal).toEqual({ status: null, code: null });
  });
});

describe('how it ends', () => {
  it('the call ends: the socket is let go, and the bar dismisses itself after 6 s', async () => {
    const c = controller();
    const socket = await goLive(c);
    socket.text({ event: 'ended', reason: 'call_ended' });
    expect(c.getState()).toMatchObject({ phase: 'ended', end: { kind: 'call_ended' } });
    expect(socket.closedWith).toBe(1000);
    // The server's close, landing after: nothing changes.
    socket.serverClose(1000, 'call_ended');
    expect(c.getState().phase).toBe('ended');
    await vi.advanceTimersByTimeAsync(LISTEN_ENDED_DISMISS_MS - 1);
    expect(c.getState().phase).toBe('ended');
    await vi.advanceTimersByTimeAsync(1);
    expect(c.getState().phase).toBe('idle');
  });

  it('revoked and superseded stay until dismissed', async () => {
    for (const [code, kind] of [[4403, 'revoked'], [4409, 'superseded']] as const) {
      const c = controller();
      const socket = await goLive(c);
      socket.serverClose(code, kind === 'revoked' ? 'permission_revoked' : 'superseded');
      expect(c.getState().end?.kind).toBe(kind);
      await vi.advanceTimersByTimeAsync(LISTEN_ENDED_DISMISS_MS * 2);
      expect(c.getState().phase).toBe('ended');
      c.dismiss();
      expect(c.getState().phase).toBe('idle');
    }
  });
});

describe('reconnecting', () => {
  it('a drop re-mints a grant and opens a new socket after a short wait', async () => {
    const c = controller();
    const first = await goLive(c);
    first.serverClose(1006);
    expect(c.getState().phase).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(LISTEN_RECONNECT_DELAYS_MS[0]! - 1);
    expect(grantCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(grantCalls).toEqual(['call-1', 'call-1']);
    expect(FakeListenSocket.all).toHaveLength(2);
    expect(last().url).toContain('token=t2');
    expect(attaches).toBe(2);
    last().open();
    last().text({ event: 'ready', listen_id: 'l-2', call_id: 'call-1', format: 'alaw8', frame_bytes: 160 });
    expect(c.getState()).toMatchObject({ phase: 'live', listenId: 'l-2' });
  });

  it('an old socket’s late close does not move the new attach', async () => {
    const c = controller();
    const first = await goLive(c);
    const closeOld = first.onclose!;
    first.serverClose(1006);
    await vi.advanceTimersByTimeAsync(LISTEN_RECONNECT_DELAYS_MS[0]!);
    last().open();
    last().text({ event: 'ready', listen_id: 'l-2', call_id: 'call-1', format: 'alaw8', frame_bytes: 160 });
    closeOld({ code: 1006, reason: '' } as CloseEvent);
    expect(c.getState().phase).toBe('live');
  });

  it('gives up after 15 s: "Connection lost", then Try again starts afresh', async () => {
    const c = controller();
    const first = await goLive(c);
    first.serverClose(1006);
    // Every reconnect fails at the socket.
    for (let elapsed = 0; elapsed < AGENCY_LISTEN_RECONNECT_WINDOW_MS + 4_000; elapsed += 250) {
      await vi.advanceTimersByTimeAsync(250);
      const socket = last();
      if (socket.readyState === 0 && socket.onclose) socket.serverClose(1006);
    }
    expect(c.getState().phase).toBe('lost');
    const count = FakeListenSocket.all.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeListenSocket.all).toHaveLength(count);
    c.retry();
    await flush();
    expect(FakeListenSocket.all).toHaveLength(count + 1);
    expect(c.getState().phase).toBe('reconnecting');
  });

  it('a socket that will not open is a drop, not a crash', async () => {
    let throwOnce = true;
    const c = new ListenSessionController({
      grant: async () => grantOk(1),
      openSocket: (url) => {
        if (throwOnce) {
          throwOnce = false;
          throw new SyntaxError('bad url');
        }
        return new FakeListenSocket(url);
      },
      onAudio: () => {},
    });
    c.start(TARGET);
    await flush();
    expect(c.getState()).toMatchObject({ phase: 'connecting', step: 'wait' });
    await vi.advanceTimersByTimeAsync(LISTEN_RECONNECT_DELAYS_MS[0]!);
    expect(FakeListenSocket.all).toHaveLength(1);
  });
});
