import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { compareMetricId, type AgencyCompareQuery } from '@magick-agency/contracts/api/agency/compare';
import { ApiError } from '../../api/client';
import { WILL_PAY, compareOptions, compareResponse, compareView } from '../helpers/compare';

/**
 * The Compare agents page (`docs/compare-agents.md` §2): supervisors only, behind its flag; the
 * campaign, window, agents, lens, metrics and trend read from and written to the URL; the
 * campaign's default view applied when the link names no metrics; a view's metrics dropped (and
 * named) when the campaign no longer has their outcomes; an agent outside the window's cohort left
 * out of the query; each refusal worded, with Try again only for busy and timed out.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  flags: { agency_compare_enabled: true } as Record<string, boolean>,
  listAgencyCampaigns: vi.fn(),
  getCompareOptions: vi.fn(),
  queryCompare: vi.fn(),
  listCompareViews: vi.fn(),
  createCompareView: vi.fn(),
  updateCompareView: vi.fn(),
  deleteCompareView: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('firebase/auth', () => ({ getAuth: () => ({ currentUser: null }) }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'sup-1', display_name: 'Anitha N', email: 'a@x' } }) }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({
  useFeatureFlagEnabled: (flag: string) => mocks.flags[flag] === true,
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));
vi.mock('../../components/common/CapabilityUnavailable', () => ({
  CapabilityUnavailable: () => <div data-testid="capability-unavailable" />,
}));
vi.mock('../../api/agencyCampaigns', () => ({ listAgencyCampaigns: mocks.listAgencyCampaigns }));
vi.mock('../../api/compare', async () => {
  const actual = await vi.importActual<typeof import('../../api/compare')>('../../api/compare');
  return {
    ...actual,
    getCompareOptions: mocks.getCompareOptions,
    queryCompare: mocks.queryCompare,
    listCompareViews: mocks.listCompareViews,
    createCompareView: mocks.createCompareView,
    updateCompareView: mocks.updateCompareView,
    deleteCompareView: mocks.deleteCompareView,
  };
});

import CompareAgentsPage, { CompareAgentsView, asOfTime } from '../../pages/agency/CompareAgentsPage';

const NOW = new Date('2026-11-21T09:00:00.000Z');

function Where() {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}`}</div>;
}

const where = () => new URLSearchParams(screen.getByTestId('where').textContent!.split('?')[1] ?? '');

function renderView(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/agency/compare${search}`]}>
      <Where />
      <Routes>
        <Route path="/agency/compare" element={<CompareAgentsView tenantId="t-1" accountId="a-1" userId="sup-1" canListen now={NOW} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function tenant(role: string) {
  mocks.useTenant.mockReturnValue({ role, tenantId: 't-1', accountId: 'a-1', accounts: [], accountResolution: 'ready' });
}

const lastQuery = (): AgencyCompareQuery => mocks.queryCompare.mock.calls[mocks.queryCompare.mock.calls.length - 1]![0];
const refusal = (status: number, code: string) => new ApiError(status, { error: 'refused', code, message: 'fallback' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flags = { agency_compare_enabled: true };
  tenant('account_admin');
  mocks.listAgencyCampaigns.mockResolvedValue([
    { id: 'camp-0', name: 'Old batch', status: 'completed' },
    { id: 'camp-1', name: 'Nov dues', status: 'running' },
  ]);
  mocks.getCompareOptions.mockImplementation(async (q: { campaign_id: string }) => compareOptions({ campaign_id: q.campaign_id }));
  mocks.queryCompare.mockResolvedValue(compareResponse());
  mocks.listCompareViews.mockResolvedValue({ views: [] });
});

describe('who sees it', () => {
  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/agency/compare']}>
        <CompareAgentsPage />
      </MemoryRouter>,
    );
  }

  it('is unavailable with the flag off', () => {
    mocks.flags = {};
    renderPage();
    expect(screen.getByTestId('capability-unavailable')).toBeTruthy();
    expect(mocks.getCompareOptions).not.toHaveBeenCalled();
  });

  it('is for supervisors only (CP3): a viewer or an agent reads nothing', () => {
    for (const role of ['viewer', 'operator', 'agent']) {
      tenant(role);
      const { unmount } = renderPage();
      expect(screen.getByText('Compare agents is for supervisors')).toBeTruthy();
      unmount();
    }
    expect(mocks.listAgencyCampaigns).not.toHaveBeenCalled();
  });
});

describe('the URL', () => {
  it('opens on the campaign that last dialled, the last 7 days, in the browser’s zone', async () => {
    renderView();
    await waitFor(() => expect(where().get('campaign')).toBe('camp-1'));
    await waitFor(() =>
      expect(mocks.getCompareOptions).toHaveBeenCalledWith(
        { campaign_id: 'camp-1', from: '2026-11-15', to: '2026-11-21', timezone: 'UTC' },
        't-1',
        'a-1',
        expect.any(AbortSignal),
      ),
    );
    await screen.findByText('Pick an agent to start');
    expect(mocks.queryCompare).not.toHaveBeenCalled();
  });

  it('starts from the campaign’s starting lens and its defaults (§4)', async () => {
    renderView('?campaign=camp-1&agents=u-lak');
    await waitFor(() => expect(mocks.queryCompare).toHaveBeenCalled());
    expect(lastQuery().metrics.map(compareMetricId)).toEqual([
      'calls_handled',
      compareMetricId(WILL_PAY),
      'choose_time',
      'no_outcome_rate',
      'avg_call',
      'breaks_over_limit',
    ]);
    expect(compareMetricId(lastQuery().trend!)).toBe(compareMetricId(WILL_PAY));
    expect(screen.getByTestId('compare-lens-collections').getAttribute('aria-selected')).toBe('true');
  });

  it('reproduces a linked comparison: agents in slot order, metrics, trend, window', async () => {
    renderView('?campaign=camp-1&when=custom&from=2026-11-01&to=2026-11-14&agents=,u-priya,u-lak&lens=sales&m=success_rate&m=avg_call&trend=none');
    await waitFor(() => expect(mocks.queryCompare).toHaveBeenCalled());
    expect(lastQuery()).toEqual({
      campaign_id: 'camp-1',
      agent_ids: ['u-priya', 'u-lak'],
      metrics: [
        { kind: 'builtin', key: 'success_rate' },
        { kind: 'builtin', key: 'avg_call' },
      ],
      trend: null,
      from: '2026-11-01',
      to: '2026-11-14',
      timezone: 'UTC',
    });
    expect(screen.getByTestId('compare-lens-sales').getAttribute('aria-selected')).toBe('true');
  });

  it('writes a pick to the URL in its colour slot', async () => {
    renderView('?campaign=camp-1&agents=u-lak');
    await waitFor(() => expect(screen.getAllByTestId('compare-agent-chip').length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByTestId('compare-agent-chip')[2]!);
    expect(where().get('agents')).toBe('u-lak,u-priya');
    fireEvent.click(screen.getAllByTestId('compare-agent-chip')[0]!);
    expect(where().get('agents')).toBe(',u-priya');
  });

  it('a lens tab resets the metrics to the lens’s own', async () => {
    renderView('?campaign=camp-1&agents=u-lak&m=avg_call');
    await waitFor(() => expect(mocks.queryCompare).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('compare-lens-sales'));
    expect(where().get('lens')).toBe('sales');
    expect(where().getAll('m')).toEqual([]);
    await waitFor(() =>
      expect(lastQuery().metrics.map(compareMetricId)).toEqual([
        'calls_handled',
        'outcomes:higher:part_paid,will_pay',
        'callbacks_booked',
        'callbacks_kept_rate',
        'avg_call',
        'calls_per_hour',
      ]),
    );
  });

  it('a new campaign clears the agents and the metrics', async () => {
    renderView('?campaign=camp-1&agents=u-lak&m=avg_call&lens=sales');
    await waitFor(() => expect(mocks.queryCompare).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('compare-campaign'), { target: { value: 'camp-0' } });
    expect(where().toString()).toBe('campaign=camp-0');
  });

  it('leaves an agent outside the window’s cohort out of the query, and says so', async () => {
    renderView('?campaign=camp-1&agents=u-gone,u-lak');
    await waitFor(() => expect(mocks.queryCompare).toHaveBeenCalled());
    expect(lastQuery().agent_ids).toEqual(['u-lak']);
    expect(screen.getByText(/One agent in the link didn’t take calls on this campaign in this window/)).toBeTruthy();
  });
});

describe('what it shows', () => {
  it('draws a chart per metric, the findings in words, the trend, the day split and the numbers', async () => {
    renderView('?campaign=camp-1&agents=u-lak,u-ravi,u-priya');
    await screen.findByTestId('compare-findings');
    expect(screen.getAllByTestId('compare-metric')).toHaveLength(3);
    expect(screen.getAllByTestId('compare-bar-row')).toHaveLength(9);
    const findings = screen.getAllByTestId('compare-finding');
    expect(findings[0]!.textContent).toContain('Priya M’s share of calls ending in Will pay is 17% (rest of the team 28%).');
    expect(findings[1]!.textContent).toContain('Worth asking whether the outcome buttons are clear to them.');
    expect(within(findings[0]!).getByTestId('compare-finding-action').getAttribute('href')).toMatch(/^\/agency\/campaigns\/camp-1\/attempts\?agent_user_id=u-priya/);
    expect(screen.getByTestId('compare-trend')).toBeTruthy();
    expect(screen.getAllByTestId('compare-trend-line')).toHaveLength(3);
    expect(screen.getAllByTestId('compare-day-row')).toHaveLength(3);
    expect(screen.getByTestId('compare-numbers').textContent).toContain('Time to choose outcome');
    expect(screen.getByText('Shown for context, never flagged: Calls handled.')).toBeTruthy();
    expect(screen.getByText(/9 agents on this campaign · as of 9:30 AM/)).toBeTruthy();
  });

  it('writes the read time as the console writes a time (AS15)', () => {
    expect(asOfTime('2026-11-21T15:05:00.000Z')).toBe('3:05 PM');
    expect(asOfTime('2026-11-21T00:07:00.000Z')).toBe('12:07 AM');
  });

  it('explains why nothing is judged when fewer than six agents clear the floor (§6)', async () => {
    const base = compareResponse();
    mocks.queryCompare.mockResolvedValue({
      ...base,
      findings: [],
      cohort: { ...base.cohort, per_metric: Object.fromEntries(Object.entries(base.cohort.per_metric).map(([k, c]) => [k, { ...c, agents_rated: 3 }])) },
    });
    renderView('?campaign=camp-1&agents=u-lak');
    expect((await screen.findByTestId('compare-findings-empty')).textContent).toMatch(/at least 6 agents .* only 3 do/);
    fireEvent.click(within(screen.getByTestId('compare-findings-empty')).getByRole('button', { name: 'Check a longer window' }));
    expect(where().get('when')).toBe('30d');
  });

  it('lists the Not clear yet gaps with Check a longer window', async () => {
    const base = compareResponse();
    mocks.queryCompare.mockResolvedValue({ ...base, findings: [], not_clear: [base.findings[0]!] });
    renderView('?campaign=camp-1&agents=u-priya&when=today');
    const unclear = await screen.findByTestId('compare-not-clear');
    expect(unclear.textContent).toContain('Not clear yet (1)');
    expect(unclear.textContent).toContain('Priya M: will pay 17% on 29 calls');
    fireEvent.click(screen.getByTestId('compare-longer-window'));
    expect(where().get('when')).toBeNull();
    expect(where().get('campaign')).toBe('camp-1');
  });
});

describe('reads', () => {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('draws only the agents the answer has: a new pick waits for its figures, never “too few” or “not logged in”', async () => {
    const base = compareResponse();
    const onlyLak = {
      ...base,
      agents: base.agents.filter((a) => a.agent_user_id === 'u-lak'),
      trend: { ...base.trend!, agents: base.trend!.agents.filter((a) => a.agent_user_id === 'u-lak') },
    };
    mocks.queryCompare.mockResolvedValueOnce(onlyLak);
    renderView('?campaign=camp-1&agents=u-lak');
    await screen.findByTestId('compare-findings');
    // Priya's read never answers, then it fails: either way her figures are not known.
    let fail: (e: unknown) => void = () => {};
    mocks.queryCompare.mockImplementationOnce(() => new Promise((_r, reject) => (fail = reject)));
    fireEvent.click(screen.getAllByTestId('compare-agent-chip')[2]!);
    await screen.findByText('Updating…');
    await waitFor(() => expect(mocks.queryCompare).toHaveBeenCalledTimes(2));
    const check = () => {
      expect(screen.getAllByTestId('compare-bar-row')).toHaveLength(3);
      expect(screen.getAllByTestId('compare-day-row')).toHaveLength(1);
      expect(screen.getAllByTestId('compare-trend-line')).toHaveLength(1);
      expect(document.body.textContent).not.toMatch(/Too few[^)]*\(0/);
      expect(screen.getAllByTestId('compare-day-row')[0]!.textContent).toContain('Lakshmi P');
      expect(screen.getByTestId('compare-trend').getAttribute('aria-label')).not.toContain('Priya');
      expect(within(screen.getByTestId('compare-numbers')).queryByText('Priya M')).toBeNull();
    };
    check();
    fail(new TypeError('Failed to fetch'));
    await screen.findByTestId('compare-error');
    check();
  });

  it('holds the comparison while a new window’s agents load, then asks once with the new window', async () => {
    renderView('?campaign=camp-1&agents=u-priya');
    await screen.findByTestId('compare-findings');
    expect(mocks.queryCompare).toHaveBeenCalledTimes(1);
    let answer: (o: unknown) => void = () => {};
    mocks.getCompareOptions.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    fireEvent.change(screen.getByTestId('compare-when'), { target: { value: 'today' } });
    await waitFor(() => expect(mocks.getCompareOptions).toHaveBeenCalledTimes(2));
    await pause(500);
    // No read with the old window's agents, and no second read beside the options read.
    expect(mocks.queryCompare).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Updating…')).toBeTruthy();
    answer(compareOptions({ campaign_id: 'camp-1' }));
    await waitFor(() => expect(mocks.queryCompare).toHaveBeenCalledTimes(2));
    expect(lastQuery()).toMatchObject({ from: '2026-11-21', to: '2026-11-21', agent_ids: ['u-priya'] });
    await pause(400);
    expect(mocks.queryCompare).toHaveBeenCalledTimes(2);
  });

  it('never asks about an agent the new window’s options leave out', async () => {
    renderView('?campaign=camp-1&agents=u-lak,u-priya');
    await screen.findByTestId('compare-findings');
    const withoutPriya = compareOptions();
    mocks.getCompareOptions.mockResolvedValueOnce({ ...withoutPriya, agents: withoutPriya.agents.filter((a) => a.agent_user_id !== 'u-priya') });
    fireEvent.change(screen.getByTestId('compare-when'), { target: { value: 'today' } });
    await waitFor(() => expect(mocks.queryCompare).toHaveBeenCalledTimes(2));
    expect(lastQuery().agent_ids).toEqual(['u-lak']);
    expect(mocks.queryCompare.mock.calls.every(([q]) => !(q.from === '2026-11-21' && q.agent_ids.includes('u-priya')))).toBe(true);
  });

  it('shows a failed options read even when an earlier one is on screen', async () => {
    renderView('?campaign=camp-1&agents=u-lak');
    await screen.findByTestId('compare-findings');
    mocks.getCompareOptions.mockRejectedValueOnce(new ApiError(500, { error: 'Internal Server Error' }));
    fireEvent.change(screen.getByTestId('compare-when'), { target: { value: 'today' } });
    const error = await screen.findByTestId('compare-error');
    expect(error.textContent).toBeTruthy();
    fireEvent.click(within(error).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mocks.getCompareOptions).toHaveBeenCalledTimes(3));
  });

  it('sends one read for picks made in quick succession', async () => {
    renderView('?campaign=camp-1&agents=u-lak');
    await screen.findByTestId('compare-findings');
    expect(mocks.queryCompare).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByTestId('compare-agent-chip')[1]!);
    await pause(80);
    fireEvent.click(screen.getAllByTestId('compare-agent-chip')[2]!);
    await pause(80);
    fireEvent.click(screen.getByTestId('compare-lens-sales'));
    await waitFor(() => expect(mocks.queryCompare).toHaveBeenCalledTimes(2));
    await pause(400);
    expect(mocks.queryCompare).toHaveBeenCalledTimes(2);
    expect(lastQuery().agent_ids).toEqual(['u-lak', 'u-ravi', 'u-priya']);
  });
});

describe('refusals', () => {
  it('words compare_busy and tries again on request', async () => {
    mocks.queryCompare.mockRejectedValueOnce(refusal(429, 'compare_busy'));
    renderView('?campaign=camp-1&agents=u-lak');
    const error = await screen.findByTestId('compare-error');
    expect(error.textContent).toContain('Your organisation is already running two comparisons. Try again in a moment.');
    fireEvent.click(within(error).getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('compare-findings');
    expect(mocks.queryCompare).toHaveBeenCalledTimes(2);
  });

  it('words compare_timed_out with Try again', async () => {
    mocks.queryCompare.mockRejectedValueOnce(refusal(503, 'compare_timed_out'));
    renderView('?campaign=camp-1&agents=u-lak');
    const error = await screen.findByTestId('compare-error');
    expect(error.textContent).toContain('took too long');
    expect(within(error).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('offers no Try again for a refusal the reader must fix first', async () => {
    mocks.getCompareOptions.mockRejectedValue(refusal(400, 'compare_window_invalid'));
    renderView('?campaign=camp-1');
    const error = await screen.findByTestId('compare-error');
    expect(error.textContent).toMatch(/valid window/);
    expect(within(error).queryByRole('button')).toBeNull();
  });

  it('offers no Try again for a 403 or a 400 with no compare code, and offers it for a network failure', async () => {
    for (const [err, retry] of [
      [new ApiError(403, { error: 'Forbidden' }), false],
      [new ApiError(400, { error: 'Bad Request', message: 'body/metrics must NOT have more than 6 items' }), false],
      [new TypeError('Failed to fetch'), true],
    ] as const) {
      mocks.queryCompare.mockRejectedValueOnce(err);
      const { unmount } = renderView('?campaign=camp-1&agents=u-lak');
      const error = await screen.findByTestId('compare-error');
      expect(within(error).queryByRole('button', { name: 'Try again' }) !== null, String(err)).toBe(retry);
      unmount();
    }
  });

  it('holds a custom window to the reports’ rule before asking', async () => {
    renderView('?campaign=camp-1&when=custom&from=2026-09-01&to=2026-11-14');
    expect(await screen.findByText('Choose up to 31 days, or one calendar month, ending no later than today.')).toBeTruthy();
    expect(mocks.getCompareOptions).not.toHaveBeenCalled();
  });
});

describe('saved views', () => {
  it('opens a campaign on its default view when the link names no metrics', async () => {
    const view = compareView({ shared: true, is_campaign_default: true, lens: 'sales', metrics: [{ kind: 'builtin', key: 'avg_call' }], trend: null });
    mocks.getCompareOptions.mockResolvedValue(compareOptions({ default_view: view }));
    renderView('?campaign=camp-1&agents=u-lak');
    await waitFor(() => expect(mocks.queryCompare).toHaveBeenCalled());
    expect(lastQuery().metrics).toEqual([{ kind: 'builtin', key: 'avg_call' }]);
    expect(lastQuery().trend).toBeNull();
  });

  it('drops a metric whose outcomes the campaign no longer has, and says so', async () => {
    const gone = { kind: 'outcomes' as const, codes: ['paid_in_full'], better: 'higher' as const, label: 'Paid in full' };
    const view = compareView({ id: 'view-2', name: 'Old view', owner: { user_id: 'sup-2', name: 'Ravi S' }, shared: true, metrics: [gone, WILL_PAY], trend: gone });
    mocks.listCompareViews.mockResolvedValue({ views: [view] });
    renderView('?campaign=camp-1&agents=u-lak');
    await waitFor(() => expect(mocks.queryCompare).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByTestId('compare-view-select') as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByTestId('compare-view-select'), { target: { value: 'view-2' } });
    expect(screen.getByTestId('compare-note').textContent).toBe(
      'Paid in full was left out: this campaign no longer has its outcomes. The per-day trend was left out for the same reason.',
    );
    expect(where().get('view')).toBe('view-2');
    await waitFor(() => expect(lastQuery().metrics.map(compareMetricId)).toEqual([compareMetricId(WILL_PAY)]));
    // Another supervisor's shared view is read-only.
    expect(screen.getByText(/Shared by Ravi S · read-only/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('saves the page as a new view, shared and as the campaign default', async () => {
    mocks.createCompareView.mockImplementation(async (body) => compareView({ id: 'view-9', ...body }));
    renderView('?campaign=camp-1&agents=u-lak&lens=sales&m=success_rate&trend=none');
    await waitFor(() => expect(mocks.queryCompare).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('compare-save-view'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Sales weekly ' } });
    fireEvent.click(screen.getByLabelText(/Open Nov dues on this view/));
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(mocks.createCompareView).toHaveBeenCalled());
    expect(mocks.createCompareView.mock.calls[0]![0]).toEqual({
      name: 'Sales weekly',
      lens: 'sales',
      metrics: [{ kind: 'builtin', key: 'success_rate' }],
      trend: null,
      campaign_id: 'camp-1',
      shared: true,
      is_campaign_default: true,
    });
    await waitFor(() => expect(where().get('view')).toBe('view-9'));
  });

  it('lets the owner save changes to their view', async () => {
    const view = compareView({ metrics: [{ kind: 'builtin', key: 'calls_handled' }], trend: null });
    mocks.listCompareViews.mockResolvedValue({ views: [view] });
    mocks.updateCompareView.mockImplementation(async (_id, body) => ({ ...view, ...body }));
    renderView(`?campaign=camp-1&agents=u-lak&lens=collections&m=calls_handled&m=avg_call&trend=none&view=${view.id}`);
    const save = await screen.findByRole('button', { name: 'Save changes' });
    fireEvent.click(save);
    await waitFor(() => expect(mocks.updateCompareView).toHaveBeenCalled());
    expect(mocks.updateCompareView.mock.calls[0]!.slice(0, 2)).toEqual([
      'view-1',
      { lens: 'collections', metrics: [{ kind: 'builtin', key: 'calls_handled' }, { kind: 'builtin', key: 'avg_call' }], trend: null },
    ]);
  });

  it('Share and Make campaign default keep unsaved edits on the page', async () => {
    const view = compareView({ metrics: [{ kind: 'builtin', key: 'calls_handled' }], trend: null });
    mocks.listCompareViews.mockResolvedValue({ views: [view] });
    mocks.updateCompareView.mockImplementation(async (_id, body) => ({ ...view, ...body }));
    renderView(`?campaign=camp-1&agents=u-lak&lens=collections&m=calls_handled&m=avg_call&trend=none&view=${view.id}`);
    await screen.findByRole('button', { name: 'Save changes' });
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledTimes(1));
    expect(mocks.updateCompareView.mock.calls[0]![1]).toEqual({ shared: true });
    expect(where().getAll('m')).toEqual(['calls_handled', 'avg_call']);
    fireEvent.click(await screen.findByRole('button', { name: 'Make campaign default' }));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledTimes(2));
    expect(mocks.updateCompareView.mock.calls[1]![1]).toEqual({ is_campaign_default: true, shared: true });
    expect(where().getAll('m')).toEqual(['calls_handled', 'avg_call']);
    expect(where().get('view')).toBe(view.id);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
  });

  it('offers Make campaign default only on a view made for this campaign', async () => {
    const anyCampaign = compareView({ id: 'view-any', campaign_id: null });
    mocks.listCompareViews.mockResolvedValue({ views: [anyCampaign] });
    renderView(`?campaign=camp-1&agents=u-lak&view=view-any&lens=collections&m=calls_handled&m=${encodeURIComponent(compareMetricId(WILL_PAY))}`);
    await screen.findByRole('button', { name: 'Share' });
    expect(screen.queryByRole('button', { name: 'Make campaign default' })).toBeNull();
  });

  it('mentions sharing in the delete confirmation only for a shared view', async () => {
    const view = compareView({ shared: false });
    mocks.listCompareViews.mockResolvedValue({ views: [view] });
    renderView(`?campaign=camp-1&agents=u-lak&view=${view.id}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(screen.getByText('“Collections weekly” will be deleted. The page stays as it is.')).toBeTruthy();
    expect(screen.queryByText(/shared with/)).toBeNull();
  });
});
