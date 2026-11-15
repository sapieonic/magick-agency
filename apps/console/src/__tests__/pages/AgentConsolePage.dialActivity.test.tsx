import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, within } from '@testing-library/react';
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
  useTenant: vi.fn(),
}));
vi.mock('../../api/agency', () => mocks);
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', display_name: 'Asha Kumar', email: 'asha@example.com', avatar_url: null },
  }),
}));

import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { DIAL_GAP_HOLD_MS } from '../../hooks/useDialActivityDisplay';
import { FakeSocket, latestSocket as latest } from '../helpers/fakeSocket';
import { inboundCall } from '../helpers/inbound';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';

/**
 * Late binding at the station: the dialer rings a customer for an idle agent and shows them
 * nothing unless the customer answers. Without `dial_activity` the screen read "Waiting for a
 * call" whether a phone was ringing for them, nothing was due, or something was stuck.
 *
 * Every test drives the frames the server actually sends, in its order:
 *  - unanswered: `dial_activity{ringing}` → `dial_activity{!ringing, n+1}` →
 *    `agent_state{available}` → (0.3–2 s) the next `dial_activity{ringing}`;
 *  - answered: `dial_activity{ringing}` → `reserved` → `bridged` → … (no `agent_state` for
 *    reserved or on_call on an outbound call, and no frame resets the count: the client clears
 *    it on `reserved`);
 *  - the customer rang in: `dial_activity{!ringing, n}` → `agent_state{reserved}` →
 *    `inbound_call` (the inbound connector's offer, `docs/inbound.md` §6);
 *  - a break queued mid-ring: `dial_activity{!ringing, n+1}` → `agent_state{break}`;
 *  - reconnect: `ready{available}` with `dial_activity` (a hidden dial still ringing: never
 *    `reserved`, never an `active_attempt`) or without it.
 * No `agent_state` is invented to move the screen.
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
  break_reasons: [{ code: 'lunch', label: 'Lunch' }],
  context_display: {},
  intervals: {
    heartbeat_ms: 10_000,
    heartbeat_grace_ms: 30_000,
    reservation_lease_ms: 10_000,
    countdown_ms: 3000,
  },
};

const DIALLING = 'Dialling a customer…';
const DIALLING_HINT = 'You’ll be connected as soon as they answer.';

const dial = (ringing: boolean, n: number) => ({
  event: 'dial_activity',
  campaign_id: 'camp-1',
  ringing,
  unanswered_in_a_row: n,
});

beforeEach(() => {
  FakeSocket.instances = [];
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1' });
  mocks.createAgencySession.mockResolvedValue(BOOTSTRAP);
  mocks.setAgentAvailable.mockResolvedValue(undefined);
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Joined, socket open, `ready` says available. */
async function available() {
  const view = render(
    <MemoryRouter initialEntries={['/app/agency/console?campaign=camp-1']}>
      <AgentConsolePage />
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    latest().open();
  });
  await act(async () => {
    latest().emit({ event: 'ready', session_id: 'sess-1', state: 'available' });
  });
  return view;
}

async function emit(...frames: unknown[]) {
  await act(async () => {
    for (const frame of frames) latest().emit(frame);
  });
}

const panel = () => screen.getByRole('region', { name: 'Contact' });
const railLabel = () => screen.getByTestId('rail-label').textContent;
const headline = () => within(panel()).getByTestId('idle-headline').textContent;
const unanswered = () => within(panel()).queryByTestId('idle-unanswered')?.textContent ?? null;

