import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type {
  AgencyCampaign,
  AgencyCampaignStats,
  AgencySupervisorAgent,
} from '../../types/agency-campaign';

/**
 * The campaign detail page — lifecycle controls and the counters.
 *
 * Written after review flagged that this page shipped with no page-level
 * coverage while its siblings had it. The behaviours below are the ones where
 * being wrong misleads a supervisor about live calls rather than merely looking
 * untidy.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getAgencyCampaign: vi.fn(),
  getAgencyCampaignStats: vi.fn(),
  transitionAgencyCampaign: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  forceAgentAvailable: vi.fn(),
  // The staffing panel (`MAG-160`) — a second consumer of `api/agency` on this
  // page, and of the tenant member list it picks from.
  listCampaignAgents: vi.fn(),
  assignAgent: vi.fn(),
  unassignAgent: vi.fn(),
  // The REAL `useTeam` runs; only the request under it is mocked. Mocking the
  // hook hid the defect these tests are meant to catch — see below.
  listTenantMembers: vi.fn(),
  /*
    `MAG-167`: the Overview panel mounts `CampaignSeriesSection`, which owns its
    own read and fires it on mount. Mocked here rather than left to a real
    `fetch` — an unmocked one would make every test on this page depend on the
    network, and the section's own behaviour is covered where it lives.
  */
  getAgencyCampaignSeries: vi.fn(),
  /*
    The header's lineage strip owns its own read and fires it on mount for
    EVERY campaign — a parent that has been retried carries
    `retry_generation: 0` and `parent_campaign_id: null` exactly like a campaign
    that never was, so nothing on the row can gate the call. The default answer
    below is the documented one for a campaign in no chain (itself, as the only
    entry), which is what almost every campaign is and what makes the strip
    render nothing.
  */
  campaignLineage: vi.fn(),
  /* The retry dialog is mounted only while open; these keep the module's shape
     honest so an accidental call is a failed assertion rather than a crash. */
  retryPreview: vi.fn(),
  createRetry: vi.fn(),
  // The dialog's caller-ID override renders `CallerIdPicker`, which reads the
  // account's numbers. Mocked at the hook — the picker has its own suite.
  usePhoneNumbers: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  getAgencyCampaignStats: mocks.getAgencyCampaignStats,
  transitionAgencyCampaign: mocks.transitionAgencyCampaign,
  campaignLineage: mocks.campaignLineage,
  retryPreview: mocks.retryPreview,
  createRetry: mocks.createRetry,
}));
vi.mock('../../api/agency', () => ({
  forceAgentAvailable: mocks.forceAgentAvailable,
  listCampaignAgents: mocks.listCampaignAgents,
  assignAgent: mocks.assignAgent,
  unassignAgent: mocks.unassignAgent,
}));
vi.mock('../../api/tenants', () => ({ listTenantMembers: mocks.listTenantMembers }));
vi.mock('../../api/agencyCampaignSeries', () => ({
  getAgencyCampaignSeries: mocks.getAgencyCampaignSeries,
}));
vi.mock('../../hooks/usePhoneNumbers', () => ({ usePhoneNumbers: mocks.usePhoneNumbers }));

import DetailPage from '../../pages/agency/AgencyCampaignDetailPage';
import { ApiError } from '../../api/client';

function campaign(over: Partial<AgencyCampaign> = {}): AgencyCampaign {
  return { id: 'camp-1', name: 'Collections', status: 'running', ...over };
}

function stats(over: Partial<AgencyCampaignStats> = {}): AgencyCampaignStats {
  return {
    campaign_id: 'camp-1',
    contacts_total: 1000,
    contacts_pending: 400,
    contacts_in_flight: 3,
    contacts_completed: 550,
    contacts_suppressed: 20,
    contacts_exhausted: 27,
    retries_pending: 12,
    attempts_live: 3,
    attempts_total: 1400,
    attempts_connected: 610,
    agents_live: 4,
    // The supervisor payload (MAG-71). A healthy campaign by default: no stall,
    // so the strip's diagnosis renders nothing and each test opts into the
    // condition it is about.
    stall: null,
    other_stalls: [],
    concurrency_limit: 5,
    concurrency_in_use: 2,
    abandonment_ceiling_pct: 3,
    abandonment_rate_24h_pct: 1.2,
    ...over,
  };
}

/**
 * One agent, mid wrap-up — the only state the force-return control is offered
 * on. `session_id` is deliberately not the `agent_user_id`: every control is
 * addressed to the session, and the tests below assert which one is used.
 */
function wrappingAgent(over: Partial<AgencySupervisorAgent> = {}): AgencySupervisorAgent {
  return {
    session_id: 'wrap-sess',
    agent_user_id: 'usr_person',
    agent_name: 'Ravi',
    state: 'wrapup',
    // Well past a 30s window plus its 60s grace, so the tile is rank 1.
    state_since: new Date(Date.now() - 300_000).toISOString(),
    connected: true,
    break_reason: null,
    calls_handled: 7,
    ...over,
  };
}

/**
 * MAG-166: the page is three sections, each its own URL, and all three mount
 * the same component. Tests name the section they are about — the default is
 * the one a supervisor lands on.
 */
