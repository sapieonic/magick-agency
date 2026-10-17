import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
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

/**
 * A render counter on a child the page root renders with props that never tick.
 *
 * `StationIdentity` is not memoised, so it re-renders exactly when the page root
 * does — which makes its count the root's render count without instrumenting the
 * page itself. A `<Profiler>` would not do: it reports every commit in its
 * subtree, so it counts the timer leaves' own repaints, which are the point.
 */
const renders = vi.hoisted(() => ({ identity: 0 }));
vi.mock('../../components/agency/StationIdentity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/agency/StationIdentity')>();
  return {
    ...actual,
    StationIdentity: (props: Parameters<typeof actual.StationIdentity>[0]) => {
      renders.identity += 1;
      return actual.StationIdentity(props);
    },
  };
});

import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { DISPOSITION_BLOCK_COPY } from '../../utils/agencyDispositionForm';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';

/**
 * **The console root does not repaint on a clock.**
 *
 * It used to: `useServerClock` ran a 250ms interval at the top of
 * `useAgencyConsole`, so the page and every component under it re-rendered four
 * times a second for the whole shift — offline, on break, mid-call — to move a
 * talk timer, a wrap-up bar and a break counter. The window `keydown` listener was
 * removed and re-added on each of those renders too.
 *
 * Each test pairs the two halves the change has to keep together, for the same
 * reason `RailPresenceRegion`'s tests do: the timer on screen is **still
 * advancing**, and the root is **not** re-rendering. A "fix" that froze the timers
 * would pass the second half alone.
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
  disposition_catalog: [
    { code: 'sale', label: 'Sale' },
    { code: 'callback', label: 'Call back later', requires_datetime: true },
  ],
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

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

/** 12s after `bridged_at` below. */
const NOW = Date.parse('2026-08-11T10:00:16.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  FakeSocket.instances = [];
  renders.identity = 0;
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1' });
  mocks.createAgencySession.mockResolvedValue(BOOTSTRAP);
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mounted() {
  render(
    <MemoryRouter initialEntries={['/app/agency/console?campaign=camp-1']}>
      <AgentConsolePage />
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    latest().open();
  });
}

/** Two seconds of repaints, one 250ms step at a time so each tick commits. */
function twoSeconds() {
  for (let i = 0; i < 8; i += 1) {
    act(() => {
      vi.advanceTimersByTime(250);
    });
  }
}

/**
 * Lets the frames' own one-off renders land before counting. The console has
 * not unlocked its cue audio here, so each cue takes the visual path and clears
 * its flash on a timer (`VISUAL_CUE_SPECS`, under a second) — one root render
 * per cue, owed to the frame and not to the clock.
 */
function settle() {
  act(() => {
    vi.advanceTimersByTime(1_000);
  });
}

describe('the console root does not repaint on a clock', () => {
  it('idle and offline: nothing is counting, so nothing renders at all', async () => {
    await mounted();
    const before = renders.identity;
    expect(before).toBeGreaterThan(0);

    twoSeconds();

    expect(renders.identity).toBe(before);
  });

  it('on a call: the talk timer advances while the root stays still', async () => {
    await mounted();
    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04.000Z' });
      latest().emit({ event: 'agent_state', state: 'on_call', since: '2026-08-11T10:00:04.000Z' });
    });
    settle();
    expect(screen.getByTestId('talk-timer').textContent).toBe('0:13');
    const before = renders.identity;

    twoSeconds();

    expect(screen.getByTestId('talk-timer').textContent).toBe('0:15');
    expect(renders.identity).toBe(before);
  });

  it('in wrap-up: the countdown drains while the root stays still', async () => {
    await mounted();
    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04.000Z' });
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'customer_hangup',
        requires_disposition: true,
        message: 'Call ended.',
      });
      latest().emit({
        event: 'wrapup',
        wrapup: {
          attempt_id: 'att-1',
          ends_at: '2026-08-11T10:00:46.000Z',
          requires_disposition: true,
          disposition_submitted: false,
          auto_return: true,
        },
      });
      latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:00:16.000Z' });
    });
    settle();
    expect(screen.getByTestId('wrapup-digits').textContent).toBe('0:29');
    const before = renders.identity;

    twoSeconds();

    expect(screen.getByTestId('wrapup-digits').textContent).toBe('0:27');
    expect(renders.identity).toBe(before);
  });

  it('on break: the elapsed time advances while the root stays still', async () => {
    await mounted();
    act(() => {
      latest().emit({
        event: 'agent_state',
        state: 'break',
        since: '2026-08-11T10:00:06.000Z',
        break_reason: 'lunch',
      });
    });
    expect(screen.getByTestId('break-elapsed').textContent).toBe('0:10');
    const before = renders.identity;

    twoSeconds();

    expect(screen.getByTestId('break-elapsed').textContent).toBe('0:12');
    expect(renders.identity).toBe(before);
  });

  it('a callback code selected: Save disables when the picked time passes, the root stays still', async () => {
    await mounted();
    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04.000Z' });
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'customer_hangup',
        requires_disposition: true,
        message: 'Call ended.',
      });
      // Timerless, so nothing else on screen is counting down.
      latest().emit({
        event: 'wrapup',
        wrapup: {
          attempt_id: 'att-1',
          ends_at: null,
          requires_disposition: true,
          disposition_submitted: false,
          auto_return: false,
        },
      });
      latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:00:16.000Z' });
    });
    settle();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /Call back later/ }));
    });
    // The next whole minute in the agent's own zone, the shape `datetime-local`
    // takes: 10:01:00, i.e. 43s after the present once `settle` has run.
    const at = new Date(NOW + 60_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
    act(() => {
      fireEvent.change(screen.getByLabelText('Callback date and time'), { target: { value: local } });
    });
    const save = () => screen.getByRole('button', { name: /save disposition/i }) as HTMLButtonElement;
    expect(save().disabled).toBe(false);
    const before = renders.identity;

    twoSeconds();
    expect(save().disabled).toBe(false);
    expect(renders.identity).toBe(before);

    // Past the picked minute: Save disables and says why, with no root render owed
    // to the clock. The 10s heartbeat does render the root once per ping (a socket
    // event, not a repaint), so those are counted and allowed — and nothing else.
    const pings = () => latest().sent.filter((f) => JSON.parse(f).event === 'ping').length;
    const pingsBefore = pings();
    for (let i = 0; i < 4 * 45; i += 1) {
      act(() => {
        vi.advanceTimersByTime(250);
      });
    }
    expect(save().disabled).toBe(true);
    expect(screen.getByText(DISPOSITION_BLOCK_COPY.callback_in_past)).toBeTruthy();
    expect(pings() - pingsBefore).toBeGreaterThan(0);
    expect(renders.identity - before).toBe(pings() - pingsBefore);

    // And the shortcut, which reaches `submit` without the button, refuses too.
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Enter', ctrlKey: true });
    });
    await act(async () => {});
    expect(mocks.submitDisposition).not.toHaveBeenCalled();
  });

  it('binds the window keydown listener once, not on every render', async () => {
    await mounted();
    const add = vi.spyOn(window, 'addEventListener');
    const before = renders.identity;

    // Frames that re-render the root and change nothing the shortcuts care about.
    act(() => {
      latest().emit({ event: 'campaign_state', status: 'paused', reason: 'manual', dialing: false });
    });
    act(() => {
      latest().emit({ event: 'campaign_state', status: 'running', reason: 'manual', dialing: true });
    });

    expect(renders.identity).toBeGreaterThan(before);
    expect(add.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0);
    add.mockRestore();
  });
});
