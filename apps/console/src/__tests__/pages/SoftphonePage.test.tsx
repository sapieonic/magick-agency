import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  openSoftphoneSession: vi.fn(),
  switchToSoftphone: vi.fn(),
  getSoftphoneBootstrap: vi.fn(),
  listManualCalls: vi.fn(),
  placeManualCall: vi.fn(),
  updateManualCall: vi.fn(),
  hangupManualCall: vi.fn(),
  dispositionManualCall: vi.fn(),
  markManualCallDnc: vi.fn(),
  mintStationToken: vi.fn(),
  leaveAgencySession: vi.fn(),
  useTenant: vi.fn(),
  flags: new Set<string>(),
}));
vi.mock('../../api/softphone', () => ({
  openSoftphoneSession: mocks.openSoftphoneSession,
  switchToSoftphone: mocks.switchToSoftphone,
  getSoftphoneBootstrap: mocks.getSoftphoneBootstrap,
  listManualCalls: mocks.listManualCalls,
  placeManualCall: mocks.placeManualCall,
  updateManualCall: mocks.updateManualCall,
  hangupManualCall: mocks.hangupManualCall,
  dispositionManualCall: mocks.dispositionManualCall,
  markManualCallDnc: mocks.markManualCallDnc,
}));
vi.mock('../../api/agency', () => ({
  mintStationToken: mocks.mintStationToken,
  leaveAgencySession: mocks.leaveAgencySession,
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', display_name: 'Priya Nair', email: 'priya@example.com', avatar_url: null } }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) }),
}));

import SoftphonePage from '../../pages/agency/SoftphonePage';
import { FakeSocket, latestSocket } from '../helpers/fakeSocket';
import { BOOTSTRAP, manualCall, step } from '../helpers/softphone';

