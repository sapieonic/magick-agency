import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  createAgencySession: vi.fn(),
  mintStationToken: vi.fn(),
  setAgentAvailable: vi.fn(),
  setAgentBreak: vi.fn(),
  cancelQueuedBreak: vi.fn(),
  submitDisposition: vi.fn(),
  saveAttemptNotes: vi.fn(),
  hangupAttempt: vi.fn(),
  leaveAgencySession: vi.fn(),
  switchToSoftphone: vi.fn(),
  returnFromSoftphone: vi.fn(),
  getSoftphoneBootstrap: vi.fn(),
  listManualCalls: vi.fn(),
  placeManualCall: vi.fn(),
  updateManualCall: vi.fn(),
  hangupManualCall: vi.fn(),
  dispositionManualCall: vi.fn(),
  markManualCallDnc: vi.fn(),
  useTenant: vi.fn(),
  flags: new Set<string>(),
}));
vi.mock('../../api/agency', () => ({
  createAgencySession: mocks.createAgencySession,
  mintStationToken: mocks.mintStationToken,
  setAgentAvailable: mocks.setAgentAvailable,
  setAgentBreak: mocks.setAgentBreak,
  cancelQueuedBreak: mocks.cancelQueuedBreak,
  submitDisposition: mocks.submitDisposition,
  saveAttemptNotes: mocks.saveAttemptNotes,
  hangupAttempt: mocks.hangupAttempt,
  leaveAgencySession: mocks.leaveAgencySession,
}));
vi.mock('../../api/softphone', () => ({
  switchToSoftphone: mocks.switchToSoftphone,
  returnFromSoftphone: mocks.returnFromSoftphone,
  getSoftphoneBootstrap: mocks.getSoftphoneBootstrap,
  listManualCalls: mocks.listManualCalls,
  placeManualCall: mocks.placeManualCall,
  updateManualCall: mocks.updateManualCall,
  hangupManualCall: mocks.hangupManualCall,
  dispositionManualCall: mocks.dispositionManualCall,
  markManualCallDnc: mocks.markManualCallDnc,
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', display_name: 'Priya Nair', email: 'priya@example.com', avatar_url: null } }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) }),
}));

import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { FakeSocket, latestSocket } from '../helpers/fakeSocket';
import { BOOTSTRAP as SP_BOOTSTRAP, CAMPAIGN, manualCall, step } from '../helpers/softphone';
import type { AgencySessionBootstrap } from '../../types/agency';

/**
 * SP7 (`docs/softphone.md` §4.2): an agent live on a campaign switches to the
 * soft phone and back. The switch is a break with the reserved reason
 * `soft_phone` — queued like any break while busy — and the station shows the
 * soft phone in place, on the same socket, once `agent_state` reports it. A
 * soft-phone break never offers the ordinary End break; Return to campaign does
 * the returning, and is refused while a manual call is unsettled.
 */

const BOOTSTRAP: AgencySessionBootstrap = {
  session_id: 'sess-1',
  campaign_id: 'camp-1',
  campaign_name: 'Home Loan Renewals',
  agent_user_id: 'u-1',
  state: 'available',
  campaign_status: 'running',
  station_ws_url: '/proxy/agency/station/sess-1?token=t1',
  disposition_catalog: [{ code: 'sale', label: 'Sale' }],
  wrapup_seconds: 30,
  wrapup_auto_return: true,
  record_calls: false,
  break_reasons: [{ code: 'lunch', label: 'Lunch' }],
  context_display: {},
  intervals: { heartbeat_ms: 10_000, heartbeat_grace_ms: 30_000, reservation_lease_ms: 10_000, countdown_ms: 3000 },
};

const SINCE = '2026-10-30T10:00:00.000Z';

async function mounted() {
  render(
    <MemoryRouter initialEntries={['/station?campaign=camp-1']}>
      <AgentConsolePage />
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    latestSocket().open();
  });
}