function renderPage(section: 'overview' | 'performance' | 'agents' = 'overview') {
  const suffix = section === 'overview' ? '' : `/${section}`;
  return render(
    <MemoryRouter initialEntries={[`/agency/campaigns/camp-1${suffix}`]}>
      <Routes>
        <Route path="/agency/campaigns/:id" element={<DetailPage />} />
        <Route path="/agency/campaigns/:id/performance" element={<DetailPage />} />
        <Route path="/agency/campaigns/:id/agents" element={<DetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'tenant_owner',
  });
  mocks.getAgencyCampaign.mockResolvedValue(campaign());
  mocks.getAgencyCampaignStats.mockResolvedValue(stats());
  mocks.listCampaignAgents.mockResolvedValue({ agents: [] });
  // An empty range answers the section's four states without drawing a chart:
  // these tests are about whether the section is MOUNTED, not about its shape.
  mocks.getAgencyCampaignSeries.mockResolvedValue({
    campaign_id: 'camp-1',
    bucket: 'day',
    buckets: [],
  });
  mocks.listTenantMembers.mockResolvedValue([]);
  // A campaign in no chain answers with itself as the only entry, not a 404 —
  // so the strip renders nothing, which is what every test here except the
  // lineage ones expects to see.
  mocks.campaignLineage.mockResolvedValue({
    root_campaign_id: 'camp-1',
    campaigns: [
      {
        id: 'camp-1',
        name: 'Collections',
        status: 'running',
        retry_generation: 0,
        parent_campaign_id: null,
        contacts_total: 1000,
        created_at: '2026-08-01T09:00:00.000Z',
        started_at: '2026-08-01T10:00:00.000Z',
        ended_at: null,
      },
    ],
  });
  mocks.usePhoneNumbers.mockReturnValue({
    phoneNumbers: [], loading: false, error: null, reload: vi.fn(), defaultNumber: null,
  });
  mocks.retryPreview.mockResolvedValue({
    matched: 300,
    by_last_outcome: { no_answer: 200, busy: 100 },
    by_last_disposition: { __none__: 300 },
    excluded: { dnc: 0, invalid: 0 },
    parent_contacts_total: 1000,
    retry_generation: 0,
    max_seed_rows: 100_000,
  });
  mocks.transitionAgencyCampaign.mockImplementation(async (_id, action) =>
    campaign({ status: action === 'stop' ? 'stopping' : action === 'pause' ? 'paused' : 'running' }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('campaign detail — the status-to-action matrix', () => {
  // [status, enabled, disabled-but-present, absent]
  const MATRIX: Array<[string, string[], string[], string[]]> = [
    ['draft', ['Start dialing', 'Stop'], [], ['Pause', 'Resume']],
    ['running', ['Pause', 'Stop'], [], ['Start dialing', 'Resume']],
    ['paused', ['Resume', 'Stop'], [], ['Pause', 'Start dialing']],
    // MAG-134: `stopping` no longer hides the controls a supervisor reaches for.
    // The pacing leader still owns the final write — the buttons are refused,
    // with the reason on screen, rather than being absent and unexplained.
    ['stopping', [], ['Resume', 'Stop'], ['Start dialing', 'Pause']],
    ['stopped', [], [], ['Start dialing', 'Pause', 'Resume', 'Stop']],
    ['completed', [], [], ['Start dialing', 'Pause', 'Resume', 'Stop']],
  ];

  it.each(MATRIX)('%s enables %j, refuses %j, hides %j', async (status, enabled, refused, absent) => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    for (const label of enabled) {
      const button = screen.getByRole('button', { name: label }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    }
    for (const label of refused) {
      const button = screen.getByRole('button', { name: label }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    }
    for (const label of absent) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('says WHY resume is refused on a stopping campaign, rather than 409-ing later', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'stopping' }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    // A bare greyed button on this page reads as a permissions failure. It is
    // not one — the campaign is draining, and that is a fact about the campaign
    // the supervisor can act on (by waiting).
    const reason = screen.getByTestId('control-reason-resume');
    expect(reason.textContent).toMatch(/still finishing/i);
    expect(reason.textContent).toMatch(/can’t be resumed/i);
  });

  it('offers a productive next step, and KEEPS the rail on a terminal campaign', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'stopped' }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.queryByRole('link', { name: 'Add contacts' })).toBeNull();
    expect(screen.getByRole('link', { name: 'New campaign' }).getAttribute('href')).toBe(
      '/agency/campaigns/new',
    );
    /*
      The rail used to be removed outright once a campaign stopped, which left
      the page one narrow column with a screen of white beside it — on the very
      status this panel is read at MOST, since a finished campaign is what a
      supervisor comes back to. It stays; what changes is its contents. The
      account's guardrails are still worth reading (the ceiling is shared, and
      the 24h window outlives this campaign), and the live floor is not — nobody
      is at a station on a campaign that has stopped.
    */
    expect(screen.getByRole('heading', { name: 'The account right now' })).toBeTruthy();
    expect(screen.getByTestId('concurrency-readout')).toBeTruthy();
    expect(screen.queryByTestId('floor-summary')).toBeNull();
    // The floor did not go away with the guardrails — it moved to its own
    // section, and a stopped campaign still has a shift to account for.
    expect(screen.getByTestId('campaign-tab-agents')).toBeTruthy();
  });

  it('names the rail for the live floor while dialing can continue', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByRole('link', { name: 'Add contacts' })).toBeTruthy();
    // Same rail, and it leads with what is happening now rather than with the
    // account's standing limits.
    expect(screen.getByRole('heading', { name: 'Right now' })).toBeTruthy();
    expect(screen.getByTestId('floor-summary')).toBeTruthy();
    expect(screen.getByTestId('concurrency-readout')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New campaign' })).toBeNull();
  });
});

describe('campaign detail — stopping', () => {
  it('confirms before stopping, and does not call the API until confirmed', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(await screen.findByText(/stop this campaign\?/i)).toBeTruthy();
    expect(mocks.transitionAgencyCampaign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /stop campaign/i }));

    await waitFor(() => expect(mocks.transitionAgencyCampaign).toHaveBeenCalled());
    const [id, action, tenantId, accountId] = mocks.transitionAgencyCampaign.mock.calls[0]!;
    expect([id, action, tenantId, accountId]).toEqual(['camp-1', 'stop', 'tenant-1', 'account-1']);
  });

  it('reports the status that came back, not the one that was asked for', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(await screen.findByRole('button', { name: /stop campaign/i }));

    // `stop` answers `stopping`. A toast reading "Stopped" would contradict the
    // badge rendered directly beneath it while calls are still connected.
    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith('Campaign is now stopping.', 'success'),
    );
  });

  it('pausing needs no confirmation', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));

    await waitFor(() => expect(mocks.transitionAgencyCampaign).toHaveBeenCalled());
    expect(mocks.transitionAgencyCampaign.mock.calls[0]![1]).toBe('pause');
  });
});

describe('campaign detail — a stale Start/Resume must not 409', () => {
  /**
   * chitboss UAT: 7× `POST …/start` and 1× `POST …/resume` against campaigns
   * that were already live. MAG-134 already hides those buttons for the
   * status the view holds; these cases are the view being behind the server.
   */

  it('fires start only once when the button is clicked twice before the first paint', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));
    let release: ((value: AgencyCampaign) => void) | undefined;
    mocks.transitionAgencyCampaign.mockImplementation(
      () => new Promise<AgencyCampaign>((resolve) => { release = resolve; }),
    );

    renderPage();
    const start = await screen.findByRole('button', { name: 'Start dialing' });
    fireEvent.click(start);
    fireEvent.click(start);

    await waitFor(() => expect(mocks.transitionAgencyCampaign).toHaveBeenCalledTimes(1));
    await act(async () => {
      release?.(campaign({ status: 'running' }));
    });
  });

  it('re-reads before POSTing start, so a stale Start never reaches the network', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));

    renderPage();
    await screen.findByRole('button', { name: 'Start dialing' });

    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start dialing' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy());
    expect(mocks.transitionAgencyCampaign).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Start dialing' })).toBeNull();
    expect(mocks.showErrorToast).not.toHaveBeenCalled();
  });

  it('a stats outage on the preflight cannot send a stale Start', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));

    renderPage();
    await screen.findByRole('button', { name: 'Start dialing' });

    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));
    mocks.getAgencyCampaignStats.mockRejectedValue(new Error('stats unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Start dialing' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy());
    expect(mocks.transitionAgencyCampaign).not.toHaveBeenCalled();
  });

  it('re-reads before POSTing resume, so a stale Resume never reaches the network', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'paused' }));

    renderPage();
    await screen.findByRole('button', { name: 'Resume' });

    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy());
    expect(mocks.transitionAgencyCampaign).not.toHaveBeenCalled();
    expect(mocks.showErrorToast).not.toHaveBeenCalled();
  });

  it('on a 409 from start, refetches and re-renders the running controls instead of a conflict toast', async () => {
    // Preflight GET still returns draft — a genuine race with another tab —
    // so the POST goes out, 409s, and the view self-corrects. Stats failing
    // on that repair must not turn the fresh `running` into `null` and toast.
    let gets = 0;
    mocks.getAgencyCampaign.mockImplementation(async () => {
      gets += 1;
      return campaign({ status: gets >= 3 ? 'running' : 'draft' });
    });
    mocks.transitionAgencyCampaign.mockRejectedValue(
      new ApiError(409, { error: 'Conflict', message: 'Campaign is already running' }),
    );

    renderPage();
    await screen.findByRole('button', { name: 'Start dialing' });
    mocks.getAgencyCampaignStats.mockRejectedValue(new Error('stats unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Start dialing' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy());
    expect(mocks.transitionAgencyCampaign).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Start dialing' })).toBeNull();
    expect(mocks.showErrorToast).not.toHaveBeenCalled();
  });

  it('still surfaces a 409 that did not move this campaign — another one is running', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));
    mocks.transitionAgencyCampaign.mockRejectedValue(
      new ApiError(409, {
        error: 'Conflict',
        code: 'another_campaign_running',
        message: 'Another campaign is already running on this account.',
      }),
    );

    renderPage();
    await screen.findByRole('button', { name: 'Start dialing' });
    fireEvent.click(screen.getByRole('button', { name: 'Start dialing' }));

    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Start dialing' })).toBeTruthy();
  });

  it('re-reads a draft campaign when the window is focused, so Start can disappear', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));

    renderPage();
    await screen.findByRole('button', { name: 'Start dialing' });

    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Start dialing' })).toBeNull();
  });

  it('re-reads on window focus as well as visibilitychange — two windows both stay visible', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));

    renderPage();
    await screen.findByRole('button', { name: 'Start dialing' });

    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Start dialing' })).toBeNull();
  });

  it('an in-flight visibility GET cannot paint a draft over a start that already succeeded', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));
    mocks.getAgencyCampaignStats.mockResolvedValue(stats());

    renderPage();
    await screen.findByRole('button', { name: 'Start dialing' });

    const campaignResolvers: Array<(value: AgencyCampaign) => void> = [];
    const statsResolvers: Array<(value: AgencyCampaignStats) => void> = [];
    mocks.getAgencyCampaign.mockImplementation(
      () => new Promise<AgencyCampaign>((resolve) => { campaignResolvers.push(resolve); }),
    );
    mocks.getAgencyCampaignStats.mockImplementation(
      () => new Promise<AgencyCampaignStats>((resolve) => { statsResolvers.push(resolve); }),
    );

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(campaignResolvers.length).toBe(1);

    mocks.transitionAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start dialing' }));
    await waitFor(() => expect(campaignResolvers.length).toBe(2));

    // Click's preflight is campaign-only, so it does not wait on stats.
    // It still sees draft, so the POST goes out and succeeds. Then the
    // earlier visibility GET returns draft and must not paint over `running`.
    await act(async () => {
      campaignResolvers[1]?.(campaign({ status: 'draft' }));
    });
    await waitFor(() => expect(mocks.transitionAgencyCampaign).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy());

    await act(async () => {
      campaignResolvers[0]?.(campaign({ status: 'draft' }));
      statsResolvers[0]?.(stats());
    });

    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start dialing' })).toBeNull();
  });
});

