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
 * `inbound_call` frame puts the caller on the station in place of the campaign's call, in the
 * station's look (AS1, one main button bottom right), before the caller's audio binds (IB1); it carries the call through
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

/** The footer's buttons, left to right: what the agent can press now (AS1: nothing else is there). */
function footButtons(): string[] {
  const foot = screen.getByTestId('station-inbound').querySelector('footer');
  if (!foot) return [];
  return within(foot as HTMLElement).queryAllByRole('button').map((b) => b.getAttribute('data-testid') ?? b.textContent ?? '');
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
  it('puts the caller on the station before any audio, in the station’s look: the card, About this call, Last calls', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'available', since: SINCE });
    await frame({ event: 'agent_state', state: 'reserved', since: SINCE });
    await call(inboundCall());

    expect(screen.getByTestId('station-inbound')).toBeTruthy();
    // The station's band (ruling 2): the same words and colour as an outbound call coming.
    expect(screen.getByTestId('band-title').textContent).toBe('Customer is calling');
    expect(screen.getByTestId('band-subtitle').textContent).toBe('Get ready. Say Namaste first.');
    expect(screen.getByTestId('station-band').getAttribute('data-tone')).toBe('coming');
    expect(screen.getByTestId('inbound-recording').textContent).toBe('Call is recorded');
    // The outbound call's customer card: name, place, the number, the facts.
    const card = screen.getByTestId('customer-card');
    expect(within(card).getByTestId('customer-name').textContent).toBe('Asha Rao');
    expect(within(card).getByTestId('customer-place').textContent).toBe('Pune');
    expect(within(card).getByTestId('customer-phone').textContent).toMatch(/98204/);
    expect(within(card).getByText('P-778')).toBeTruthy();
    expect(within(card).getByTestId('customer-last-said').textContent).toMatch(/Asked to ring after six/);
    // About this call, in the station's words.
    expect(screen.getByTestId('inbound-to').textContent).toMatch(/22489/);
    expect(screen.getByTestId('inbound-route').textContent).toBe('Customer care');
    expect(screen.getByTestId('inbound-campaign').textContent).toBe('Card Renewals');
    expect(screen.getByTestId('inbound-sticky').textContent).toBe('Your customer. You spoke to them last time.');
    expect(screen.getByTestId('inbound-waited').textContent).toBe('0:42');
    // Last calls, named by the matched work's own list.
    expect(screen.getByTestId('last-calls').textContent).toMatch(/No answer/);
    // The campaign's own panel is not on screen.
    expect(screen.queryByTestId('customer-card')).toBe(card);
    expect(screen.queryByRole('region', { name: 'Contact detail' })).toBeNull();
  });

  it('has no button until the caller is connected (AS11): the call connects by itself', async () => {
    await mounted();
    await call(inboundCall());
    expect(footButtons()).toEqual([]);
    expect(screen.getByText('The call connects by itself.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Hold to end call' })).toBeNull();
    expect(screen.queryByTestId('inbound-save')).toBeNull();
    // E twice does not hang up on a caller who has not heard anyone yet.
    fireEvent.keyDown(window, { key: 'e' });
    fireEvent.keyDown(window, { key: 'e' });
    expect(mocks.hangupInboundCall).not.toHaveBeenCalled();
  });

  it('shows the number as the station’s phone display says (AS9)', async () => {
    mocks.createAgencySession.mockResolvedValue({ ...BOOTSTRAP, phone_display: 'masked' });
    await mounted();
    await call(inboundCall());
    expect(screen.getByTestId('customer-phone').textContent).toBe('98••• ••733');
  });

  it('a withheld, unmatched caller on a DNC list: "Number hidden", the enquiry, ask their name, no Don’t call again', async () => {
    await mounted();
    await call(connected({ from_e164: null, match: null, caller_dnc: true, sticky: null, catalog_source: 'route' }));
    expect(screen.getByTestId('customer-name').textContent).toBe('Number hidden');
    expect(screen.getByTestId('inbound-dnc-badge').textContent).toBe('Asked not to be called');
    expect(screen.getByTestId('inbound-dnc-enquiry').textContent).toMatch(/They called us, so help them now/);
    expect(screen.getByTestId('inbound-no-match').textContent).toMatch(/number is hidden\. Ask the customer’s name and number/);
    expect(screen.getByTestId('inbound-campaign').textContent).toBe('Not in any work');
    expect(screen.queryByTestId('last-calls')).toBeNull();
    // D does nothing: there is no number to mark.
    fireEvent.keyDown(window, { key: 'd' });
    expect(screen.queryByTestId('stop-calling')).toBeNull();
    await call(owing({ from_e164: null, match: null, caller_dnc: true, sticky: null, catalog_source: 'route' }));
    expect(screen.queryByTestId('dont-call-again-row')).toBeNull();
  });
});

