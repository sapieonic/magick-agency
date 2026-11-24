import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  openSoftphoneSession: vi.fn(),
  getSoftphoneBootstrap: vi.fn(),
  listManualCalls: vi.fn(),
  mintStationToken: vi.fn(),
  leaveAgencySession: vi.fn(),
  raiseHelp: vi.fn(),
  cancelHelp: vi.fn(),
  useTenant: vi.fn(),
  flags: new Set<string>(),
}));
vi.mock('../../api/softphone', () => ({
  openSoftphoneSession: mocks.openSoftphoneSession,
  switchToSoftphone: vi.fn(),
  getSoftphoneBootstrap: mocks.getSoftphoneBootstrap,
  listManualCalls: mocks.listManualCalls,
  placeManualCall: vi.fn(),
  updateManualCall: vi.fn(),
  hangupManualCall: vi.fn(),
  dispositionManualCall: vi.fn(),
  markManualCallDnc: vi.fn(),
}));
vi.mock('../../api/agency', () => ({
  mintStationToken: mocks.mintStationToken,
  leaveAgencySession: mocks.leaveAgencySession,
  raiseHelp: mocks.raiseHelp,
  cancelHelp: mocks.cancelHelp,
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', display_name: 'Ravi Kumar', email: 'ravi@example.com', avatar_url: null } }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) }),
}));

import * as posthog from '../../analytics/posthog';
import SoftphonePage from '../../pages/agency/SoftphonePage';
import { ApiError } from '../../api/client';
import { FakeSocket, latestSocket } from '../helpers/fakeSocket';
import { BOOTSTRAP, manualCall, step } from '../helpers/softphone';

/**
 * Floor assist on `/dialer/phone` (LF39, AS5): the station's Need help in the soft phone page's top
 * bar, with the station's states (raise, cancel, answered, lapsed, refused, restored on reconnect),
 * and supervisors' messages under the band, on the page's own station socket. Its telemetry with
 * `surface: 'softphone'`.
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

const R1 = '2026-11-19T10:00:00.000Z';
const R0 = '2026-11-19T09:30:00.000Z';
const FLOOR_ASSIST = 'agency_floor_assist_enabled';

let capture: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  Object.values(mocks).forEach((m) => (typeof m === 'function' && 'mockReset' in m ? m.mockReset() : undefined));
  mocks.flags = new Set(['agency_softphone_enabled', FLOOR_ASSIST]);
  mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role: 'agent', accounts: [], setActiveAccountId: vi.fn() });
  mocks.openSoftphoneSession.mockResolvedValue({ ok: true, value: SESSION });
  mocks.getSoftphoneBootstrap.mockResolvedValue({ ...BOOTSTRAP, session: { session_id: 'sess-sp', account_id: 'a-1', kind: 'softphone', campaign_id: null, campaign_name: null, state: 'break', break_reason: 'soft_phone', on_softphone: true } });
  mocks.listManualCalls.mockResolvedValue({ rows: [], next_cursor: null, limit: 8 });
  mocks.raiseHelp.mockResolvedValue({ session_id: 'sess-sp', help: { raised_at: R1, call_id: null } });
  mocks.cancelHelp.mockResolvedValue({ session_id: 'sess-sp', help: null });
  capture = vi.spyOn(posthog, 'captureEvent').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  capture.mockRestore();
  vi.unstubAllGlobals();
});

async function mount({ open = true } = {}) {
  render(
    <MemoryRouter initialEntries={['/dialer/phone']}>
      <Routes>
        <Route path="/dialer/phone" element={<SoftphonePage />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  if (open) await act(async () => latestSocket().open());
}

const frame = async (f: unknown) => {
  await act(async () => {
    latestSocket().emit(f);
  });
};

async function onCall() {
  await frame({ event: 'manual_call', call: step(manualCall(), 9, { state: 'bridged', bridged_at: '2026-10-30T10:00:09Z' }) });
  expect(screen.getByTestId('band-title').textContent).toBe('On call');
}

const helpButton = () => screen.getByTestId('need-help-button');
const asked = () => /^Help asked · [\d:]+$/.test(helpButton().textContent ?? '');
const status = () => screen.queryByTestId('need-help-status-body')?.textContent ?? null;
const said = () => within(screen.getByTestId('floor-assist-announcer')).queryAllByTestId('floor-assist-said').map((n) => n.textContent);
const press = async () => {
  await act(async () => {
    fireEvent.click(helpButton());
  });
};
/** The floor assist events captured (LF39), name and properties, in order. */
const events = (): [string, unknown][] =>
  capture.mock.calls
    .filter((call: unknown[]) => /^agency_(help_|supervisor_message_)/.test(String(call[0])))
    .map((call: unknown[]) => [String(call[0]), call[1]]);

