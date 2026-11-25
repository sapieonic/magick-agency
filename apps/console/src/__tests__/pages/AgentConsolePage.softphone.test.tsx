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
  raiseHelp: vi.fn(),
  cancelHelp: vi.fn(),
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
  raiseHelp: mocks.raiseHelp,
  cancelHelp: mocks.cancelHelp,
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

import * as posthog from '../../analytics/posthog';
import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { stubStationMicrophone } from '../helpers/stationDevices';
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

/** ⋮ More → Dial a number myself: where "Switch to soft phone" moved (spec §8). */
async function dialMyself() {
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  await act(async () => {
    fireEvent.click(screen.getByTestId('station-menu-dial_myself'));
  });
}

let microphone: ReturnType<typeof stubStationMicrophone>;
beforeEach(() => {
  microphone = stubStationMicrophone();
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
  microphone.restore();
  vi.unstubAllGlobals();
});

describe('that a supervisor may listen (LS2)', () => {
  it('the station and its soft phone carry the Monitoring and recording button and the one-time notice', async () => {
    mocks.flags.add('agency_live_listen_enabled');
    window.localStorage.clear();
    mocks.switchToSoftphone.mockResolvedValue({ ok: true, value: { session_id: 'sess-1', state: 'break', break_reason: 'soft_phone' } });
    await mounted();
    await frame({ event: 'agent_state', state: 'available', since: SINCE });
    expect(screen.getByRole('button', { name: 'Monitoring and recording' })).toBeTruthy();
    expect(screen.getByTestId('listen-first-notice')).toBeTruthy();
    await dialMyself();
    await frame({ event: 'agent_state', state: 'break', break_reason: 'soft_phone', since: SINCE });
    expect(screen.getByTestId('station-softphone')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Monitoring and recording' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByTestId('listen-first-notice')).toBeNull();
    window.localStorage.clear();
  });
});

describe('floor assist telemetry on the station’s soft phone (LF39)', () => {
  it('a raise there is `softphone`; on a call only once the call is connected or owes its outcome', async () => {
    const capture = vi.spyOn(posthog, 'captureEvent').mockImplementation(() => {});
    mocks.flags.add('agency_floor_assist_enabled');
    mocks.switchToSoftphone.mockResolvedValue({ ok: true, value: { session_id: 'sess-1', state: 'break', break_reason: 'soft_phone' } });
    mocks.raiseHelp.mockResolvedValue({ session_id: 'sess-1', help: { raised_at: '2026-11-19T10:00:00.000Z', call_id: null } });
    await mounted();
    await frame({ event: 'agent_state', state: 'available', since: SINCE });
    await dialMyself();
    await frame({ event: 'agent_state', state: 'break', break_reason: 'soft_phone', since: SINCE });
    expect(screen.getByTestId('station-softphone')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('need-help-button'));
    });
    const message = (id: string) => ({ event: 'supervisor_message', id, text: 'Note', from_name: 'Priya N', sent_at: SINCE });
    await frame({ event: 'manual_call', call: step(manualCall(), 1, { state: 'dialing' }) });
    await frame(message('m-dialing'));
    await frame({ event: 'manual_call', call: step(manualCall(), 2, { state: 'ringing' }) });
    await frame(message('m-ringing'));
    await frame({ event: 'manual_call', call: step(manualCall(), 9, { state: 'bridged', bridged_at: '2026-10-30T10:00:09Z' }) });
    await frame(message('m-bridged'));
    const events = capture.mock.calls
      .filter((call: unknown[]) => /^agency_(help_|supervisor_message_)/.test(String(call[0])))
      .map((call: unknown[]) => [String(call[0]), call[1]]);
    expect(events).toEqual([
      ['agency_help_raised', { surface: 'softphone', on_call: false }],
      ['agency_supervisor_message_shown', { on_call: false }],
      ['agency_supervisor_message_shown', { on_call: false }],
      ['agency_supervisor_message_shown', { on_call: true }],
    ]);
    capture.mockRestore();
  });
});

