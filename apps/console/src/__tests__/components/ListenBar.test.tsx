import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { liveCall } from '../helpers/liveCalls';

/**
 * The listening bar with the shell's listen behind it (`docs/listening.md` §9, LS6): the first
 * use confirmation, every bar state and its words, the notice always, Esc, the mutes and the
 * remembered volume, the refused grant's toast, and the listen ending with the account.
 */

const mocks = vi.hoisted(() => ({
  listLiveCalls: vi.fn(),
  revealLiveCallNumber: vi.fn(),
  grantListen: vi.fn(),
  showToast: vi.fn(),
  compact: false,
  audioState: 'running' as AudioContextState,
  audioThrows: false,
  flagOn: true,
  role: 'account_admin' as string,
}));

vi.mock('../../api/liveCalls', () => ({
  listLiveCalls: mocks.listLiveCalls,
  revealLiveCallNumber: mocks.revealLiveCallNumber,
  grantListen: mocks.grantListen,
}));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 't-1', accountId: 'a-1', role: mocks.role }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (f: string) => mocks.flagOn && f === 'agency_live_listen_enabled', status: 'ready' }),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));
vi.mock('../../hooks/useMediaQuery', () => ({ useMediaQuery: () => mocks.compact }));

import { LiveCallsTable } from '../../components/listen/LiveCallsTable';
import { ListenProvider, LISTEN_CONFIRMED_KEY } from '../../components/listen/ListenProvider';
import { ListenBar } from '../../components/listen/ListenBar';
import { LISTEN_VOLUME_KEY } from '../../hooks/listen/useListenPlayback';

class FakeWs {
  static all: FakeWs[] = [];
  binaryType = 'blob';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: unknown[] = [];
  closed: number | null = null;
  constructor(public url: string) {
    FakeWs.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closed = code ?? 1005;
    this.readyState = 3;
  }
  ready() {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ event: 'ready', listen_id: 'l-1', call_id: 'c-1', format: 'alaw8', frame_bytes: 160 }) });
  }
  frame(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  serverClose(code: number, reason = '') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

class FakeAudioContext {
  static all: FakeAudioContext[] = [];
  state: AudioContextState = mocks.audioState;
  currentTime = 0;
  destination = {};
  resumed = 0;
  sourcesStopped = 0;
  onstatechange: (() => void) | null = null;
  constructor() {
    if (mocks.audioThrows) throw new DOMException('no more contexts', 'NotSupportedError');
    FakeAudioContext.all.push(this);
  }
  createGain() {
    return { connect: () => {}, gain: { value: 1 } };
  }
  createAnalyser() {
    return { connect: () => {}, fftSize: 512, getFloatTimeDomainData: (o: Float32Array) => o.fill(0) };
  }
  createBuffer(_c: number, length: number, rate: number) {
    const d = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => d };
  }
  createBufferSource() {
    return {
      connect: () => {},
      start: () => {},
      stop: () => {
        this.sourcesStopped += 1;
      },
      buffer: null,
      onended: null,
    };
  }
  async resume() {
    this.resumed += 1;
    if (mocks.audioState === 'running') this.state = 'running';
  }
  async suspend() {
    this.state = 'suspended';
  }
  async close() {
    this.state = 'closed';
  }
}

const NOW = new Date('2026-11-16T10:10:00Z').getTime();
const CALL = liveCall({ call_id: 'c-1', agent_name: 'Priya Sharma', customer_phone_masked: '****4321', connected_at: '2026-11-16T10:06:18Z', campaign_name: 'Renewals · Nov' });
const OTHER = liveCall({ call_id: 'c-2', agent_user_id: 'u-2', agent_name: 'Arjun Nair', connected_at: '2026-11-16T10:08:00Z' });

function App({ account = 'a-1' }: { account?: string }) {
  return (
    <MemoryRouter>
      <ListenProvider key={account}>
        <LiveCallsTable />
        <ListenBar />
      </ListenProvider>
    </MemoryRouter>
  );
}

