import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { activity, allocation, health, readiness, summary, trends, uploads } from '../helpers/insights';

/**
 * The analytic tabs as a whole (decision IN13): the range in the URL, the lazy
 * range reads (only those the tab on screen shows), Refresh, Print, and the
 * status headline Overview picks. Each section's own figures
 * are covered in `InsightsSections.test.tsx`, each status in
 * `InsightsHeadline.test.tsx`.
 */

const api = vi.hoisted(() => ({
  getInsightsSummary: vi.fn(),
  getInsightsAllocation: vi.fn(),
  getInsightsReadiness: vi.fn(),
  getInsightsUploads: vi.fn(),
  getInsightsActivity: vi.fn(),
  getInsightsTrends: vi.fn(),
  getInsightsHealth: vi.fn(),
}));
vi.mock('../../api/agencyInsights', () => api);
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 'tenant-1', accountId: 'account-1', role: 'tenant_owner' }),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }),
}));

import { InsightsPanel } from '../../pages/agency/campaign-detail/insights/InsightsPanel';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.search}</output>;
}

type PanelProps = Parameters<typeof InsightsPanel>[0];

function panelElement(props: Partial<PanelProps> = {}) {
  return <InsightsPanel campaignId="camp-1" canRetry onRetry={vi.fn()} refreshToken={0} shellStatus="running" view="overview" {...props} />;
}

