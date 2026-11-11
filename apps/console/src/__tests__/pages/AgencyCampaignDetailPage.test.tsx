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
  // The staffing panel — a second consumer of `api/agency` on this
  // page, and of the tenant member list it picks from.
  listCampaignAgents: vi.fn(),
  assignAgent: vi.fn(),
  unassignAgent: vi.fn(),
  // The REAL `useTeam` runs; only the request under it is mocked. Mocking the
  // hook hid the defect these tests are meant to catch — see below.
  listTenantMembers: vi.fn(),
  /*
    The Insights panel owns its own reads and fires them on mount. Mocked here
    rather than left to a real `fetch` — an unmocked one would make every test
    on this page depend on the network, and the panel's own behaviour is
    covered where it lives (`InsightsPanel.test.tsx`).
  */
  insights: {
    getInsightsSummary: vi.fn(),
    getInsightsAllocation: vi.fn(),
    getInsightsReadiness: vi.fn(),
    getInsightsUploads: vi.fn(),
    getInsightsActivity: vi.fn(),
    getInsightsTrends: vi.fn(),
    getInsightsHealth: vi.fn(),
  },
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
  // The contact-assignment flag, off unless a test turns it on, and the reads
  // behind it (dedicated caller IDs, contacts by agent).
  flag: vi.fn(),
  getAgentCallerIds: vi.fn(),
  getAssignmentProgress: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
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
vi.mock('../../api/agencyInsights', () => mocks.insights);
vi.mock('../../hooks/usePhoneNumbers', () => ({ usePhoneNumbers: mocks.usePhoneNumbers }));
vi.mock('../../hooks/useFeatureFlagEnabled', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useFeatureFlagEnabled')>()),
  useFeatureFlagEnabled: mocks.flag,
}));
vi.mock('../../api/agencyAssignment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/agencyAssignment')>()),
  getAgentCallerIds: mocks.getAgentCallerIds,
  getAssignmentProgress: mocks.getAssignmentProgress,
}));

import DetailPage from '../../pages/agency/AgencyCampaignDetailPage';
import { CampaignLandingRedirect } from '../../pages/agency/campaign-detail/CampaignLandingRedirect';
import * as insightsSamples from '../helpers/insights';
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
    // The supervisor payload. A healthy campaign by default: no stall,
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
    client_kind: 'web',
    on_inbound_call: false,
    can_take_inbound: true,
    ...over,
  };
}

/**
 * The page is five panels, each its own URL, and all mount the same component.
 * The campaign's own URL and the retired `…/performance` redirect, as in
 * `App.tsx`. Tests name the section they are about — the default is the one a
 * supervisor lands on. `path` opens any other URL (a redirect under test).
 */
