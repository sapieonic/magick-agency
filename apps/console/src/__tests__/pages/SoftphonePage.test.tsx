import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
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
  setActiveAccountId: vi.fn(),
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

/** The agent's two accounts in the workspace: this one, and a sibling. */
const ACCOUNTS = [
  { id: 'a-1', name: 'Head Office', tenant_id: 't-1' },
  { id: 'a-2', name: 'North Region', tenant_id: 't-1' },
];

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
  mocks.useTenant.mockReturnValue({
    tenantId: 't-1', accountId: 'a-1', role: 'agent', accounts: ACCOUNTS, setActiveAccountId: mocks.setActiveAccountId,
  });
  mocks.openSoftphoneSession.mockResolvedValue({ ok: true, value: SESSION });
  mocks.getSoftphoneBootstrap.mockResolvedValue({ ...BOOTSTRAP, session: { session_id: 'sess-sp', account_id: 'a-1', kind: 'softphone', campaign_id: null, campaign_name: null, state: 'break', break_reason: 'soft_phone', on_softphone: true } });
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

  describe('a reload mid-call keeps the call details the agent typed', () => {
    const SP_SESSION = { session_id: 'sess-sp', account_id: 'a-1', kind: 'softphone', campaign_id: null, campaign_name: null, state: 'break', break_reason: 'soft_phone', on_softphone: true };
    const typed = { customer_name: 'Rahul Verma', reason: 'Rate query' };
    const live = step(manualCall({ fields: typed, notes: 'Asked about rates' }), 9, {
      state: 'bridged',
      bridged_at: '2026-10-30T10:00:09Z',
    });

    async function typeNote(text: string) {
      mocks.updateManualCall.mockClear();
      fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: text } });
      await waitFor(() => expect(mocks.updateManualCall).toHaveBeenCalled(), { timeout: 2000 });
      return mocks.updateManualCall.mock.calls[0]![1] as Record<string, unknown>;
    }

    beforeEach(() => {
      mocks.updateManualCall.mockResolvedValue({ ok: true, value: live });
    });

    it('the frame before the bootstrap: notes save alone, then the fields come back with the set', async () => {
      let resolveBootstrap!: (value: unknown) => void;
      mocks.getSoftphoneBootstrap.mockReturnValue(new Promise((resolve) => (resolveBootstrap = resolve)));
      await mount();
      await act(async () => latestSocket().open());
      await act(async () => latestSocket().emit({ event: 'manual_call', call: live }));
      expect(screen.getByTestId('rail-label').textContent).toBe('On call');
      expect(screen.getByTestId('call-fields-loading')).toBeTruthy();

      // No field set yet: `fields` would replace the stored values, so it is not sent.
      const early = await typeNote('Asked about rates, wants it in writing');
      expect(early).toEqual({ notes: 'Asked about rates, wants it in writing' });

      await act(async () => resolveBootstrap({ ...BOOTSTRAP, session: SP_SESSION, call: live }));
      expect((screen.getByTestId('call-field-customer_name') as HTMLInputElement).value).toBe('Rahul Verma');
      expect((screen.getByTestId('call-field-reason') as HTMLSelectElement).value).toBe('Rate query');

      const later = await typeNote('Asked about rates, wants it in writing today');
      expect(later).toEqual({ fields: typed, notes: 'Asked about rates, wants it in writing today' });
    });

    it('the bootstrap before the frame: the frame’s values fill the form and are sent back', async () => {
      await mount();
      await act(async () => latestSocket().open());
      await act(async () => latestSocket().emit({ event: 'manual_call', call: live }));
      expect((screen.getByTestId('call-field-customer_name') as HTMLInputElement).value).toBe('Rahul Verma');
      expect((screen.getByTestId('call-field-reason') as HTMLSelectElement).value).toBe('Rate query');
      const sent = await typeNote('Asked about rates, wants it in writing');
      expect(sent).toEqual({ fields: typed, notes: 'Asked about rates, wants it in writing' });
    });
  });

  it('says, on the way to another screen, that the soft phone stays open', async () => {
    await mount();
    await act(async () => latestSocket().open());
    const link = screen.getByTestId('agent-nav-attempts');
    expect(link.closest('a')).not.toBeNull();
    const hint = document.getElementById(link.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toBe('Your soft phone stays open on other screens. Close it here when you’re done.');
    expect(link.getAttribute('title')).toBe(hint.textContent);
  });

  describe('with the soft phone turned off', () => {
    const SP_SESSION = { session_id: 'sess-sp', account_id: 'a-1', kind: 'softphone', campaign_id: null, campaign_name: null, state: 'break', break_reason: 'soft_phone', on_softphone: true };
    beforeEach(() => {
      mocks.flags = new Set();
    });

    it('with nothing to finish it is unavailable, as the route gate was, and opens no session', async () => {
      mocks.getSoftphoneBootstrap.mockResolvedValue({ ...BOOTSTRAP, softphone_enabled: false, session: null });
      await mount();
      expect(screen.getByText('Not available for your account')).toBeTruthy();
      expect(mocks.openSoftphoneSession).not.toHaveBeenCalled();
    });

    it('a server that refuses even the read is unavailable too', async () => {
      mocks.getSoftphoneBootstrap.mockRejectedValue(Object.assign(new Error('Forbidden'), { statusCode: 403 }));
      await mount();
      expect(screen.getByText('Not available for your account')).toBeTruthy();
      expect(mocks.openSoftphoneSession).not.toHaveBeenCalled();
    });

    it('reopens the session the agent still has, in finish mode: the call, no dial pad', async () => {
      const owed = manualCall({ state: 'ended', outcome: 'connected', requires_disposition: true, bridged_at: '2026-10-30T10:00:05Z' });
      mocks.getSoftphoneBootstrap.mockResolvedValue({ ...BOOTSTRAP, softphone_enabled: false, session: SP_SESSION, call: owed });
      await mount();
      expect(mocks.openSoftphoneSession).toHaveBeenCalledTimes(1);
      await act(async () => latestSocket().open());
      expect(screen.getByTestId('rail-label').textContent).toBe('Outcome needed');
      expect(screen.getByTestId('softphone-finish-notice').textContent).toMatch(/Finish this call; you can’t start new ones\./);
      expect(screen.queryByTestId('dial-number')).toBeNull();
    });

    /** The agent's session is in a sibling account (a-2): this account's bootstrap names it, without its call. */
    function sessionInSibling(owedThere: boolean) {
      const owed = manualCall({ state: 'ended', outcome: 'connected', requires_disposition: true, bridged_at: '2026-10-30T10:00:05Z' });
      const session = { ...SP_SESSION, account_id: 'a-2' };
      mocks.getSoftphoneBootstrap.mockImplementation(async (_tenant: string, account: string) =>
        account === 'a-2'
          ? { ...BOOTSTRAP, softphone_enabled: true, session, call: owedThere ? owed : null }
          : { ...BOOTSTRAP, softphone_enabled: false, session, call: null });
    }

    it('a session in another account of the workspace can be closed there, and says who can save an owed outcome', async () => {
      sessionInSibling(true);
      mocks.leaveAgencySession.mockResolvedValue(undefined);
      await mount();
      // This account cannot rehydrate it, so it is not asked to.
      expect(mocks.openSoftphoneSession).not.toHaveBeenCalled();
      const stranded = screen.getByTestId('softphone-stranded');
      expect(stranded.textContent).toMatch(/open in another account of this workspace/);
      // The call is read where the session lives.
      expect(mocks.getSoftphoneBootstrap).toHaveBeenCalledWith('t-1', 'a-2');
      expect(stranded.textContent).toMatch(/A supervisor can save it for you from Soft-phone calls\./);
      await act(async () => {
        fireEvent.click(screen.getByTestId('softphone-stranded-close'));
      });
      // `leave` is scoped to the session's account: this account's would be a 404.
      expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-sp', 't-1', 'a-2');
      expect(screen.getByTestId('where').textContent).toBe('/dialer?left=station');
    });

    it('a flag map gone stale (on here, off on the server) lands the same way', async () => {
      mocks.flags = new Set(['agency_softphone_enabled']);
      mocks.openSoftphoneSession.mockResolvedValue({ ok: false, refusal: { code: 'softphone_disabled', status: 403, message: 'x' } });
      mocks.getSoftphoneBootstrap.mockResolvedValue({ ...BOOTSTRAP, softphone_enabled: false, session: null });
      await mount();
      expect(screen.getByText('Not available for your account')).toBeTruthy();
      cleanup();
      sessionInSibling(false);
      await mount();
      const stranded = screen.getByTestId('softphone-stranded');
      expect(stranded.textContent).not.toMatch(/needs its outcome/);
    });
  });

  it('closes the soft phone: leaves the session and goes home', async () => {
    mocks.leaveAgencySession.mockResolvedValue(undefined);
    await mount();
    await act(async () => latestSocket().open());
    fireEvent.click(screen.getByTestId('softphone-close'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/Close the soft phone\?/);
    expect(dialog.textContent).toMatch(/takes you to My campaigns\. To call again, choose Soft phone at the top of the page\./);
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
        account_id: 'a-1',
        account_name: 'Head Office',
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
    // Its own account: the console stays where it is.
    expect(mocks.setActiveAccountId).not.toHaveBeenCalled();
  });

  it('says why when the switch is refused, and stays', async () => {
    mocks.openSoftphoneSession.mockResolvedValue({
      ok: false,
      refusal: {
        code: 'session_on_campaign', status: 409, message: 'x', session_id: 's', campaign_id: 'c', campaign_name: 'C',
        state: 'available', account_id: 'a-1', account_name: 'Head Office',
      },
    });
    mocks.switchToSoftphone.mockResolvedValue({ ok: false, refusal: { code: 'softphone_disabled', status: 403, message: 'x' } });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-switch-from-campaign'));
    });
    expect(screen.getByTestId('softphone-switch-failure').textContent).toMatch(/turned off for this account/);
  });

  describe('a soft-phone session open in another account of the workspace (the flag on here)', () => {
    const ELSEWHERE = {
      code: 'session_on_softphone', status: 409, message: 'x', session_id: 'sess-b', account_id: 'a-2', account_name: 'North Region',
    };
    /** That account's bootstrap names the session; `owed` puts an unsettled call on it. */
    function inSibling(owed: boolean) {
      const session = { session_id: 'sess-b', account_id: 'a-2', kind: 'softphone', campaign_id: null, campaign_name: null, state: 'break', break_reason: 'soft_phone', on_softphone: true };
      mocks.getSoftphoneBootstrap.mockImplementation(async (_t: string, account: string) => ({
        ...BOOTSTRAP,
        session,
        call: account === 'a-2' && owed
          ? manualCall({ state: 'ended', outcome: 'connected', requires_disposition: true, bridged_at: '2026-10-30T10:00:05Z' })
          : null,
      }));
    }

    it('says so, closes it with its own account, and opens the soft phone here', async () => {
      inSibling(false);
      mocks.openSoftphoneSession.mockResolvedValueOnce({ ok: false, refusal: ELSEWHERE }).mockResolvedValueOnce({ ok: true, value: SESSION });
      mocks.leaveAgencySession.mockResolvedValue(undefined);
      await mount();
      const screenEl = screen.getByTestId('softphone-elsewhere');
      expect(screenEl.textContent).toMatch(/Your soft phone is open in another account/);
      expect(screenEl.textContent).toMatch(/open in North Region\./);
      expect(FakeSocket.instances).toHaveLength(0);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Close it and open the soft phone here' }));
      });
      expect(mocks.getSoftphoneBootstrap).toHaveBeenCalledWith('t-1', 'a-2');
      expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-b', 't-1', 'a-2');
      expect(mocks.openSoftphoneSession).toHaveBeenCalledTimes(2);
      expect(mocks.openSoftphoneSession.mock.calls[1]).toEqual(['t-1', 'a-1']);
      expect(screen.queryByTestId('softphone-elsewhere')).toBeNull();
      expect(latestSocket().url).toContain('sess-sp');
    });

    it('closes nothing while its call is unfinished, says why, and offers that account', async () => {
      inSibling(true);
      mocks.openSoftphoneSession.mockResolvedValue({ ok: false, refusal: ELSEWHERE });
      await mount();
      await act(async () => {
        fireEvent.click(screen.getByTestId('softphone-elsewhere-close'));
      });
      expect(mocks.leaveAgencySession).not.toHaveBeenCalled();
      expect(mocks.openSoftphoneSession).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('softphone-elsewhere-call-pending').textContent).toBe(
        'Your soft phone in North Region has a call that isn’t finished, so it’s still open. Hang up and save its outcome there first.',
      );
      expect(screen.queryByTestId('softphone-elsewhere-close')).toBeNull();
      const goThere = screen.getByRole('button', { name: 'Use the soft phone in North Region' });
      expect(document.activeElement).toBe(goThere);
      fireEvent.click(goThere);
      expect(mocks.setActiveAccountId).toHaveBeenCalledWith('a-2');
    });

    it('a call the server refuses to leave over (agent_on_live_call) says the same', async () => {
      inSibling(false);
      mocks.openSoftphoneSession.mockResolvedValue({ ok: false, refusal: ELSEWHERE });
      mocks.leaveAgencySession.mockRejectedValue(
        Object.assign(new Error('Conflict'), { statusCode: 409, details: { code: 'agent_on_live_call', message: 'Hang up first.' } }),
      );
      await mount();
      await act(async () => {
        fireEvent.click(screen.getByTestId('softphone-elsewhere-close'));
      });
      expect(screen.getByTestId('softphone-elsewhere-call-pending')).toBeTruthy();
      expect(mocks.openSoftphoneSession).toHaveBeenCalledTimes(1);
    });

    it('any other failure to leave keeps the screen and says the soft phone is still open', async () => {
      inSibling(false);
      mocks.openSoftphoneSession.mockResolvedValue({ ok: false, refusal: ELSEWHERE });
      mocks.leaveAgencySession.mockRejectedValue(Object.assign(new Error('Service Unavailable'), { statusCode: 503 }));
      await mount();
      await act(async () => {
        fireEvent.click(screen.getByTestId('softphone-elsewhere-close'));
      });
      expect(screen.getByTestId('softphone-elsewhere-failure').textContent).toBe('Your soft phone is still open — Service Unavailable');
      expect((screen.getByTestId('softphone-elsewhere-close') as HTMLButtonElement).disabled).toBe(false);
      expect(mocks.openSoftphoneSession).toHaveBeenCalledTimes(1);
    });

    it('without the account in the console\'s list: named from the refusal, closable, nowhere to switch to', async () => {
      mocks.useTenant.mockReturnValue({
        tenantId: 't-1', accountId: 'a-1', role: 'agent', accounts: [ACCOUNTS[0]], setActiveAccountId: mocks.setActiveAccountId,
      });
      mocks.openSoftphoneSession.mockResolvedValue({ ok: false, refusal: { ...ELSEWHERE, account_name: null } });
      await mount();
      expect(screen.getByTestId('softphone-elsewhere').textContent).toMatch(/open in another account of this workspace/);
      expect(screen.getByTestId('softphone-elsewhere-close')).toBeTruthy();
      expect(screen.queryByTestId('softphone-elsewhere-go-there')).toBeNull();
    });
  });

  it('any other refusal is a screen with a way to try again', async () => {
    // (`softphone_disabled` is not one: that is the turned-off path above.)
    mocks.openSoftphoneSession.mockResolvedValueOnce({ ok: false, refusal: { code: 'unknown', raw_code: null, status: 503, message: 'Service Unavailable' } });
    await mount();
    expect(screen.getByRole('alert').textContent).toMatch(/Can’t open the soft phone/);
    mocks.openSoftphoneSession.mockResolvedValueOnce({ ok: true, value: SESSION });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(latestSocket().url).toContain('sess-sp');
  });
});