async function renderApp() {
  const view = render(<App />);
  await act(async () => {});
  return view;
}

const flush = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});

async function startListening(callId = 'c-1') {
  await act(async () => {
    fireEvent.click(screen.getByTestId(`live-call-listen-${callId}`));
  });
  if (screen.queryByText('Listening is logged')) {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start listening' }));
    });
  }
  await flush();
  return FakeWs.all[FakeWs.all.length - 1]!;
}

const bar = () => screen.getByTestId('listen-bar');

/** One 20 ms frame of `leg` on the listener socket (tag byte, then 160 bytes of A-law). */
function audioFrame(ws: FakeWs, tag: 1 | 2) {
  const frame = new Uint8Array(161);
  frame[0] = tag;
  act(() => ws.onmessage?.({ data: frame.buffer }));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  FakeWs.all = [];
  FakeAudioContext.all = [];
  mocks.compact = false;
  mocks.audioState = 'running';
  mocks.audioThrows = false;
  mocks.flagOn = true;
  mocks.role = 'account_admin';
  mocks.showToast.mockReset();
  mocks.listLiveCalls.mockReset().mockResolvedValue({ calls: [CALL, OTHER], as_of: new Date(NOW).toISOString() });
  mocks.grantListen.mockReset().mockImplementation(async () => ({
    ok: true,
    grant: { listen_id: 'l-1', ws_url: '/proxy/agency/listen/s-1/l-1?token=tok', expires_at: '2026-11-16T10:11:00Z' },
  }));
  vi.stubGlobal('WebSocket', FakeWs);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the first listen in this browser', () => {
  it('asks once that the supervisor knows listening is logged', async () => {
    await renderApp();
    await act(async () => {
      fireEvent.click(screen.getByTestId('live-call-listen-c-1'));
    });
    expect(screen.getByText('Listening is logged')).toBeTruthy();
    expect(screen.getByText('Each time you listen, your name, the call and the start and end times are recorded and can be seen by your account’s admins.')).toBeTruthy();
    // Cancel: nothing starts, nothing is remembered.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.grantListen).not.toHaveBeenCalled();
    expect(screen.queryByTestId('listen-bar')).toBeNull();
    expect(window.localStorage.getItem(LISTEN_CONFIRMED_KEY)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('live-call-listen-c-1'));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start listening' }));
    });
    expect(mocks.grantListen).toHaveBeenCalledWith('c-1', 't-1', 'a-1');
    expect(window.localStorage.getItem(LISTEN_CONFIRMED_KEY)).toBe('1');
  });

  it('does not ask again in this browser', async () => {
    window.localStorage.setItem(LISTEN_CONFIRMED_KEY, '1');
    await renderApp();
    await act(async () => {
      fireEvent.click(screen.getByTestId('live-call-listen-c-1'));
    });
    expect(screen.queryByText('Listening is logged')).toBeNull();
    expect(mocks.grantListen).toHaveBeenCalledTimes(1);
  });
});