const frame = async (f: unknown) => {
  await act(async () => {
    latestSocket().emit(f);
  });
};

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  Object.values(mocks).forEach((m) => (typeof m === 'function' && 'mockReset' in m ? m.mockReset() : undefined));
  mocks.flags = new Set(['agency_softphone_enabled']);
  mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role: 'agent' });
  mocks.createAgencySession.mockResolvedValue(BOOTSTRAP);
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  mocks.getSoftphoneBootstrap.mockResolvedValue({
    ...SP_BOOTSTRAP,
    taggable_campaigns: [{ ...CAMPAIGN, campaign_id: 'camp-1', campaign_name: 'Home Loan Renewals' }],
  });
  mocks.listManualCalls.mockResolvedValue({ rows: [], next_cursor: null, limit: 8 });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Switch to soft phone', () => {
  it('is offered in the action bar and as the break menu’s last entry, with the flag on', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'available', since: SINCE });
    expect(screen.getByTestId('switch-to-softphone')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Break/ }));
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Lunch', 'Switch to soft phone']);
  });

  it('is not offered with the flag off', async () => {
    mocks.flags = new Set();
    await mounted();
    expect(screen.queryByTestId('switch-to-softphone')).toBeNull();
  });

  it('immediate: the station becomes the soft phone on agent_state break/soft_phone, with the campaign as the tag', async () => {
    mocks.switchToSoftphone.mockResolvedValue({ ok: true, value: { session_id: 'sess-1', state: 'break', break_reason: 'soft_phone' } });
    await mounted();
    await frame({ event: 'agent_state', state: 'available', since: SINCE });
    await act(async () => {
      fireEvent.click(screen.getByTestId('switch-to-softphone'));
    });
    expect(mocks.switchToSoftphone).toHaveBeenCalledWith('sess-1', 't-1', 'a-1');
    // Nothing queued: the frame is what switches the screen.
    expect(screen.queryByTestId('queued-break-chip')).toBeNull();
    await frame({ event: 'agent_state', state: 'break', break_reason: 'soft_phone', since: SINCE });
    expect(screen.getByTestId('station-softphone')).toBeTruthy();
    expect(screen.getByTestId('rail-label').textContent).toBe('Ready to dial');
    expect(screen.getByTestId('rail-detail').textContent).toMatch(/campaign's dialer does not reserve you here/);
    expect((screen.getByTestId('log-to-select') as HTMLSelectElement).value).toBe('camp-1');
    // A soft-phone break is never ended as an ordinary one.
    expect(screen.queryByRole('button', { name: /End break/ })).toBeNull();
    fireEvent.keyDown(window, { key: 'a' });
    expect(mocks.setAgentAvailable).not.toHaveBeenCalled();
  });

  it('queued: while on a call it shows "switching after this call", cancellable like a queued break', async () => {
    mocks.switchToSoftphone.mockResolvedValue({
      ok: true,
      value: { session_id: 'sess-1', state: 'on_call', pending_state: 'break', break_reason: 'soft_phone' },
    });
    mocks.cancelQueuedBreak.mockResolvedValue({ session_id: 'sess-1', state: 'on_call' });
    await mounted();
    await frame({ event: 'agent_state', state: 'on_call', since: SINCE });
    await act(async () => {
      fireEvent.click(screen.getByTestId('switch-to-softphone'));
    });
    expect(screen.getByTestId('queued-break-chip').textContent).toMatch(/Switching to the soft phone after this call/);
    // The button stays in place, disabled, while its request is queued (disable, don't remove).
    const queued = screen.getByTestId('switch-to-softphone');
    expect(queued.getAttribute('aria-disabled')).toBe('true');
    expect(queued.textContent).toBe('Switching after this call');
    fireEvent.click(queued);
    expect(mocks.switchToSoftphone).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel the switch to the soft phone' }));
    });
    expect(mocks.cancelQueuedBreak).toHaveBeenCalledWith('sess-1', 't-1', 'a-1');
    expect(screen.queryByTestId('queued-break-chip')).toBeNull();
    expect(screen.getByTestId('switch-to-softphone').getAttribute('aria-disabled')).toBeNull();
    expect(screen.getByTestId('switch-to-softphone').textContent).toBe('Switch to soft phone');
  });

  it('queued, then applied at the end of wrap-up by the frame', async () => {
    mocks.switchToSoftphone.mockResolvedValue({
      ok: true,
      value: { session_id: 'sess-1', state: 'on_call', pending_state: 'break', break_reason: 'soft_phone' },
    });
    await mounted();
    await frame({ event: 'agent_state', state: 'on_call', since: SINCE });
    await act(async () => {
      fireEvent.click(screen.getByTestId('switch-to-softphone'));
    });
    await frame({ event: 'agent_state', state: 'wrapup', since: SINCE, pending_state: 'break', pending_break_reason: 'soft_phone' });
    expect(screen.getByTestId('queued-break-chip').textContent).toMatch(/Switching to the soft phone/);
    await frame({ event: 'agent_state', state: 'break', break_reason: 'soft_phone', since: SINCE });
    expect(screen.getByTestId('station-softphone')).toBeTruthy();
  });

  it('says why when the switch is refused', async () => {
    mocks.switchToSoftphone.mockResolvedValue({ ok: false, refusal: { code: 'softphone_disabled', status: 403, message: 'x' } });
    await mounted();
    await act(async () => {
      fireEvent.click(screen.getByTestId('switch-to-softphone'));
    });
    expect(screen.getByTestId('switch-to-softphone-refused').textContent).toMatch(/turned off for this account/);
  });

  it('a switch Redis did not take says the status did not change, not that a call was not placed', async () => {
    mocks.switchToSoftphone.mockResolvedValue({ ok: false, refusal: { code: 'dial_failed', status: 503, message: 'x' } });
    await mounted();
    await act(async () => {
      fireEvent.click(screen.getByTestId('switch-to-softphone'));
    });
    expect(screen.getByTestId('switch-to-softphone-refused').textContent).toBe('Couldn’t change your status just now; nothing changed. Try again.');
  });
});