function renderPage(section: 'overview' | 'calls' | 'agents' | 'callbacks' | 'health' = 'overview', path?: string) {
  return render(
    <MemoryRouter initialEntries={[path ?? `/agency/campaigns/camp-1/${section}`]}>
      <Routes>
        <Route path="/agency/campaigns/:id" element={<CampaignLandingRedirect />} />
        <Route path="/agency/campaigns/:id/performance" element={<CampaignLandingRedirect />} />
        <Route path="/agency/campaigns/:id/insights" element={<CampaignLandingRedirect />} />
        <Route path="/agency/campaigns/:id/overview" element={<DetailPage />} />
        <Route path="/agency/campaigns/:id/calls" element={<DetailPage />} />
        <Route path="/agency/campaigns/:id/agents" element={<DetailPage />} />
        <Route path="/agency/campaigns/:id/callbacks" element={<DetailPage />} />
        <Route path="/agency/campaigns/:id/health" element={<DetailPage />} />
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
  mocks.flag.mockReturnValue(false);
  mocks.getAgentCallerIds.mockResolvedValue({
    campaign_id: 'camp-1', caller_ids: [], dedicated: [], rotation: [], all_dedicated: false,
  });
  mocks.getAssignmentProgress.mockReturnValue(new Promise(() => {}));
  // The Insights reads answer with the reconciling samples; these tests are
  // about the shell around the panel, not the panel's figures.
  mocks.insights.getInsightsSummary.mockResolvedValue(insightsSamples.summary('running'));
  mocks.insights.getInsightsAllocation.mockResolvedValue(insightsSamples.allocation());
  mocks.insights.getInsightsReadiness.mockResolvedValue(insightsSamples.readiness());
  mocks.insights.getInsightsUploads.mockResolvedValue(insightsSamples.uploads());
  mocks.insights.getInsightsActivity.mockResolvedValue(insightsSamples.activity());
  mocks.insights.getInsightsTrends.mockResolvedValue(insightsSamples.trends());
  mocks.insights.getInsightsHealth.mockResolvedValue(insightsSamples.health());
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
    ['draft', ['Start dialling', 'Stop'], [], ['Pause', 'Resume']],
    ['running', ['Pause', 'Stop'], [], ['Start dialling', 'Resume']],
    ['paused', ['Resume', 'Stop'], [], ['Pause', 'Start dialling']],
    // `stopping` no longer hides the controls a supervisor reaches for.
    // The pacing leader still owns the final write — the buttons are refused,
    // with the reason on screen, rather than being absent and unexplained.
    ['stopping', [], ['Resume', 'Stop'], ['Start dialling', 'Pause']],
    ['stopped', [], [], ['Start dialling', 'Pause', 'Resume', 'Stop']],
    ['completed', [], [], ['Start dialling', 'Pause', 'Resume', 'Stop']],
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

  it('offers a productive next step on a terminal campaign', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'stopped' }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.queryByRole('link', { name: 'Add contacts' })).toBeNull();
    expect(screen.getByRole('link', { name: 'New campaign' }).getAttribute('href')).toBe(
      '/agency/campaigns/new',
    );
    // The floor still has its own section on a stopped campaign.
    expect(screen.getByTestId('campaign-tab-agents')).toBeTruthy();
  });

  it('offers Add contacts while dialing can continue', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByRole('link', { name: 'Add contacts' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New campaign' })).toBeNull();
  });
  /*
    History (decision IN14): the activity trail left the tab bar for the header,
    on its page's own gate (`audit.read`), not the lifecycle controls' one.
  */
  it('offers History in the header, opening the activity page, and no Activity tab', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    const history = screen.getByTestId('campaign-history-link');
    expect(history.textContent).toBe('History');
    expect(history.getAttribute('href')).toBe('/agency/campaigns/camp-1/activity');
    expect(history.getAttribute('aria-current')).toBeNull();
    expect(screen.queryByTestId('campaign-tab-activity')).toBeNull();
  });

  it('groups the tabs as Monitor, Data and Set up', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    const groups = screen.getAllByRole('group').filter((g) => g.closest('[data-testid="campaign-tabs"]'));
    expect(groups.map((g) => g.getAttribute('aria-labelledby') && document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent))
      .toEqual(['Monitor', 'Data', 'Set up']);
    expect(within(screen.getByTestId('campaign-tab-group-data')).getAllByRole('link').map((l) => l.textContent))
      .toEqual(['Contacts', 'Call log']);
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
   * Seen in production use: 7× `POST …/start` and 1× `POST …/resume` against campaigns
   * that were already live. The page already hides those buttons for the
   * status the view holds; these cases are the view being behind the server.
   */

  it('fires start only once when the button is clicked twice before the first paint', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));
    let release: ((value: AgencyCampaign) => void) | undefined;
    mocks.transitionAgencyCampaign.mockImplementation(
      () => new Promise<AgencyCampaign>((resolve) => { release = resolve; }),
    );

    renderPage();
    const start = await screen.findByRole('button', { name: 'Start dialling' });
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
    await screen.findByRole('button', { name: 'Start dialling' });

    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start dialling' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy());
    expect(mocks.transitionAgencyCampaign).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Start dialling' })).toBeNull();
    expect(mocks.showErrorToast).not.toHaveBeenCalled();
  });

  it('a stats outage on the preflight cannot send a stale Start', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));

    renderPage();
    await screen.findByRole('button', { name: 'Start dialling' });

    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));
    mocks.getAgencyCampaignStats.mockRejectedValue(new Error('stats unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Start dialling' }));

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
    await screen.findByRole('button', { name: 'Start dialling' });
    mocks.getAgencyCampaignStats.mockRejectedValue(new Error('stats unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Start dialling' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy());
    expect(mocks.transitionAgencyCampaign).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Start dialling' })).toBeNull();
    expect(mocks.showErrorToast).not.toHaveBeenCalled();
  });

  it('still surfaces a 409 that did not move this campaign — the roster gate', async () => {
    // Another running campaign on the account is no longer a refusal (decisions MC6);
    // an empty roster still is, and the campaign stays a draft with Start offered.
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));
    mocks.transitionAgencyCampaign.mockRejectedValue(
      new ApiError(409, {
        error: 'No Contacts',
        code: 'campaign_roster_empty',
        message: 'This campaign has no contacts. Upload a contact roster before starting it.',
      }),
    );

    renderPage();
    await screen.findByRole('button', { name: 'Start dialling' });
    fireEvent.click(screen.getByRole('button', { name: 'Start dialling' }));

    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Start dialling' })).toBeTruthy();
  });

  it.each([
    ['resume', 'paused', 'Resume', 409, 'telephony_credential_not_active', /carrier account is not active.*Contact support to have it re-enabled/],
    ['start', 'draft', 'Start dialling', 404, 'telephony_credential_not_found', /carrier account no longer exists/],
  ] as const)('says what to do when %s is refused for the campaign’s carrier account', async (
    _action, status, button, statusCode, code, copy,
  ) => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status }));
    mocks.transitionAgencyCampaign.mockRejectedValue(
      new ApiError(statusCode, { error: 'Conflict', code, message: 'server words' }),
    );

    renderPage();
    await screen.findByRole('button', { name: button });
    fireEvent.click(screen.getByRole('button', { name: button }));

    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalled());
    const [shown] = mocks.showErrorToast.mock.calls[0]!;
    expect((shown as Error).message).toMatch(copy);
    // The campaign has not moved, so the control stays offered.
    expect(screen.getByRole('button', { name: button })).toBeTruthy();
  });

  it('re-reads a draft campaign when the window is focused, so Start can disappear', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));

    renderPage();
    await screen.findByRole('button', { name: 'Start dialling' });

    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Start dialling' })).toBeNull();
  });

  it('re-reads on window focus as well as visibilitychange — two windows both stay visible', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));

    renderPage();
    await screen.findByRole('button', { name: 'Start dialling' });

    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Start dialling' })).toBeNull();
  });

  it('an in-flight visibility GET cannot paint a draft over a start that already succeeded', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'draft' }));
    mocks.getAgencyCampaignStats.mockResolvedValue(stats());

    renderPage();
    await screen.findByRole('button', { name: 'Start dialling' });

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
    fireEvent.click(screen.getByRole('button', { name: 'Start dialling' }));
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
    expect(screen.queryByRole('button', { name: 'Start dialling' })).toBeNull();
  });
});

