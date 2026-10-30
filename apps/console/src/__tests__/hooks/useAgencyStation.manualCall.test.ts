import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ mintStationToken: vi.fn() }));
vi.mock('../../api/agency', () => ({ mintStationToken: mocks.mintStationToken }));

import { useAgencyStation, type StationSocketBootstrap } from '../../hooks/useAgencyStation';
import { FakeSocket, latestSocket } from '../helpers/fakeSocket';
import { manualCall, step } from '../helpers/softphone';

/**
 * `manual_call` on the station socket (`docs/softphone.md` §4.1 step 5): every
 * state change of a soft-phone call, the whole row. The station surfaces it as
 * `manualCall` for the soft phone to read, and connects for a soft-phone session
 * that has no campaign at all — the bootstrap it needs is the socket's, not a
 * campaign's.
 */

const SOFTPHONE_SOCKET: StationSocketBootstrap = {
  session_id: 'sess-sp',
  station_ws_url: '/proxy/agency/station/sess-sp?token=t1',
  intervals: { heartbeat_ms: 10_000, heartbeat_grace_ms: 30_000, reservation_lease_ms: 10_000, countdown_ms: 3000 },
  campaign_id: null,
};

describe('useAgencyStation — manual_call frames', () => {
  const mounted: Array<{ unmount: () => void }> = [];

  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  });
  afterEach(() => {
    mounted.splice(0).forEach((m) => m.unmount());
    vi.unstubAllGlobals();
  });

  function mount() {
    const hook = renderHook(() => useAgencyStation(SOFTPHONE_SOCKET, { tenantId: 't', accountId: 'a' }));
    mounted.push(hook);
    act(() => latestSocket().open());
    return hook;
  }

  it('connects a soft-phone session on its own upgrade URL', () => {
    mount();
    expect(latestSocket().url).toContain('/proxy/agency/station/sess-sp?token=t1');
  });

  it('holds the newest row and ignores an older one', () => {
    const { result } = mount();
    const queued = manualCall();
    const ringing = step(queued, 2, { state: 'ringing' });
    act(() => latestSocket().emit({ event: 'manual_call', call: queued }));
    expect(result.current.manualCall?.state).toBe('queued');
    act(() => latestSocket().emit({ event: 'manual_call', call: ringing }));
    act(() => latestSocket().emit({ event: 'manual_call', call: queued }));
    expect(result.current.manualCall?.state).toBe('ringing');
  });

  it('costs one frame, not the socket, for a malformed one', () => {
    const { result } = mount();
    act(() => latestSocket().emit({ event: 'manual_call' }));
    act(() => latestSocket().emit({ event: 'manual_call', call: { state: 'ringing' } }));
    expect(result.current.manualCall).toBeNull();
    act(() => latestSocket().emit({ event: 'manual_call', call: manualCall() }));
    expect(result.current.manualCall?.id).toBe('mc-1');
  });

  it('keeps the call through a ready snapshot — the server re-sends it after reattaching', () => {
    const { result } = mount();
    act(() => latestSocket().emit({ event: 'manual_call', call: step(manualCall(), 5, { state: 'bridged', bridged_at: '2026-10-30T10:00:05Z' }) }));
    act(() => latestSocket().emit({ event: 'ready', session_id: 'sess-sp', state: 'break' }));
    expect(result.current.manualCall?.state).toBe('bridged');
    expect(result.current.agentState).toBe('break');
  });

  it('asks before the tab closes over a live soft-phone call (the agent state alone is `break`)', () => {
    mount();
    act(() => latestSocket().emit({ event: 'ready', session_id: 'sess-sp', state: 'break' }));
    act(() => latestSocket().emit({ event: 'manual_call', call: step(manualCall(), 5, { state: 'bridged', bridged_at: '2026-10-30T10:00:05Z' }) }));
    const live = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(live);
    expect(live.defaultPrevented).toBe(true);

    act(() => latestSocket().emit({ event: 'manual_call', call: step(manualCall(), 9, { state: 'ended', requires_disposition: true }) }));
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});
