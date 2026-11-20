import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
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
  getInboundCall: vi.fn(),
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
vi.mock('../../api/inbound', () => ({
  getInboundCall: mocks.getInboundCall,
  updateInboundCallNotes: vi.fn(),
  hangupInboundCall: vi.fn(),
  dispositionInboundCall: vi.fn(),
  markInboundCallDnc: vi.fn(),
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u-1', display_name: 'Ravi Kumar', email: 'ravi@example.com', avatar_url: null } }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) }),
}));

import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { stubStationMicrophone } from '../helpers/stationDevices';
import { ApiError } from '../../api/client';
import { FakeSocket, latestSocket } from '../helpers/fakeSocket';
import { inboundCall } from '../helpers/inbound';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';

/**
 * Floor assist on the agent's console station (LF4, LF5, LF24–LF26, AS5): Need help raised and
 * cancelled from the top bar on On call and What happened? (where today's server accepts it),
 * restored on reconnect and ended only by a frame about the request on screen; supervisors'
 * messages shown as text under the band, announced politely, never taking focus; and the break's
 * time against its limit (07, 08).
 */

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  contact_id: 'c-1',
  phone_e164: '+919876543210',
  caller_id: '+911234567890',
  attempt_number: 1,
  context: { 'First Name': 'Asha' },
  prior_attempts: [],
};

const BOOTSTRAP: AgencySessionBootstrap = {
  session_id: 'sess-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  agent_user_id: 'u-1',
  state: 'offline',
  campaign_status: 'running',
  station_ws_url: '/proxy/agency/station/sess-1?token=t1',
  disposition_catalog: [{ code: 'sale', label: 'Sale' }],
  wrapup_seconds: 30,
  wrapup_auto_return: true,
  record_calls: false,
  break_reasons: [
    { code: 'tea', label: 'Tea', limit_minutes: 15 },
    { code: 'training', label: 'Training' },
  ],
  context_display: {},
  intervals: { heartbeat_ms: 10_000, heartbeat_grace_ms: 30_000, reservation_lease_ms: 10_000, countdown_ms: 3000 },
};

const R1 = '2026-11-19T10:00:00.000Z';
const R0 = '2026-11-19T09:30:00.000Z';
const FLAG = 'agency_floor_assist_enabled';

let microphone: ReturnType<typeof stubStationMicrophone>;
beforeEach(() => {
  microphone = stubStationMicrophone();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  Object.values(mocks).forEach((m) => (typeof m === 'function' && 'mockReset' in m ? m.mockReset() : undefined));
  mocks.flags = new Set([FLAG]);
  mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role: 'agent' });
  mocks.createAgencySession.mockResolvedValue(BOOTSTRAP);
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  mocks.raiseHelp.mockResolvedValue({ session_id: 'sess-1', help: { raised_at: R1, call_id: 'call-1' } });
  mocks.cancelHelp.mockResolvedValue({ session_id: 'sess-1', help: null });
});

afterEach(() => {
  cleanup();
  microphone.restore();
  vi.unstubAllGlobals();
});

const message = (id: string, text: string, from: string | null = 'Priya N') => ({
  event: 'supervisor_message',
  id,
  text,
  from_name: from,
  sent_at: '2026-11-19T10:01:00.000Z',
});

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