describe('campaign detail — landmarks and the refresh stamp', () => {
  it('uses one page landmark and labels the Insights panel as a region', async () => {
    const { container } = renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(container.querySelectorAll('main')).toHaveLength(0);
    expect(await screen.findByRole('region', { name: 'Campaign insights' })).toBeTruthy();
  });

  it('keeps the shell’s refresh timestamp quiet for screen readers', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    // Case-sensitive: the shell says "Auto-refreshing", the Insights stamp
    // "auto-refreshing". Neither stamp is a live region; Insights announces
    // only a Refresh the reader asked for.
    const timestamp = screen.getByText(/Updated .*Auto-refreshing/);
    expect(timestamp.getAttribute('aria-live')).toBeNull();
  });
});

/**
 * ── The page is sections now ───────────────────────────────────
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
  it('lands a supervisor on Overview, from the campaign’s own URL and the retired Performance and Insights URLs', async () => {
    for (const path of ['/agency/campaigns/camp-1', '/agency/campaigns/camp-1/performance', '/agency/campaigns/camp-1/insights']) {
      cleanup();
      renderPage('overview', path);
      await screen.findByRole('heading', { name: 'Collections' });
      expect((await screen.findByTestId('insights-panel')).getAttribute('data-view')).toBe('overview');
      expect(screen.getByTestId('campaign-tab-overview').getAttribute('aria-current')).toBe('page');
    }
  });

  it.each(['viewer', 'operator'])(
    'lands a %s, who cannot read Insights, on the Agents panel rather than a page of 403s',
    async (role) => {
      mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role });
      mocks.getAgencyCampaignStats.mockResolvedValue(stats({ agents: [wrappingAgent()] }));
      for (const path of ['/agency/campaigns/camp-1', '/agency/campaigns/camp-1/insights', '/agency/campaigns/camp-1/calls']) {
        cleanup();
        renderPage('overview', path);
        await screen.findByRole('heading', { name: 'Collections' });
        expect(await screen.findByTestId('floor-row-wrap-sess')).toBeTruthy();
        expect(screen.queryByTestId('insights-panel')).toBeNull();
        expect(screen.queryByTestId('campaign-tab-overview')).toBeNull();
        expect(screen.getByTestId('campaign-tab-agents').getAttribute('aria-current')).toBe('page');
      }
      expect(mocks.insights.getInsightsSummary).not.toHaveBeenCalled();
    },
  );

  it('keeps the shell — name, controls, health strip — on every tab of the page', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(
      stats({ stall: { code: 'dnc_unavailable', tenant_wide: true }, other_stalls: [] }),
    );
    for (const section of ['overview', 'calls', 'agents', 'callbacks', 'health'] as const) {
      cleanup();
      renderPage(section);
      await screen.findByRole('heading', { name: 'Collections' });
      expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
      expect(screen.getByRole('link', { name: /join as agent/i })).toBeTruthy();
      expect(await screen.findByTestId('health-strip-diagnosis')).toBeTruthy();
    }
  });

  it('shows the floor only on Agents, with the agents’ performance beneath it for a supervisor', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ agents: [wrappingAgent()] }));
    renderPage();
    await screen.findByTestId('insights-panel');
    expect(screen.queryByTestId('floor-row-wrap-sess')).toBeNull();

    cleanup();
    renderPage('agents');
    await screen.findByRole('heading', { name: 'Collections' });
    expect(screen.getByTestId('floor-row-wrap-sess')).toBeTruthy();
    const panel = await screen.findByTestId('insights-panel');
    expect(panel.getAttribute('data-view')).toBe('agents');
    // The Overview's own parts stay on Overview.
    expect(screen.queryByTestId('overview-kpis')).toBeNull();
    expect(await screen.findByTestId('insights-agents')).toBeTruthy();
  });

  it('shows each analytic tab its own sections and none of the others’', async () => {
    const own: Record<string, string> = {
      overview: 'overview-kpis',
      calls: 'insights-calls',
      callbacks: 'insights-callbacks',
      health: 'insights-health',
    };
    for (const [section, testId] of Object.entries(own)) {
      cleanup();
      renderPage(section as 'overview');
      expect(await screen.findByTestId(testId)).toBeTruthy();
      for (const [other, otherId] of Object.entries(own)) {
        if (other !== section) expect(screen.queryByTestId(otherId)).toBeNull();
      }
    }
  });

  it('does not read the staffing routes until the Agents section is opened', async () => {
    // Both reads 403 below `agency.supervise` and neither answers a question
    // Overview asks, so a campaign page view should not spend them.
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    await waitFor(() => expect(mocks.listCampaignAgents).not.toHaveBeenCalled());
    expect(mocks.listTenantMembers).not.toHaveBeenCalled();
  });

  it('offers only the sections the role can actually reach', async () => {
    // An `agent` is below both `agency.supervise` and `audit.read`. A tab that
    // renders and then 403s on arrival is a worse answer than no tab.
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'agent' });

    renderPage('agents');
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByTestId('campaign-tab-agents')).toBeTruthy();
    for (const id of ['overview', 'calls', 'callbacks', 'health', 'contacts', 'attempts', 'activity', 'settings']) {
      expect(screen.queryByTestId(`campaign-tab-${id}`)).toBeNull();
    }
  });

  it('puts Overview first in the bar for a supervisor, then a tab per question, with no Insights or Performance', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });
    const tabs = within(screen.getByTestId('campaign-tabs')).getAllByRole('link');
    expect(tabs.slice(0, 5).map((t) => t.getAttribute('data-testid'))).toEqual(
      ['overview', 'calls', 'agents', 'callbacks', 'health'].map((id) => `campaign-tab-${id}`),
    );
    expect(tabs[0]?.textContent).toBe('Overview');
    expect(screen.queryByTestId('campaign-tab-insights')).toBeNull();
    expect(screen.queryByTestId('campaign-tab-performance')).toBeNull();
  });

  it('keeps the range when moving between the analytic tabs, and drops it for the other screens', async () => {
    renderPage('overview', '/agency/campaigns/camp-1/calls?range=today');
    await screen.findByRole('heading', { name: 'Collections' });
    expect(screen.getByTestId('campaign-tab-callbacks').getAttribute('href')).toBe('/agency/campaigns/camp-1/callbacks?range=today');
    expect(screen.getByTestId('campaign-tab-contacts').getAttribute('href')).toBe('/agency/campaigns/camp-1/contacts');
  });

  it('badges the Callbacks tab with the callbacks overdue now, and nothing when there are none', async () => {
    const withOverdue = insightsSamples.allocation();
    withOverdue.totals.callbacks_overdue = 7;
    mocks.insights.getInsightsAllocation.mockResolvedValue(withOverdue);
    renderPage();
    const badge = await screen.findByTestId('campaign-tab-callbacks-alert');
    expect(badge.textContent).toBe('7, 7 overdue');

    cleanup();
    const none = insightsSamples.allocation();
    none.totals.callbacks_overdue = 0;
    mocks.insights.getInsightsAllocation.mockResolvedValue(none);
    renderPage();
    await screen.findByTestId('overview-kpis');
    await waitFor(() => expect(mocks.insights.getInsightsAllocation).toHaveBeenCalled());
    expect(screen.queryByTestId('campaign-tab-callbacks-alert')).toBeNull();
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
    // No per-agent rows is NOT an empty floor — the server may not have produced them,
    // or the read failed. A `0` here would be a claim drawn from our ignorance.
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ agents: undefined, agents_live: 4 }));
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });
    expect(screen.queryByTestId('campaign-tab-agents-count')).toBeNull();
  });

  it('re-reads every section of the tab when the shell’s Refresh is pressed', async () => {
    renderPage('calls');
    await screen.findByTestId('insights-panel');
    await waitFor(() => expect(mocks.insights.getInsightsActivity).toHaveBeenCalledTimes(1));

    // The shell's own control (the Insights toolbar has "Refresh insights").
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mocks.insights.getInsightsActivity).toHaveBeenCalledTimes(2));
    expect(mocks.insights.getInsightsSummary).toHaveBeenCalledTimes(2);
    expect(mocks.insights.getInsightsTrends).toHaveBeenCalledTimes(2);
  });
});

describe('campaign detail — the health strip', () => {
  it('renders NOTHING when the campaign is not stalled', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    // Not an "all good" banner. A banner that is present when everything is fine
    // trains a supervisor to skim past the one place a real diagnosis appears.
    expect(screen.queryByTestId('health-strip-diagnosis')).toBeNull();
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
        // it itself — relying on the server's ordering means a producer-side reorder
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
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Collections' })).toBeTruthy());
    const afterLoad = mocks.getAgencyCampaignStats.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mocks.getAgencyCampaignStats.mock.calls.length).toBeGreaterThan(afterLoad);
  });

  it('stops polling once a paused campaign has drained', async () => {
    vi.useFakeTimers();
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'paused' }));
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ attempts_live: 0, agents_live: 0 }));

    renderPage();
    // Wait for the counters to be RENDERED, not merely requested. The poll
    // predicate reads `stats.attempts_live`, so a wait that only proves the
    // request was made can advance the clock before the state that enables
    // polling exists — and then assert the absence of a poll it prevented.
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Collections' })).toBeTruthy());
    const afterLoad = mocks.getAgencyCampaignStats.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    // Nothing is moving; a request every ten seconds could only confirm what is
    // already on screen.
    expect(mocks.getAgencyCampaignStats.mock.calls.length).toBe(afterLoad);
  });

  /**
   * `agents` is optional on the wire. A payload without the roster still says
   * how many are on the floor through `agents_live`, and their state changes
   * whether or not this payload lists them.
   */
  it('keeps polling a drained paused campaign while agents_live says someone is on the floor', async () => {
    vi.useFakeTimers();
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'paused' }));
    mocks.getAgencyCampaignStats.mockResolvedValue(
      stats({ attempts_live: 0, agents: undefined, agents_live: 2 }),
    );

    renderPage();
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Collections' })).toBeTruthy());
    const afterLoad = mocks.getAgencyCampaignStats.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(mocks.getAgencyCampaignStats.mock.calls.length).toBeGreaterThan(afterLoad);
  });
});

