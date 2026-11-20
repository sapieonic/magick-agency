import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApiError } from '../../api/client';
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
import { stubStationMicrophone } from '../helpers/stationDevices';
import type {
  AgencyPriorAttempt,
  AgencyReservedAttempt,
  AgencySessionBootstrap,
} from '../../types/agency';

/**
 * The agent's half of retry campaigns (slice S5).
 *
 * ── The assertion discipline this file inherits ────────────────────────────
 * From `AgentConsolePage.test.tsx`: nothing here asserts that a component was
 * rendered with the right props. Every case drives real socket frames through
 * the real hook and asserts what an agent would see. A test that pokes a
 * callback cannot tell a rendered banner from an unrendered one.
 *
 * ── The boundary being defended ────────────────────────────────────────────
 * The agent gets a name and a sentence. Not the parent campaign's stats, its
 * connect rate, its roster counts, its agent roster, or its disposition
 * catalog. `agent` sits at level 5 holding exactly four `agency.*` permissions,
 * and this feature must not become the reason anyone raises it — so the
 * catalog-leak case is asserted as an ABSENCE, which is the only way a leak
 * shows up in a test.
 */

const CHILD_CAMPAIGN = { id: 'camp-child', name: 'Q3 Winback — Retry 1' };
const PARENT_CAMPAIGN = { id: 'camp-parent', name: 'Q3 Winback' };

function prior(over: Partial<AgencyPriorAttempt> = {}): AgencyPriorAttempt {
  return {
    attempt_number: 1,
    outcome: 'no_answer',
    disposition_code: null,
    notes: null,
    ended_at: '2026-08-20T10:00:00.000Z',
    campaign_id: CHILD_CAMPAIGN.id,
    campaign_name: CHILD_CAMPAIGN.name,
    dialed_at: '2026-08-20T09:59:00.000Z',
    ...over,
  };
}

function attempt(priors: AgencyPriorAttempt[] = []): AgencyReservedAttempt {
  return {
    attempt_id: 'att-1',
    campaign_id: CHILD_CAMPAIGN.id,
    campaign_name: CHILD_CAMPAIGN.name,
    contact_id: 'c-1',
    phone_e164: '+919876543210',
    caller_id: '+911234567890',
    attempt_number: 1,
    context: { 'First Name': 'Asha' },
    prior_attempts: priors,
  };
}

/**
 * The CHILD's catalog. It holds `sale` and `callback` and deliberately does NOT
 * hold `ptp` — an operator dropping an outcome between passes is the ordinary
 * reason to author a retry, so a parent-only code is a routine payload rather
 * than a stale console.
 */