describe('Switch to soft phone', () => {
  it('is offered under ⋮ More as Dial a number myself, and never in Which break?', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'available', since: SINCE });
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByTestId('station-menu-dial_myself').textContent).toBe('Dial a number myself');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /take break/i }));
    const tiles = within(screen.getByRole('dialog', { name: 'Which break?' })).getAllByRole('button').map((b) => b.textContent);
    expect(tiles.some((t) => /soft phone|dial/i.test(t ?? ''))).toBe(false);
  });

  it('is offered on Start of day as “I dial the number”, which Start work then switches to', async () => {
    mocks.switchToSoftphone.mockResolvedValue({ ok: true, value: { session_id: 'sess-1', state: 'break', break_reason: 'soft_phone' } });
    await mounted();
    const tile = screen.getByTestId('work-dial-myself');
    expect(screen.getByTestId('work-calls-come').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(tile);
    expect(tile.getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /start work/i }));
    });
    expect(mocks.switchToSoftphone).toHaveBeenCalledWith('sess-1', 't-1', 'a-1');
    expect(mocks.setAgentAvailable).not.toHaveBeenCalled();
  });

  it('A on Start of day is Start work: it honours “I dial the number” and never goes available instead', async () => {
    mocks.switchToSoftphone.mockResolvedValue({ ok: true, value: { session_id: 'sess-1', state: 'break', break_reason: 'soft_phone' } });
    await mounted();
    fireEvent.click(screen.getByTestId('work-dial-myself'));
    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'a' });
    });
    expect(mocks.switchToSoftphone).toHaveBeenCalledWith('sess-1', 't-1', 'a-1');
    expect(mocks.setAgentAvailable).not.toHaveBeenCalled();
  });

  it('is not offered with the flag off', async () => {
    mocks.flags = new Set();
    await mounted();
    expect(screen.queryByTestId('work-dial-myself')).toBeNull();
    await frame({ event: 'agent_state', state: 'available', since: SINCE });
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByTestId('station-menu-dial_myself')).toBeNull();
  });

  it('immediate: the station becomes the soft phone on agent_state break/soft_phone, with the campaign as the tag', async () => {
    mocks.switchToSoftphone.mockResolvedValue({ ok: true, value: { session_id: 'sess-1', state: 'break', break_reason: 'soft_phone' } });
    await mounted();
    await frame({ event: 'agent_state', state: 'available', since: SINCE });
    await dialMyself();
    expect(mocks.switchToSoftphone).toHaveBeenCalledWith('sess-1', 't-1', 'a-1');
    // Nothing queued: the frame is what switches the screen.
    expect(screen.queryByTestId('queued-break')).toBeNull();
    await frame({ event: 'agent_state', state: 'break', break_reason: 'soft_phone', since: SINCE });
    expect(screen.getByTestId('station-softphone')).toBeTruthy();
    // The station's band (ruling 2), with Back to my calls bottom right.
    expect(screen.getByTestId('band-title').textContent).toBe('Dial a number');
    expect(screen.getByTestId('return-to-campaign').textContent).toBe('Back to my calls');
    expect((screen.getByTestId('log-to-select') as HTMLSelectElement).value).toBe('camp-1');
    // A soft-phone break is never ended as an ordinary one.
    expect(screen.queryByRole('button', { name: /End break/ })).toBeNull();
    fireEvent.keyDown(window, { key: 'a' });
    expect(mocks.setAgentAvailable).not.toHaveBeenCalled();
  });

  it('is not offered during a call (⋮ More holds only Sound there, spec §3)', async () => {
    await mounted();
    await frame({ event: 'reserved', attempt: { attempt_id: 'att-1', campaign_id: 'camp-1', campaign_name: 'Home Loan Renewals', contact_id: 'c-1', phone_e164: '+919876543210', caller_id: '+911234567890', attempt_number: 1, context: {}, prior_attempts: [] } });
    await frame({ event: 'agent_state', state: 'on_call', since: SINCE });
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByTestId('station-menu-dial_myself')).toBeNull();
    expect(screen.getByTestId('station-menu-sound')).toBeTruthy();
  });

  it('a switch queued behind the call shows “after this call” with its ✕, then is applied at the end of wrap-up by the frame', async () => {
    mocks.cancelQueuedBreak.mockResolvedValue({ session_id: 'sess-1', state: 'wrapup' });
    await mounted();
    await frame({ event: 'reserved', attempt: { attempt_id: 'att-1', campaign_id: 'camp-1', campaign_name: 'Home Loan Renewals', contact_id: 'c-1', phone_e164: '+919876543210', caller_id: '+911234567890', attempt_number: 1, context: {}, prior_attempts: [] } });
    await frame({ event: 'released', attempt_id: 'att-1', reason: 'remote_hangup', requires_disposition: true, message: '' });
    await frame({ event: 'agent_state', state: 'wrapup', since: SINCE, pending_state: 'break', pending_break_reason: 'soft_phone' });
    expect(screen.getByTestId('queued-break').textContent).toMatch(/Dial a number myself after this call/);
    // Its ✕ says what it cancels: the switch, not a break.
    expect(screen.getByTestId('queued-break-cancel').getAttribute('aria-label')).toBe('Do not dial a number myself after this call');
    expect(screen.queryByRole('button', { name: 'Cancel the break after this call' })).toBeNull();
    await frame({ event: 'agent_state', state: 'break', break_reason: 'soft_phone', since: SINCE });
    expect(screen.getByTestId('station-softphone')).toBeTruthy();
  });

  it('says why when the switch is refused', async () => {
    mocks.switchToSoftphone.mockResolvedValue({ ok: false, refusal: { code: 'softphone_disabled', status: 403, message: 'x' } });
    await mounted();
    await frame({ event: 'agent_state', state: 'available', since: SINCE });
    await dialMyself();
    expect(screen.getByTestId('switch-to-softphone-refused').textContent).toBe('Dialling a number yourself is turned off. Ask your supervisor.');
  });

  it('a switch Redis did not take says the status did not change, not that a call was not placed', async () => {
    mocks.switchToSoftphone.mockResolvedValue({ ok: false, refusal: { code: 'dial_failed', status: 503, message: 'x' } });
    await mounted();
    await frame({ event: 'agent_state', state: 'available', since: SINCE });
    await dialMyself();
    expect(screen.getByTestId('switch-to-softphone-refused').textContent).toBe('You cannot dial a number yourself just now. Nothing changed. Try again in a moment.');
  });
});