describe('campaign detail — counters', () => {
  it('renders an absent counter as a dash, never as zero', async () => {
    // A zero is a claim about the campaign. A dash is a claim about our
    // knowledge of it, which is the true one when a field did not arrive.
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ contacts_exhausted: undefined }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    const tile = screen.getByTestId('contact-state-contacts_exhausted');
    expect(tile.textContent).toContain('—');
    expect(tile.textContent).not.toContain('0');
  });

  it('separates the roster total from simultaneous contact states', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByTestId('total-contacts').textContent).toContain('1,000');
    expect(screen.getByTestId('contact-state-contacts_completed').textContent).toContain('Completed');
    expect(screen.queryByText('Done')).toBeNull();
    // One cell for live attempts, named for what it is. "Active attempts" was
    // the rail's label for the same figure; the strip absorbed it, and two
    // labels for one number is how a supervisor comes to believe there are two.
    expect(screen.getAllByText('On the line now')).toHaveLength(1);
    expect(screen.queryByText('Live calls')).toBeNull();
    expect(screen.queryByText('Active attempts')).toBeNull();
  });

  it('uses one page landmark and labels this screen as a region', async () => {
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(container.querySelectorAll('main')).toHaveLength(0);
    expect(screen.getByRole('region', { name: 'Campaign overview' })).toBeTruthy();
  });

  it('keeps the refresh timestamp quiet for screen readers', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    const timestamp = screen.getByText(/Updated .*Auto-refreshing/i);
    expect(timestamp.getAttribute('aria-live')).toBeNull();
  });
});

/**
 * ── The page is sections now (`MAG-166`) ───────────────────────────────────
 *
 * It used to be one scroll carrying eleven counters, four derived performance
 * read-outs, the guardrails, the live floor and the staffing roster — with the
 * four *other* campaign screens hanging off the same header row as Stop.
 *
 * What is worth pinning is not the tab strip's markup but the two things a
 * split can get wrong: showing a supervisor something the section they chose
 * did not ask for, and hiding something they must never have to choose to see.
 */
describe('campaign detail — sections', () => {
  it('lands on the overview: the counters and the guardrails, and nothing else', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ agents: [wrappingAgent()] }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByTestId('total-contacts')).toBeTruthy();
    expect(screen.getByTestId('concurrency-readout')).toBeTruthy();
    // The two sections that moved off it.
    expect(screen.queryByTestId('connect-rate-readout')).toBeNull();
    expect(screen.queryByTestId('floor-row-wrap-sess')).toBeNull();
  });

  it('shows the derived figures on their own section', async () => {
    renderPage('performance');
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByTestId('connect-rate-readout')).toBeTruthy();
    expect(screen.queryByTestId('total-contacts')).toBeNull();
  });

  it('keeps the lifecycle controls and the campaign name on every section', async () => {
    // The header is the reason all three panels are one component: a supervisor
    // must be able to press Stop from wherever they noticed the problem.
    for (const section of ['performance', 'agents'] as const) {
      cleanup();
      renderPage(section);
      await screen.findByRole('heading', { name: 'Collections' });
      expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
      expect(screen.getByRole('link', { name: /join as agent/i })).toBeTruthy();
    }
  });

  it('keeps a stall diagnosis above the tab strip, on whichever section is open', async () => {
    // A blocker a supervisor only sees if they happened to pick the right
    // section is a blocker that goes unread. This is the one thing on the page
    // worth seeing before choosing what to look at.
    mocks.getAgencyCampaignStats.mockResolvedValue(
      stats({ stall: { code: 'dnc_unavailable', tenant_wide: true }, other_stalls: [] }),
    );

    for (const section of ['overview', 'performance', 'agents'] as const) {
      cleanup();
      renderPage(section);
      expect(await screen.findByTestId('health-strip-diagnosis')).toBeTruthy();
    }
  });

  it('does not read the staffing routes until the Agents section is opened', async () => {
    // Both reads 403 below `agency.supervise` and neither answers a question the
    // overview asks, so a campaign page view should not spend them.
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'tenant_owner',
    });

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    await waitFor(() => expect(mocks.listCampaignAgents).not.toHaveBeenCalled());
    expect(mocks.listTenantMembers).not.toHaveBeenCalled();
  });

  it('offers only the sections the role can actually reach', async () => {
    // An `agent` is below both `agency.supervise` and `audit.read`. A tab that
    // renders and then 403s on arrival is a worse answer than no tab.
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'agent' });

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByTestId('campaign-tab-overview')).toBeTruthy();
    for (const id of ['contacts', 'attempts', 'activity', 'settings']) {
      expect(screen.queryByTestId(`campaign-tab-${id}`)).toBeNull();
    }
  });

  it('marks the open section as the current page, and only that one', async () => {
    renderPage('agents');
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByTestId('campaign-tab-agents').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('campaign-tab-overview').getAttribute('aria-current')).toBeNull();
  });

  it('badges the Agents tab with the live floor — and says nothing when the floor is unknown', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(
      stats({ agents: [wrappingAgent(), wrappingAgent({ session_id: 'b' })] }),
    );
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });
    expect(screen.getByTestId('campaign-tab-agents-count').textContent).toBe('2');

    cleanup();
    // No per-agent rows is NOT an empty floor — core may not have produced them,
    // or the read failed. A `0` here would be a claim drawn from our ignorance.
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ agents: undefined, agents_live: 4 }));
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });
    expect(screen.queryByTestId('campaign-tab-agents-count')).toBeNull();
  });
});

