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
import { ApiError } from '../../api/client';
import { FakeSocket, latestSocket } from '../helpers/fakeSocket';
import { inboundCall } from '../helpers/inbound';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';

/**
 * Floor assist on the agent's console station (LF4, LF5, LF24–LF26): Need help raised and
 * cancelled from the action bar, restored on reconnect and ended only by a frame about the request
 * on screen; supervisors' messages shown as text, announced politely, never taking focus; and the
 * break countdown in the rail.
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

beforeEach(() => {
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
const status = () => screen.queryByTestId('need-help-status')?.textContent ?? null;
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
    expect(screen.queryByTestId('need-help')).toBeNull();
    expect(screen.queryByRole('button', { name: /Need help/ })).toBeNull();
  });

  it('is the last control in the bar, after Hang up, and reachable by Tab', async () => {
    await onCall();
    const bar = screen.getByTestId('need-help').parentElement!;
    const order = Array.from(bar.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '');
    const hangupIdx = order.findIndex((n) => n.startsWith('Hang up'));
    const helpIdx = order.findIndex((n) => n.includes('Need help'));
    expect(hangupIdx).toBeGreaterThanOrEqual(0);
    expect(helpIdx).toBeGreaterThan(hangupIdx);
    expect(helpButton().tabIndex).toBeGreaterThanOrEqual(0);
    expect(helpButton().hasAttribute('disabled')).toBe(false);
  });

  it('is refused in place off a call, saying why, and sends nothing', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'available', since: '2026-11-19T09:00:00.000Z' });
    const button = helpButton();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // Focusable, so a keyboard agent can read why.
    expect(button.hasAttribute('disabled')).toBe(false);
    const reason = document.getElementById(button.getAttribute('aria-describedby')!)!.textContent;
    expect(reason).toBe('You can ask for help during a call, or while you finish one.');
    await pressHelp();
    expect(mocks.raiseHelp).not.toHaveBeenCalled();
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
    expect(status()).toBe('Help requested. Waiting for a supervisor.');
    expect(announcer()).toBe('Help requested. Your supervisors can see it.');
    // The same node, now the way to cancel: focus never moved.
    expect(helpButton()).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(button.textContent).toContain('Cancel help request');

    await pressHelp();
    expect(mocks.cancelHelp).toHaveBeenCalledWith('sess-1', 't-1', 'a-1');
    expect(status()).toBeNull();
    expect(helpButton().textContent).toContain('Need help');
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
    expect(status()).toBe('Help requested. Waiting for a supervisor.');
    // A reconnect's `ready` restating the same request (as a server re-raise would answer it).
    await frame({ event: 'ready', session_id: 'sess-1', state: 'on_call', help: { raised_at: R1, call_id: 'call-1' } });
    expect(status()).toBe('Help requested. Waiting for a supervisor.');
  });

  it.each([
    ['floor_assist_disabled', 403, 'Need help is not turned on for this account. Ask your supervisor directly.'],
    ['help_not_on_call', 409, 'You can ask for help during a call, or while you finish one.'],
    ['session_ended', 409, 'Your station session has ended. Rejoin the campaign to ask for help.'],
    ['account_scope_required', 400, 'Open your station from your account to ask for help.'],
    [null, 404, 'Your station session was not found. Rejoin the campaign to ask for help.'],
    [null, 403, 'You do not have permission to ask for help here.'],
    [null, 500, 'Your request for help did not go through. Try again.'],
  ])('says the refusal %s (%i) in words, and opens nothing', async (code, statusCode, words) => {
    await onCall();
    mocks.raiseHelp.mockRejectedValueOnce(
      new ApiError(statusCode, code ? { error: 'Refused', code, message: 'raw' } : { error: 'Not Found', message: 'Session not found' }),
    );
    await pressHelp();
    expect(screen.getByTestId('need-help-refusal').textContent).toBe(words);
    expect(status()).toBeNull();
    expect(helpButton().textContent).toContain('Need help');
  });

  it('says a failed cancel, and keeps the request open', async () => {
    await onCall();
    await pressHelp();
    mocks.cancelHelp.mockRejectedValueOnce(new Error('offline'));
    await pressHelp();
    expect(screen.getByTestId('need-help-refusal').textContent).toBe('Your request could not be cancelled. Try again.');
    expect(status()).toBe('Help requested. Waiting for a supervisor.');
  });

  it('offers the cancel after the call has ended: a request outlives its call', async () => {
    await onCall();
    await pressHelp();
    await frame({ event: 'agent_state', state: 'available', since: '2026-11-19T10:05:00.000Z' });
    expect(helpButton().getAttribute('aria-disabled')).toBeNull();
    expect(helpButton().textContent).toContain('Cancel help request');
  });
});

describe('Need help: what the station hears', () => {
  it('restores an open request from ready.help on reconnect', async () => {
    await mounted();
    await frame({ event: 'ready', session_id: 'sess-1', state: 'on_call', help: { raised_at: R1, call_id: 'call-1' } });
    expect(status()).toBe('Help requested. Waiting for a supervisor.');
    expect(helpButton().textContent).toContain('Cancel help request');
  });

  it('says who is listening, then keeps it as a dismissible notice once the request ends', async () => {
    await onCall();
    await pressHelp();
    await frame({ event: 'help_answered', raised_at: R1, by_name: 'Priya', how: 'listen' });
    expect(status()).toBe('Priya is listening in.');
    expect(announcer()).toBe('Priya is listening in.');
    await frame({ event: 'help_cleared', raised_at: R1, reason: 'answered' });
    expect(status()).toBe('Priya is listening in.');
    expect(helpButton().textContent).toContain('Need help');
    fireEvent.click(screen.getByTestId('need-help-dismiss'));
    expect(status()).toBeNull();
  });

  it('words an answer by message, and an answer whose name could not be read', async () => {
    await onCall();
    await pressHelp();
    await frame({ event: 'help_answered', raised_at: R1, by_name: null, how: 'message' });
    await frame({ event: 'help_cleared', raised_at: R1, reason: 'answered' });
    expect(status()).toBe('A supervisor sent you a message.');
  });

  it('ignores an answer and a clear about another request than the one on screen', async () => {
    await onCall();
    await pressHelp();
    await frame({ event: 'help_answered', raised_at: R0, by_name: 'Priya', how: 'listen' });
    await frame({ event: 'help_cleared', raised_at: R0, reason: 'expired' });
    expect(status()).toBe('Help requested. Waiting for a supervisor.');
    expect(helpButton().textContent).toContain('Cancel help request');
  });

  it('says a lapsed request may be raised again', async () => {
    await onCall();
    await pressHelp();
    await frame({ event: 'help_cleared', raised_at: R1, reason: 'expired' });
    expect(status()).toBe('Nobody answered your request in 15 minutes, so it was closed. You can ask again.');
    expect(helpButton().textContent).toContain('Need help');
    // Raising again retires the notice.
    mocks.raiseHelp.mockResolvedValueOnce({ session_id: 'sess-1', help: { raised_at: '2026-11-19T10:20:00.000Z', call_id: null } });
    await pressHelp();
    expect(status()).toBe('Help requested. Waiting for a supervisor.');
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
    const mute = screen.getByTestId('mute-toggle');
    const hangup = screen.getByRole('button', { name: /Hang up/ });
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
    // Laid over the station, not inside the action bar: nothing in the bar moved.
    expect(screen.getByTestId('supervisor-messages').closest('[data-testid="need-help"]')).toBeNull();
    expect(mute.closest('div')!.contains(screen.getByTestId('supervisor-messages'))).toBe(false);
  });

  it('signs a message whose sender could not be read “Your supervisor”', async () => {
    await onCall();
    await frame(message('m-1', 'Carry on', null));
    expect(within(screen.getByTestId('supervisor-message')).getByText('Your supervisor')).toBeTruthy();
  });

  it('stacks several, three at a time with the rest counted, each once, until dismissed', async () => {
    await onCall();
    for (const id of ['m-1', 'm-2', 'm-3', 'm-4']) await frame(message(id, `Note ${id}`));
    await frame(message('m-2', 'Note m-2'));
    expect(screen.getAllByTestId('supervisor-message')).toHaveLength(3);
    expect(screen.getByTestId('supervisor-messages-more').textContent).toBe('1 more message');
    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss message from Priya N' })[0]!);
    const texts = screen.getAllByTestId('supervisor-message-text').map((n) => n.textContent);
    expect(texts).toEqual(['Note m-2', 'Note m-3', 'Note m-4']);
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
      'Priya N sent you a message.',
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
      'Your request for help did not go through. Try again.',
      'Your request for help did not go through. Try again.',
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
      'Priya N is listening in.',
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
    expect(status()).toBe('Priya N is listening in.');
    await pressHelp();
    expect(mocks.cancelHelp).toHaveBeenCalledTimes(1);
    expect(status()).toBe('Priya N is listening in.');
    expect(said()).not.toContain('Help request cancelled.');
    await frame({ event: 'help_cleared', raised_at: R1, reason: 'answered' });
    expect(status()).toBe('Priya N is listening in.');
    expect(said()).toEqual(['Help requested. Your supervisors can see it.', 'Priya N is listening in.']);
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

  it('puts the stack after the call controls in tab order, on the campaign’s screen and an inbound call’s', async () => {
    mocks.getInboundCall.mockReturnValue(new Promise(() => {}));
    await onCall();
    await frame(message('m-1', 'Note'));
    const after = (control: Element) =>
      Boolean(control.compareDocumentPosition(screen.getByTestId('supervisor-messages')) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(after(helpButton())).toBe(true);
    expect(after(screen.getByRole('button', { name: /Hang up/ }))).toBe(true);
    await frame({ event: 'agent_state', state: 'reserved', since: '2026-11-19T10:03:00.000Z' });
    await frame({ event: 'inbound_call', call: inboundCall() });
    const bar = screen.getByTestId('inbound-action-bar');
    for (const control of within(bar).getAllByRole('button')) expect(after(control)).toBe(true);
    expect(after(screen.getByTestId('inbound-body'))).toBe(true);
  });
});

describe('the break countdown', () => {
  const sinceNow = () => new Date(Date.now()).toISOString();

  it('counts down on a break whose reason has a limit', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'break', since: sinceNow(), break_reason: 'tea' });
    expect(screen.getByTestId('break-time').textContent).toMatch(/^Tea · (15:00|14:5\d) left$/);
  });

  it('counts up on a break with no limit, and on a reserved reason', async () => {
    await mounted();
    await frame({ event: 'agent_state', state: 'break', since: sinceNow(), break_reason: 'training' });
    expect(screen.getByTestId('break-elapsed').textContent).toMatch(/^0:0\d$/);
    await frame({ event: 'agent_state', state: 'break', since: sinceNow(), break_reason: 'device_away' });
    expect(screen.getByTestId('break-elapsed').textContent).toMatch(/^0:0\d$/);
    expect(screen.getByTestId('break-time').textContent).not.toMatch(/left|over by/);
  });

  it('says how far over a break is once its limit has passed', async () => {
    await mounted();
    const since = new Date(Date.now() - 18 * 60_000).toISOString();
    await frame({ event: 'agent_state', state: 'break', since, break_reason: 'tea' });
    expect(screen.getByTestId('break-elapsed').textContent).toMatch(/^over by (3|4) min$/);
    expect(screen.getByTestId('break-time').getAttribute('data-over')).toBe('true');
  });
});