describe('the waiting screen says when a customer is being dialled', () => {
  it('a ringing hidden dial shows in the panel and the rail, and nothing about the contact', async () => {
    await available();
    expect(headline()).toBe('Waiting for a call');

    await emit(dial(true, 0));

    expect(headline()).toBe(DIALLING);
    expect(within(panel()).getByText(DIALLING_HINT)).toBeTruthy();
    expect(unanswered()).toBeNull();
    expect(railLabel()).toBe(DIALLING);
    // Said politely, once, by the rail: the station's status region.
    const rail = screen.getByRole('status');
    expect(rail.getAttribute('aria-live')).toBe('polite');
    expect(rail.textContent).toContain(DIALLING);
    // No number, no name: the agent is shown the call only if it is answered.
    expect(screen.queryByText(ATTEMPT.phone_e164)).toBeNull();
  });

  it('the count line: singular, then plural, while ringing and while plain waiting', async () => {
    vi.useFakeTimers();
    await available();
    await emit(dial(true, 0));
    await emit(dial(false, 1), { event: 'agent_state', state: 'available', since: '2026-08-11T10:00:30.000Z' });
    await act(async () => { await vi.advanceTimersByTimeAsync(DIAL_GAP_HOLD_MS); });

    expect(headline()).toBe('Waiting for a call');
    expect(unanswered()).toBe('No answer from the last number');
    expect(railLabel()).toBe('Waiting for a call');

    await emit(dial(true, 1));
    expect(headline()).toBe(DIALLING);
    expect(unanswered()).toBe('No answer from the last number');

    await emit(dial(false, 2), { event: 'agent_state', state: 'available', since: '2026-08-11T10:01:00.000Z' });
    expect(unanswered()).toBe('No answer from the last 2 numbers');
    // The count line is not itself a live region: each unanswered dial must not be read out.
    const line = within(panel()).getByTestId('idle-unanswered');
    expect(line.closest('[aria-live]')).toBeNull();
  });

  it('holds "Dialling" through the gap between dials, then falls back', async () => {
    vi.useFakeTimers();
    await available();
    await emit(dial(true, 0));
    await emit(dial(false, 1), { event: 'agent_state', state: 'available', since: '2026-08-11T10:00:30.000Z' });

    expect(headline()).toBe(DIALLING);
    expect(railLabel()).toBe(DIALLING);

    await act(async () => { await vi.advanceTimersByTimeAsync(DIAL_GAP_HOLD_MS - 100); });
    expect(headline()).toBe(DIALLING);
    expect(railLabel()).toBe(DIALLING);

    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(headline()).toBe('Waiting for a call');
    expect(railLabel()).toBe('Waiting for a call');
    expect(unanswered()).toBe('No answer from the last number');
  });

  it('the next dial inside the gap never shows "Waiting for a call"', async () => {
    vi.useFakeTimers();
    await available();
    await emit(dial(true, 0));
    await emit(dial(false, 1), { event: 'agent_state', state: 'available', since: '2026-08-11T10:00:30.000Z' });
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(railLabel()).toBe(DIALLING);
    await emit(dial(true, 1));
    await act(async () => { await vi.advanceTimersByTimeAsync(DIAL_GAP_HOLD_MS); });
    expect(railLabel()).toBe(DIALLING);
    expect(headline()).toBe(DIALLING);
  });

  it('reserved clears it at once and the panel shows the call; the count starts again after it', async () => {
    await available();
    await emit(dial(true, 0));
    await emit(dial(false, 1), { event: 'agent_state', state: 'available', since: '2026-08-11T10:00:30.000Z' });
    await emit(dial(true, 1));

    await emit({ event: 'reserved', attempt: ATTEMPT });

    expect(within(panel()).getByText(ATTEMPT.phone_e164)).toBeTruthy();
    expect(within(panel()).queryByTestId('idle-unanswered')).toBeNull();
    expect(screen.queryByText(DIALLING)).toBeNull();
    expect(railLabel()).toBe('Ringing — get ready');

    // Answered: the dialer sends `bridged` and no `agent_state` for reserved or on_call.
    await emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:02:04.000Z' });
    expect(railLabel()).toBe('On call');
    expect(screen.getByTestId('rail-detail').textContent).toBe(ATTEMPT.phone_e164);
    expect(screen.queryByText(DIALLING)).toBeNull();

    // The call ends with no outcome owed, straight back to the pool.
    await emit(
      { event: 'released', attempt_id: 'att-1', reason: 'completed', requires_disposition: false, message: 'Call ended.' },
      { event: 'agent_state', state: 'available', since: '2026-08-11T10:05:00.000Z' },
    );
    // No count is carried over from before the answered call, and no gap hold.
    expect(screen.queryByTestId('idle-unanswered')).toBeNull();
    expect(railLabel()).toBe('Waiting for a call');

    await emit(dial(true, 0));
    expect(railLabel()).toBe(DIALLING);
    expect(screen.queryByTestId('idle-unanswered')).toBeNull();
  });

  it('a reserved inside the gap hold drops the hold at once', async () => {
    vi.useFakeTimers();
    await available();
    await emit(dial(true, 0));
    await emit(dial(false, 1));
    expect(railLabel()).toBe(DIALLING);
    await emit({ event: 'reserved', attempt: ATTEMPT });
    expect(railLabel()).toBe('Ringing — get ready');
    expect(screen.queryByText(DIALLING)).toBeNull();
  });

  it('ready on reconnect restores it, and a ready without it clears it', async () => {
    await available();
    await emit({
      event: 'ready',
      session_id: 'sess-1',
      state: 'available',
      dial_activity: { ringing: true, unanswered_in_a_row: 2 },
    });
    expect(headline()).toBe(DIALLING);
    expect(unanswered()).toBe('No answer from the last 2 numbers');
    expect(railLabel()).toBe(DIALLING);

    await emit({ event: 'ready', session_id: 'sess-1', state: 'available' });
    expect(headline()).toBe('Waiting for a call');
    expect(unanswered()).toBeNull();
    expect(railLabel()).toBe('Waiting for a call');
  });

  it('ready with a live attempt shows the attempt, not the dial', async () => {
    await available();
    await emit(dial(true, 3));
    await emit({
      event: 'ready',
      session_id: 'sess-1',
      state: 'reserved',
      active_attempt: { ...ATTEMPT, bridged_at: null, state: 'ringing' },
    });
    expect(within(panel()).getByText(ATTEMPT.phone_e164)).toBeTruthy();
    expect(screen.queryByText(DIALLING)).toBeNull();
    expect(screen.queryByTestId('idle-unanswered')).toBeNull();
  });

  it('a paused campaign never shows it', async () => {
    await available();
    await emit(
      {
        event: 'campaign_state',
        campaign_id: 'camp-1',
        status: 'paused',
        reason: 'paused_by_supervisor',
        dialing: false,
        message: 'paused',
      },
      dial(true, 2),
    );
    expect(headline()).toBe('No calls will come through right now.');
    expect(unanswered()).toBeNull();
    expect(railLabel()).toBe('Campaign paused — no campaign calls for now');
    expect(screen.queryByText(DIALLING)).toBeNull();
  });

  it('pausing the campaign mid-dial drops it, hold and all', async () => {
    vi.useFakeTimers();
    await available();
    await emit(dial(true, 0), dial(false, 1));
    await emit({
      event: 'campaign_state',
      campaign_id: 'camp-1',
      status: 'paused',
      reason: 'paused_by_supervisor',
      dialing: false,
      message: 'paused',
    });
    expect(screen.queryByText(DIALLING)).toBeNull();
    expect(railLabel()).toBe('Campaign paused — no campaign calls for now');
  });

  it('a break never shows it', async () => {
    await available();
    await emit(dial(true, 1));
    await emit({ event: 'agent_state', state: 'break', since: '2026-08-11T10:00:30.000Z', break_reason: 'lunch' });
    expect(screen.queryByText(DIALLING)).toBeNull();
    expect(screen.queryByTestId('idle-unanswered')).toBeNull();
    expect(railLabel()).toBe('On break — Lunch');
  });

  it('a ringing dial outranks "Nothing due now"', async () => {
    await available();
    await emit({ event: 'queue', campaign_id: 'camp-1', due: false, reason: 'queue_empty' });
    expect(screen.getByTestId('idle-nothing-due')).toBeTruthy();

    await emit(dial(true, 0));
    expect(screen.queryByTestId('idle-nothing-due')).toBeNull();
    expect(headline()).toBe(DIALLING);
  });

  it('"Nothing due now" with no dial ringing leaves out the count line, as the agent app does', async () => {
    vi.useFakeTimers();
    await available();
    await emit(dial(true, 1));
    await emit({ event: 'queue', campaign_id: 'camp-1', due: false, reason: 'queue_empty' });
    // Ringing outranks it, count line and all.
    expect(screen.queryByTestId('idle-nothing-due')).toBeNull();
    expect(unanswered()).toBe('No answer from the last number');

    await emit(dial(false, 2), { event: 'agent_state', state: 'available', since: '2026-08-11T10:00:30.000Z' });
    await act(async () => { await vi.advanceTimersByTimeAsync(DIAL_GAP_HOLD_MS); });
    expect(screen.getByTestId('idle-nothing-due')).toBeTruthy();
    expect(unanswered()).toBeNull();
    expect(headline()).toBe('Waiting for a call');
    expect(railLabel()).toBe('Waiting for a call');

    // Something falls due again: the count line is back.
    await emit({ event: 'queue', campaign_id: 'camp-1', due: true });
    expect(screen.queryByTestId('idle-nothing-due')).toBeNull();
    expect(unanswered()).toBe('No answer from the last 2 numbers');
  });

  it('the socket dropping mid-dial stops saying it; the rail says the connection', async () => {
    await available();
    await emit(dial(true, 2));
    expect(headline()).toBe(DIALLING);

    await act(async () => {
      latest().serverClose(1006, '');
    });
    expect(screen.queryByText(DIALLING)).toBeNull();
    expect(screen.queryByTestId('idle-unanswered')).toBeNull();
    expect(railLabel()).toBe('Reconnecting');
  });

  it('the customer ringing in supersedes it: the inbound panel, nothing about dialling', async () => {
    await available();
    await emit(dial(true, 2));
    // The inbound connector's offer, in its order.
    await emit(
      dial(false, 2),
      { event: 'agent_state', state: 'reserved', since: '2026-11-09T10:00:00.000Z' },
      { event: 'inbound_call', call: inboundCall() },
    );
    expect(screen.getByTestId('station-inbound')).toBeTruthy();
    expect(railLabel()).toBe('Incoming call from Asha Rao');
    expect(screen.queryByText(DIALLING)).toBeNull();
    expect(screen.queryByTestId('idle-unanswered')).toBeNull();
    expect(screen.queryByTestId('missed-release-dialling')).toBeNull();
  });

  it('a break queued mid-ring: no "Dialling", and no gap hold', async () => {
    vi.useFakeTimers();
    await available();
    await emit(dial(true, 0));
    await emit(
      dial(false, 1),
      { event: 'agent_state', state: 'break', since: '2026-08-11T10:00:30.000Z', break_reason: 'lunch' },
    );
    expect(screen.queryByText(DIALLING)).toBeNull();
    expect(screen.queryByTestId('idle-unanswered')).toBeNull();
    expect(railLabel()).toBe('On break — Lunch');
    await act(async () => { await vi.advanceTimersByTimeAsync(DIAL_GAP_HOLD_MS); });
    expect(screen.queryByText(DIALLING)).toBeNull();
    expect(railLabel()).toBe('On break — Lunch');
  });

  it('a reconnect mid-ring: the server’s ready{available} with a ringing dial shows it and the count', async () => {
    await available();
    await emit(dial(true, 1));
    // A real drop and reconnect: same mount, a second socket on a re-minted token.
    mocks.mintStationToken.mockResolvedValue({
      session_id: 'sess-1',
      station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
      expires_at: '2026-08-11T10:05:00.000Z',
    });
    await act(async () => {
      latest().serverClose(1006, '');
    });
    expect(screen.queryByText(DIALLING)).toBeNull();
    // The backoff is the hook's own; this waits for the socket, not a delay.
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 3000 });
    await act(async () => {
      latest().open();
    });
    // While the hidden dial still rings the server says `available` (never `reserved`), with
    // the activity and no `active_attempt`.
    await emit({
      event: 'ready',
      session_id: 'sess-1',
      state: 'available',
      dial_activity: { ringing: true, unanswered_in_a_row: 2 },
    });
    expect(headline()).toBe(DIALLING);
    expect(unanswered()).toBe('No answer from the last 2 numbers');
    expect(railLabel()).toBe(DIALLING);
  });

  it('a malformed ready.dial_activity is not shown in the panel or the rail', async () => {
    await available();
    await emit({
      event: 'ready',
      session_id: 'sess-1',
      state: 'available',
      dial_activity: { ringing: 'yes', unanswered_in_a_row: 2 },
    });
    expect(headline()).toBe('Waiting for a call');
    expect(unanswered()).toBeNull();
    expect(railLabel()).toBe('Waiting for a call');
  });

  it('a missed release keeps the slot, and says a dial is ringing under it', async () => {
    await available();
    await emit({
      event: 'ready',
      session_id: 'sess-1',
      state: 'available',
      missed_release: {
        attempt_id: 'att-0',
        reason: 'no_answer',
        requires_disposition: false,
        message: 'No answer.',
        ended_at: '2026-08-11T09:59:00.000Z',
      },
      dial_activity: { ringing: true, unanswered_in_a_row: 0 },
    });
    expect(within(panel()).getByTestId('missed-release').textContent).toMatch(/^While you were disconnected: /);
    expect(within(panel()).getByTestId('missed-release-dialling').textContent).toBe(DIALLING);
    expect(railLabel()).toBe(DIALLING);

    await emit(dial(false, 1), { event: 'agent_state', state: 'available', since: '2026-08-11T10:00:30.000Z' });
    // Inside the gap hold it still says so; the missed release stays first.
    expect(within(panel()).getByTestId('missed-release')).toBeTruthy();
    expect(within(panel()).getByTestId('missed-release-dialling').textContent).toBe(DIALLING);
  });
});

describe('early binding is unchanged', () => {
  it('a call shown from the start, with no dial_activity frames, reads exactly as before', async () => {
    await available();
    expect(headline()).toBe('Waiting for a call');
    expect(within(panel()).getByText('Stay on this screen so the next customer reaches you.')).toBeTruthy();
    expect(railLabel()).toBe('Waiting for a call');

    await emit({ event: 'reserved', attempt: ATTEMPT });
    expect(railLabel()).toBe('Ringing — get ready');
    expect(within(panel()).getByText(ATTEMPT.phone_e164)).toBeTruthy();
    // `bridged` alone moves it on: the dialer sends no `agent_state` for an outbound call's
    // reserved or on_call.
    await emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04.000Z' });
    expect(railLabel()).toBe('On call');
    await emit(
      { event: 'released', attempt_id: 'att-1', reason: 'completed', requires_disposition: false, message: 'Call ended.' },
      { event: 'agent_state', state: 'available', since: '2026-08-11T10:05:00.000Z' },
    );

    expect(railLabel()).toBe('Waiting for a call');
    expect(screen.queryByText(DIALLING)).toBeNull();
    expect(screen.queryByTestId('idle-unanswered')).toBeNull();
  });
});