const BOOTSTRAP: AgencySessionBootstrap = {
  session_id: 'sess-1',
  campaign_id: CHILD_CAMPAIGN.id,
  campaign_name: CHILD_CAMPAIGN.name,
  agent_user_id: 'u-1',
  state: 'offline',
  campaign_status: 'running',
  station_ws_url: '/proxy/agency/station/sess-1?token=t1',
  disposition_catalog: [
    { code: 'sale', label: 'Sale' },
    { code: 'callback', label: 'Call back later', requires_note: true },
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

const RETRY_BOOTSTRAP: AgencySessionBootstrap = {
  ...BOOTSTRAP,
  retry_context: {
    generation: 1,
    parent_campaign_name: PARENT_CAMPAIGN.name,
    selection_summary: 'voicemail, callback, no answer',
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
});

async function mounted() {
  const view = render(
    <MemoryRouter initialEntries={['/station?campaign=camp-child']}>
      <AgentConsolePage />
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    latest().open();
  });
  return view;
}

/** Bridged and talking, so the contact panel and its history are on screen. */
async function onCall(reserved: AgencyReservedAttempt) {
  const view = await mounted();
  await act(async () => {
    latest().emit({ event: 'reserved', attempt: reserved });
    latest().emit({ event: 'agent_state', state: 'reserved', since: '2026-08-25T10:00:00.000Z' });
    latest().emit({
      event: 'bridged',
      attempt_id: reserved.attempt_id,
      bridged_at: '2026-08-25T10:00:04.000Z',
    });
    latest().emit({ event: 'agent_state', state: 'on_call', since: '2026-08-25T10:00:04.000Z' });
  });
  return view;
}

describe('the retry banner is gone (spec §8: supervisor language)', () => {
  it('shows no retry banner on a retry campaign; Last calls says the customer was called before', async () => {
    mocks.createAgencySession.mockResolvedValue(RETRY_BOOTSTRAP);
    await onCall(attempt([prior({ ...PARENT_CAMPAIGN_FIELDS(), attempt_number: 2, notes: 'asked for a week' })]));
    expect(screen.queryByTestId('retry-context')).toBeNull();
    expect(screen.queryByText(/Retry 1 of/)).toBeNull();
    expect(screen.queryByText(/voicemail, callback, no answer/)).toBeNull();
    const calls = screen.getByTestId('last-calls');
    expect(within(calls).getByText('“asked for a week”')).toBeTruthy();
  });
});

const lastCallRows = () => within(screen.getByTestId('last-calls')).getAllByRole('listitem');

describe('Last calls across a lineage (04c)', () => {
  it('lists the newest calls first, across the campaigns of the lineage', async () => {
    await onCall(
      attempt([
        prior({ ...PARENT_CAMPAIGN_FIELDS(), attempt_number: 2, ended_at: '2026-08-24T10:00:00.000Z', notes: 'parent, newest' }),
        prior({ attempt_number: 1, ended_at: '2026-08-20T10:00:00.000Z', notes: 'child, older' }),
      ]),
    );
    expect(lastCallRows().map((el) => el.textContent)).toEqual([
      expect.stringContaining('parent, newest'),
      expect.stringContaining('child, older'),
    ]);
  });

  it('keeps at most the three newest', async () => {
    await onCall(
      attempt([
        prior({ attempt_number: 4, ended_at: '2026-08-24T10:00:00.000Z', notes: 'fourth' }),
        prior({ attempt_number: 3, ended_at: '2026-08-23T10:00:00.000Z', notes: 'third' }),
        prior({ attempt_number: 2, ended_at: '2026-08-22T10:00:00.000Z', notes: 'second' }),
        prior({ attempt_number: 1, ended_at: '2026-08-21T10:00:00.000Z', notes: 'first' }),
      ]),
    );
    expect(lastCallRows().map((el) => el.textContent)).toEqual([
      expect.stringContaining('fourth'),
      expect.stringContaining('third'),
      expect.stringContaining('second'),
    ]);
  });

  it('renders two attempts that each call themselves "attempt 1"', async () => {
    // `attempt_number` resets in every retry campaign, so it is not a key.
    // Keyed on it alone, React collapses these two into one row.
    await onCall(
      attempt([prior({ attempt_number: 1, notes: 'child note' }), prior({
        ...PARENT_CAMPAIGN_FIELDS(),
        attempt_number: 1,
        notes: 'parent note',
      })]),
    );
    expect(screen.getByText('“child note”')).toBeTruthy();
    expect(screen.getByText('“parent note”')).toBeTruthy();
  });
});

describe('a disposition code this campaign has no label for', () => {
  it('shows the code, never "Unknown outcome", and does not crash', async () => {
    // `ptp` is on the PARENT's catalog and not on this one. An agent reading
    // "Unknown outcome" concludes the write-up was lost; it is intact, and only
    // its label is missing.
    await onCall(
      attempt([prior({ ...PARENT_CAMPAIGN_FIELDS(), disposition_code: 'ptp', notes: 'promised' })]),
    );

    expect(within(screen.getByTestId('last-calls')).getByText('ptp')).toBeTruthy();
    expect(screen.queryByText('Unknown outcome')).toBeNull();
  });

  it('does not leak the parent’s catalog onto the agent’s screen', async () => {
    // The label exists — on the parent campaign, which this bootstrap does not
    // and must not carry. If it ever appears here, a supervisor-scoped read
    // reached the agent console.
    await onCall(attempt([prior({ ...PARENT_CAMPAIGN_FIELDS(), disposition_code: 'ptp' })]));
    expect(screen.queryByText('PTP')).toBeNull();
    expect(mocks.createAgencySession).toHaveBeenCalledTimes(1);
  });

  it('still names a code this campaign does hold', async () => {
    await onCall(attempt([prior({ disposition_code: 'sale' })]));
    // Scoped to the history: the outcome tiles say "Sale" too on What happened?.
    expect(within(screen.getByTestId('last-calls')).getByText('Sale')).toBeTruthy();
    expect(within(screen.getByTestId('last-calls')).queryByText('sale')).toBeNull();
  });
});

describe('the agent is given lineage and nothing else', () => {
  it('shows no ancestor stats, connect rate or roster counts', async () => {
    mocks.createAgencySession.mockResolvedValue(RETRY_BOOTSTRAP);
    await onCall(attempt([prior({ ...PARENT_CAMPAIGN_FIELDS(), disposition_code: 'ptp' })]));

    // The whole of what the parent campaign contributes to this screen is a
    // name, a generation and a sentence. Anything numeric about it would be a
    // supervisor-gated read on an `agent`-floored surface.
    expect(screen.queryByText(/connect rate/i)).toBeNull();
    expect(screen.queryByText(/contacts total/i)).toBeNull();
    expect(screen.queryByRole('link', { name: /Q3 Winback/ })).toBeNull();
  });
});

/** The two fields that move an attempt into the parent's group. */
function PARENT_CAMPAIGN_FIELDS(): Partial<AgencyPriorAttempt> {
  return { campaign_id: PARENT_CAMPAIGN.id, campaign_name: PARENT_CAMPAIGN.name };
}

describe('joining while the station token cannot be stored (D9)', () => {
  it('a 503 station_token_unavailable join is retried on its own and the station opens', async () => {
    mocks.createAgencySession
      .mockRejectedValueOnce(new ApiError(503, {
        error: 'Service Unavailable', code: 'station_token_unavailable', message: 'Try again in a moment.',
      }))
      .mockResolvedValue(BOOTSTRAP);
    render(
      <MemoryRouter initialEntries={['/station?campaign=camp-child']}>
        <AgentConsolePage />
      </MemoryRouter>,
    );
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1), { timeout: 3_000 });
    expect(mocks.createAgencySession).toHaveBeenCalledTimes(2);
    expect(latest().url).toContain('token=t1');
  });
});