describe('the bar', () => {
  beforeEach(() => {
    window.localStorage.setItem(LISTEN_CONFIRMED_KEY, '1');
  });

  it('Connecting…, then Listening, with who, the campaign and the time on call; the notice throughout', async () => {
    await renderApp();
    const ws = await startListening();
    expect(ws.url).toMatch(/^ws:\/\/[^/]+\/proxy\/agency\/listen\/s-1\/l-1\?token=tok$/);
    expect(screen.getByTestId('listen-status').textContent).toBe('Connecting…');
    expect(screen.getByTestId('live-call-connecting-c-1')).toBeTruthy();
    expect(screen.getByTestId('listen-notice').textContent).toBe('This session is logged. Do not record or share what you hear.');

    act(() => ws.ready());
    expect(screen.getByTestId('listen-status').textContent).toBe('Listening');
    expect(bar().textContent).toContain('Priya S. with ****4321');
    expect(bar().textContent).toContain('Renewals · Nov · 03:42');
    expect(screen.getByTestId('listen-meter-agent').textContent).toContain('Agent');
    expect(screen.getByTestId('listen-meter-customer').textContent).toContain('Customer');
    // Open call: the call's own page, its attempt (the row's `correlation_id`).
    expect(screen.getByTestId('listen-open-call').getAttribute('href')).toBe('/agency/campaigns/camp-1/attempts/att-1');
    expect(screen.getByTestId('listen-notice')).toBeTruthy();
    // The row is the supervisor's: tinted, with Stop.
    expect(screen.getByTestId('live-call-c-1').getAttribute('data-mine')).toBe('true');
    expect(screen.getByTestId('live-call-stop-c-1')).toBeTruthy();
  });

  it.each([
    ['a soft-phone call opens its call page', { origin: 'manual', correlation_id: 'man-3', campaign_id: null, campaign_name: null }, '/agency/softphone/calls/man-3'],
    ['an inbound call has no call page in the console, so none is offered', { origin: 'inbound', correlation_id: 'in-3', campaign_id: null, campaign_name: null, inbound_route_name: 'Support' }, null],
  ] as const)('Open call: %s', async (_name, over, href) => {
    const third = liveCall({ ...over, call_id: 'c-3', agent_user_id: 'u-3', agent_name: 'Sneha Iyer' });
    mocks.listLiveCalls.mockResolvedValue({ calls: [CALL, third], as_of: new Date(NOW).toISOString() });
    await renderApp();
    const ws = await startListening('c-3');
    act(() => ws.ready());
    expect(screen.queryByTestId('listen-open-call')?.getAttribute('href') ?? null).toBe(href);
    act(() => ws.frame({ event: 'ended', reason: 'call_ended' }));
    expect(screen.queryByTestId('listen-open-call')?.getAttribute('href') ?? null).toBe(href);
  });

  it('Stop listening sends `stop` and closes the bar', async () => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    fireEvent.click(screen.getByTestId('listen-stop'));
    expect(ws.sent).toEqual([{ event: 'stop' }]);
    expect(ws.closed).toBe(1000);
    expect(screen.queryByTestId('listen-bar')).toBeNull();
  });

  it('Esc stops while the bar has focus, and not from elsewhere', async () => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByTestId('listen-bar')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('listen-volume'), { key: 'Escape' });
    expect(ws.sent).toEqual([{ event: 'stop' }]);
    expect(screen.queryByTestId('listen-bar')).toBeNull();
  });

  it('the row offers Stop while connecting too, not only once live', async () => {
    await renderApp();
    const ws = await startListening();
    expect(screen.getByTestId('live-call-connecting-c-1').textContent).toContain('Connecting…');
    fireEvent.click(screen.getByTestId('live-call-stop-c-1'));
    expect(ws.closed).toBe(1000);
    expect(screen.queryByTestId('listen-bar')).toBeNull();
  });

  it('…and while reconnecting', async () => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    act(() => ws.serverClose(1006));
    expect(screen.getByTestId('live-call-connecting-c-1').textContent).toContain('Reconnecting…');
    fireEvent.click(screen.getByTestId('live-call-stop-c-1'));
    expect(screen.queryByTestId('listen-bar')).toBeNull();
  });

  it('the row’s Stop stops too', async () => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    fireEvent.click(screen.getByTestId('live-call-stop-c-1'));
    expect(ws.sent).toEqual([{ event: 'stop' }]);
  });

  it('mutes each leg on its own', async () => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    const mute = screen.getByTestId('listen-mute-agent');
    expect(mute.getAttribute('aria-label')).toBe('Mute the agent');
    fireEvent.click(mute);
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    expect(mute.getAttribute('aria-label')).toBe('Unmute the agent');
    expect(screen.getByTestId('listen-mute-customer').getAttribute('aria-pressed')).toBe('false');
  });

  it('remembers the volume in this browser', async () => {
    window.localStorage.setItem(LISTEN_VOLUME_KEY, '0.35');
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    const volume = screen.getByTestId('listen-volume') as HTMLInputElement;
    expect(volume.value).toBe('35');
    fireEvent.change(volume, { target: { value: '60' } });
    expect(window.localStorage.getItem(LISTEN_VOLUME_KEY)).toBe('0.6');
  });

  it('works with browser storage blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    fireEvent.change(screen.getByTestId('listen-volume'), { target: { value: '40' } });
    expect((screen.getByTestId('listen-volume') as HTMLInputElement).value).toBe('40');
    vi.restoreAllMocks();
  });

  it('says when the browser blocked the sound, and turns it on with a click', async () => {
    mocks.audioState = 'suspended';
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(screen.getByTestId('listen-sound-blocked').textContent).toContain('Your browser has blocked the sound.');
    mocks.audioState = 'running';
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn sound on' }));
    });
    expect(screen.queryByTestId('listen-sound-blocked')).toBeNull();
  });

  it('says "No sound from the agent" when the agent’s leg is silent over 2 s (a muted agent sends nothing)', async () => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    expect(screen.queryByTestId('listen-agent-gap')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_600);
    });
    expect(screen.getByTestId('listen-agent-gap').textContent).toBe('No sound from the agent');
    const frame = new Uint8Array(161);
    frame[0] = 2;
    act(() => ws.onmessage?.({ data: frame.buffer }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(screen.queryByTestId('listen-agent-gap')).toBeNull();
  });

  it.each([
    ['a drop (1006)', 1006],
    ['the server shutting down with no `ended` frame (1005, one process, LS16 g)', 1005],
  ])('%s: "Reconnecting…", and back to Listening on a fresh grant', async (_name, code) => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    act(() => ws.serverClose(code));
    expect(screen.getByTestId('listen-status').textContent).toBe('Reconnecting…');
    expect(screen.getByTestId('listen-reconnecting').textContent).toContain('15 s');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mocks.grantListen).toHaveBeenCalledTimes(2);
    const next = FakeWs.all[FakeWs.all.length - 1]!;
    expect(next).not.toBe(ws);
    act(() => next.ready());
    expect(screen.getByTestId('listen-status').textContent).toBe('Listening');
  });

  it('no way back within 15 s: "Connection lost" and Try again', async () => {
    mocks.grantListen.mockImplementation(async () => ({ ok: false, status: 503, code: 'listen_unavailable' }));
    await renderApp();
    mocks.grantListen.mockImplementationOnce(async () => ({
      ok: true,
      grant: { listen_id: 'l-1', ws_url: '/proxy/agency/listen/s-1/l-1?token=tok', expires_at: 'x' },
    }));
    const ws = await startListening();
    act(() => ws.ready());
    act(() => ws.serverClose(1006));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(screen.getByTestId('listen-status').textContent).toBe('Connection lost');
    expect(screen.getByTestId('listen-lost').textContent).toBe('The call is not affected.');
    expect(screen.getByTestId('listen-notice')).toBeTruthy();
    // Nothing is left to stop: Close (not a red Stop listening) puts the bar away.
    expect(screen.queryByTestId('listen-stop')).toBeNull();
    expect(screen.getByTestId('listen-close').textContent).toBe('Close');
    // Lost: nothing plays on, and the context is not left running.
    expect(FakeAudioContext.all[0]!.state).toBe('suspended');
    const calls = mocks.grantListen.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId('listen-retry'));
    });
    expect(mocks.grantListen.mock.calls.length).toBe(calls + 1);
    // Try again is a gesture: it runs the context again.
    expect(FakeAudioContext.all[0]!.state).toBe('running');
  });

  it.each([
    ['full width', false],
    ['phone width', true],
  ])('Connection lost: Close puts the bar away (%s)', async (_name, compact) => {
    mocks.compact = compact;
    mocks.grantListen.mockImplementation(async () => ({ ok: false, status: 503, code: 'listen_unavailable' }));
    await renderApp();
    mocks.grantListen.mockImplementationOnce(async () => ({
      ok: true,
      grant: { listen_id: 'l-1', ws_url: '/proxy/agency/listen/s-1/l-1?token=tok', expires_at: 'x' },
    }));
    const ws = await startListening();
    act(() => ws.ready());
    act(() => ws.serverClose(1006));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });
    expect(screen.getByTestId('listen-lost').textContent).toBe('The call is not affected.');
    expect(screen.getByTestId('listen-retry').textContent).toBe('Try again');
    fireEvent.click(screen.getByTestId('listen-close'));
    expect(screen.queryByTestId('listen-bar')).toBeNull();
  });

  it('the call ends: "Call ended" over who and how long, Open call, gone after 6 s', async () => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130_000);
    });
    act(() => ws.frame({ event: 'ended', reason: 'call_ended' }));
    expect(screen.getByTestId('listen-status').textContent).toBe('Call ended');
    // The head says "Call ended" once; the line under it says who and for how long.
    expect(screen.getByTestId('listen-ended-line').textContent).toBe('Priya S. with ****4321 · you listened for 02:10');
    expect(screen.getByTestId('listen-open-call').getAttribute('href')).toBe('/agency/campaigns/camp-1/attempts/att-1');
    expect(screen.getByTestId('listen-notice')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(screen.queryByTestId('listen-bar')).toBeNull();
  });

  it('at phone width the ended line says the call ended itself (there is no head)', async () => {
    mocks.compact = true;
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130_000);
    });
    act(() => ws.frame({ event: 'ended', reason: 'call_ended' }));
    expect(screen.getByTestId('listen-ended-line').textContent).toBe('Call ended · you listened for 02:10');
  });

  it.each([
    [4403, 'permission_revoked', 'You no longer have access to listen to calls.'],
    [4409, 'superseded', 'You started listening in another tab or window, so it stopped here.'],
  ])('close %i: "%s" says so until dismissed', async (code, reason, words) => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    act(() => ws.serverClose(code, reason));
    expect(screen.getByTestId('listen-ended-line').textContent).toBe(words);
    expect(screen.getByTestId('listen-status').textContent).toBe('Listening stopped');
    fireEvent.click(screen.getByTestId('listen-dismiss'));
    expect(screen.queryByTestId('listen-bar')).toBeNull();
  });

  it.each([
    ['the flag goes off', () => {
      mocks.flagOn = false;
    }, 'Listening has been turned off for this account.'],
    ['the permission goes', () => {
      mocks.role = 'agent';
    }, 'You no longer have access to listen to calls.'],
  ])('%s here while listening: the listen stops and the bar says why, until dismissed', async (_name, take, words) => {
    const view = await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    take();
    view.rerender(<App />);
    await flush();
    expect(ws.sent).toEqual([{ event: 'stop' }]);
    expect(ws.closed).toBe(1000);
    expect(screen.getByTestId('listen-status').textContent).toBe('Listening stopped');
    expect(screen.getByTestId('listen-ended-line').textContent).toBe(words);
    // Not a "Call ended" bar: it does not go by itself.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });
    expect(screen.getByTestId('listen-bar')).toBeTruthy();
    fireEvent.click(screen.getByTestId('listen-dismiss'));
    expect(screen.queryByTestId('listen-bar')).toBeNull();
  });

  it('a re-grant refused because the flag went off says listening was turned off, not that access went', async () => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    mocks.grantListen.mockResolvedValue({ ok: false, status: 403, code: 'feature_disabled' });
    act(() => ws.serverClose(1006));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByTestId('listen-ended-line').textContent).toBe('Listening has been turned off for this account.');
  });

  it('a refused grant is a toast with the reason, and no bar', async () => {
    mocks.grantListen.mockResolvedValue({ ok: false, status: 409, code: 'listen_limit_call' });
    await renderApp();
    await startListening();
    // CALL has no listeners in the row, so there is no count to give.
    expect(mocks.showToast).toHaveBeenCalledWith('That call has reached its listening limit.', 'error');
    expect(screen.queryByTestId('listen-bar')).toBeNull();
    expect(FakeWs.all).toEqual([]);
  });

  it('a call full of listeners: the toast counts them from the row the listen started from', async () => {
    const full = liveCall({
      ...CALL,
      listeners: [
        { user_id: 'u-a', name: 'Anita Kapoor', started_at: '2026-11-16T10:07:00Z' },
        { user_id: 'u-b', name: 'Rohan Shah', started_at: '2026-11-16T10:08:00Z' },
      ],
    });
    mocks.listLiveCalls.mockResolvedValue({ calls: [full, OTHER], as_of: new Date(NOW).toISOString() });
    mocks.grantListen.mockResolvedValue({ ok: false, status: 409, code: 'listen_limit_call' });
    await renderApp();
    await startListening();
    expect(mocks.showToast).toHaveBeenCalledWith('2 supervisors are already listening to that call.', 'error');
  });

  it('listening to another call stops the first', async () => {
    await renderApp();
    const first = await startListening('c-1');
    act(() => first.ready());
    await startListening('c-2');
    expect(first.sent).toEqual([{ event: 'stop' }]);
    expect(mocks.grantListen).toHaveBeenLastCalledWith('c-2', 't-1', 'a-1');
  });

  it('switching account (the provider re-keyed) ends the listen', async () => {
    const view = await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    view.rerender(<App account="a-2" />);
    expect(ws.sent).toEqual([{ event: 'stop' }]);
    expect(ws.closed).toBe(1000);
    expect(FakeAudioContext.all[0]!.state).toBe('closed');
    expect(screen.queryByTestId('listen-bar')).toBeNull();
  });

  it('leaving the shell (unmount) ends the listen', async () => {
    const view = await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    view.unmount();
    expect(ws.sent).toEqual([{ event: 'stop' }]);
    expect(ws.closed).toBe(1000);
    expect(FakeAudioContext.all[0]!.state).toBe('closed');
  });

  it('at phone width: the dot, the timer and Stop, with the notice', async () => {
    mocks.compact = true;
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    expect(screen.getByTestId('listen-bar').getAttribute('data-compact')).toBe('true');
    expect(screen.getByTestId('listen-timer').textContent).toBe('03:42');
    expect(screen.queryByTestId('listen-meter-agent')).toBeNull();
    expect(screen.queryByTestId('listen-volume')).toBeNull();
    expect(screen.getByTestId('listen-stop').textContent).toBe('Stop');
    expect(screen.getByTestId('listen-notice')).toBeTruthy();
    fireEvent.click(screen.getByTestId('listen-stop'));
    expect(ws.sent).toEqual([{ event: 'stop' }]);
  });
});