describe('campaign detail — the health strip (§C.2)', () => {
  it('renders NOTHING when the campaign is not stalled', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    // Not an "all good" banner. A banner that is present when everything is fine
    // trains a supervisor to skim past the one place a real diagnosis appears.
    expect(screen.queryByTestId('health-strip-diagnosis')).toBeNull();
    // The read-outs are not diagnoses and stay on screen regardless.
    expect(screen.getByTestId('concurrency-readout')).toBeTruthy();
  });

  it('shows the ONE diagnosis, with that arm’s own evidence', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(
      stats({
        stall: {
          code: 'no_agents_available',
          agents_on_shift: 6,
          on_break_by_reason: { lunch: 5 },
          on_call: 1,
          last_dial_at: null,
        },
        other_stalls: [],
      }),
    );

    renderPage();
    const strip = await screen.findByTestId('health-strip-diagnosis');

    expect(strip.getAttribute('data-stall-code')).toBe('no_agents_available');
    expect(strip.textContent).toContain('6 agents on shift');
    expect(strip.textContent).toContain('5 on break (lunch 5)');
  });

  it('discloses additional blockers in priority order without competing with the diagnosis', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(
      stats({
        stall: { code: 'dnc_unavailable', tenant_wide: true },
        // Deliberately out of priority order on the wire. The console must sort
        // it itself — relying on core's ordering means a producer-side reorder
        // silently changes what a supervisor reads.
        other_stalls: ['elevated_failure_rate', 'concurrency_saturated'],
      }),
    );

    renderPage();
    await screen.findByTestId('health-strip-diagnosis');

    const disclosure = screen.getByRole('button', { name: /2 additional blockers/i });
    expect(screen.queryByTestId('health-strip-others')).toBeNull();
    fireEvent.click(disclosure);

    const items = Array.from(
      screen.getByTestId('health-strip-others').querySelectorAll('li'),
    ).map((li) => li.textContent);
    expect(items).toEqual(['At the concurrency limit', 'Unusually many failed calls']);
  });

  it('does not offer a disclosure when nothing else matched', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(
      stats({ stall: { code: 'dnc_unavailable', tenant_wide: true }, other_stalls: [] }),
    );

    renderPage();
    await screen.findByTestId('health-strip-diagnosis');

    expect(screen.queryByTestId('health-strip-others')).toBeNull();
    expect(screen.queryByRole('button', { name: /additional blocker/i })).toBeNull();
  });
});

describe('campaign detail — concurrency (CR-2 / D10)', () => {
  it('reads out the live count against the ceiling', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(
      stats({ concurrency_limit: 5, concurrency_in_use: 3 }),
    );

    renderPage();
    const readout = await screen.findByTestId('concurrency-readout');
    expect(readout.textContent).toContain('3 of 5');
  });

  it('is READ-ONLY — no setter, no input, no link to one', async () => {
    renderPage();
    const readout = await screen.findByTestId('concurrency-readout');

    // D10 is explicit: the supervisor sees it and cannot set it. Rendering any
    // affordance here would be a claim the platform cannot honour.
    expect(readout.querySelector('input')).toBeNull();
    expect(readout.querySelector('button')).toBeNull();
    expect(readout.querySelector('a')).toBeNull();
    expect(readout.querySelector('select')).toBeNull();
  });

  it('renders a null in-use as unknown — never 0, never saturated', async () => {
    // `null` means Redis could not answer. Telling a supervisor to contact
    // support about a limit we merely failed to read is the wrong instruction.
    mocks.getAgencyCampaignStats.mockResolvedValue(
      stats({ concurrency_limit: 5, concurrency_in_use: null }),
    );

    renderPage();
    const readout = await screen.findByTestId('concurrency-readout');

    expect(readout.getAttribute('data-unknown')).toBe('true');
    expect(readout.getAttribute('data-saturated')).toBe('false');
    expect(readout.textContent).not.toContain('0 of 5');
    expect(readout.textContent).toMatch(/couldn’t read/i);
  });

  it('marks a genuinely saturated account as saturated', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(
      stats({ concurrency_limit: 5, concurrency_in_use: 5 }),
    );

    renderPage();
    const readout = await screen.findByTestId('concurrency-readout');
    expect(readout.getAttribute('data-saturated')).toBe('true');
  });
});

describe('campaign detail — abandonment against the campaign’s own ceiling', () => {
  it('draws the measured 24h rate against this campaign’s ceiling', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(
      stats({ abandonment_rate_24h_pct: 2.4, abandonment_ceiling_pct: 3 }),
    );

    renderPage();
    const readout = await screen.findByTestId('abandonment-readout');

    // The threshold a supervisor watches has to be the one that actually pauses
    // their campaign — hence the campaign's own field, not a constant.
    expect(readout.textContent).toContain('2.4%');
    expect(readout.textContent).toContain('3%');
    expect(readout.getAttribute('data-over')).toBe('false');
  });

  it('renders a null rate as “No data”, never as 0%', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(
      stats({ abandonment_rate_24h_pct: null }),
    );

    renderPage();
    const readout = await screen.findByTestId('abandonment-readout');

    expect(readout.textContent).toContain('No data');
    expect(readout.textContent).not.toContain('0%');
  });
});

describe('campaign detail — polling', () => {
  /**
   * Status alone is the wrong predicate. A paused campaign still has in-flight
   * calls finishing, and freezing the counters at that exact moment is the
   * worst possible time — a supervisor watching a drain reads a frozen number
   * as a finished one.
   */
  it('keeps polling a PAUSED campaign while attempts are still live', async () => {
    vi.useFakeTimers();
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'paused' }));
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ attempts_live: 2 }));

    renderPage();
    // Wait for the counters to be RENDERED, not merely requested. The poll
    // predicate reads `stats.attempts_live`, so a wait that only proves the
    // request was made can advance the clock before the state that enables
    // polling exists — and then assert the absence of a poll it prevented.
    await vi.waitFor(() => expect(screen.getByTestId('active-attempts')).toBeTruthy());
    const afterLoad = mocks.getAgencyCampaignStats.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mocks.getAgencyCampaignStats.mock.calls.length).toBeGreaterThan(afterLoad);
  });

  it('stops polling once a paused campaign has drained', async () => {
    vi.useFakeTimers();
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'paused' }));
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ attempts_live: 0 }));

    renderPage();
    // Wait for the counters to be RENDERED, not merely requested. The poll
    // predicate reads `stats.attempts_live`, so a wait that only proves the
    // request was made can advance the clock before the state that enables
    // polling exists — and then assert the absence of a poll it prevented.
    await vi.waitFor(() => expect(screen.getByTestId('active-attempts')).toBeTruthy());
    const afterLoad = mocks.getAgencyCampaignStats.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    // Nothing is moving; a request every ten seconds could only confirm what is
    // already on screen.
    expect(mocks.getAgencyCampaignStats.mock.calls.length).toBe(afterLoad);
  });
});

describe('campaign detail — pause does not cancel live calls', () => {
  it('says so on a running campaign', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    // A supervisor who believes pausing cut off live conversations may say so to
    // a customer who is still on one.
    expect(screen.getByText(/new calls only/i)).toBeTruthy();
    expect(screen.getByText(/nobody is cut off/i)).toBeTruthy();
  });

  it('keeps saying so on a paused campaign, where it also explains non-zero active attempts', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'paused' }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByText(/keep going until they end normally/i)).toBeTruthy();
  });

  it('is not shown once the campaign is stopping', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'stopping' }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.queryByText(/new calls only/i)).toBeNull();
  });
});