describe('one main button, bottom right (AS1)', () => {
  it('End call while connected, Save once the outcome is owed; nothing else moves in', async () => {
    await mounted();
    await call(connected());
    expect(screen.getByTestId('band-title').textContent).toBe('On call');
    expect(screen.getByRole('button', { name: 'Hold to end call' })).toBeTruthy();
    expect(screen.queryByTestId('inbound-save')).toBeNull();
    expect(footButtons().at(-1)).toMatch(/Hold to end call/);
    await call(owing());
    expect(screen.getByTestId('band-title').textContent).toBe('What happened?');
    expect(screen.queryByRole('button', { name: 'Hold to end call' })).toBeNull();
    expect(footButtons().at(-1)).toBe('inbound-save');
    // The station's own tiles: one per outcome, in the call's list's order, keys 1–9.
    const tiles = within(screen.getByTestId('outcome-tiles')).getAllByRole('button', { pressed: false });
    expect(tiles.map((t) => t.getAttribute('data-testid'))).toEqual(['outcome-resolved', 'outcome-callback', 'outcome-complaint']);
  });

  it('the band carries a talk timer while connected and the time left while the outcome is owed', async () => {
    await mounted();
    await call(connected());
    expect(screen.getByTestId('band-subtitle').textContent).toBe('Asha Rao');
    expect(screen.getByTestId('inbound-talk-timer')).toBeTruthy();
    expect(screen.queryByTestId('inbound-lapse')).toBeNull();
    await call(owing());
    expect(screen.queryByTestId('inbound-talk-timer')).toBeNull();
    expect(screen.getByTestId('inbound-lapse-digits').textContent).toMatch(/^\d+:\d\d$/);
    expect(screen.getByTestId('inbound-lapse').textContent).toMatch(/If you do not choose, this call closes at \d{1,2}:\d\d (AM|PM)\./);
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

  it('Save before a pick says what is missing and saves nothing; the keys then pick and save, and give the station back', async () => {
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
    const save = screen.getByTestId('inbound-save');
    expect(save.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(save);
    expect(screen.getByTestId('inbound-save-reason').textContent).toBe('Choose one first.');
    expect(screen.getByTestId('outcome-tiles').getAttribute('data-shake')).toBe('true');
    expect(mocks.dispositionInboundCall).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: '1' });
    expect(screen.queryByTestId('inbound-save-reason')).toBeNull();
    expect(screen.getByTestId('outcome-resolved').getAttribute('aria-pressed')).toBe('true');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    expect(mocks.dispositionInboundCall).toHaveBeenCalledWith('ib-1', { code: 'resolved' }, 't-1', 'a-1');
    expect(screen.queryByTestId('station-inbound')).toBeNull();
  });

  it('autosaves the notes as the agent types', async () => {
    await mounted();
    await call(owing());
    fireEvent.change(screen.getByRole('textbox', { name: /note/i }), { target: { value: 'Moved house' } });
    await waitFor(() => expect(mocks.updateInboundCallNotes).toHaveBeenCalledWith('ib-1', 'Moved house', 't-1', 'a-1'));
  });

  it('Don’t call again under the tiles asks first, for the caller’s work, then marks the number', async () => {
    mocks.markInboundCallDnc.mockResolvedValue({
      ok: true,
      value: { call_id: 'ib-1', phone_e164: '+919820461733', scope: 'campaign', dnc_recorded: true, contact_state: 'suppressed' },
    });
    await mounted();
    await call(owing());
    fireEvent.click(screen.getByTestId('dont-call-again-row'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/Stop calling this customer\?/);
    expect(dialog.textContent).toMatch(/We will not call this number again for Card Renewals\./);
    expect(mocks.markInboundCallDnc).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId('stop-calling-yes'));
    });
    expect(mocks.markInboundCallDnc).toHaveBeenCalledWith('ib-1', undefined, 't-1', 'a-1');
    expect(screen.getByTestId('inbound-dnc-outcome').textContent).toBe('We will not call this number again.');
    expect(screen.queryByTestId('dont-call-again-row')).toBeNull();
  });

  it('D on the call opens the same question; No, go back marks nothing', async () => {
    await mounted();
    await call(connected());
    fireEvent.keyDown(window, { key: 'd' });
    expect(screen.getByTestId('stop-calling')).toBeTruthy();
    fireEvent.click(screen.getByTestId('stop-calling-no'));
    expect(screen.queryByTestId('stop-calling')).toBeNull();
    expect(mocks.markInboundCallDnc).not.toHaveBeenCalled();
  });

  it('an outcome that stops calls asks first; Yes picks it and marks nothing by itself', async () => {
    const catalog = [...owing().disposition_catalog, { code: 'stop', label: 'Don’t call again', suppress: true }];
    await mounted();
    await call(owing({ disposition_catalog: catalog }));
    // The list has its own stop outcome: no separate row (spec §6.2).
    expect(screen.queryByTestId('dont-call-again-row')).toBeNull();
    fireEvent.click(screen.getByTestId('outcome-stop'));
    expect(screen.getByTestId('outcome-stop').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('dialog').textContent).toMatch(/Stop calling this customer\?/);
    fireEvent.click(screen.getByTestId('stop-calling-yes'));
    expect(screen.getByTestId('outcome-stop').getAttribute('aria-pressed')).toBe('true');
    expect(mocks.markInboundCallDnc).not.toHaveBeenCalled();
  });

  it('a caller who hangs up before audio binds gives the station back, and says so', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'reserved', since: SINCE });
    await call(inboundCall());
    await call(inboundCall({ state: 'ended', outcome: 'abandoned_in_queue', settled_at: '2026-11-09T10:00:01Z' }));
    await frame({ event: 'agent_state', state: 'available', since: SINCE });
    expect(screen.queryByTestId('station-inbound')).toBeNull();
    expect(screen.getByTestId('inbound-notice').textContent).toBe('The customer hung up before you were connected.');
  });

  it('is restored by the frame the server sends after a reload’s ready', async () => {
    await mounted();
    await frame({ event: 'ready', session_id: 'sess-1', state: 'wrapup' });
    await call(owing({ notes: 'Before the reload' }));
    expect(screen.getByTestId('station-inbound')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: /note/i }) as HTMLTextAreaElement).value).toBe('Before the reload');
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