describe('the audio when a listen ends (K7)', () => {
  beforeEach(() => {
    window.localStorage.setItem(LISTEN_CONFIRMED_KEY, '1');
  });

  it.each([
    ['Stop', (ws: FakeWs) => fireEvent.click(screen.getByTestId('listen-stop')) && ws],
    ['superseded (4409)', (ws: FakeWs) => act(() => ws.serverClose(4409, 'superseded'))],
    ['revoked (4403)', (ws: FakeWs) => act(() => ws.serverClose(4403, 'permission_revoked'))],
  ] as const)('%s: what is queued stops at once and the context is suspended', async (_name, end) => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    audioFrame(ws, 1);
    audioFrame(ws, 2);
    audioFrame(ws, 1);
    const ctx = FakeAudioContext.all[0]!;
    expect(ctx.state).toBe('running');
    end(ws);
    expect(ctx.sourcesStopped).toBe(3);
    expect(ctx.state).toBe('suspended');
    expect(ctx.state).not.toBe('closed');
  });

  it('the next Listen runs the suspended context again', async () => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    fireEvent.click(screen.getByTestId('listen-stop'));
    expect(FakeAudioContext.all[0]!.state).toBe('suspended');
    await startListening();
    expect(FakeAudioContext.all).toHaveLength(1);
    expect(FakeAudioContext.all[0]!.state).toBe('running');
  });

  it.each([
    ['no Web Audio at all', () => vi.stubGlobal('AudioContext', undefined)],
    ['a context the browser refuses to make', () => {
      mocks.audioThrows = true;
    }],
  ])('%s: Listen says so in a toast, mints no grant and shows no bar', async (_name, arrange) => {
    arrange();
    await renderApp();
    await act(async () => {
      fireEvent.click(screen.getByTestId('live-call-listen-c-1'));
    });
    expect(mocks.showToast).toHaveBeenCalledWith('This browser cannot play the call’s sound, so you cannot listen here.', 'error');
    expect(mocks.grantListen).not.toHaveBeenCalled();
    expect(screen.queryByTestId('listen-bar')).toBeNull();
  });
});