describe('campaign detail — the agent floor (MAG-148, §C.4)', () => {
  /**
   * The wiring the component's own tests cannot see: that the page threads the
   * campaign's `wrapup_seconds` into rank 1's threshold, and that the roster it
   * has been throwing away since PR #236 now reaches a screen.
   */
  it('renders the roster the stats payload was already carrying', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(
      stats({ agents: [wrappingAgent(), wrappingAgent({ session_id: 'calm', agent_name: 'Sunita', state: 'available' })] }),
    );

    renderPage('agents');
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByTestId('floor-row-wrap-sess')).toBeTruthy();
    expect(screen.getByTestId('floor-row-calm')).toBeTruthy();
    // The roster is the single source of truth for staffing on this screen; a
    // duplicate aggregate tile would compete with the actionable floor.
    expect(screen.getAllByTestId(/^floor-row-/)).toHaveLength(2);
  });

  it('measures rank 1 against THIS campaign’s wrap-up window', async () => {
    // 300s in wrap-up. With a 30s window (+60s grace) it is an overrun; with a
    // 3600s window it is not, and the same payload must render differently.
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ agents: [wrappingAgent()] }));

    mocks.getAgencyCampaign.mockResolvedValue(campaign({ wrapup_seconds: 30 }));
    renderPage('agents');
    await screen.findByRole('heading', { name: 'Collections' });
    expect(screen.getByTestId('floor-row-wrap-sess').getAttribute('data-risk')).toBe('wrapup_overrun');

    cleanup();
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ wrapup_seconds: 3600 }));
    renderPage('agents');
    await screen.findByRole('heading', { name: 'Collections' });
    expect(screen.getByTestId('floor-row-wrap-sess').getAttribute('data-risk')).toBe('none');
  });

  it('says the roster didn’t load rather than showing an empty floor', async () => {
    // The pre-MAG-148 wire: `agents_live` and no `agents`. Rendering that as
    // "nobody is on this campaign" would be a claim about staffing drawn from
    // our own ignorance.
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ agents: undefined, agents_live: 4 }));

    renderPage('agents');
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByTestId('floor-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('floor-empty')).toBeNull();
  });

  it('re-reads the campaign after a forced return', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'tenant_owner' });
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ agents: [wrappingAgent()] }));

    renderPage('agents');
    await screen.findByRole('heading', { name: 'Collections' });
    const before = mocks.getAgencyCampaignStats.mock.calls.length;

    fireEvent.click(screen.getByTestId('floor-row-wrap-sess'));
    fireEvent.click(screen.getByTestId('force-available-button'));
    fireEvent.click(screen.getByRole('button', { name: 'End wrap-up and return' }));

    await waitFor(() => expect(mocks.forceAgentAvailable).toHaveBeenCalledWith(
      'wrap-sess', '', 'tenant-1', 'account-1',
    ));
    // The floor a supervisor is left looking at must reflect the action they
    // just took, not the snapshot they took it from.
    await waitFor(() => expect(mocks.getAgencyCampaignStats.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('campaign detail — permissions (MAG-136: agency.supervise)', () => {
  /**
   * Asserted here rather than left to master's 403.
   *
   * The controls check `agency.supervise` (floored at `account_admin`), which is
   * what master's four lifecycle proxies now gate on. Two roles below that floor
   * are worth pinning by name: an `agent` — the Agency Dialer role, deliberately
   * BELOW `viewer` — and a `viewer`. Neither may see a control, and neither may
   * invoke one, because a button that 403s on click is a worse answer than no
   * button.
   */
  it.each(['agent', 'viewer'])('%s can neither see nor invoke a lifecycle control', async (role) => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role });

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    for (const label of ['Start dialing', 'Pause', 'Resume', 'Stop']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    // Not merely hidden: nothing on the page can reach the transition API.
    expect(mocks.transitionAgencyCampaign).not.toHaveBeenCalled();
    // The counters and the strip are still readable — supervising without
    // controlling is the point of the read-only view.
    expect(screen.getByTestId('total-contacts')).toBeTruthy();
    expect(screen.getByTestId('concurrency-readout')).toBeTruthy();
  });

  it('an operator is now below the floor too — the gate moved off proxy.schedules.write', async () => {
    // `operator` used to hold `proxy.schedules.write` and so used to see all
    // four controls. MAG-136 made the lifecycle supervisory; master matched.
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'operator',
    });

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('an account_admin — the floor itself — does get them', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'account_admin',
    });

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  /**
   * ── The floor's control uses the SAME permission (MAG-148 / MAG-142) ───────
   *
   * `AgentFloor` takes `canSupervise` as a prop, so its own tests can only prove
   * the component honours whatever it is handed. What is proved HERE is that the
   * page hands it `hasPermission(role, 'agency.supervise')` — the thing master
   * actually gates `POST /proxy/agency/sessions/:id/force-available` on. Passing
   * a looser check (or a literal `true`) would compile, render, and 403 on click
   * for exactly the role that must never reach it.
   */
  it.each(['agent', 'viewer', 'operator'])(
    '%s cannot reach the force-return control on a wrap-up session',
    async (role) => {
      mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role });
      mocks.getAgencyCampaignStats.mockResolvedValue(stats({ agents: [wrappingAgent()] }));

      renderPage('agents');
      await screen.findByRole('heading', { name: 'Collections' });

      fireEvent.click(screen.getByTestId('floor-row-wrap-sess'));
      expect(screen.queryByTestId('force-available-button')).toBeNull();
      expect(mocks.forceAgentAvailable).not.toHaveBeenCalled();
      // The floor itself is still readable — supervising without controlling.
      expect(screen.getByTestId('agent-drawer-facts')).toBeTruthy();
    },
  );

  it('an account_admin — the floor of agency.supervise — does reach it', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'account_admin',
    });
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ agents: [wrappingAgent()] }));

    renderPage('agents');
    await screen.findByRole('heading', { name: 'Collections' });

    fireEvent.click(screen.getByTestId('floor-row-wrap-sess'));
    expect(screen.getByTestId('force-available-button')).toBeTruthy();
  });

  it('links to the station WITH the campaign id, which the console requires', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    const link = screen.getByRole('link', { name: /join as agent/i });
    // A bare `/station` lands on "No campaign selected." — the earlier revision
    // of the sidebar shipped exactly that.
    expect(link.getAttribute('href')).toBe('/station?campaign=camp-1');
  });
});

/**
 * ── The staffing panel (`MAG-160`) ─────────────────────────────────────────
 *
 * Master floors all four assignment routes on `agency.supervise`, so the panel's
 * very first request 403s for anyone below it. That makes the gate a property of
 * the page — the component takes `canSupervise` as a prop and can only prove it
 * honours what it is handed — and the same rule `AgentFloor`'s props comment
 * states: the UI gate has to BE the API gate.
 */
