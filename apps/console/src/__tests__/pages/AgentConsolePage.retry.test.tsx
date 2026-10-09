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

describe('the retry banner', () => {
  it('names the pass and the campaign it came from', async () => {
    mocks.createAgencySession.mockResolvedValue(RETRY_BOOTSTRAP);
    await mounted();

    const banner = screen.getByTestId('retry-context');
    expect(banner.textContent).toContain('Retry 1');
    expect(banner.textContent).toContain('Q3 Winback');
  });

  it('renders the API’s selection summary unchanged', async () => {
    // The API builds it from the frozen selector on the child's row, so the
    // sentence the agent reads and the query that put this contact in front of
    // them cannot disagree. Re-deriving it here would be a second answer.
    mocks.createAgencySession.mockResolvedValue(RETRY_BOOTSTRAP);
    await mounted();

    expect(screen.getByTestId('retry-context').textContent).toContain(
      'voicemail, callback, no answer',
    );
  });

  it('is present from the moment the station opens, before any call', async () => {
    // Read from the bootstrap, which is fixed at join — so the banner cannot
    // appear or disappear under the agent's cursor mid-shift, which is what
    // lets it sit above the console body without breaking the frozen geometry.
    mocks.createAgencySession.mockResolvedValue(RETRY_BOOTSTRAP);
    await mounted();
    expect(screen.getByTestId('retry-context')).toBeTruthy();
    expect(screen.getByTestId('idle-guide')).toBeTruthy();
  });

  it('leaves the console exactly as it was on an ordinary campaign', async () => {
    // The 100% case today: `retry_context` is absent for every non-retry
    // campaign, and an absent one must render nothing at all — not an empty
    // banner holding space.
    await mounted();
    expect(screen.queryByTestId('retry-context')).toBeNull();
    expect(screen.getByTestId('idle-guide')).toBeTruthy();
    expect(screen.getByTestId('station-identity')).toBeTruthy();
  });
});

describe('prior attempts across a lineage', () => {
  it('groups by campaign, with this campaign first', async () => {
    await onCall(
      attempt([
        // The ancestor's attempt is the NEWEST, and the agent's own pass still
        // leads: it is the context for the call they are about to take.
        prior({
          ...PARENT_CAMPAIGN_FIELDS(),
          attempt_number: 2,
          ended_at: '2026-08-24T10:00:00.000Z',
          disposition_code: null,
        }),
        prior({ attempt_number: 1, ended_at: '2026-08-20T10:00:00.000Z' }),
      ]),
    );

    const groups = screen.getAllByTestId(/^prior-group-/);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.getAttribute('data-testid')).toBe(`prior-group-${CHILD_CAMPAIGN.id}`);
    expect(groups[0]!.getAttribute('data-current')).toBe('true');
    expect(groups[1]!.getAttribute('data-testid')).toBe(`prior-group-${PARENT_CAMPAIGN.id}`);
  });

  it('names the ancestor campaign and says "This campaign" for the agent’s own', async () => {
    await onCall(
      attempt([prior({ ...PARENT_CAMPAIGN_FIELDS() }), prior({ attempt_number: 1 })]),
    );

    expect(
      within(screen.getByTestId(`prior-group-${CHILD_CAMPAIGN.id}`)).getByText('This campaign'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId(`prior-group-${PARENT_CAMPAIGN.id}`)).getByText('Q3 Winback'),
    ).toBeTruthy();
  });

  it('keeps each group newest-first, as the API ordered them', async () => {
    await onCall(
      attempt([
        prior({ attempt_number: 3, notes: 'third' }),
        prior({ attempt_number: 2, notes: 'second' }),
        prior({ attempt_number: 1, notes: 'first' }),
      ]),
    );

    const items = within(screen.getByTestId(`prior-group-${CHILD_CAMPAIGN.id}`)).getAllByRole(
      'listitem',
    );
    expect(items.map((el) => el.textContent)).toEqual([
      expect.stringContaining('third'),
      expect.stringContaining('second'),
      expect.stringContaining('first'),
    ]);
  });

  it('counts every attempt in the heading, across all groups', async () => {
    // The cap is 20 across the whole lineage, so a per-group count would not
    // add up to what the agent can see.
    await onCall(
      attempt([prior({ ...PARENT_CAMPAIGN_FIELDS() }), prior(), prior({ attempt_number: 2 })]),
    );
    expect(screen.getByTestId('prior-attempts').textContent).toContain('Prior attempts (3)');
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
    expect(screen.getByText('child note')).toBeTruthy();
    expect(screen.getByText('parent note')).toBeTruthy();
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

    const group = screen.getByTestId(`prior-group-${PARENT_CAMPAIGN.id}`);
    expect(within(group).getByText('ptp')).toBeTruthy();
    expect(screen.queryByText('Unknown outcome')).toBeNull();
  });

  it('marks it as an unresolved code rather than passing it off as prose', async () => {
    await onCall(attempt([prior({ ...PARENT_CAMPAIGN_FIELDS(), disposition_code: 'ptp' })]));
    const code = within(screen.getByTestId(`prior-group-${PARENT_CAMPAIGN.id}`)).getByText('ptp');
    expect(code.getAttribute('data-unlabelled')).toBe('true');
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
    // Scoped to the history: the disposition pad renders "Sale" too, and a
    // page-wide query would pass on the pad's card while the history showed a
    // bare code.
    const label = within(screen.getByTestId(`prior-group-${CHILD_CAMPAIGN.id}`)).getByText('Sale');
    expect(label.getAttribute('data-unlabelled')).toBeNull();
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