function renderPanel(search = '', props: Partial<PanelProps> = {}) {
  return render(
    <MemoryRouter initialEntries={[`/agency/campaigns/camp-1/x${search}`]}>
      <Routes>
        <Route
          path="/agency/campaigns/:id/x"
          element={(
            <>
              {panelElement(props)}
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getInsightsSummary.mockResolvedValue(summary('running'));
  api.getInsightsAllocation.mockResolvedValue(allocation());
  api.getInsightsReadiness.mockResolvedValue(readiness());
  api.getInsightsUploads.mockResolvedValue(uploads());
  api.getInsightsActivity.mockResolvedValue(activity());
  api.getInsightsTrends.mockResolvedValue(trends());
  api.getInsightsHealth.mockResolvedValue(health());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Insights — first paint', () => {
  it('paints Overview’s as-of-now numbers, then the reads it shows and no others', async () => {
    renderPanel();
    expect(await screen.findByTestId('headline-running')).toBeTruthy();
    expect(screen.getByTestId('insights-roster')).toBeTruthy();
    expect(screen.getByTestId('overview-kpis')).toBeTruthy();
    await waitFor(() => expect(api.getInsightsHealth).toHaveBeenCalledTimes(1));
    // Lifetime: no range on the wire.
    expect(api.getInsightsActivity).toHaveBeenCalledWith('camp-1', {}, 'tenant-1', 'account-1');
    // The trends are the Calls tab's alone, and the uploads are on Settings.
    expect(api.getInsightsTrends).not.toHaveBeenCalled();
    expect(api.getInsightsUploads).not.toHaveBeenCalled();
    // No detail table on Overview.
    expect(screen.queryByTestId('insights-calls')).toBeNull();
    expect(screen.queryByTestId('insights-allocation')).toBeNull();
  });

  it('shows each tab its own sections over the same reads, loading each read once', async () => {
    const view = renderPanel();
    await waitFor(() => expect(api.getInsightsHealth).toHaveBeenCalledTimes(1));
    const show = (next: PanelProps['view']) =>
      view.rerender(
        <MemoryRouter initialEntries={['/agency/campaigns/camp-1/x']}>
          <Routes><Route path="/agency/campaigns/:id/x" element={panelElement({ view: next })} /></Routes>
        </MemoryRouter>,
      );

    // Each tab shows exactly its own sections, and none of another tab's.
    const SECTIONS = [
      'overview-kpis', 'insights-attention', 'insights-roster',
      'insights-calls', 'insights-trends',
      'insights-agents', 'insights-allocation', 'insights-overrides',
      'insights-callbacks',
      'insights-health', 'insights-recording',
    ];
    const showsOnly = async (mine: string[]) => {
      for (const id of mine) expect(await screen.findByTestId(id)).toBeTruthy();
      expect(SECTIONS.filter((id) => !mine.includes(id) && screen.queryByTestId(id) !== null)).toEqual([]);
    };

    await showsOnly(['overview-kpis', 'insights-attention', 'insights-roster']);

    show('calls');
    await showsOnly(['insights-calls', 'insights-trends']);

    show('agents');
    await showsOnly(['insights-agents', 'insights-allocation', 'insights-overrides']);

    show('callbacks');
    await showsOnly(['insights-callbacks']);

    show('health');
    await showsOnly(['insights-health', 'insights-recording']);

    show('overview');
    await showsOnly(['overview-kpis', 'insights-attention', 'insights-roster']);
    // Going back and forth never read anything twice.
    expect(api.getInsightsActivity).toHaveBeenCalledTimes(1);
    expect(api.getInsightsHealth).toHaveBeenCalledTimes(1);
    expect(api.getInsightsTrends).toHaveBeenCalledTimes(1);
  });

  it('says when a read Overview needs has failed, instead of “Checking…” and “…” for ever', async () => {
    api.getInsightsHealth.mockRejectedValue(new Error('The health read failed.'));
    renderPanel();
    expect((await screen.findByTestId('overview-error')).textContent).toBe('The health read failed. Refresh to try again.');
    expect(within(screen.getByTestId('overview-kpi-abandonment')).getByText('—')).toBeTruthy();
    expect(screen.getByTestId('teaser-health').textContent).toContain('Could not load.');
    // The attention list has stopped waiting: it judges what it has.
    await waitFor(() => expect(screen.queryByText('Checking…')).toBeNull());
    // A read that answered still shows.
    expect(within(screen.getByTestId('overview-kpi-dials')).queryByText('—')).toBeNull();
  });

  it('opens the tab an attention item names, keeping the range', async () => {
    renderPanel('?range=7d');
    const item = await screen.findByTestId('attention-callbacks-overdue');
    expect(within(item).getByRole('link', { name: 'Callbacks' }).getAttribute('href')).toBe('/agency/campaigns/camp-1/callbacks?range=7d');
    // Settings is not an analytic tab: the range would mean nothing there.
    const hours = await screen.findByTestId('attention-calling-hours-default');
    expect(within(hours).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('/agency/campaigns/camp-1/settings');
    expect(screen.getByTestId('teaser-calls').getAttribute('href')).toBe('/agency/campaigns/camp-1/calls?range=7d');
  });

  it('reports the callbacks overdue now, for the Callbacks tab’s badge', async () => {
    const onCallbacksOverdue = vi.fn();
    const rows = allocation();
    rows.totals.callbacks_overdue = 4;
    api.getInsightsAllocation.mockResolvedValue(rows);
    renderPanel('', { onCallbacksOverdue });
    await waitFor(() => expect(onCallbacksOverdue).toHaveBeenLastCalledWith(4));
  });

  it('does not start a range read before the summary has answered', async () => {
    let answer: (value: unknown) => void = () => {};
    api.getInsightsSummary.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    renderPanel();
    await waitFor(() => expect(api.getInsightsSummary).toHaveBeenCalled());
    expect(api.getInsightsActivity).not.toHaveBeenCalled();
    answer(summary('running'));
    await waitFor(() => expect(api.getInsightsActivity).toHaveBeenCalledTimes(1));
  });

  it('says what went wrong when the summary cannot be read', async () => {
    api.getInsightsSummary.mockRejectedValue(new Error('The insights store is unavailable.'));
    renderPanel();
    expect(await screen.findByText('The insights store is unavailable.')).toBeTruthy();
  });

  it('shows the draft checklist, and reads readiness for it', async () => {
    api.getInsightsSummary.mockResolvedValue(summary('draft'));
    renderPanel();
    expect(await screen.findByTestId('headline-draft')).toBeTruthy();
    await screen.findByTestId('readiness-roster_uploaded');
    expect(api.getInsightsReadiness).toHaveBeenCalledTimes(1);
  });
});

describe('Insights — the range', () => {
  it('reads Today in the campaign zone and keeps it in the URL', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T01:00:00.000Z'));
    renderPanel('', { view: 'calls' });
    await screen.findByTestId('insights-calls');

    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.getByTestId('location').textContent).toBe('?range=today');
    // From the Kolkata midnight (18:30 UTC the day before) to now: the clock
    // has moved a few milliseconds since it was set.
    await waitFor(() =>
      expect(api.getInsightsActivity).toHaveBeenLastCalledWith(
        'camp-1',
        { from: '2026-11-03T18:30:00.000Z', to: expect.stringMatching(/^2026-11-04T01:00:0/) },
        'tenant-1',
        'account-1',
      ),
    );
    // A day defaults to hourly trends.
    expect(api.getInsightsTrends.mock.calls.at(-1)?.[2]).toBe('hour');
    expect(screen.getByRole('button', { name: 'Today' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('opens on the range a shared link names', async () => {
    renderPanel('?from=2026-11-01&to=2026-11-02');
    await waitFor(() =>
      expect(api.getInsightsActivity).toHaveBeenCalledWith(
        'camp-1',
        { from: '2026-10-31T18:30:00.000Z', to: '2026-11-02T18:30:00.000Z' },
        'tenant-1',
        'account-1',
      ),
    );
    expect(screen.getByRole('button', { name: 'Custom' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('applies a custom range from the date pickers', async () => {
    renderPanel('', { view: 'calls' });
    await screen.findByTestId('insights-calls');
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByTestId('location').textContent).toBe('?from=2026-11-01&to=2026-11-03');
  });

  it('refuses a backwards range on screen and fetches nothing for it', async () => {
    renderPanel('?from=2026-11-03&to=2026-11-01', { view: 'calls' });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('The start date is after the end date.');
    expect(within(screen.getByTestId('insights-calls')).getByText('Choose a valid range to see these figures.')).toBeTruthy();
    expect(api.getInsightsActivity).not.toHaveBeenCalled();
  });

  it('a lifetime the server clamped to 92 days says so, and its numbers link to that window', async () => {
    const clamped = { from: '2026-08-04T10:15:00.000Z', to: '2026-11-04T10:15:00.000Z', lifetime: true, clamped: true, timezone: 'Asia/Kolkata' };
    api.getInsightsActivity.mockResolvedValue(activity({ range: clamped }));
    api.getInsightsTrends.mockResolvedValue(trends({ range: clamped }));
    api.getInsightsHealth.mockResolvedValue(health({ range: clamped }));
    renderPanel('', { view: 'calls' });
    expect(await screen.findByText(/follow the range \(Last 92 days\)/)).toBeTruthy();
    // Still asked as the lifetime: the server decides the window.
    expect(api.getInsightsActivity).toHaveBeenCalledWith('camp-1', {}, 'tenant-1', 'account-1');
    const link = await waitFor(() => within(screen.getByTestId('insights-calls')).getAllByRole('link', { name: /connected calls$/ })[0]!);
    const params = new URLSearchParams(link.getAttribute('href')!.split('?')[1]);
    expect(params.get('dialed_from')).toBe(clamped.from);
    expect(params.get('dialed_to')).toBe(clamped.to);
  });

  it('a lifetime the server served whole stays "Lifetime", its links unwindowed', async () => {
    renderPanel('', { view: 'calls' });
    expect(await screen.findByText(/follow the range \(Lifetime\)/)).toBeTruthy();
    const link = await waitFor(() => within(screen.getByTestId('insights-calls')).getAllByRole('link', { name: /connected calls$/ })[0]!);
    expect(link.getAttribute('href')).not.toContain('dialed_from');
  });

  it('labels the figures that are live and says the rest follow the range', async () => {
    renderPanel('?range=yesterday');
    expect(await screen.findByText(/figures marked “now” are live; the rest follow the range \(Yesterday\)/)).toBeTruthy();
    expect(screen.getByTestId('overview-kpi-reached').textContent).toContain('Reached · now');
    expect(await screen.findByText('Dials · Yesterday')).toBeTruthy();
    expect(screen.getByText(/Times in Asia\/Kolkata/)).toBeTruthy();
  });
});

describe('Insights — Refresh and Print', () => {
  it('Refresh re-reads every section the tab shows and tells a screen reader it did', async () => {
    renderPanel();
    await screen.findByTestId('overview-kpis');
    await waitFor(() => expect(api.getInsightsHealth).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('insights-announcement').textContent).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh insights' }));
    await waitFor(() => expect(api.getInsightsHealth).toHaveBeenCalledTimes(2));
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(2);
    expect(api.getInsightsAllocation).toHaveBeenCalledTimes(2);
    expect(api.getInsightsActivity).toHaveBeenCalledTimes(2);
    expect(api.getInsightsTrends).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('insights-announcement').textContent).toMatch(/^Insights updated at /));
    expect(screen.getByTestId('insights-announcement').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByTestId('insights-updated').getAttribute('aria-live')).toBeNull();
  });

  it('re-reads when the shell’s Refresh token moves, and when the shell’s status changes', async () => {
    const view = renderPanel('', { view: 'calls' });
    await screen.findByTestId('insights-calls');
    await waitFor(() => expect(api.getInsightsActivity).toHaveBeenCalledTimes(1));

    view.rerender(
      <MemoryRouter initialEntries={['/agency/campaigns/camp-1/x']}>
        <Routes>
          <Route path="/agency/campaigns/:id/x" element={panelElement({ view: 'calls', refreshToken: 1, shellStatus: 'paused' })} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.getInsightsActivity).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.getInsightsSummary.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it('prints only once every range section has loaded', async () => {
    const print = vi.fn();
    Object.assign(window, { print });
    let answerHealth: (value: unknown) => void = () => {};
    api.getInsightsHealth.mockReturnValue(new Promise((resolve) => { answerHealth = resolve; }));
    renderPanel();
    await screen.findByTestId('overview-kpis');

    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(print).not.toHaveBeenCalled();

    answerHealth(health());
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Print' })).toBeTruthy();
  });
});