describe('on the soft phone, in the station', () => {
  async function onSoftphone() {
    await mounted();
    await frame({ event: 'agent_state', state: 'break', break_reason: 'soft_phone', since: SINCE });
  }

  it('Finish work for today is in ⋮ More while nothing is dialled: 11 opens, and No, keep working comes back', async () => {
    mocks.leaveAgencySession.mockResolvedValue(undefined);
    await onSoftphone();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByTestId('station-menu-finish'));
    expect(screen.queryByTestId('station-softphone')).toBeNull();
    expect(screen.getByTestId('band-title').textContent).toBe('Finish work for today?');
    fireEvent.click(screen.getByTestId('keep-working'));
    expect(screen.getByTestId('station-softphone')).toBeTruthy();
    // During a call: only Sound and the colour, as on 04.
    await frame({ event: 'manual_call', call: step(manualCall({ session_id: 'sess-1' }), 3, { state: 'ringing' }) });
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByTestId('station-menu-finish')).toBeNull();
    expect(screen.getByTestId('station-menu-sound')).toBeTruthy();
  });

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

  it('Back to my calls is hidden, with its reason, while a manual call is live or owes its outcome (AS1)', async () => {
    await onSoftphone();
    await frame({ event: 'manual_call', call: step(manualCall({ session_id: 'sess-1' }), 3, { state: 'ringing' }) });
    expect(screen.queryByTestId('return-to-campaign')).toBeNull();
    expect(screen.getByTestId('return-to-campaign-reason').textContent).toBe('Finish your call and save what happened first.');
    await frame({
      event: 'manual_call',
      call: step(manualCall({ session_id: 'sess-1' }), 60, { state: 'ended', requires_disposition: true, bridged_at: '2026-10-30T10:00:05Z' }),
    });
    expect(screen.queryByTestId('return-to-campaign')).toBeNull();
    expect(mocks.returnFromSoftphone).not.toHaveBeenCalled();
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
    expect(screen.getByTestId('return-to-campaign-reason').textContent).toBe('Finish your call and save what happened first.');
    // It re-reads the bootstrap to show the call it did not know about.
    expect(mocks.getSoftphoneBootstrap.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a return Redis did not take says the status did not change, not that a call was not placed', async () => {
    mocks.returnFromSoftphone.mockResolvedValue({ ok: false, refusal: { code: 'dial_failed', status: 503, message: 'x' } });
    await onSoftphone();
    await act(async () => {
      fireEvent.click(screen.getByTestId('return-to-campaign'));
    });
    expect(screen.getByTestId('return-to-campaign-reason').textContent).toBe('You could not go back to your calls just now. Try again in a moment.');
  });

  it('with the flag turned off it is still the soft phone, in finish mode: the call, Return to campaign, no dial pad', async () => {
    mocks.flags = new Set();
    mocks.returnFromSoftphone.mockResolvedValue({ ok: true, value: { session_id: 'sess-1', state: 'available' } });
    await onSoftphone();
    expect(screen.getByTestId('station-softphone')).toBeTruthy();
    // No ordinary break (whose End break would skip the soft phone's return).
    expect(screen.queryByRole('button', { name: /End break/ })).toBeNull();
    expect(screen.getByTestId('softphone-finish-notice').textContent).toBe('Dialling is turned off. Press Back to my calls when you are ready.');
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
      fireEvent.change(screen.getByRole('textbox', { name: /note/i }), { target: { value: text } });
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

  it('an ordinary break stays an ordinary break, with Start calls again', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'break', break_reason: 'lunch', since: SINCE });
    expect(screen.queryByTestId('station-softphone')).toBeNull();
    expect(screen.getByRole('button', { name: /Start calls again/ })).toBeTruthy();
  });
});