describe('/dialer/phone: Need help', () => {
  it('is not there while floor assist is off', async () => {
    mocks.flags.delete(FLOOR_ASSIST);
    await mount();
    expect(screen.queryByTestId('need-help-button')).toBeNull();
    expect(screen.queryByRole('button', { name: /Need help/ })).toBeNull();
  });

  it('waits for the socket, then sits in the top bar after the agent nav', async () => {
    await mount({ open: false });
    expect(screen.queryByTestId('need-help-button')).toBeNull();
    await act(async () => latestSocket().open());
    const header = screen.getByTestId('softphone-page').querySelector('header')!;
    expect(header.contains(helpButton())).toBe(true);
    expect(helpButton().textContent).toBe('Need help');
  });

  it('raises on the soft phone’s own session while ready to dial, and the same button cancels', async () => {
    await mount();
    const button = helpButton();
    await press();
    expect(mocks.raiseHelp).toHaveBeenCalledWith('sess-sp', 't-1', 'a-1');
    expect(asked()).toBe(true);
    expect(helpButton()).toBe(button);
    expect(said().at(-1)).toBe('Help requested. Your supervisors can see it.');

    await press();
    expect(mocks.cancelHelp).toHaveBeenCalledWith('sess-sp', 't-1', 'a-1');
    expect(helpButton().textContent).toBe('Need help');
    expect(status()).toBeNull();
    expect(said().at(-1)).toBe('Help request cancelled.');
    // Cancelled is the server's clear, never the reply.
    expect(events().map(([name]) => name)).toEqual(['agency_help_raised']);
    await frame({ event: 'help_cleared', raised_at: R1, reason: 'cancelled' });
    expect(events().map(([name]) => name)).toEqual(['agency_help_raised', 'agency_help_cancelled']);
    expect(events()[0]![1]).toEqual({ surface: 'softphone', on_call: false });
  });

  it('on a call: the raise is sent as on a call', async () => {
    await mount();
    await onCall();
    await press();
    expect(events()).toEqual([['agency_help_raised', { surface: 'softphone', on_call: true }]]);
  });

  it('says who answered, keeps it until dismissed, and sends the answer once', async () => {
    await mount();
    await onCall();
    await press();
    await frame({ event: 'help_answered', raised_at: R1, by_name: 'Priya N', how: 'listen' });
    await frame({ event: 'help_cleared', raised_at: R1, reason: 'answered' });
    await frame({ event: 'help_cleared', raised_at: R1, reason: 'answered' });
    expect(status()).toBe('Help is here. Priya N is listening to this call.');
    expect(helpButton().textContent).toBe('Need help');
    fireEvent.click(screen.getByTestId('need-help-dismiss'));
    expect(status()).toBeNull();
    expect(events().map(([name]) => name)).toEqual(['agency_help_raised', 'agency_help_answered']);
    expect(events()[1]![1]).toEqual({ how: 'listen', wait_bucket: expect.any(String) });
  });

  it('says a lapsed request may be raised again', async () => {
    await mount();
    await press();
    await frame({ event: 'help_cleared', raised_at: R1, reason: 'expired' });
    expect(status()).toBe('No supervisor answered. Ask again if you still need help.');
    expect(helpButton().textContent).toBe('Need help');
    expect(events().map(([name]) => name)).toEqual(['agency_help_raised', 'agency_help_expired']);
  });

  it('restores an open request from ready.help on reconnect, and that is not a new raise', async () => {
    await mount();
    await frame({ event: 'ready', session_id: 'sess-sp', state: 'break', break_reason: 'soft_phone', help: { raised_at: R0, call_id: null } });
    expect(asked()).toBe(true);
    await frame({ event: 'help_cleared', raised_at: R0, reason: 'session_ended' });
    expect(helpButton().textContent).toBe('Need help');
    expect(status()).toBeNull();
    expect(events()).toEqual([]);
  });

  it('says a refusal in the station’s words', async () => {
    await mount();
    mocks.raiseHelp.mockRejectedValueOnce(new ApiError(403, { error: 'Forbidden', code: 'floor_assist_disabled', message: 'raw' }));
    await press();
    expect(screen.getByTestId('need-help-refusal-body').textContent).toBe('Need help is not turned on. Call your supervisor to your desk.');
    expect(helpButton().textContent).toBe('Need help');
    expect(events()).toEqual([['agency_help_refused', { action: 'raise', code: 'floor_assist_disabled' }]]);
  });
});

describe('/dialer/phone: supervisors’ messages', () => {
  const message = (id: string, text: string, from: string | null = 'Priya N') => ({
    event: 'supervisor_message',
    id,
    text,
    from_name: from,
    sent_at: '2026-11-19T10:01:00.000Z',
  });

  it('shows them under the band one at a time, announces each once, and counts each id once', async () => {
    await mount();
    await onCall();
    await frame(message('m-1', 'Offer the 3-month plan'));
    await frame(message('m-2', 'Then wrap up'));
    await frame(message('m-1', 'Offer the 3-month plan'));
    const card = screen.getByTestId('supervisor-message');
    expect(screen.getByTestId('station-banners').contains(card)).toBe(true);
    expect(within(card).getByText('Priya N')).toBeTruthy();
    expect(screen.getByTestId('supervisor-message-text').textContent).toBe('Offer the 3-month plan');
    expect(screen.getByTestId('supervisor-messages-more').textContent).toBe('1 more message');
    expect(said()).toEqual(['Message from Priya N: Offer the 3-month plan', 'Message from Priya N: Then wrap up']);

    fireEvent.click(screen.getByTestId('supervisor-message-ok'));
    expect(screen.getByTestId('supervisor-message-text').textContent).toBe('Then wrap up');
    fireEvent.click(screen.getByTestId('supervisor-message-ok'));
    expect(screen.queryByTestId('supervisor-message')).toBeNull();

    // Once per id, on a call; never the text, the sender or the id.
    expect(events()).toEqual([
      ['agency_supervisor_message_shown', { on_call: true }],
      ['agency_supervisor_message_shown', { on_call: true }],
    ]);
  });

  it('while ready to dial, a message is shown off a call, and floor assist’s flag does not hide it', async () => {
    mocks.flags.delete(FLOOR_ASSIST);
    await mount();
    await frame(message('m-1', 'Carry on', null));
    expect(within(screen.getByTestId('supervisor-message')).getByText('Your supervisor')).toBeTruthy();
    expect(events()).toEqual([['agency_supervisor_message_shown', { on_call: false }]]);
  });
});