describe('campaign detail — assigned agents', () => {
  it.each(['agent', 'viewer', 'operator'])(
    '%s sees no staffing panel and issues no assignment read',
    async (role) => {
      mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role });

      renderPage('agents');
      await screen.findByRole('heading', { name: 'Collections' });

      expect(screen.queryByRole('heading', { name: 'Assigned agents' })).toBeNull();
      // Not merely hidden: nothing on the page reaches a route they'd 403 on.
      expect(mocks.listCampaignAgents).not.toHaveBeenCalled();
      /**
       * ── And that includes the member list ──────────────────────────────────
       *
       * The panel picks assignees out of `useTeam()`, and hooks cannot be called
       * conditionally — so with the permission gate INSIDE the component this
       * fired `GET /tenants/:id/members` for every viewer, operator and agent
       * who opened a campaign page: a 403 on every page view, silent because
       * nothing reads the hook's error. The first version of this test asserted
       * "nothing reaches the route they'd 403 on" while `vi.mock`ing the hook
       * that was doing exactly that.
       */
      await waitFor(() => expect(mocks.listTenantMembers).not.toHaveBeenCalled());
    },
  );

  it('an account_admin — the floor of agency.supervise — gets it, and it reads the roster of people', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'account_admin',
    });
    mocks.listCampaignAgents.mockResolvedValue({
      agents: [
        {
          user_id: 'usr-1',
          name: 'Ravi',
          email: 'ravi@example.com',
          role: 'agent',
          assigned_at: '2026-08-01T09:00:00.000Z',
        },
      ],
    });

    renderPage('agents');
    await screen.findByRole('heading', { name: 'Assigned agents' });

    await waitFor(() => expect(screen.getByText('Ravi')).toBeTruthy());
    expect(mocks.listCampaignAgents).toHaveBeenCalledWith('camp-1', 'tenant-1', 'account-1');
    // Distinct from the live floor immediately above it: this one names a person
    // who may not be signed in at all.
    expect(screen.getByRole('button', { name: /remove ravi/i })).toBeTruthy();
  });

  it('assigns the picked member and re-reads, rather than patching the list locally', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'tenant_owner',
    });
    mocks.listTenantMembers.mockResolvedValue([
      {
        membership: { id: 'm-1', role: 'agent' },
        user: { id: 'usr-2', display_name: 'Priya', email: 'priya@example.com' },
      },
    ]);
    mocks.assignAgent.mockResolvedValue({
      user_id: 'usr-2',
      campaign_id: 'camp-1',
      assigned_at: '2026-08-16T10:00:00.000Z',
    });

    renderPage('agents');
    await screen.findByRole('heading', { name: 'Assigned agents' });
    // A supervisor DOES read the member list — the gate is on the permission,
    // not on the panel being invisible.
    await waitFor(() => expect(mocks.listTenantMembers).toHaveBeenCalledWith('tenant-1'));

    fireEvent.change(screen.getByLabelText('Add someone'), { target: { value: 'usr-2' } });
    fireEvent.click(screen.getByRole('button', { name: /^assign$/i }));

    await waitFor(() =>
      expect(mocks.assignAgent).toHaveBeenCalledWith('camp-1', 'usr-2', 'tenant-1', 'account-1'),
    );
    // The server owns the 1:1 rule (a move, not a duplicate), so the panel asks
    // it what the list is now instead of assuming its own write landed as sent.
    await waitFor(() => expect(mocks.listCampaignAgents).toHaveBeenCalledTimes(2));
  });
});

/**
 * ── Assigned here, but not AT a station here (`MAG-160`) ────────────────────
 *
 * Reassignment deliberately does not touch live sessions: master moves its own
 * row, and core refuses the agent's next join here until they leave their old
 * station. So a moved agent appears on this list immediately while still working
 * somewhere else, and a supervisor reading a name with no tile on the floor has
 * no way to tell "hasn't started yet" from "is stuck elsewhere" unless the list
 * says so. The live rows come from the stats payload the floor already has —
 * a prop, not a second fetch.
 */
describe('campaign detail — the not-yet-joined signal', () => {
  const assigned = (userId: string, name: string) => ({
    user_id: userId,
    name,
    email: `${name.toLowerCase()}@example.com`,
    role: 'agent',
    assigned_at: '2026-08-01T09:00:00.000Z',
  });

  beforeEach(() => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'account_admin',
    });
  });

  it('marks an assigned agent with no live session here, and leaves the joined one alone', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ agents: [wrappingAgent()] }));
    mocks.listCampaignAgents.mockResolvedValue({
      agents: [assigned('usr_person', 'Ravi'), assigned('usr-2', 'Priya')],
    });

    renderPage('agents');
    await screen.findByRole('heading', { name: 'Assigned agents' });

    // `wrappingAgent()` is `usr_person`, live on this campaign.
    await waitFor(() => expect(screen.getByTestId('not-joined-usr-2')).toBeTruthy());
    expect(screen.queryByTestId('not-joined-usr_person')).toBeNull();
  });

  it('claims nothing when the floor is unknown', async () => {
    // No per-agent rows is NOT an empty floor — core may not have produced them,
    // or the stats read failed. Marking everyone absent on the strength of a
    // payload we never received would put a warning against every name here.
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ agents: undefined }));
    mocks.listCampaignAgents.mockResolvedValue({ agents: [assigned('usr-2', 'Priya')] });

    renderPage('agents');
    await screen.findByRole('heading', { name: 'Assigned agents' });
    await waitFor(() => expect(screen.getByText('Priya')).toBeTruthy());

    expect(screen.queryByTestId('not-joined-usr-2')).toBeNull();
  });
});

/**
 * ── The campaign's own clock (`MAG-167`) ────────────────────────────────────
 *
 * The header used to carry one meta line — "Updated 10:23" — which is when this
 * SCREEN last read the server, not anything about the campaign. A supervisor
 * opening a stopped campaign had no answer on the page to when it started, how
 * long it ran, or who stopped it; the last of those is the question an
 * abandonment auto-pause is opened with.
 *
 * Every one of these facts is optional on the wire, and the rule throughout is
 * that an absent one is OMITTED. A dash here would read as a failed read, and
 * on a campaign that genuinely never started it would read as a wrong one — so
 * the assertions below are on absence of the TEXT, never on a dash.
 */
describe('campaign detail — the header timeline', () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

  it('says when a live campaign started and how long it has been going', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ started_at: hoursAgo(6) }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    const line = screen.getByTestId('campaign-timeline');
    expect(line.textContent).toMatch(/^Started .+/);
    // Present tense, beside a live Pause button. "Ran for" here would
    // contradict the control directly above it.
    expect(line.textContent).toContain('Running for 6 hours');
    expect(line.textContent).not.toContain('Ran for');
  });

  it('keeps the refresh time as its own, separate line', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ started_at: hoursAgo(6) }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    // Two different facts — when this screen last read the server, and when the
    // campaign started. One line answering both is how the first is read as the
    // second.
    expect(screen.getByTestId('campaign-timeline').textContent).not.toMatch(/Updated/);
    expect(screen.getByText(/Updated .*Auto-refreshing/i)).toBeTruthy();
  });

  it('omits the whole line when the campaign carries no start, rather than dashing it', async () => {
    // An older master. The campaign did not fail to start — we were not told.
    mocks.getAgencyCampaign.mockResolvedValue(campaign());

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.queryByTestId('campaign-timeline')).toBeNull();
    expect(screen.queryByText(/Started /)).toBeNull();
    expect(screen.queryByText(/Running for/)).toBeNull();
    expect(screen.queryByText(/Ran for/)).toBeNull();
  });

  it('closes the clock in the past tense once the campaign is terminal', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({
      status: 'stopped',
      started_at: hoursAgo(30),
      ended_at: hoursAgo(6),
    }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByTestId('campaign-timeline').textContent).toContain('Ran for 1 day');
    expect(screen.getByTestId('campaign-timeline').textContent).not.toContain('Running for');
  });
});