describe('the soft phone in the station’s look (AS1)', () => {
  const TAG = { campaign_id: 'camp-1', campaign_name: 'Home Loan Renewals' };
  const CONTACT = {
    contact_id: 'ct-9',
    state: 'in_flight' as const,
    claimed: true,
    context: { Name: 'Asha Rao', 'Loan account': 'HL-4471' },
    prior_attempts: [
      {
        attempt_number: 1,
        outcome: 'no_answer' as const,
        disposition_code: null,
        notes: 'Rang after six',
        ended_at: '2026-10-29T09:00:30.000Z',
        dialed_at: '2026-10-29T09:00:00.000Z',
        campaign_id: 'camp-1',
        campaign_name: 'Home Loan Renewals',
      },
    ],
  };
  const placed = manualCall({ session_id: 'sess-1', tag: TAG, contact: CONTACT, recording_requested: true });
  const ringing = step(placed, 3, { state: 'ringing' });
  const onCall = step(placed, 9, { state: 'bridged', answered_at: '2026-10-30T10:00:09Z', bridged_at: '2026-10-30T10:00:09Z' });
  const owed = step(placed, 60, {
    state: 'ended',
    outcome: 'connected',
    requires_disposition: true,
    bridged_at: '2026-10-30T10:00:09Z',
    ended_at: '2026-10-30T10:01:00Z',
    outcome_due_at: '2026-10-30T10:31:00Z',
  });

  async function onSoftphone() {
    await mounted();
    await frame({ event: 'agent_state', state: 'break', break_reason: 'soft_phone', since: SINCE });
  }
  function footButtons(): string[] {
    const foot = screen.getByTestId('station-softphone').querySelector('footer') as HTMLElement | null;
    return foot ? within(foot).queryAllByRole('button').map((b) => b.getAttribute('data-testid') ?? b.textContent ?? '') : [];
  }

  it('ready: a big keypad, Call faded until it can dial and saying why, where the call is saved, recent calls', async () => {
    await onSoftphone();
    for (const key of ['1', '5', '9', '*', '0', '#']) expect(screen.getByTestId(`dial-key-${key}`)).toBeTruthy();
    const callButton = screen.getByTestId('dial-call');
    expect(callButton.textContent).toMatch(/^Call/);
    expect(callButton.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByLabelText('Save this call to')).toBe(screen.getByTestId('log-to-select'));
    expect(screen.getByLabelText('Call from')).toBe(screen.getByTestId('caller-id'));
    expect(screen.getByTestId('recent-empty').textContent).toBe('Numbers you dial show here. Press one to dial it again.');
    // Back to my calls is the main button, bottom right, as the frame has always had it.
    expect(footButtons()).toEqual(['return-to-campaign']);
    // Too short a number is said in the station's words, and Call places nothing.
    fireEvent.click(screen.getByTestId('dial-key-1'));
    fireEvent.click(screen.getByTestId('dial-key-2'));
    expect(screen.getByTestId('dial-reason').textContent).toBe('This number is too short.');
    await act(async () => {
      fireEvent.click(screen.getByTestId('dial-call'));
    });
    expect(mocks.placeManualCall).not.toHaveBeenCalled();
  });

  it('calling: the customer’s card when the number is on the list, the ringing warning, End call held bottom right', async () => {
    await onSoftphone();
    await frame({ event: 'manual_call', call: ringing });
    expect(screen.getByTestId('band-title').textContent).toBe('Calling +91 98204 61733');
    expect(screen.getByTestId('customer-name').textContent).toBe('Asha Rao');
    expect(within(screen.getByTestId('customer-card')).getByText('HL-4471')).toBeTruthy();
    expect(screen.getByTestId('softphone-recording').textContent).toBe('Call is recorded');
    expect(screen.getByTestId('ringing-warning').textContent).toMatch(/customer’s phone may keep ringing/);
    expect(screen.getByTestId('log-to-fixed').textContent).toBe('Home Loan Renewals');
    // No keypad, no Call, no Back to my calls: End call is the one main button (AS1, AS3).
    expect(screen.queryByTestId('dial-call')).toBeNull();
    expect(screen.queryByTestId('return-to-campaign')).toBeNull();
    expect(footButtons().at(-1)).toMatch(/Hold to end call/);
    // While ringing, Mute is the ring's.
    expect(screen.getByTestId('softphone-mute').textContent).toMatch(/^Mute ring/);
  });

  it('on call: the card, Last calls, the note and the call details; E twice ends the call', async () => {
    mocks.hangupManualCall.mockResolvedValue({ ok: true, value: onCall });
    await onSoftphone();
    await frame({ event: 'manual_call', call: onCall });
    expect(screen.getByTestId('band-title').textContent).toBe('On call');
    expect(screen.getByTestId('band-subtitle').textContent).toBe('Asha Rao');
    expect(screen.getByTestId('last-calls').textContent).toMatch(/No answer/);
    expect(screen.getByRole('textbox', { name: /note/i })).toBeTruthy();
    expect(screen.getByTestId('call-field-customer_name')).toBeTruthy();
    expect(screen.queryByTestId('ringing-warning')).toBeNull();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'e' });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'e' });
    });
    expect(mocks.hangupManualCall).toHaveBeenCalledWith('mc-1', 't-1', 'a-1');
  });

  it('What happened?: the station’s tiles; Save says what is missing, in order, and then saves', async () => {
    mocks.dispositionManualCall.mockResolvedValue({ ok: true, value: step(owed, 70, { settled_at: '2026-10-30T10:01:10Z', disposition_code: 'interested' }) });
    mocks.updateManualCall.mockResolvedValue({ ok: true, value: owed });
    await onSoftphone();
    await frame({ event: 'manual_call', call: owed });
    expect(screen.getByTestId('band-title').textContent).toBe('What happened?');
    expect(screen.getByTestId('softphone-outcome-due')).toBeTruthy();
    expect(footButtons().at(-1)).toBe('softphone-save');
    expect(screen.getByTestId('outcome-interested')).toBeTruthy();
    fireEvent.click(screen.getByTestId('softphone-save'));
    expect(screen.getByTestId('softphone-save-reason').textContent).toBe('Choose one first.');
    fireEvent.keyDown(window, { key: '1' });
    expect(screen.getByTestId('outcome-interested').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('softphone-save'));
    expect(screen.getByTestId('softphone-save-reason').textContent).toBe('Fill in the call details first.');
    expect(mocks.dispositionManualCall).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('call-field-customer_name'), { target: { value: 'Asha Rao' } });
    fireEvent.change(screen.getByTestId('call-field-reason'), { target: { value: 'Rate query' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-save'));
    });
    expect(mocks.dispositionManualCall).toHaveBeenCalled();
    expect(mocks.dispositionManualCall.mock.calls[0]![1]).toMatchObject({ code: 'interested' });
  });

  it('an outcome that stops calls asks first; D asks to mark the number, for the call’s work', async () => {
    await onSoftphone();
    await frame({ event: 'manual_call', call: owed });
    fireEvent.click(screen.getByTestId('outcome-do_not_call'));
    expect(screen.getByTestId('stop-calling')).toBeTruthy();
    expect(screen.getByTestId('outcome-do_not_call').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByTestId('stop-calling-yes'));
    expect(screen.getByTestId('outcome-do_not_call').getAttribute('aria-pressed')).toBe('true');
    expect(mocks.markManualCallDnc).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'd' });
    expect(screen.getByTestId('stop-calling').textContent).toMatch(/We will not call this number again for Home Loan Renewals\./);
    fireEvent.click(screen.getByTestId('stop-calling-no'));
    expect(screen.queryByTestId('stop-calling')).toBeNull();
    expect(mocks.markManualCallDnc).not.toHaveBeenCalled();

    // CL6 (docs/call-log.md §5): a number on no list of this work. The work is only where the call
    // is saved, so the mark covers the whole account, and the question says so.
    await frame({ event: 'manual_call', call: { ...owed, contact: null } });
    fireEvent.keyDown(window, { key: 'd' });
    expect(screen.getByTestId('stop-calling').textContent).toMatch(/We will not call this number again for any work in this account\./);
    fireEvent.click(screen.getByTestId('stop-calling-no'));
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
    expect(screen.getByRole('link', { name: 'Open the soft phone' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and start here' }));
    });
    expect(mocks.leaveAgencySession).toHaveBeenCalledWith('sess-sp', 't-1', 'a-1');
    expect(mocks.createAgencySession).toHaveBeenCalledTimes(2);
    expect(mocks.createAgencySession.mock.calls[1]).toEqual(['camp-1', 't-1', 'a-1']);
    expect(screen.queryByTestId('join-on-softphone')).toBeNull();
    await act(async () => {
      latestSocket().open();
    });
    expect(screen.getByTestId('band-title')).toBeTruthy();
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
        fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and start here' }));
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
        fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and start here' }));
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
        fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and start here' }));
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
      fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and start here' }));
    });
    expect(mocks.leaveAgencySession).not.toHaveBeenCalled();
    expect(screen.getByTestId('join-softphone-call-pending').textContent).toMatch(/call that is not finished/);
    // The way to finish it is the one action left.
    expect(screen.queryByRole('button', { name: 'Close the soft phone and start here' })).toBeNull();
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
      fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and start here' }));
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
      fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and start here' }));
    });
    expect(screen.queryByTestId('join-on-softphone')).toBeNull();
  });

  it('any other failure to leave keeps the screen and says the soft phone is still open', async () => {
    mocks.createAgencySession.mockRejectedValueOnce(onSoftphone());
    mocks.leaveAgencySession.mockRejectedValue(Object.assign(new Error('Service Unavailable'), { statusCode: 503 }));
    await refused();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and start here' }));
    });
    // The station's words (AS15), never the error's own message.
    expect(screen.getByTestId('join-close-softphone-failure').textContent).toBe('Your soft phone is still open. Try again.');
    expect((screen.getByRole('button', { name: 'Close the soft phone and start here' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('closed, but the join then fails: the ordinary join error, naming that the soft phone is closed', async () => {
    mocks.createAgencySession
      .mockRejectedValueOnce(onSoftphone())
      .mockRejectedValueOnce(Object.assign(new Error('Campaign is stopped'), { statusCode: 409, details: { code: 'campaign_not_running' } }));
    mocks.leaveAgencySession.mockResolvedValue(undefined);
    await refused();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close the soft phone and start here' }));
    });
    expect(screen.queryByTestId('join-on-softphone')).toBeNull();
    expect(document.body.textContent).toContain('The soft phone is closed, but your work did not open. Go back and open it again.');
    expect(document.body.textContent).not.toContain('Campaign is stopped');
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
    expect(screenEl.textContent).toMatch(/Your soft phone is still open/);
    expect(screen.getByRole('link', { name: 'Open the soft phone' }).getAttribute('href')).toBe('/dialer/phone');
  });
});
