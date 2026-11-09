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
  getInboundCall: vi.fn(),
  updateInboundCallNotes: vi.fn(),
  hangupInboundCall: vi.fn(),
  dispositionInboundCall: vi.fn(),
  markInboundCallDnc: vi.fn(),
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
vi.mock('../../api/inbound', () => ({
  getInboundCall: mocks.getInboundCall,
  updateInboundCallNotes: mocks.updateInboundCallNotes,
  hangupInboundCall: mocks.hangupInboundCall,
  dispositionInboundCall: mocks.dispositionInboundCall,
  markInboundCallDnc: mocks.markInboundCallDnc,
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
import { connected, inboundCall, owing } from '../helpers/inbound';
import type { AgencySessionBootstrap } from '../../types/agency';
import type { AgencyInboundCall } from '../../types/inbound';

/**
 * P2 (`docs/inbound.md` §6): an inbound call put through to an agent on a campaign station. The
 * `inbound_call` frame puts the caller's panel on the station in place of the campaign's, in the
 * station's frozen geometry, before the caller's audio binds (IB1); it carries the call through
 * connected and an owed outcome, saved through the call's routes, and gives the station back
 * when the call settles. "Your customer is waiting" is a pill on the campaign station.
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

const SINCE = '2026-11-09T09:59:00.000Z';

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
const call = (c: AgencyInboundCall) => frame({ event: 'inbound_call', call: c });

/** What the agent can reach, in tab order: the regions, then the action bar's controls. */
function layout() {
  const body = screen.getByTestId('inbound-body');
  const regions = within(body).getAllByRole('region').map((r) => r.getAttribute('aria-label'));
  const bar = screen.getByTestId('inbound-action-bar');
  const controls = within(bar).getAllByRole('button').map((b) => b.getAttribute('data-testid') ?? b.textContent);
  return { regions, controls };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  Object.values(mocks).forEach((m) => (typeof m === 'function' && 'mockReset' in m ? m.mockReset() : undefined));
  mocks.flags = new Set();
  mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role: 'agent' });
  mocks.createAgencySession.mockResolvedValue(BOOTSTRAP);
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  mocks.updateInboundCallNotes.mockImplementation(async (_id: string, notes: string) => ({ ok: true, value: owing({ notes }) }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the offer', () => {
  it('puts the caller’s panel on the station before any audio: who, the number rung, the route, the contact', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'available', since: SINCE });
    await frame({ event: 'agent_state', state: 'reserved', since: SINCE });
    await call(inboundCall());

    expect(screen.getByTestId('station-inbound')).toBeTruthy();
    expect(screen.getByTestId('rail-label').textContent).toBe('Incoming call from Asha Rao');
    expect(screen.getByTestId('rail-detail').textContent).toMatch(/connecting you now/);
    expect(screen.getByTestId('inbound-caller-name').textContent).toBe('Asha Rao');
    expect(screen.getByTestId('inbound-caller-number').textContent).toMatch(/98204/);
    expect(screen.getByTestId('inbound-route').textContent).toBe('Customer care');
    expect(screen.getByTestId('inbound-campaign').textContent).toBe('Card Renewals · Waiting');
    expect(screen.getByTestId('inbound-sticky').textContent).toBe('Your customer: you last spoke to them');
    expect(screen.getByTestId('inbound-recording').textContent).toBe('Recording');
    expect(screen.getByTestId('inbound-waited').textContent).toBe('Waited 42 s');
    // The matched contact's fields and earlier calls, the call's campaign named (not "This campaign").
    expect(within(screen.getByTestId('inbound-match')).getByText('P-778')).toBeTruthy();
    expect(screen.getByTestId('prior-attempts').textContent).toMatch(/Card Renewals/);
    expect(screen.getByTestId('prior-attempts').textContent).not.toMatch(/This campaign/);
    // The campaign's own panel is not on screen.
    expect(screen.queryByRole('region', { name: 'Contact detail' })).toBeNull();
  });

  it('offers nothing to act on until the caller is connected, each with its reason', async () => {
    await mounted();
    await call(inboundCall());
    expect((screen.getByTestId('inbound-save') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('inbound-dnc') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('inbound-mute') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Connecting you to the caller…')).toBeTruthy();
    // The pad shows its outcomes, disabled, with the reason.
    expect(screen.getByText('Outcomes open when you’re connected to the caller.')).toBeTruthy();
    // E twice does not hang up on a caller who has not heard anyone yet.
    fireEvent.keyDown(window, { key: 'e' });
    fireEvent.keyDown(window, { key: 'e' });
    expect(mocks.hangupInboundCall).not.toHaveBeenCalled();
  });

  it('a withheld, unmatched caller on a DNC list: "Number withheld", the enquiry wording, no DNC button', async () => {
    await mounted();
    await call(connected({ from_e164: null, match: null, caller_dnc: true, sticky: null, catalog_source: 'route' }));
    expect(screen.getByTestId('inbound-caller-number').textContent).toBe('Number withheld');
    expect(screen.queryByTestId('inbound-caller-name')).toBeNull();
    expect(screen.getByTestId('inbound-dnc-badge').textContent).toBe('On Do Not Call');
    expect(screen.getByTestId('inbound-dnc-enquiry').textContent).toMatch(/customer’s own call is an enquiry/);
    expect(screen.getByTestId('inbound-no-match').textContent).toMatch(/no number to match/);
    expect(screen.getByTestId('inbound-campaign').textContent).toBe('Not on a campaign');
    expect((screen.getByTestId('inbound-dnc') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('From the Customer care route’s outcome list')).toBeTruthy();
  });
});

describe('the frozen geometry', () => {
  it('renders the same regions and the same controls, in the same order, offered, connected and owing', async () => {
    await mounted();
    await call(inboundCall());
    const offered = layout();
    await call(connected());
    const live = layout();
    await call(owing());
    const owed = layout();

    expect(offered.regions).toEqual(['Caller', 'Contact', 'Outcome']);
    expect(live).toEqual(offered);
    expect(owed).toEqual(offered);
    expect(offered.controls).toEqual(['inbound-save', 'inbound-dnc', 'inbound-mute', expect.stringMatching(/hang up/i)]);
    // The pad renders every outcome in every state.
    for (const label of ['Resolved', 'Call back', 'Complaint']) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
  });

  it('the rail carries a talk timer while connected and the lapse countdown while the outcome is owed', async () => {
    await mounted();
    await call(connected());
    expect(screen.getByTestId('rail-label').textContent).toBe('On a call with Asha Rao');
    expect(screen.getByTestId('inbound-talk-timer')).toBeTruthy();
    expect(screen.queryByTestId('inbound-lapse')).toBeNull();
    await call(owing());
    expect(screen.getByTestId('rail-label').textContent).toBe('Outcome needed');
    expect(screen.queryByTestId('inbound-talk-timer')).toBeNull();
    expect(screen.getByTestId('inbound-lapse').textContent).toMatch(/^Without one, it closes in(Closes in)? \d+:\d\d/);
    expect(screen.getByTestId('inbound-lapse').textContent).toMatch(/the call closes at \d\d:\d\d/);
  });
});

describe('finishing the call', () => {
  it('hangs up with E twice once connected', async () => {
    mocks.hangupInboundCall.mockResolvedValue({ ok: true, value: connected() });
    await mounted();
    await call(connected());
    await act(async () => {
      fireEvent.keyDown(window, { key: 'e' });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'e' });
    });
    expect(mocks.hangupInboundCall).toHaveBeenCalledWith('ib-1', 't-1', 'a-1');
  });

  it('saves the outcome from the keys, then gives the station back', async () => {
    mocks.dispositionInboundCall.mockResolvedValue({
      ok: true,
      value: {
        call: owing({ settled_at: '2026-11-09T10:05:00Z', disposition_code: 'resolved' }),
        contact_state: 'completed',
        next_attempt_at: null,
        callback_requested_at: null,
      },
    });
    await mounted();
    await call(owing());
    expect(screen.getByTestId('inbound-save-reason').textContent).toBe('Pick an outcome to save this call.');
    fireEvent.keyDown(window, { key: '1' });
    expect(screen.queryByTestId('inbound-save-reason')).toBeNull();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    expect(mocks.dispositionInboundCall).toHaveBeenCalledWith('ib-1', { code: 'resolved' }, 't-1', 'a-1');
    expect(screen.queryByTestId('station-inbound')).toBeNull();
  });

  it('autosaves the notes as the agent types', async () => {
    await mounted();
    await call(owing());
    fireEvent.change(screen.getByRole('textbox', { name: /notes/i }), { target: { value: 'Moved house' } });
    await waitFor(() => expect(mocks.updateInboundCallNotes).toHaveBeenCalledWith('ib-1', 'Moved house', 't-1', 'a-1'));
  });

  it('marks DNC after the confirmation, for the call’s campaign', async () => {
    mocks.markInboundCallDnc.mockResolvedValue({
      ok: true,
      value: { call_id: 'ib-1', phone_e164: '+919820461733', scope: 'campaign', dnc_recorded: true, contact_state: 'suppressed' },
    });
    await mounted();
    await call(owing());
    fireEvent.click(screen.getByTestId('inbound-dnc'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/won’t be called again for Card Renewals/);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add to Do Not Call' }));
    });
    expect(mocks.markInboundCallDnc).toHaveBeenCalledWith('ib-1', undefined, 't-1', 'a-1');
    expect(screen.getByTestId('inbound-dnc-outcome').textContent).toMatch(/for Card Renewals\.$/);
  });

  it('a caller who hangs up before audio binds gives the station back, and says so', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'reserved', since: SINCE });
    await call(inboundCall());
    await call(inboundCall({ state: 'ended', outcome: 'abandoned_in_queue', settled_at: '2026-11-09T10:00:01Z' }));
    await frame({ event: 'agent_state', state: 'available', since: SINCE });
    expect(screen.queryByTestId('station-inbound')).toBeNull();
    expect(screen.getByTestId('inbound-notice').textContent).toBe('The caller hung up before you were connected.');
  });

  it('is restored by the frame the server sends after a reload’s ready', async () => {
    await mounted();
    await frame({ event: 'ready', session_id: 'sess-1', state: 'wrapup' });
    await call(owing({ notes: 'Before the reload' }));
    expect(screen.getByTestId('station-inbound')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: /notes/i }) as HTMLTextAreaElement).value).toBe('Before the reload');
  });
});

describe('Your customer is waiting', () => {
  it('is a pill on the campaign station while the agent is busy, and goes when they are offered the call', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'on_call', since: SINCE });
    await frame({
      event: 'customer_waiting',
      inbound_call_id: 'ib-1',
      from_e164: '+919820461733',
      match_name: 'Asha Rao',
      waiting_since: SINCE,
    });
    expect(screen.getByTestId('customer-waiting').textContent).toBe('Your customer is waiting: Asha Rao');
    await frame({ event: 'agent_state', state: 'reserved', since: SINCE });
    await call(inboundCall());
    await call(inboundCall({ state: 'ended', outcome: 'abandoned_in_queue', settled_at: '2026-11-09T10:00:01Z' }));
    expect(screen.queryByTestId('customer-waiting')).toBeNull();
  });
});
