import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { liveCall } from '../helpers/liveCalls';

/**
 * The console shell's listen as `ConsoleLayout` really wires it (`docs/listening.md` §9): one
 * `ListenProvider` around the shell, keyed by the account, with the listening bar docked under
 * `<main>` (outside it, so a page's remount on the account key cannot take it). A listen carries
 * on across the shell's pages, and ends (`stop`, the socket closed, the audio context closed)
 * when the reader switches account or leaves the shell.
 */

const mocks = vi.hoisted(() => ({
  accountId: 'a-1',
  grantListen: vi.fn(),
}));

vi.mock('../../hooks/usePostHogIdentify', () => ({ usePostHogIdentify: () => {} }));
vi.mock('../../analytics/useProductSurface', () => ({ useProductSurface: () => {} }));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 't-1', accountId: mocks.accountId, role: 'account_admin' }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (f: string) => f === 'agency_live_listen_enabled', status: 'ready' }),
}));
vi.mock('../../api/liveCalls', () => ({
  listLiveCalls: vi.fn(),
  revealLiveCallNumber: vi.fn(),
  grantListen: mocks.grantListen,
}));
vi.mock('../../components/layout/ConsoleTopBar', () => ({ ConsoleTopBar: () => <div /> }));
vi.mock('../../components/layout/ConsoleSidebar', () => ({ ConsoleSidebar: () => <div /> }));
vi.mock('../../components/common/GlobalSearch', () => ({ GlobalSearch: () => null }));

import { ConsoleLayout } from '../../components/layout/ConsoleLayout';
import { LISTEN_CONFIRMED_KEY, useListen } from '../../components/listen/ListenProvider';

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
    this.onmessage?.({ data: JSON.stringify({ event: 'ready', listen_id: 'l-1', call_id: 'c-1', format: 'alaw8', frame_bytes: 160 }) });
  }
}

class FakeAudioContext {
  static all: FakeAudioContext[] = [];
  state: AudioContextState = 'running';
  currentTime = 0;
  destination = {};
  onstatechange: (() => void) | null = null;
  constructor() {
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
    return { connect: () => {}, start: () => {}, stop: () => {}, buffer: null, onended: null };
  }
  async resume() {
    this.state = 'running';
  }
  async suspend() {
    this.state = 'suspended';
  }
  async close() {
    this.state = 'closed';
  }
}

/** A page of the shell with a Listen button and a link to another page. */
function PageWithListen() {
  const listen = useListen();
  return (
    <div>
      <button type="button" onClick={() => listen?.listen(liveCall({ call_id: 'c-1' }), 0)}>
        Listen here
      </button>
      <Link to="/agency/other">Other page</Link>
    </div>
  );
}

function Tree() {
  return (
    <MemoryRouter initialEntries={['/agency/live']}>
      <Routes>
        <Route element={<ConsoleLayout />}>
          <Route path="/agency/live" element={<PageWithListen />} />
          <Route path="/agency/other" element={<Link to="/station">Go to the station</Link>} />
        </Route>
        <Route path="/station" element={<div>Station (outside the shell)</div>} />
      </Routes>
    </MemoryRouter>
  );
}

async function listenAndGoLive() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Listen here' }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const ws = FakeWs.all[FakeWs.all.length - 1]!;
  act(() => ws.ready());
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  FakeWs.all = [];
  FakeAudioContext.all = [];
  mocks.accountId = 'a-1';
  mocks.grantListen.mockReset().mockResolvedValue({
    ok: true,
    grant: { listen_id: 'l-1', ws_url: '/proxy/agency/listen/s-1/l-1?token=tok', expires_at: '2026-11-16T10:11:00Z' },
  });
  vi.stubGlobal('WebSocket', FakeWs);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  window.localStorage.clear();
  window.localStorage.setItem(LISTEN_CONFIRMED_KEY, '1');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ConsoleLayout — the shell’s listen', () => {
  it('docks the bar under <main>, outside it, and keeps the listen across the shell’s pages', async () => {
    render(<Tree />);
    const ws = await listenAndGoLive();
    const bar = screen.getByTestId('listen-bar');
    const main = screen.getByRole('main');
    expect(main.contains(bar)).toBe(false);
    expect(main.nextElementSibling).toBe(bar);
    expect(screen.getByTestId('listen-status').textContent).toBe('Listening');

    fireEvent.click(screen.getByRole('link', { name: 'Other page' }));
    expect(screen.getByRole('link', { name: 'Go to the station' })).toBeTruthy();
    expect(screen.getByTestId('listen-bar')).toBe(bar);
    expect(ws.sent).toEqual([]);
    expect(ws.closed).toBeNull();
    expect(FakeAudioContext.all[0]!.state).toBe('running');
  });

  it('switching account ends the listen: stop, the socket closed, the audio context closed', async () => {
    const view = render(<Tree />);
    const ws = await listenAndGoLive();
    mocks.accountId = 'a-2';
    view.rerender(<Tree />);
    expect(ws.sent).toEqual([{ event: 'stop' }]);
    expect(ws.closed).toBe(1000);
    expect(FakeAudioContext.all[0]!.state).toBe('closed');
    expect(screen.queryByTestId('listen-bar')).toBeNull();
  });

  it('leaving the shell ends the listen the same way', async () => {
    render(<Tree />);
    const ws = await listenAndGoLive();
    fireEvent.click(screen.getByRole('link', { name: 'Other page' }));
    fireEvent.click(screen.getByRole('link', { name: 'Go to the station' }));
    expect(screen.getByText('Station (outside the shell)')).toBeTruthy();
    expect(ws.sent).toEqual([{ event: 'stop' }]);
    expect(ws.closed).toBe(1000);
    expect(FakeAudioContext.all[0]!.state).toBe('closed');
    expect(screen.queryByTestId('listen-bar')).toBeNull();
  });
});