describe('focus and announcements (K9)', () => {
  beforeEach(() => {
    window.localStorage.setItem(LISTEN_CONFIRMED_KEY, '1');
  });

  it('Listen moves focus into the bar (Esc stops from there), and it comes back to the row’s Listen', async () => {
    await renderApp();
    const listenButton = screen.getByTestId('live-call-listen-c-1');
    act(() => listenButton.focus());
    const ws = await startListening();
    // The Listen button gave way to "Connecting…": focus is on the bar, not lost to the page.
    expect(bar().contains(document.activeElement)).toBe(true);
    act(() => ws.ready());
    expect(bar().contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByTestId('listen-bar')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('live-call-listen-c-1'));
  });

  it('the row’s Stop gives focus back to the row’s Listen', async () => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    const stop = screen.getByTestId('live-call-stop-c-1');
    act(() => stop.focus());
    fireEvent.click(stop);
    expect(document.activeElement).toBe(screen.getByTestId('live-call-listen-c-1'));
  });

  it('the bar going by itself (6 s after the call ended) gives focus back too', async () => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    act(() => ws.frame({ event: 'ended', reason: 'call_ended' }));
    expect(bar().contains(document.activeElement)).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(screen.queryByTestId('listen-bar')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('live-call-listen-c-1'));
  });

  it('leaves focus alone when the supervisor has moved on', async () => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    const filter = screen.getByTestId('live-calls-agent-filter');
    act(() => filter.focus());
    act(() => ws.serverClose(4409, 'superseded'));
    expect(document.activeElement).toBe(filter);
    fireEvent.click(screen.getByTestId('listen-dismiss'));
    expect(document.activeElement).toBe(filter);
  });

  it.each([
    ['full width', false],
    ['phone width', true],
  ])('the reason a listen ended is inside the live region (%s)', async (_name, compact) => {
    mocks.compact = compact;
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    act(() => ws.serverClose(4403, 'permission_revoked'));
    const line = screen.getByTestId('listen-ended-line');
    expect(line.textContent).toBe('You no longer have access to listen to calls.');
    expect(line.closest('[role="status"]')).not.toBeNull();
  });

  it('a call gone before the first ready (4404) says it ended before you joined, not "you listened for 00:00"', async () => {
    await renderApp();
    const ws = await startListening();
    act(() => ws.serverClose(4404, 'listen_call_not_live'));
    expect(screen.getByTestId('listen-ended-line').textContent).toBe('The call ended before you joined.');
  });
});

describe('analytics never see the call (K4, CH6)', () => {
  it('the bar (agent, masked number, campaign) is inside a ph-no-capture boundary', async () => {
    window.localStorage.setItem(LISTEN_CONFIRMED_KEY, '1');
    await renderApp();
    const ws = await startListening();
    act(() => ws.ready());
    expect(bar().classList.contains('ph-no-capture')).toBe(true);
  });
});
