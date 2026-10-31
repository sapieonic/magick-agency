import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  openSoftphoneSession: vi.fn(),
  getSoftphoneBootstrap: vi.fn(),
  listManualCalls: vi.fn(),
  placeManualCall: vi.fn(),
  useTenant: vi.fn(),
  audio: {
    sink: { onMedia: () => {} },
    sync: vi.fn(),
    preflight: vi.fn(),
    resume: vi.fn(),
    toggleMute: vi.fn(),
    muted: false,
    sending: false,
    error: null,
  },
}));
vi.mock('../../api/softphone', () => ({
  openSoftphoneSession: mocks.openSoftphoneSession,
  switchToSoftphone: vi.fn(),
  getSoftphoneBootstrap: mocks.getSoftphoneBootstrap,
  listManualCalls: mocks.listManualCalls,
  placeManualCall: mocks.placeManualCall,
  updateManualCall: vi.fn(),
  hangupManualCall: vi.fn(),
  dispositionManualCall: vi.fn(),
  markManualCallDnc: vi.fn(),
}));
vi.mock('../../api/agency', () => ({ mintStationToken: vi.fn(), leaveAgencySession: vi.fn() }));
vi.mock('../../hooks/useAgencyAudio', () => ({ useAgencyAudio: () => mocks.audio }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', display_name: 'Priya Nair', email: 'priya@example.com', avatar_url: null } }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => flag === 'agency_softphone_enabled' }),
}));

import SoftphonePage from '../../pages/agency/SoftphonePage';
import { FakeSocket, latestSocket } from '../helpers/fakeSocket';
import { BOOTSTRAP, manualCall } from '../helpers/softphone';

/**
 * `/dialer/phone`'s audio preflight. The station warms its playback context and
 * probes the microphone on "Go available"; this page has no such button, so the
 * agent's first gesture on the page does it — before anything is dialled, so the
 * permission prompt never lands while a customer's phone is ringing, and the
 * playback context is not first created (suspended) from a socket frame.
 */

const SESSION = {
  session_id: 'sess-sp',
  kind: 'softphone',
  state: 'break',
  break_reason: 'soft_phone',
  station_ws_url: '/proxy/agency/station/sess-sp?token=t1',
  station_token_expires_at: '2026-10-30T10:02:00Z',
  intervals: { heartbeat_ms: 10_000, heartbeat_grace_ms: 30_000, reservation_lease_ms: 10_000, countdown_ms: 3000 },
};

async function mount() {
  render(
    <MemoryRouter initialEntries={['/dialer/phone']}>
      <Routes>
        <Route path="/dialer/phone" element={<SoftphonePage />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => latestSocket().open());
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  for (const fn of [mocks.openSoftphoneSession, mocks.getSoftphoneBootstrap, mocks.listManualCalls, mocks.placeManualCall, mocks.useTenant]) fn.mockReset();
  for (const fn of [mocks.audio.sync, mocks.audio.preflight, mocks.audio.resume, mocks.audio.toggleMute]) fn.mockReset();
  mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role: 'agent' });
  mocks.openSoftphoneSession.mockResolvedValue({ ok: true, value: SESSION });
  mocks.getSoftphoneBootstrap.mockResolvedValue(BOOTSTRAP);
  mocks.listManualCalls.mockResolvedValue({ rows: [], next_cursor: null, limit: 8 });
  mocks.placeManualCall.mockResolvedValue({ ok: true, value: manualCall() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/dialer/phone audio preflight', () => {
  it('waits for a gesture, then warms and probes once — on the first key, before the Call', async () => {
    await mount();
    expect(screen.getByTestId('rail-label').textContent).toBe('Ready to dial');
    // Nothing on open: a context made without a gesture starts suspended.
    expect(mocks.audio.preflight).not.toHaveBeenCalled();

    for (const key of '9820461733') fireEvent.keyDown(window, { key });
    expect(mocks.audio.preflight).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId('dial-call'));
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    expect(mocks.placeManualCall).toHaveBeenCalledTimes(1);
    expect(mocks.audio.preflight).toHaveBeenCalledTimes(1);
    expect(mocks.audio.preflight.mock.invocationCallOrder[0]!).toBeLessThan(mocks.placeManualCall.mock.invocationCallOrder[0]!);
    // The Call press still resumes both contexts.
    expect(mocks.audio.resume).toHaveBeenCalled();
  });

  it('a pointer press anywhere on the page counts as the first gesture', async () => {
    await mount();
    fireEvent.pointerDown(screen.getByTestId('softphone-body'));
    expect(mocks.audio.preflight).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(screen.getByTestId('softphone-body'));
    expect(mocks.audio.preflight).toHaveBeenCalledTimes(1);
  });

  it('a Call activated with no pointer or key before it preflights before it dials', async () => {
    await mount();
    fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
    expect(mocks.audio.preflight).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    expect(mocks.audio.preflight).toHaveBeenCalledTimes(1);
    expect(mocks.audio.preflight.mock.invocationCallOrder[0]!).toBeLessThan(mocks.placeManualCall.mock.invocationCallOrder[0]!);
  });
});