/**
 * ── "How it ended" ─────────────────────────────────────────────────────────
 *
 * The rail's terminal block. Above "How it ran" on purpose: when it ended and
 * who ended it is the first question on a stopped campaign, and the calling
 * window below is context for that answer.
 */
describe('campaign detail — how it ended', () => {
  const stoppedCampaign = (over: Partial<AgencyCampaign> = {}) => campaign({
    status: 'stopped',
    started_at: new Date(Date.now() - 30 * 3_600_000).toISOString(),
    ended_at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    ...over,
  });

  it('names who stopped it, and how long it ran', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(stoppedCampaign({
      last_transition_by: { user_id: 'usr-1', name: 'Priya Sharma' },
    }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    const block = screen.getByTestId('how-it-ended');
    expect(block.textContent).toContain('Stopped by');
    expect(block.textContent).toContain('Priya Sharma');
    expect(block.textContent).toContain('Ran for');
  });

  it('says the dialer stopped it when nobody did', async () => {
    /*
      `null` is core saying the transition had no human behind it — the
      abandonment auto-pause. On a campaign that stopped itself this is the
      single most useful sentence on the page, so it is said rather than
      dropped, and never left as an unattributed dash.
    */
    mocks.getAgencyCampaign.mockResolvedValue(stoppedCampaign({ last_transition_by: null }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByTestId('how-it-ended').textContent).toContain('Automatically');
  });

  it('reports the busiest the floor ever got, which the live floor cannot', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(stoppedCampaign());
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ agents_peak: 4 }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    const block = screen.getByTestId('how-it-ended');
    expect(block.textContent).toContain('Agents who worked it');
    expect(block.textContent).toContain('4');
  });

  it('skips the block entirely when none of the fields arrived', async () => {
    // An older master carries none of the three, and the stats payload no peak.
    // A heading over an empty list is worse than no heading: it says the
    // campaign ended in a way nobody recorded.
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'stopped' }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.queryByTestId('how-it-ended')).toBeNull();
    // The rest of the rail is unaffected — the guardrails still render.
    expect(screen.getByTestId('concurrency-readout')).toBeTruthy();
  });

  it('never claims an ending on a campaign that is still running', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({
      started_at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
      last_transition_by: { user_id: 'usr-1', name: 'Priya Sharma' },
    }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.queryByTestId('how-it-ended')).toBeNull();
  });
});

/**
 * ── The time dimension on Overview ─────────────────────────────────────────
 *
 * The panel's answer to "is it dialing" — every counter beside it is a lifetime
 * total and cannot tell a campaign that has been going all week from one that
 * woke up an hour ago. It is a section of Overview only: Performance asks a
 * different question of the same endpoint, and Agents asks none of it.
 */
describe('campaign detail — the dialing activity section', () => {
  it('renders on the Overview panel and reads the campaign it is on', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByTestId('campaign-series-activity')).toBeTruthy();
    await waitFor(() => expect(mocks.getAgencyCampaignSeries).toHaveBeenCalled());
    const [campaignId, query, tenantId, accountId] =
      mocks.getAgencyCampaignSeries.mock.calls[0]!;
    expect([campaignId, tenantId, accountId]).toEqual(['camp-1', 'tenant-1', 'account-1']);
    expect((query as { bucket: string }).bucket).toBe('day');
  });

  it('is not mounted on the other two sections', async () => {
    renderPage('performance');
    await screen.findByRole('heading', { name: 'Collections' });
    expect(screen.queryByTestId('campaign-series-activity')).toBeNull();

    cleanup();

    renderPage('agents');
    await screen.findByRole('heading', { name: 'Collections' });
    expect(screen.queryByTestId('campaign-series-activity')).toBeNull();
  });
});

/**
 * ── The rate trend on Performance ──────────────────────────────────────────
 *
 * A sibling of `CampaignPerformance`, not a section inside it. That component
 * has a second caller — `AgencyAnalyticsPage` renders it once per campaign down
 * a list — so a fetch inside it would be one series request per row on a page
 * that never asked the question. The screen that wants the trend mounts it.
 */
describe('campaign detail — the rate trend section', () => {
  it('renders on the Performance panel, exactly once', async () => {
    renderPage('performance');
    await screen.findByRole('heading', { name: 'Collections' });

    /*
      `getByTestId` throws on a second match, which is the assertion that
      matters here: two mounts would be two requests for one answer, and the
      pair could disagree the moment their range pickers diverged.
    */
    expect(screen.getByTestId('campaign-series-rates')).toBeTruthy();
  });

  it('asks the same endpoint for the same campaign, by day', async () => {
    renderPage('performance');
    await screen.findByRole('heading', { name: 'Collections' });

    await waitFor(() => expect(mocks.getAgencyCampaignSeries).toHaveBeenCalled());
    const [campaignId, query, tenantId, accountId] =
      mocks.getAgencyCampaignSeries.mock.calls[0]!;
    expect([campaignId, tenantId, accountId]).toEqual(['camp-1', 'tenant-1', 'account-1']);
    expect((query as { bucket: string }).bucket).toBe('day');
  });

  it('is not on Overview, where the activity chart asks the other question', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    // Two charts off one endpoint: "is it dialing" belongs to Overview, "are
    // the rates holding" to Performance. Both on one panel would be the same
    // data drawn twice.
    expect(screen.queryByTestId('campaign-series-rates')).toBeNull();
    expect(screen.getByTestId('campaign-series-activity')).toBeTruthy();
  });
});

/**
 * The contact funnel, at the page level.
 *
 * `contactFunnel`'s own suite pins the arithmetic. What only a rendered page can
 * check is the two things the panel asserts around it: that the KEY holds as
 * many tracks as it has cells, and that the sentences beside it agree with the
 * status badge above them. Review caught both of these here after the util
 * tests were all green.
 */