describe('campaign detail — polling is visible-only and single-flight', () => {
  /**
   * The campaigns home checked both; this page polled a hidden tab every ten
   * seconds and stacked a new load on top of one a slow backend had not
   * answered yet.
   */
  it('does not poll while the tab is hidden, and catches up on return', async () => {
    vi.useFakeTimers();
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ attempts_live: 2 }));

    renderPage();
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Collections' })).toBeTruthy());
    const afterLoad = mocks.getAgencyCampaignStats.mock.calls.length;

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.getAgencyCampaignStats.mock.calls.length).toBe(afterLoad);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(mocks.getAgencyCampaignStats.mock.calls.length).toBe(afterLoad + 1);
  });

  it('does not start a tick while the previous one is still waiting on the server', async () => {
    vi.useFakeTimers();
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ attempts_live: 2 }));

    renderPage();
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Collections' })).toBeTruthy());
    const afterLoad = mocks.getAgencyCampaignStats.mock.calls.length;

    // The next read hangs: a slow backend.
    let answer!: (value: AgencyCampaignStats) => void;
    mocks.getAgencyCampaignStats.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.getAgencyCampaignStats.mock.calls.length).toBe(afterLoad + 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // Three more intervals elapsed; none of them stacked a second request.
    expect(mocks.getAgencyCampaignStats.mock.calls.length).toBe(afterLoad + 1);

    await act(async () => {
      answer(stats({ attempts_live: 2 }));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.getAgencyCampaignStats.mock.calls.length).toBe(afterLoad + 2);
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

describe('campaign detail — the agent floor ', () => {
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
    // The older wire: `agents_live` and no `agents`. Rendering that as
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

describe('campaign detail — permissions (agency.supervise)', () => {
  /**
   * Asserted here rather than left to the server's 403.
   *
   * The controls check `agency.supervise` (floored at `account_admin`), which is
   * what the server's four lifecycle proxies now gate on. Two roles below that floor
   * are worth pinning by name: an `agent` — the Agency Dialer role, deliberately
   * BELOW `viewer` — and a `viewer`. Neither may see a control, and neither may
   * invoke one, because a button that 403s on click is a worse answer than no
   * button.
   */
  it.each(['agent', 'viewer'])('%s can neither see nor invoke a lifecycle control', async (role) => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role });

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    for (const label of ['Start dialling', 'Pause', 'Resume', 'Stop']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    // Not merely hidden: nothing on the page can reach the transition API.
    expect(mocks.transitionAgencyCampaign).not.toHaveBeenCalled();
    // The floor is still readable — supervising without controlling is the
    // point of the read-only view — and Insights, whose reads would 403, is not.
    expect(await screen.findByTestId('floor-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('insights-panel')).toBeNull();
    // History follows `audit.read`, which neither holds.
    expect(screen.queryByTestId('campaign-history-link')).toBeNull();
  });

  it('an operator is now below the floor too — the gate moved off proxy.schedules.write', async () => {
    // `operator` used to hold `proxy.schedules.write` and so used to see all
    // four controls. the lifecycle is now supervisory, and the server matches.
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
   * ── The floor's control uses the SAME permission  ───────
   *
   * `AgentFloor` takes `canSupervise` as a prop, so its own tests can only prove
   * the component honours whatever it is handed. What is proved HERE is that the
   * page hands it `hasPermission(role, 'agency.supervise')` — the thing the server
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
 * ── The staffing panel ─────────────────────────────────────────
 *
 * The server floors all four assignment routes on `agency.supervise`, so the panel's
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
 * ── Assigned here, but not AT a station here ────────────────────
 *
 * Reassignment deliberately does not touch live sessions: the server moves its own
 * row, and the server refuses the agent's next join here until they leave their old
 * station. So a moved agent appears on this list immediately while still working
 * somewhere else, and a supervisor reading a name with no tile on the floor has
 * no way to tell "hasn't started yet" from "is stuck elsewhere" unless the list
 * says so. The live rows come from the stats payload the floor already has —
 * a prop, not a second fetch.
 */
describe('campaign detail — dedicated caller IDs on the staffing list', () => {
  const AGENT = {
    user_id: 'usr_person', name: 'Ravi', email: null, role: 'agent', assigned_at: '2026-11-01T09:00:00.000Z',
  };

  it('with the contact-assignment flag on, a supervisor sees each agent’s caller ID', async () => {
    mocks.flag.mockReturnValue(true);
    mocks.listCampaignAgents.mockResolvedValue({ agents: [AGENT] });
    renderPage('agents');
    await waitFor(() => expect(screen.getByTestId('caller-id-usr_person').textContent).toContain('Shared rotation'));
    expect(mocks.getAgentCallerIds).toHaveBeenCalledWith('camp-1', 'tenant-1', 'account-1');
  });

  it('with the flag off and no dedications, the caller IDs are read once and nothing is shown', async () => {
    mocks.listCampaignAgents.mockResolvedValue({ agents: [AGENT] });
    renderPage('agents');
    await screen.findByText('Ravi');
    // Read whatever the flag, so a dedication made while it was on can be released.
    await waitFor(() => expect(mocks.getAgentCallerIds).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('caller-id-usr_person')).toBeNull();
    expect(screen.queryByText(/caller ID/i)).toBeNull();
  });

  it('with the flag off, a dedicated number is shown with only its release', async () => {
    mocks.listCampaignAgents.mockResolvedValue({ agents: [AGENT] });
    mocks.getAgentCallerIds.mockResolvedValue({
      campaign_id: 'camp-1',
      caller_ids: ['+912200000001'],
      dedicated: [{
        campaign_id: 'camp-1', user_id: 'usr_person', agent_name: 'Ravi', caller_id: '+912200000001',
        in_campaign: true, set_at: '2026-11-02T09:00:00.000Z', set_by_user_id: 'usr_sup',
      }],
      rotation: ['+912200000001'],
      all_dedicated: true,
    });
    renderPage('agents');
    await waitFor(() => expect(screen.getByTestId('caller-id-usr_person').textContent).toContain('+91 22000 00001'));
    expect(screen.getByRole('button', { name: 'Use shared rotation for Ravi' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Change caller ID/ })).toBeNull();
  });

  it.each(['agent', 'viewer', 'operator'])('%s with the flag on issues no caller ID read', async (role) => {
    mocks.flag.mockReturnValue(true);
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role });
    renderPage('agents');
    await screen.findByRole('heading', { name: 'Collections' });
    await waitFor(() => expect(mocks.getAgentCallerIds).not.toHaveBeenCalled());
  });
});

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
    // No per-agent rows is NOT an empty floor — the server may not have produced them,
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
 * ── The campaign's own clock ────────────────────────────────────
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
    expect(screen.getByText(/Updated .*Auto-refreshing/)).toBeTruthy();
  });

  it('omits the whole line when the campaign carries no start, rather than dashing it', async () => {
    // An older server. The campaign did not fail to start — we were not told.
    // (On Agents: Insights lists the lifecycle, with its own "Started" line.)
    mocks.getAgencyCampaign.mockResolvedValue(campaign());

    renderPage('agents');
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

describe('campaign detail — the account’s lines (decisions MC7)', () => {
  const sharing = {
    campaign_live: 4, fair_share: 5, account_limit: 10, account_live: 7, running_campaigns: 2,
  };

  it('shows its live calls against its share while another campaign runs', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ attempts_live: 4, concurrency: sharing }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByTestId('campaign-lines').textContent)
      .toBe('4 live calls · share 5 of 10 lines · 2 campaigns running');
  });

  it('shows the account’s lines in use when it runs alone', async () => {
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({
      concurrency: { ...sharing, fair_share: null, running_campaigns: 1, account_live: 4 },
    }));

    renderPage('agents');
    await screen.findByRole('heading', { name: 'Collections' });

    // In the header, so it is on every section, not only Insights.
    expect(screen.getByTestId('campaign-lines').textContent).toBe('4 of 10 lines in use');
  });

  it('reads the campaign’s own status, not the stats’ copy of it', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'paused' }));
    mocks.getAgencyCampaignStats.mockResolvedValue(stats({
      concurrency: { ...sharing, fair_share: null, running_campaigns: 1, account_live: 6 },
    }));

    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });

    expect(screen.getByTestId('campaign-lines').textContent).toBe('6 of 10 lines in use · 1 campaign running');
  });

  it('says nothing when the server sends no block, or a null one', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });
    expect(screen.queryByTestId('campaign-lines')).toBeNull();
    cleanup();

    mocks.getAgencyCampaignStats.mockResolvedValue(stats({ concurrency: null }));
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });
    expect(screen.queryByTestId('campaign-lines')).toBeNull();
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
    // A server that predates the route answers 404. Putting an error strip at
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

    // Contract no answer, busy, and the ones nobody dialed. Everything else
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

  it('tells the supervisor a retry can run beside its running parent', async () => {
    // The campaign here is `running` by default. Several campaigns may run per
    // account (decisions MC6): the note says they share the lines, not that Start
    // will be refused.
    renderPage();
    await screen.findByRole('heading', { name: 'Collections' });
    fireEvent.click(screen.getByTestId('campaign-retry-action'));

    const note = await screen.findByTestId('retry-parent-running');
    expect(note.textContent).toMatch(/start it while this one runs/i);
    expect(note.textContent).not.toMatch(/cannot be started/i);
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