/**
 * `/dialer/phone`: open a soft-phone session, connect the station socket for
 * it, and run the soft phone on that socket — or, for an agent still at a
 * campaign station, offer the switch on THAT session (§4.2).
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

function Where() {
  const location = useLocation();
  return <span data-testid="where">{location.pathname + location.search}</span>;
}

async function mount() {
  render(
    <MemoryRouter initialEntries={['/dialer/phone']}>
      <Routes>
        <Route path="/dialer/phone" element={<SoftphonePage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  Object.values(mocks).forEach((m) => (typeof m === 'function' && 'mockReset' in m ? m.mockReset() : undefined));
  mocks.flags = new Set(['agency_softphone_enabled']);
  mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role: 'agent' });
  mocks.openSoftphoneSession.mockResolvedValue({ ok: true, value: SESSION });
  mocks.getSoftphoneBootstrap.mockResolvedValue({ ...BOOTSTRAP, session: { session_id: 'sess-sp', kind: 'softphone', campaign_id: null, campaign_name: null, state: 'break', break_reason: 'soft_phone', on_softphone: true } });
  mocks.listManualCalls.mockResolvedValue({ rows: [], next_cursor: null, limit: 8 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('/dialer/phone', () => {
  it('opens a soft-phone session and connects its station socket', async () => {
    await mount();
    expect(mocks.openSoftphoneSession).toHaveBeenCalledWith('t-1', 'a-1');
    expect(latestSocket().url).toContain('/proxy/agency/station/sess-sp?token=t1');
    expect(screen.getByTestId('rail-label').textContent).toBe('Connecting your phone…');
    await act(async () => latestSocket().open());
    expect(screen.getByTestId('rail-label').textContent).toBe('Ready to dial');
    // The agent's screens, with the soft phone as the current one.
    expect(screen.getByTestId('agent-nav-phone').getAttribute('aria-current')).toBe('page');
  });

  it('mints a token first when the session answers without one', async () => {
    mocks.openSoftphoneSession.mockResolvedValue({ ok: true, value: { ...SESSION, station_ws_url: '/proxy/agency/station/sess-sp' } });
    mocks.mintStationToken.mockResolvedValue({ session_id: 'sess-sp', station_ws_url: '/proxy/agency/station/sess-sp?token=fresh', expires_at: 'x' });
    await mount();
    expect(mocks.mintStationToken).toHaveBeenCalledWith('sess-sp', 't-1', 'a-1');
    expect(latestSocket().url).toContain('token=fresh');
  });

  it('runs the call off the socket’s manual_call frames, and locks the way out while it is unsettled', async () => {
    await mount();
    await act(async () => latestSocket().open());
    await act(async () => latestSocket().emit({ event: 'manual_call', call: step(manualCall(), 2, { state: 'ringing' }) }));
    expect(screen.getByTestId('rail-label').textContent).toBe('Ringing +91 98204 61733');
    expect((screen.getByTestId('softphone-close') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('agent-nav-attempts').getAttribute('data-locked')).toBe('true');
    expect(screen.getByTestId('agent-nav-attempts').closest('a')).toBeNull();

    await act(async () =>
      latestSocket().emit({ event: 'manual_call', call: step(manualCall(), 9, { state: 'bridged', bridged_at: '2026-10-30T10:00:09Z' }) }),
    );
    expect(screen.getByTestId('rail-label').textContent).toBe('On call');
  });

  it('closes the soft phone: leaves the session and goes home', async () => {
    mocks.leaveAgencySession.mockResolvedValue(undefined);
    await mount();
    await act(async () => latestSocket().open());
    fireEvent.click(screen.getByTestId('softphone-close'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/Close the soft phone\?/);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close soft phone' }));
    });
    expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-sp', 't-1', 'a-1');
    expect(screen.getByTestId('where').textContent).toBe('/dialer?left=station');
  });

  it('an agent at a campaign station is offered the switch on that session', async () => {
    mocks.openSoftphoneSession.mockResolvedValue({
      ok: false,
      refusal: {
        code: 'session_on_campaign',
        status: 409,
        message: 'x',
        session_id: 'sess-camp',
        campaign_id: 'camp-1',
        campaign_name: 'Home Loan Renewals',
        state: 'on_call',
      },
    });
    mocks.switchToSoftphone.mockResolvedValue({ ok: true, value: { session_id: 'sess-camp', state: 'on_call', pending_state: 'break', break_reason: 'soft_phone' } });
    await mount();
    const screenEl = screen.getByTestId('softphone-on-campaign');
    expect(screenEl.textContent).toMatch(/You’re still at the Home Loan Renewals station/);
    expect(screenEl.textContent).toMatch(/switches after this call and its wrap-up/);
    expect(screen.getByTestId('softphone-go-to-station').getAttribute('href')).toBe('/station?campaign=camp-1');
    expect(FakeSocket.instances).toHaveLength(0);
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-switch-from-campaign'));
    });
    expect(mocks.switchToSoftphone).toHaveBeenCalledWith('sess-camp', 't-1', 'a-1');
    expect(screen.getByTestId('where').textContent).toBe('/station?campaign=camp-1');
  });

  it('says why when the switch is refused, and stays', async () => {
    mocks.openSoftphoneSession.mockResolvedValue({
      ok: false,
      refusal: { code: 'session_on_campaign', status: 409, message: 'x', session_id: 's', campaign_id: 'c', campaign_name: 'C', state: 'available' },
    });
    mocks.switchToSoftphone.mockResolvedValue({ ok: false, refusal: { code: 'softphone_disabled', status: 403, message: 'x' } });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-switch-from-campaign'));
    });
    expect(screen.getByTestId('softphone-switch-failure').textContent).toMatch(/turned off for this account/);
  });

  it('any other refusal is a screen with a way to try again', async () => {
    mocks.openSoftphoneSession.mockResolvedValueOnce({ ok: false, refusal: { code: 'softphone_disabled', status: 403, message: 'x' } });
    await mount();
    expect(screen.getByRole('alert').textContent).toMatch(/Can’t open the soft phone/);
    mocks.openSoftphoneSession.mockResolvedValueOnce({ ok: true, value: SESSION });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(latestSocket().url).toContain('sess-sp');
  });
});
