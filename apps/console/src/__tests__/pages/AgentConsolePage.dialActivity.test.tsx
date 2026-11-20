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
import { STATION_COPY } from '../../utils/agency/stationCopy';
import { stubStationMicrophone } from '../helpers/stationDevices';
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

const DIALLING = STATION_COPY.dialling;
const WAITING = STATION_COPY.nextCallComing;

const dial = (ringing: boolean, n: number) => ({
  event: 'dial_activity',
  campaign_id: 'camp-1',
  ringing,
  unanswered_in_a_row: n,
});

let microphone: ReturnType<typeof stubStationMicrophone>;
beforeEach(() => {
  microphone = stubStationMicrophone();
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
  microphone.restore();
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

const panel = () => screen.getByTestId('station-body');
/**
 * What the station's status says, in the old rail's terms: on Ready the band says Ready and its
 * subtitle says whether a customer is being dialled, so this reads that as DIALLING or WAITING;
 * on any other screen it is the band's title (the inbound view keeps its own rail).
 */
const railLabel = () => {
  if (screen.queryByTestId('station-inbound')) return screen.getByTestId('rail-label').textContent;
  const title = screen.getByTestId('band-title').textContent;
  if (title !== 'Ready') return title;
  return screen.getByTestId('band-subtitle').textContent === STATION_COPY.diallingSubtitle ? DIALLING : WAITING;
};
const headline = () => within(panel()).getByTestId('waiting-headline').textContent;
const unanswered = () => within(panel()).queryByTestId('dial-activity')?.textContent ?? null;

describe('the waiting screen says when a customer is being dialled', () => {
  it('a ringing hidden dial shows in the panel and the rail, and nothing about the contact', async () => {
    await available();
    expect(headline()).toBe(WAITING);

    await emit(dial(true, 0));

    expect(headline()).toBe(DIALLING);
    expect(unanswered()).toBeNull();
    expect(railLabel()).toBe(DIALLING);
    // Said politely, once, by the band: the station's status region.
    const band = screen.getByTestId('station-band');
    expect(band.getAttribute('role')).toBe('status');
    expect(band.getAttribute('aria-live')).toBe('polite');
    expect(band.textContent).toContain(STATION_COPY.diallingSubtitle);
    // No number, no name: the agent is shown the call only if it is answered.
    expect(screen.queryByText(ATTEMPT.phone_e164)).toBeNull();
  });

  it('the count line: singular, then plural, while ringing and while plain waiting', async () => {
    vi.useFakeTimers();
    await available();
    await emit(dial(true, 0));
    await emit(dial(false, 1), { event: 'agent_state', state: 'available', since: '2026-08-11T10:00:30.000Z' });
    await act(async () => { await vi.advanceTimersByTimeAsync(DIAL_GAP_HOLD_MS); });

    expect(headline()).toBe(WAITING);
    expect(unanswered()).toBe('No answer from the last number.');
    expect(railLabel()).toBe(WAITING);

    await emit(dial(true, 1));
    expect(headline()).toBe(DIALLING);
    expect(unanswered()).toBe('No answer from the last number.');

    await emit(dial(false, 2), { event: 'agent_state', state: 'available', since: '2026-08-11T10:01:00.000Z' });
    expect(unanswered()).toBe('No answer from the last 2 numbers.');
    // The count line is not itself a live region: each unanswered dial must not be read out.
    const line = within(panel()).getByTestId('dial-activity');
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
    expect(headline()).toBe(WAITING);
    expect(railLabel()).toBe(WAITING);
    expect(unanswered()).toBe('No answer from the last number.');
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
    expect(within(panel()).queryByTestId('dial-activity')).toBeNull();
    expect(screen.queryByText(DIALLING)).toBeNull();
    expect(railLabel()).toBe('Call coming');

    // Answered: the dialer sends `bridged` and no `agent_state` for reserved or on_call.
    await emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:02:04.000Z' });
    expect(railLabel()).toBe('On call');
    expect(screen.getByTestId('customer-phone').textContent).toBe(ATTEMPT.phone_e164);
    expect(screen.queryByText(DIALLING)).toBeNull();

    // The call ends with no outcome owed, straight back to the pool.
    await emit(
      { event: 'released', attempt_id: 'att-1', reason: 'completed', requires_disposition: false, message: 'Call ended.' },
      { event: 'agent_state', state: 'available', since: '2026-08-11T10:05:00.000Z' },
    );
    // No count is carried over from before the answered call, and no gap hold.
    expect(screen.queryByTestId('dial-activity')).toBeNull();
    expect(railLabel()).toBe(WAITING);

    await emit(dial(true, 0));
    expect(railLabel()).toBe(DIALLING);
    expect(screen.queryByTestId('dial-activity')).toBeNull();
  });

  it('a reserved inside the gap hold drops the hold at once', async () => {
    vi.useFakeTimers();
    await available();
    await emit(dial(true, 0));
    await emit(dial(false, 1));
    expect(railLabel()).toBe(DIALLING);
    await emit({ event: 'reserved', attempt: ATTEMPT });
    expect(railLabel()).toBe('Call coming');
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
    expect(unanswered()).toBe('No answer from the last 2 numbers.');
    expect(railLabel()).toBe(DIALLING);

    await emit({ event: 'ready', session_id: 'sess-1', state: 'available' });
    expect(headline()).toBe(WAITING);
    expect(unanswered()).toBeNull();
    expect(railLabel()).toBe(WAITING);
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
    expect(screen.queryByTestId('dial-activity')).toBeNull();
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
    expect(headline()).toBe(STATION_COPY.noCallsBody);
    expect(unanswered()).toBeNull();
    expect(railLabel()).toBe('No calls right now');
    expect(screen.getByTestId('band-subtitle').textContent).toBe('Your supervisor has stopped calls. Stay on this screen.');
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
    expect(railLabel()).toBe('No calls right now');
  });

  it('a break never shows it', async () => {
    await available();
    await emit(dial(true, 1));
    await emit({ event: 'agent_state', state: 'break', since: '2026-08-11T10:00:30.000Z', break_reason: 'lunch' });
    expect(screen.queryByText(DIALLING)).toBeNull();
    expect(screen.queryByTestId('dial-activity')).toBeNull();
    expect(railLabel()).toBe('On break · Lunch');
  });

  it('a ringing dial outranks "Nothing due now"', async () => {
    await available();
    await emit({ event: 'queue', campaign_id: 'camp-1', due: false, reason: 'queue_empty' });
    expect(screen.getByTestId('no-calls')).toBeTruthy();

    await emit(dial(true, 0));
    expect(screen.queryByTestId('no-calls')).toBeNull();
    expect(headline()).toBe(DIALLING);
  });

  it('"Nothing due now" with no dial ringing leaves out the count line, as the agent app does', async () => {
    vi.useFakeTimers();
    await available();
    await emit(dial(true, 1));
    await emit({ event: 'queue', campaign_id: 'camp-1', due: false, reason: 'queue_empty' });
    // Ringing outranks it, count line and all.
    expect(screen.queryByTestId('no-calls')).toBeNull();
    expect(unanswered()).toBe('No answer from the last number.');

    await emit(dial(false, 2), { event: 'agent_state', state: 'available', since: '2026-08-11T10:00:30.000Z' });
    await act(async () => { await vi.advanceTimersByTimeAsync(DIAL_GAP_HOLD_MS); });
    expect(screen.getByTestId('no-calls')).toBeTruthy();
    expect(unanswered()).toBeNull();
    // 02c, not Ready: nothing is due and nothing rings.
    expect(headline()).toBe(STATION_COPY.noCallsBody);
    expect(railLabel()).toBe('No calls right now');

    // Something falls due again: the count line is back.
    await emit({ event: 'queue', campaign_id: 'camp-1', due: true });
    expect(screen.queryByTestId('no-calls')).toBeNull();
    expect(unanswered()).toBe('No answer from the last 2 numbers.');
  });

  it('the socket dropping mid-dial stops saying it; the rail says the connection', async () => {
    await available();
    await emit(dial(true, 2));
    expect(headline()).toBe(DIALLING);

    await act(async () => {
      latest().serverClose(1006, '');
    });
    expect(screen.queryByText(DIALLING)).toBeNull();
    expect(screen.queryByTestId('dial-activity')).toBeNull();
    expect(railLabel()).toBe('Internet problem');
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
    expect(screen.queryByTestId('dial-activity')).toBeNull();
    expect(screen.queryByTestId('missed-release')).toBeNull();
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
    expect(screen.queryByTestId('dial-activity')).toBeNull();
    expect(railLabel()).toBe('On break · Lunch');
    await act(async () => { await vi.advanceTimersByTimeAsync(DIAL_GAP_HOLD_MS); });
    expect(screen.queryByText(DIALLING)).toBeNull();
    expect(railLabel()).toBe('On break · Lunch');
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
    expect(unanswered()).toBe('No answer from the last 2 numbers.');
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
    expect(headline()).toBe(WAITING);
    expect(unanswered()).toBeNull();
    expect(railLabel()).toBe(WAITING);
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
    expect(screen.getByTestId('missed-release').textContent).toBe('While your internet was down, the last call did not connect.');
    expect(headline()).toBe(DIALLING);
    expect(railLabel()).toBe(DIALLING);

    await emit(dial(false, 1), { event: 'agent_state', state: 'available', since: '2026-08-11T10:00:30.000Z' });
    // Inside the gap hold it still says so; the missed release stays on screen.
    expect(screen.getByTestId('missed-release')).toBeTruthy();
    expect(headline()).toBe(DIALLING);
  });
});

describe('early binding is unchanged', () => {
  it('a call shown from the start, with no dial_activity frames, reads exactly as before', async () => {
    await available();
    expect(headline()).toBe(WAITING);
    expect(screen.getByTestId('band-subtitle').textContent).toBe('Next call is coming. Stay on this screen.');
    expect(railLabel()).toBe(WAITING);

    await emit({ event: 'reserved', attempt: ATTEMPT });
    expect(railLabel()).toBe('Call coming');
    expect(within(panel()).getByText(ATTEMPT.phone_e164)).toBeTruthy();
    // `bridged` alone moves it on: the dialer sends no `agent_state` for an outbound call's
    // reserved or on_call.
    await emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04.000Z' });
    expect(railLabel()).toBe('On call');
    await emit(
      { event: 'released', attempt_id: 'att-1', reason: 'completed', requires_disposition: false, message: 'Call ended.' },
      { event: 'agent_state', state: 'available', since: '2026-08-11T10:05:00.000Z' },
    );

    expect(railLabel()).toBe(WAITING);
    expect(screen.queryByText(DIALLING)).toBeNull();
    expect(screen.queryByTestId('dial-activity')).toBeNull();
  });
});