describe('on the soft phone, in the station', () => {
  async function onSoftphone() {
    await mounted();
    await frame({ event: 'agent_state', state: 'break', break_reason: 'soft_phone', since: SINCE });
  }

  it('Return to campaign ends the soft-phone break', async () => {
    mocks.returnFromSoftphone.mockResolvedValue({ ok: true, value: { session_id: 'sess-1', state: 'available' } });
    await onSoftphone();
    await act(async () => {
      fireEvent.click(screen.getByTestId('return-to-campaign'));
    });
    expect(mocks.returnFromSoftphone).toHaveBeenCalledWith('sess-1', 't-1', 'a-1');
    await frame({ event: 'agent_state', state: 'available', since: SINCE });
    expect(screen.queryByTestId('station-softphone')).toBeNull();
  });

  it('Return to campaign is disabled, with its reason, while a manual call is live or owes its outcome', async () => {
    await onSoftphone();
    await frame({ event: 'manual_call', call: step(manualCall({ session_id: 'sess-1' }), 3, { state: 'ringing' }) });
    expect((screen.getByTestId('return-to-campaign') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('return-to-campaign-reason').textContent).toBe('Finish this call and save its outcome first.');
    await frame({
      event: 'manual_call',
      call: step(manualCall({ session_id: 'sess-1' }), 60, { state: 'ended', requires_disposition: true, bridged_at: '2026-10-30T10:00:05Z' }),
    });
    expect((screen.getByTestId('return-to-campaign') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the server’s manual_call_live refusal when it says so first', async () => {
    mocks.returnFromSoftphone.mockResolvedValue({
      ok: false,
      refusal: { code: 'manual_call_live', status: 409, message: 'x', call: manualCall({ state: 'ended', requires_disposition: true }) },
    });
    await onSoftphone();
    await act(async () => {
      fireEvent.click(screen.getByTestId('return-to-campaign'));
    });
    expect(screen.getByTestId('return-to-campaign-reason').textContent).toBe('Finish this call and save its outcome first.');
    // It re-reads the bootstrap to show the call it did not know about.
    expect(mocks.getSoftphoneBootstrap.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a return Redis did not take says the status did not change, not that a call was not placed', async () => {
    mocks.returnFromSoftphone.mockResolvedValue({ ok: false, refusal: { code: 'dial_failed', status: 503, message: 'x' } });
    await onSoftphone();
    await act(async () => {
      fireEvent.click(screen.getByTestId('return-to-campaign'));
    });
    expect(screen.getByTestId('return-to-campaign-reason').textContent).toBe('Couldn’t change your status just now; nothing changed. Try again.');
  });

  it('with the flag turned off it is still the soft phone, in finish mode: the call, Return to campaign, no dial pad', async () => {
    mocks.flags = new Set();
    mocks.returnFromSoftphone.mockResolvedValue({ ok: true, value: { session_id: 'sess-1', state: 'available' } });
    await onSoftphone();
    expect(screen.getByTestId('station-softphone')).toBeTruthy();
    // No ordinary break (whose End break would skip the soft phone's return).
    expect(screen.queryByRole('button', { name: /End break/ })).toBeNull();
    expect(screen.getByTestId('softphone-finish-notice').textContent).toMatch(/Return to your campaign when you’re ready\./);
    expect(screen.queryByTestId('dial-call')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId('return-to-campaign'));
    });
    expect(mocks.returnFromSoftphone).toHaveBeenCalledWith('sess-1', 't-1', 'a-1');
  });

  it('places calls from the campaign session, on the same socket', async () => {
    mocks.placeManualCall.mockResolvedValue({ ok: true, value: manualCall({ session_id: 'sess-1' }) });
    await onSoftphone();
    fireEvent.change(screen.getByTestId('dial-number'), { target: { value: '9820461733' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    expect(mocks.placeManualCall.mock.calls[0]![0]).toMatchObject({ session_id: 'sess-1', campaign_id: 'camp-1' });
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('after a reload (ready carries no break reason) asks the soft phone’s bootstrap', async () => {
    mocks.getSoftphoneBootstrap.mockResolvedValue({
      ...SP_BOOTSTRAP,
      session: {
        session_id: 'sess-1',
        kind: 'campaign',
        campaign_id: 'camp-1',
        campaign_name: 'Home Loan Renewals',
        state: 'break',
        break_reason: 'soft_phone',
        on_softphone: true,
      },
    });
    await mounted();
    await frame({ event: 'ready', session_id: 'sess-1', state: 'break' });
    expect(screen.getByTestId('station-softphone')).toBeTruthy();
  });

  describe('a reload mid-call keeps the call details the agent typed', () => {
    const SP_SESSION = {
      session_id: 'sess-1',
      kind: 'campaign',
      campaign_id: 'camp-1',
      campaign_name: 'Home Loan Renewals',
      state: 'break',
      break_reason: 'soft_phone',
      on_softphone: true,
    };
    const typed = { customer_name: 'Rahul Verma', reason: 'Rate query' };
    const live = step(manualCall({ session_id: 'sess-1', fields: typed, notes: 'Asked about rates' }), 9, {
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

    it('the manual_call frame before the bootstrap (which waits for the ready frame): the fields come back with the set', async () => {
      let resolveBootstrap!: (value: unknown) => void;
      mocks.getSoftphoneBootstrap.mockReturnValue(new Promise((resolve) => (resolveBootstrap = resolve)));
      await mounted();
      await frame({ event: 'ready', session_id: 'sess-1', state: 'break' });
      await frame({ event: 'manual_call', call: live });
      expect(mocks.getSoftphoneBootstrap).toHaveBeenCalled();

      await act(async () =>
        resolveBootstrap({
          ...SP_BOOTSTRAP,
          taggable_campaigns: [CAMPAIGN],
          session: SP_SESSION,
          call: live,
        }),
      );
      expect(screen.getByTestId('station-softphone')).toBeTruthy();
      expect((screen.getByTestId('call-field-customer_name') as HTMLInputElement).value).toBe('Rahul Verma');
      expect((screen.getByTestId('call-field-reason') as HTMLSelectElement).value).toBe('Rate query');
      const sent = await typeNote('Asked about rates, wants it in writing');
      expect(sent).toEqual({ fields: typed, notes: 'Asked about rates, wants it in writing' });
    });

    it('the bootstrap before the manual_call frame: the frame’s values fill the form and are sent back', async () => {
      mocks.getSoftphoneBootstrap.mockResolvedValue({ ...SP_BOOTSTRAP, taggable_campaigns: [CAMPAIGN], session: SP_SESSION, call: null });
      await mounted();
      await frame({ event: 'ready', session_id: 'sess-1', state: 'break' });
      expect(screen.getByTestId('station-softphone')).toBeTruthy();
      await frame({ event: 'manual_call', call: live });
      expect((screen.getByTestId('call-field-customer_name') as HTMLInputElement).value).toBe('Rahul Verma');
      const sent = await typeNote('Asked about rates, wants it in writing');
      expect(sent).toEqual({ fields: typed, notes: 'Asked about rates, wants it in writing' });
    });
  });

  it('an ordinary break stays an ordinary break, with End break', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'break', break_reason: 'lunch', since: SINCE });
    expect(screen.queryByTestId('station-softphone')).toBeNull();
    expect(screen.getByRole('button', { name: /End break/ })).toBeTruthy();
  });
});

describe('joining a campaign while on the soft phone', () => {
  const onSoftphone = () =>
    Object.assign(new Error('On the soft phone'), { statusCode: 409, details: { code: 'session_on_softphone', session_id: 'sess-sp' } });
  async function refused() {
    render(
      <MemoryRouter initialEntries={['/station?campaign=camp-1']}>
        <AgentConsolePage />
      </MemoryRouter>,
    );
    await act(async () => {});
  }

  it('closes the soft phone and joins in one click: leave that session, then join this campaign', async () => {
    mocks.createAgencySession.mockRejectedValueOnce(onSoftphone()).mockResolvedValueOnce(BOOTSTRAP);
    mocks.leaveAgencySession.mockResolvedValue(undefined);
    await refused();
    expect(within(screen.getByTestId('join-on-softphone')).getByRole('link', { name: 'Open the soft phone' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and join' }));
    });
    expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-sp', 't-1', 'a-1');
    expect(mocks.createAgencySession).toHaveBeenCalledTimes(2);
    expect(mocks.createAgencySession.mock.calls[1]).toEqual(['camp-1', 't-1', 'a-1']);
    expect(screen.queryByTestId('join-on-softphone')).toBeNull();
    await act(async () => {
      latestSocket().open();
    });
    expect(screen.getByTestId('rail-label')).toBeTruthy();
  });

  describe('a soft-phone session in another account of the workspace', () => {
    const owed = manualCall({ state: 'ended', outcome: 'connected', requires_disposition: true, bridged_at: '2026-10-30T10:00:05Z' });
    const SIBLING_SESSION = {
      session_id: 'sess-sp', account_id: 'a-2', kind: 'softphone', campaign_id: null, campaign_name: null,
      state: 'break', break_reason: 'soft_phone', on_softphone: true,
    };
    function sessionInSibling(owedThere: boolean) {
      mocks.getSoftphoneBootstrap.mockImplementation(async (_tenant: string, account: string) => ({
        ...SP_BOOTSTRAP, session: SIBLING_SESSION, call: account === 'a-2' && owedThere ? owed : null,
      }));
    }

    it('is closed with its own account, then this campaign is joined', async () => {
      sessionInSibling(false);
      mocks.createAgencySession.mockRejectedValueOnce(onSoftphone()).mockResolvedValueOnce(BOOTSTRAP);
      mocks.leaveAgencySession.mockResolvedValue(undefined);
      await refused();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and join' }));
      });
      // `leave` is scoped to the session's account; this account's would be a 404 taken for "gone".
      expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-sp', 't-1', 'a-2');
      expect(mocks.createAgencySession.mock.calls[1]).toEqual(['camp-1', 't-1', 'a-1']);
      expect(screen.queryByTestId('join-on-softphone')).toBeNull();
    });

    it('is read and left with the account the refusal names, even when no bootstrap can be read', async () => {
      mocks.getSoftphoneBootstrap.mockRejectedValue(new Error('Bad Gateway'));
      mocks.createAgencySession
        .mockRejectedValueOnce(Object.assign(new Error('On the soft phone'), {
          statusCode: 409, details: { code: 'session_on_softphone', session_id: 'sess-sp', account_id: 'a-2', account_name: 'North Region' },
        }))
        .mockResolvedValueOnce(BOOTSTRAP);
      mocks.leaveAgencySession.mockResolvedValue(undefined);
      await refused();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and join' }));
      });
      expect(mocks.getSoftphoneBootstrap).toHaveBeenCalledWith('t-1', 'a-2');
      expect(mocks.getSoftphoneBootstrap).not.toHaveBeenCalledWith('t-1', 'a-1');
      expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-sp', 't-1', 'a-2');
      expect(mocks.createAgencySession.mock.calls[1]).toEqual(['camp-1', 't-1', 'a-1']);
    });

    it('is not closed while its call owes an outcome, read in that account', async () => {
      sessionInSibling(true);
      mocks.createAgencySession.mockRejectedValueOnce(onSoftphone());
      await refused();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and join' }));
      });
      expect(mocks.getSoftphoneBootstrap).toHaveBeenCalledWith('t-1', 'a-2');
      expect(mocks.leaveAgencySession).not.toHaveBeenCalled();
      expect(screen.getByTestId('join-softphone-call-pending')).toBeTruthy();
    });
  });

  it('does not close a soft phone whose call owes its outcome: it says to finish it there', async () => {
    mocks.createAgencySession.mockRejectedValueOnce(onSoftphone());
    mocks.getSoftphoneBootstrap.mockResolvedValue({
      ...SP_BOOTSTRAP,
      call: manualCall({ state: 'ended', outcome: 'connected', requires_disposition: true, bridged_at: '2026-10-30T10:00:05Z' }),
    });
    await refused();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and join' }));
    });
    expect(mocks.leaveAgencySession).not.toHaveBeenCalled();
    expect(screen.getByTestId('join-softphone-call-pending').textContent).toMatch(/call that isn’t finished/);
    // The way to finish it is the one action left.
    expect(screen.queryByRole('button', { name: 'Close the soft phone and join' })).toBeNull();
    expect(screen.getByTestId('join-open-softphone').getAttribute('href')).toBe('/dialer/phone');
    expect(document.activeElement).toBe(screen.getByTestId('join-open-softphone'));
  });

  it('a live call the server refuses to leave (agent_on_live_call) says the same, and joins nothing', async () => {
    mocks.createAgencySession.mockRejectedValueOnce(onSoftphone());
    mocks.leaveAgencySession.mockRejectedValue(
      Object.assign(new Error('Conflict'), { statusCode: 409, details: { code: 'agent_on_live_call', message: 'Hang up your soft-phone call before leaving the station.' } }),
    );
    await refused();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and join' }));
    });
    expect(screen.getByTestId('join-softphone-call-pending')).toBeTruthy();
    expect(mocks.createAgencySession).toHaveBeenCalledTimes(1);
  });

  it('a soft-phone session already gone is closed enough: it joins', async () => {
    mocks.createAgencySession.mockRejectedValueOnce(onSoftphone()).mockResolvedValueOnce(BOOTSTRAP);
    mocks.leaveAgencySession.mockRejectedValue(
      Object.assign(new Error('Session Ended'), { statusCode: 409, details: { code: 'session_ended' } }),
    );
    await refused();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and join' }));
    });
    expect(screen.queryByTestId('join-on-softphone')).toBeNull();
  });

  it('any other failure to leave keeps the screen and says the soft phone is still open', async () => {
    mocks.createAgencySession.mockRejectedValueOnce(onSoftphone());
    mocks.leaveAgencySession.mockRejectedValue(Object.assign(new Error('Service Unavailable'), { statusCode: 503 }));
    await refused();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and join' }));
    });
    expect(screen.getByTestId('join-close-softphone-failure').textContent).toBe('Your soft phone is still open — Service Unavailable');
    expect((screen.getByRole('button', { name: 'Close the soft phone and join' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('closed, but the join then fails: the ordinary join error, naming that the soft phone is closed', async () => {
    mocks.createAgencySession
      .mockRejectedValueOnce(onSoftphone())
      .mockRejectedValueOnce(Object.assign(new Error('Campaign is stopped'), { statusCode: 409, details: { code: 'campaign_not_running' } }));
    mocks.leaveAgencySession.mockResolvedValue(undefined);
    await refused();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and join' }));
    });
    expect(screen.queryByTestId('join-on-softphone')).toBeNull();
    expect(document.body.textContent).toMatch(/Closed the soft phone, but couldn’t join this campaign — Campaign is stopped/);
  });

  it('says so and links to the soft phone (session_on_softphone)', async () => {
    mocks.createAgencySession.mockRejectedValue(
      Object.assign(new Error('On the soft phone'), { statusCode: 409, details: { code: 'session_on_softphone', session_id: 'sess-sp' } }),
    );
    render(
      <MemoryRouter initialEntries={['/station?campaign=camp-1']}>
        <AgentConsolePage />
      </MemoryRouter>,
    );
    await act(async () => {});
    const screenEl = screen.getByTestId('join-on-softphone');
    expect(screenEl.textContent).toMatch(/You’re on the soft phone/);
    expect(within(screenEl).getByRole('link', { name: 'Open the soft phone' }).getAttribute('href')).toBe('/dialer/phone');
  });
});