async function onCall() {
  await mounted();
  await frame({ event: 'reserved', attempt: ATTEMPT });
  await frame({ event: 'agent_state', state: 'reserved', since: '2026-11-19T09:59:00.000Z' });
  await frame({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-11-19T09:59:04.000Z' });
  await frame({ event: 'agent_state', state: 'on_call', since: '2026-11-19T09:59:04.000Z' });
}

const helpButton = () => screen.getByTestId('need-help-button');
/** What the station says about the request once something happened to it (answered, lapsed). */
const status = () => screen.queryByTestId('need-help-status-body')?.textContent ?? null;
/** The button while a request is open: "Help asked · 0:42" (spec §3), pressing it cancels. */
const asked = () => /^Help asked · [\d:]+$/.test(helpButton().textContent ?? '');
/** Everything the polite region holds, one entry per thing said, oldest first. */
const said = () => within(screen.getByTestId('floor-assist-announcer')).queryAllByTestId('floor-assist-said').map((n) => n.textContent);
/** The last thing the polite region said. */
const announcer = () => said().at(-1) ?? '';

async function pressHelp() {
  await act(async () => {
    fireEvent.click(helpButton());
  });
}

describe('Need help: offered', () => {
  it('is not in the bar at all while the flag is off', async () => {
    mocks.flags = new Set();
    await onCall();
    expect(screen.queryByTestId('need-help-button')).toBeNull();
    expect(screen.queryByRole('button', { name: /Need help/ })).toBeNull();
  });

  it('sits top right in the top bar, before ⋮ More, and is reachable by Tab', async () => {
    await onCall();
    const header = screen.getByTestId('station').querySelector('header')!;
    const order = Array.from(header.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '');
    expect(order).toEqual(['Need help', 'More']);
    expect(helpButton().tabIndex).toBeGreaterThanOrEqual(0);
    expect(helpButton().hasAttribute('disabled')).toBe(false);
  });

  it('is on every working screen (BE-9): Ready and a break, never Start of day', async () => {
    await mounted();
    expect(screen.queryByTestId('need-help-button')).toBeNull();
    await frame({ event: 'agent_state', state: 'break', since: '2026-11-19T09:00:00.000Z', break_reason: 'tea' });
    expect(helpButton()).toBeTruthy();
    await frame({ event: 'agent_state', state: 'available', since: '2026-11-19T09:00:00.000Z' });
    await pressHelp();
    expect(mocks.raiseHelp).toHaveBeenCalledWith('sess-1', 't-1', 'a-1');
  });

  it('an older server’s help_not_on_call narrows it back to calls for this session', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'available', since: '2026-11-19T09:00:00.000Z' });
    mocks.raiseHelp.mockRejectedValueOnce(new ApiError(409, { error: 'Conflict', code: 'help_not_on_call', message: 'raw' }));
    await pressHelp();
    // Hidden off a call from now on (AS1), with the reason said once.
    expect(screen.queryByTestId('need-help-button')).toBeNull();
    expect(screen.getByTestId('need-help-refusal-body').textContent).toBe('You can ask for help on a call, or while you choose what happened.');
    await frame({ event: 'agent_state', state: 'break', since: '2026-11-19T09:05:00.000Z', break_reason: 'tea' });
    expect(screen.queryByTestId('need-help-button')).toBeNull();
    await frame({ event: 'agent_state', state: 'available', since: '2026-11-19T09:20:00.000Z' });
    // On a call it is offered again.
    await frame({ event: 'reserved', attempt: ATTEMPT });
    await frame({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-11-19T10:00:04.000Z' });
    expect(helpButton()).toBeTruthy();
    expect(mocks.raiseHelp).toHaveBeenCalledTimes(1);
  });

  it('is offered in wrap-up too', async () => {
    await onCall();
    await frame({ event: 'released', attempt_id: 'att-1', reason: 'customer_hangup', requires_disposition: true });
    await frame({ event: 'agent_state', state: 'wrapup', since: '2026-11-19T10:02:00.000Z' });
    expect(helpButton().getAttribute('aria-disabled')).toBeNull();
    await pressHelp();
    expect(mocks.raiseHelp).toHaveBeenCalledTimes(1);
  });
});

describe('Need help: raise and cancel', () => {
  it('raises on the agent’s own session, shows it is waiting, and the same button (still focused) cancels', async () => {
    await onCall();
    const button = helpButton();
    button.focus();
    await pressHelp();
    expect(mocks.raiseHelp).toHaveBeenCalledWith('sess-1', 't-1', 'a-1');
    // Solid red, "Help asked · 0:42" (spec §3); nothing else on screen about it yet.
    expect(asked()).toBe(true);
    expect(helpButton().getAttribute('data-open')).toBe('true');
    expect(status()).toBeNull();
    expect(announcer()).toBe('Help requested. Your supervisors can see it.');
    // The same node, now the way to cancel: focus never moved.
    expect(helpButton()).toBe(button);
    expect(document.activeElement).toBe(button);

    await pressHelp();
    expect(mocks.cancelHelp).toHaveBeenCalledWith('sess-1', 't-1', 'a-1');
    expect(status()).toBeNull();
    expect(helpButton().textContent).toBe('Need help');
    expect(announcer()).toBe('Help request cancelled.');
  });

  it('sends one request for a double press, and a re-raise answering the open request changes nothing', async () => {
    await onCall();
    let resolve!: (v: unknown) => void;
    mocks.raiseHelp.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    await act(async () => {
      fireEvent.click(helpButton());
      fireEvent.click(helpButton());
    });
    expect(mocks.raiseHelp).toHaveBeenCalledTimes(1);
    expect(helpButton().getAttribute('aria-disabled')).toBe('true');
    expect(helpButton().textContent).toContain('Asking…');
    await act(async () => {
      resolve({ session_id: 'sess-1', help: { raised_at: R1, call_id: 'call-1' } });
    });
    expect(asked()).toBe(true);
    // A reconnect's `ready` restating the same request (as a server re-raise would answer it).
    await frame({ event: 'ready', session_id: 'sess-1', state: 'on_call', help: { raised_at: R1, call_id: 'call-1' } });
    expect(asked()).toBe(true);
    expect(status()).toBeNull();
  });

  it.each([
    ['floor_assist_disabled', 403, 'Need help is not turned on. Call your supervisor to your desk.'],
    ['help_not_on_call', 409, 'You can ask for help on a call, or while you choose what happened.'],
    ['session_ended', 409, 'Your work was closed. Open today’s work again to ask for help.'],
    ['account_scope_required', 400, 'Open your work from your account to ask for help.'],
    [null, 404, 'Your work was not found. Open today’s work again to ask for help.'],
    [null, 403, 'You cannot ask for help here. Call your supervisor to your desk.'],
    [null, 500, 'Your request did not go through. Try again.'],
  ])('says the refusal %s (%i) in the station’s words, and opens nothing', async (code, statusCode, words) => {
    await onCall();
    mocks.raiseHelp.mockRejectedValueOnce(
      new ApiError(statusCode, code ? { error: 'Refused', code, message: 'raw' } : { error: 'Not Found', message: 'Session not found' }),
    );
    await pressHelp();
    expect(screen.getByTestId('need-help-refusal-body').textContent).toBe(words);
    // Said aloud in the same words, never the server's sentence (AS15).
    expect(announcer()).toBe(words);
    expect(status()).toBeNull();
    expect(helpButton().textContent).toBe('Need help');
  });

  it('says a failed cancel, and keeps the request open', async () => {
    await onCall();
    await pressHelp();
    mocks.cancelHelp.mockRejectedValueOnce(new Error('offline'));
    await pressHelp();
    expect(screen.getByTestId('need-help-refusal-body').textContent).toBe('Your request could not be cancelled. Try again.');
    expect(asked()).toBe(true);
  });

  it('offers the cancel after the call has ended: a request outlives its call', async () => {
    await onCall();
    await pressHelp();
    await frame({ event: 'agent_state', state: 'available', since: '2026-11-19T10:05:00.000Z' });
    // Off the call the request stays on screen, so it can be cancelled.
    expect(helpButton().getAttribute('aria-disabled')).toBeNull();
    expect(asked()).toBe(true);
    await pressHelp();
    expect(mocks.cancelHelp).toHaveBeenCalledTimes(1);
  });
});

describe('Need help: what the station hears', () => {
  it('restores an open request from ready.help on reconnect', async () => {
    await mounted();
    await frame({ event: 'ready', session_id: 'sess-1', state: 'on_call', help: { raised_at: R1, call_id: 'call-1' } });
    expect(asked()).toBe(true);
  });

  it('says who is listening, then keeps it as a dismissible notice once the request ends', async () => {
    await onCall();
    await pressHelp();
    await frame({ event: 'help_answered', raised_at: R1, by_name: 'Priya', how: 'listen' });
    expect(status()).toBe('Help is here. Priya is listening to this call.');
    expect(announcer()).toBe('Help is here. Priya is listening to this call.');
    await frame({ event: 'help_cleared', raised_at: R1, reason: 'answered' });
    expect(status()).toBe('Help is here. Priya is listening to this call.');
    expect(helpButton().textContent).toBe('Need help');
    fireEvent.click(screen.getByTestId('need-help-dismiss'));
    expect(status()).toBeNull();
  });

  it('words an answer by message, and an answer whose name could not be read', async () => {
    await onCall();
    await pressHelp();
    await frame({ event: 'help_answered', raised_at: R1, by_name: null, how: 'message' });
    await frame({ event: 'help_cleared', raised_at: R1, reason: 'answered' });
    expect(status()).toBe('Help is here. Your supervisor sent you a message.');
  });

  it('ignores an answer and a clear about another request than the one on screen', async () => {
    await onCall();
    await pressHelp();
    await frame({ event: 'help_answered', raised_at: R0, by_name: 'Priya', how: 'listen' });
    await frame({ event: 'help_cleared', raised_at: R0, reason: 'expired' });
    expect(status()).toBeNull();
    expect(asked()).toBe(true);
  });

  it('says a lapsed request may be raised again', async () => {
    await onCall();
    await pressHelp();
    await frame({ event: 'help_cleared', raised_at: R1, reason: 'expired' });
    expect(status()).toBe('No supervisor answered. Ask again if you still need help.');
    expect(helpButton().textContent).toBe('Need help');
    // Raising again retires the notice.
    mocks.raiseHelp.mockResolvedValueOnce({ session_id: 'sess-1', help: { raised_at: '2026-11-19T10:20:00.000Z', call_id: null } });
    await pressHelp();
    expect(status()).toBeNull();
    expect(asked()).toBe(true);
  });

  it('clears silently when the session ends', async () => {
    await onCall();
    await pressHelp();
    const before = said();
    await frame({ event: 'help_cleared', raised_at: R1, reason: 'session_ended' });
    expect(status()).toBeNull();
    expect(screen.queryByTestId('need-help-dismiss')).toBeNull();
    expect(said()).toEqual(before);
  });
});

describe('supervisor messages', () => {
  it('shows the sender, the time and the text as plain text, never as markup', async () => {
    await onCall();
    const hostile = 'Offer the <b>3-month</b> plan <img src=x onerror="window.__pwned=1">';
    await frame(message('m-1', hostile));
    const card = screen.getByTestId('supervisor-message');
    expect(within(card).getByText('Priya N')).toBeTruthy();
    expect(card.querySelector('time')!.getAttribute('datetime')).toBe('2026-11-19T10:01:00.000Z');
    expect(screen.getByTestId('supervisor-message-text').textContent).toBe(hostile);
    expect(card.querySelector('b')).toBeNull();
    expect(card.querySelector('img')).toBeNull();
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('is announced in a polite live region, and never takes focus from the call controls', async () => {
    await onCall();
    const hangup = screen.getByRole('button', { name: 'Hold to end call' });
    hangup.focus();
    expect(document.activeElement).toBe(hangup);
    await frame(message('m-1', 'Wrap up this call'));
    expect(document.activeElement).toBe(hangup);
    const region = screen.getByTestId('floor-assist-announcer');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('role')).not.toBe('alert');
    // Each utterance a node of its own, said as it is added.
    expect(region.getAttribute('aria-atomic')).toBe('false');
    expect(said()).toEqual(['Message from Priya N: Wrap up this call']);
    // A banner under the band, never inside the footer's controls: nothing in the footer moved.
    const footer = screen.getByTestId('station').querySelector('footer')!;
    expect(footer.contains(screen.getByTestId('supervisor-message'))).toBe(false);
    expect(screen.getByTestId('station-banners').contains(screen.getByTestId('supervisor-message'))).toBe(true);
  });

  it('signs a message whose sender could not be read “Your supervisor”', async () => {
    await onCall();
    await frame(message('m-1', 'Carry on', null));
    expect(within(screen.getByTestId('supervisor-message')).getByText('Your supervisor')).toBeTruthy();
  });

  it('shows one at a time with the rest counted, each once; OK shows the next (spec 02b)', async () => {
    await onCall();
    for (const id of ['m-1', 'm-2', 'm-3', 'm-4']) await frame(message(id, `Note ${id}`));
    await frame(message('m-2', 'Note m-2'));
    expect(screen.getAllByTestId('supervisor-message')).toHaveLength(1);
    expect(screen.getByTestId('supervisor-message-text').textContent).toBe('Note m-1');
    expect(screen.getByTestId('supervisor-messages-more').textContent).toBe('3 more messages');
    fireEvent.click(screen.getByTestId('supervisor-message-ok'));
    expect(screen.getByTestId('supervisor-message-text').textContent).toBe('Note m-2');
    expect(screen.getByTestId('supervisor-messages-more').textContent).toBe('2 more messages');
    fireEvent.click(screen.getByTestId('supervisor-message-ok'));
    fireEvent.click(screen.getByTestId('supervisor-message-ok'));
    expect(screen.getByTestId('supervisor-message-text').textContent).toBe('Note m-4');
    expect(screen.queryByTestId('supervisor-messages-more')).toBeNull();
  });

  it('drops a malformed frame rather than show an empty message', async () => {
    await onCall();
    await frame({ event: 'supervisor_message', id: 'm-1', from_name: 'Priya', sent_at: R1 });
    expect(screen.queryByTestId('supervisor-message')).toBeNull();
  });
});

describe('what the polite region says (LF25)', () => {
  it('says a Talk answer’s message and then the answer, the message never overwritten', async () => {
    await onCall();
    await pressHelp();
    // A Talk answer, in the server's order.
    await frame(message('m-1', 'Offer the 3-month plan'));
    await frame({ event: 'help_answered', raised_at: R1, by_name: 'Priya N', how: 'message' });
    await frame({ event: 'help_cleared', raised_at: R1, reason: 'answered' });
    expect(said()).toEqual([
      'Help requested. Your supervisors can see it.',
      'Message from Priya N: Offer the 3-month plan',
      'Help is here. Priya N sent you a message.',
    ]);
  });

  it('says the same words again when they are said again', async () => {
    await onCall();
    await frame(message('m-1', 'Carry on'));
    await frame(message('m-2', 'Carry on'));
    expect(said()).toEqual(['Message from Priya N: Carry on', 'Message from Priya N: Carry on']);
    // The same refusal twice.
    mocks.raiseHelp.mockRejectedValue(new Error('offline'));
    await pressHelp();
    await pressHelp();
    expect(said().slice(-2)).toEqual([
      'Your request did not go through. Try again.',
      'Your request did not go through. Try again.',
    ]);
  });

  it('keeps one region through a move to an inbound call and back, and says nothing again', async () => {
    mocks.getInboundCall.mockReturnValue(new Promise(() => {}));
    await onCall();
    await pressHelp();
    await frame({ event: 'help_answered', raised_at: R1, by_name: 'Priya N', how: 'listen' });
    await frame(message('m-1', 'I am listening'));
    const region = screen.getByTestId('floor-assist-announcer');
    const before = said();
    expect(before).toEqual([
      'Help requested. Your supervisors can see it.',
      'Help is here. Priya N is listening to this call.',
      'Message from Priya N: I am listening',
    ]);
    await frame({ event: 'agent_state', state: 'reserved', since: '2026-11-19T10:03:00.000Z' });
    await frame({ event: 'inbound_call', call: inboundCall() });
    expect(screen.getByTestId('station-inbound')).toBeTruthy();
    // The same node, holding what it held: not remounted, nothing said again.
    expect(screen.getByTestId('floor-assist-announcer')).toBe(region);
    expect(said()).toEqual(before);
    await frame({ event: 'inbound_call', call: inboundCall({ state: 'ended', outcome: 'abandoned_in_queue', settled_at: '2026-11-19T10:03:01Z' }) });
    await frame({ event: 'agent_state', state: 'available', since: '2026-11-19T10:03:01.000Z' });
    expect(screen.queryByTestId('station-inbound')).toBeNull();
    expect(screen.getByTestId('floor-assist-announcer')).toBe(region);
    expect(said()).toEqual(before);
  });

  it('keeps the answer and says no cancel when the cancel lands between the answer and its clear', async () => {
    await onCall();
    await pressHelp();
    await frame({ event: 'help_answered', raised_at: R1, by_name: 'Priya N', how: 'listen' });
    expect(status()).toBe('Help is here. Priya N is listening to this call.');
    await pressHelp();
    expect(mocks.cancelHelp).toHaveBeenCalledTimes(1);
    expect(status()).toBe('Help is here. Priya N is listening to this call.');
    expect(said()).not.toContain('Help request cancelled.');
    await frame({ event: 'help_cleared', raised_at: R1, reason: 'answered' });
    expect(status()).toBe('Help is here. Priya N is listening to this call.');
    expect(said()).toEqual(['Help requested. Your supervisors can see it.', 'Help is here. Priya N is listening to this call.']);
  });
});

describe('supervisor messages on a phone', () => {
  function narrowScreen(matches: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: matches && query === '(max-width: 767px)',
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  }

  it('shows one card at a time, the rest counted', async () => {
    narrowScreen(true);
    await onCall();
    for (const id of ['m-1', 'm-2', 'm-3']) await frame(message(id, `Note ${id}`));
    expect(screen.getAllByTestId('supervisor-message')).toHaveLength(1);
    expect(screen.getByTestId('supervisor-message-text').textContent).toBe('Note m-1');
    expect(screen.getByTestId('supervisor-messages-more').textContent).toBe('2 more messages');
  });

  it('puts the messages after the call controls in tab order, on the campaign’s screen and an inbound call’s', async () => {
    mocks.getInboundCall.mockReturnValue(new Promise(() => {}));
    await onCall();
    await frame(message('m-1', 'Note'));
    // Under the band on screen (CSS order), after the controls in the document.
    const afterBanner = (control: Element) =>
      Boolean(control.compareDocumentPosition(screen.getByTestId('supervisor-message')) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(afterBanner(helpButton())).toBe(true);
    expect(afterBanner(screen.getByRole('button', { name: 'Hold to end call' }))).toBe(true);
    const after = (control: Element) =>
      Boolean(control.compareDocumentPosition(screen.getByTestId('supervisor-message')) & Node.DOCUMENT_POSITION_FOLLOWING);
    await frame({ event: 'agent_state', state: 'reserved', since: '2026-11-19T10:03:00.000Z' });
    await frame({ event: 'inbound_call', call: inboundCall() });
    const bar = screen.getByTestId('inbound-action-bar');
    for (const control of within(bar).getAllByRole('button')) expect(after(control)).toBe(true);
    expect(after(screen.getByTestId('inbound-body'))).toBe(true);
  });
});

describe('the break’s time against its limit (07, 08)', () => {
  const sinceNow = () => new Date(Date.now()).toISOString();

  it('counts down on a break whose reason has a limit', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'break', since: sinceNow(), break_reason: 'tea' });
    expect(screen.getByTestId('band-title').textContent).toBe('On break · Tea');
    expect(screen.getByTestId('break-line').textContent).toMatch(/^(15:00|14:5\d) left of your 15 minutes\.$/);
  });

  it('counts up on a break with no limit, and on a reserved reason', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'break', since: sinceNow(), break_reason: 'training' });
    expect(screen.getByTestId('break-elapsed').textContent).toMatch(/^0:0\d$/);
    expect(screen.getByTestId('break-line').textContent).toBe('');
    await frame({ event: 'agent_state', state: 'break', since: sinceNow(), break_reason: 'device_away' });
    expect(screen.getByTestId('break-elapsed').textContent).toMatch(/^0:0\d$/);
    expect(screen.getByTestId('break-line').textContent).not.toMatch(/left|late/);
  });

  it('turns into Break time is over once its limit has passed (08)', async () => {
    await mounted();
    const since = new Date(Date.now() - 18 * 60_000).toISOString();
    await frame({ event: 'agent_state', state: 'break', since, break_reason: 'tea' });
    expect(screen.getByTestId('band-title').textContent).toBe('Break time is over');
    expect(screen.getByTestId('band-subtitle').textContent).toMatch(/^You are 3:0\d late\. Start calls now\.$/);
    expect(screen.getByTestId('break-elapsed').textContent).toMatch(/^18:0\d$/);
    expect(screen.getByTestId('break-line').textContent).toBe('Your break was 15 minutes. Your supervisor can see this.');
    expect(screen.getByTestId('station-band').getAttribute('data-tone')).toBe('over');
    expect(screen.getByRole('button', { name: /start calls again/i })).toBeTruthy();
  });
});