describe('campaign detail — the contact funnel', () => {
  /** The five counters sum to the total: no remainder, so no sixth state. */
  const reconciling = () => stats({
    contacts_total: 1000,
    contacts_pending: 400,
    contacts_in_flight: 3,
    contacts_completed: 550,
    contacts_suppressed: 20,
    contacts_exhausted: 27,
  });

  /** Three contacts short of the total — the production shape, bridged agents. */
  const withOnCall = () => stats({ ...reconciling(), contacts_pending: 397 });

  it('lists five states and asks for five tracks when nothing is on a call', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(reconciling());

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    const key = await screen.findByTestId('contact-funnel-key');
    expect(key.getAttribute('data-count')).toBe('5');
    expect(screen.queryByTestId('contact-state-contacts_on_call')).toBeNull();
  });

  it('lists the sixth state and asks for six tracks when contacts are on a call', async () => {
    /*
      The layout defect review caught, on the exact campaign this branch was
      written from.

      `.funnelKey` was a hard `grid-template-columns: repeat(5, …)` with a
      comment saying that a state wrapping onto its own row is the failure five
      explicit tracks exist to prevent. A sixth cell in five tracks is that
      failure: five on row one and Exhausted alone on row two at a fifth of the
      width. Nothing in the util suite could see it, and nothing in this file
      looked at the funnel at all.

      The count is asserted rather than the resolved CSS because happy-dom
      computes no grid — the contract is that the page tells the stylesheet how
      many cells there are, and the stylesheet has a rule for each count.
    */
    mocks.getAgencyCampaignStats.mockResolvedValue(withOnCall());

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    const key = await screen.findByTestId('contact-funnel-key');
    expect(key.getAttribute('data-count')).toBe('6');
    expect(screen.getByTestId('contact-state-contacts_on_call')).toBeTruthy();
    // And every cell is still one cell — no stray wrapper inside the grid.
    expect(key.children.length).toBe(6);
  });

  it('has a track rule for every cell count the funnel can produce', async () => {
    /*
      The guard, rather than one more fix.

      `data-count` above is only half a contract: the page can say `6` and the
      stylesheet still has to have a rule for it. A hard `repeat(5, …)` was
      correct until `contactFunnel` grew a sixth state, and adding a seventh
      would break it again just as quietly — happy-dom computes no grid, so no
      rendering test can see a wrapped row.

      So this reads the stylesheet and requires a rule per reachable count. The
      counts come from `CONTACT_FUNNEL_STATES`: every state can be listed, and
      "On a call" is the one that drops out when it has nothing to say.
    */
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { CONTACT_FUNNEL_STATES } = await import('../../utils/agencyCampaignOverview');

    const css = readFileSync(
      resolve(process.cwd(), 'src/pages/agency/AgencyCampaignDetailPage.module.css'), 'utf8',
    );
    const all = CONTACT_FUNNEL_STATES.length;

    // The base rule carries the count with every state but "On a call".
    expect(css).toMatch(
      new RegExp(`\\.funnelKey \\{[^}]*grid-template-columns: repeat\\(${all - 1},`),
    );
    // And an explicit rule carries the full set.
    expect(css).toMatch(
      new RegExp(`\\.funnelKey\\[data-count='${all}'\\] \\{[^}]*repeat\\(${all},`),
    );
  });

  it('does not tell a completed campaign that it stopped', async () => {
    /*
      Two sentences, one badge. `terminal` is true for `completed` as well as
      `stopped`, so both the panel's caption and the stuck note read "stopped"
      under a badge saying **Completed** — the conflation `howItEndedLines` and
      `campaignTimeline` exist to keep apart, on a new surface.
    */
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'completed' }));
    mocks.getAgencyCampaignStats.mockResolvedValue(withOnCall());

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });
    await screen.findByTestId('contact-funnel-key');

    const panel = screen.getByLabelText('Where the contacts finished');
    expect(panel.textContent).toMatch(/3 contacts are still marked as being on a call/);
    expect(panel.textContent).not.toMatch(/stopp/i);
  });

  it('names the stop on a campaign that was stopped', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'stopped' }));
    mocks.getAgencyCampaignStats.mockResolvedValue(withOnCall());

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });
    await screen.findByTestId('contact-funnel-key');

    const panel = screen.getByLabelText('Where the contacts finished');
    expect(panel.textContent).toMatch(/on a campaign that was stopped/);
    // The claim it may not make: this page reads a derived remainder, not
    // whether any call is actually still up.
    expect(panel.textContent).not.toMatch(/calls (themselves )?have ended/i);
  });
});

/**
 * ── The lineage strip (retry campaigns, slice S4) ──────────────────────────
 *
 * It lives in the HEADER, not in an eighth tab: `agencyCampaignTabs.ts`'s own
 * rule is that the header holds what CHANGES the campaign and each tab answers
 * one question, and "this is Retry 1 of something else" is neither — it is
 * navigation, and it is the fact a supervisor needs before reading any number
 * on the page.
 */
function lineage(entries: Array<Record<string, unknown>>) {
  return { root_campaign_id: 'camp-root', campaigns: entries };
}

function root(over: Record<string, unknown> = {}) {
  return {
    id: 'camp-root',
    name: 'Q3 Winback',
    status: 'completed',
    retry_generation: 0,
    parent_campaign_id: null,
    contacts_total: 4000,
    created_at: '2026-07-01T09:00:00.000Z',
    started_at: '2026-07-01T10:00:00.000Z',
    ended_at: '2026-07-20T18:00:00.000Z',
    ...over,
  };
}

describe('the campaign header names the retry chain', () => {
  it('renders nothing when the campaign is in no chain', async () => {
    // The route answers with the campaign itself rather than a 404, so this is
    // almost every campaign in the product and it must produce no strip at all.
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });
    expect(screen.queryByTestId('campaign-lineage')).toBeNull();
  });

  it('says "Retry 1 of Q3 Winback" on a child, and links the original', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(
      campaign({ id: 'camp-1', name: 'Q3 Winback — Retry 1', retry_generation: 1 }),
    );
    mocks.campaignLineage.mockResolvedValue(
      lineage([root(), root({ id: 'camp-1', name: 'Q3 Winback — Retry 1', retry_generation: 1 })]),
    );

    renderPage();
    const strip = await screen.findByTestId('campaign-lineage');
    expect(strip.textContent).toContain('Retry 1 of Q3 Winback');
    expect(within(strip).getByRole('link', { name: 'Original' }).getAttribute('href')).toBe(
      '/agency/campaigns/camp-root',
    );
    // Where you already are is a marker, not a link to itself.
    expect(within(strip).queryByRole('link', { name: 'Retry 1' })).toBeNull();
  });

  it('counts the retries below a parent, never the chain itself', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ id: 'camp-root', name: 'Q3 Winback' }));
    mocks.campaignLineage.mockResolvedValue(
      lineage([
        root({ id: 'camp-root' }),
        root({ id: 'camp-r1', retry_generation: 1 }),
        root({ id: 'camp-r2', retry_generation: 2 }),
      ]),
    );

    renderPage();
    const strip = await screen.findByTestId('campaign-lineage');
    // A parent is not one of its own retries.
    expect(strip.textContent).toContain('Retried 2 times');
    expect(within(strip).getByRole('link', { name: 'Retry 1' })).toBeTruthy();
    expect(within(strip).getByRole('link', { name: 'Retry 2' })).toBeTruthy();
  });

  it('leaves the campaign page intact when the lineage read fails', async () => {
    // A master that predates the route answers 404. Putting an error strip at
    // the top of every campaign in the product for the length of a deploy — over
    // a line that is empty for almost all of them — is worse than showing what
    // this build showed before the feature existed.
    mocks.campaignLineage.mockRejectedValue(new Error('not found'));
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });
    expect(screen.queryByTestId('campaign-lineage')).toBeNull();
    expect(screen.getByTestId('campaign-tab-overview')).toBeTruthy();
  });
});

describe('Retry contacts, from the campaign header', () => {
  it('opens the dialog on the default cohort and says it is a default', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    fireEvent.click(screen.getByTestId('campaign-retry-action'));

    // Contract §8: no answer, busy, and the ones nobody dialed. Everything else
    // is opt-in and reached by narrowing the Contacts tab first.
    await waitFor(() =>
      expect(mocks.retryPreview).toHaveBeenCalledWith(
        'camp-1',
        // One dimension carrying `__none__`, not two ANDed keys — see
        // `DEFAULT_RETRY_SELECTOR`. The pair matched no contact on any campaign.
        { last_outcome: ['no_answer', 'busy', '__none__'] },
        'tenant-1',
        'account-1',
      ),
    );
    expect(await screen.findByText(/This is the default selection/)).toBeTruthy();
  });

  it('warns that a running parent blocks the child from starting', async () => {
    // The campaign here is `running` by default, which is the case the unique
    // index refuses at Start.
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });
    fireEvent.click(screen.getByTestId('campaign-retry-action'));

    const note = await screen.findByTestId('retry-parent-running');
    expect(note.textContent).toMatch(/cannot be started/i);
  });

  it('is hidden from a role that cannot create a campaign', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1', accountId: 'account-1', role: 'operator',
    });
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });
    expect(screen.queryByTestId('campaign-retry-action')).toBeNull();
  });
});
