import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { activity, allocation, health, readiness, summary, trends, uploads } from '../helpers/insights';

/**
 * The Insights tab as a whole: the range in the URL, the lazy range reads,
 * Refresh, Print, and the status headline it picks. Each section's own figures
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

function renderPanel(search = '', props: Partial<Parameters<typeof InsightsPanel>[0]> = {}) {
  return render(
    <MemoryRouter initialEntries={[`/agency/campaigns/camp-1/insights${search}`]}>
      <Routes>
        <Route
          path="/agency/campaigns/:id/insights"
          element={(
            <>
              <InsightsPanel campaignId="camp-1" canRetry onRetry={vi.fn()} refreshToken={0} shellStatus="running" {...props} />
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
  it('paints the as-of-now numbers, then loads every range section', async () => {
    renderPanel();
    expect(await screen.findByTestId('headline-running')).toBeTruthy();
    expect(screen.getByTestId('insights-roster')).toBeTruthy();
    await screen.findByTestId('insights-calls');
    expect(await screen.findByTestId('insights-trends')).toBeTruthy();
    expect(await screen.findByTestId('insights-health')).toBeTruthy();
    expect(await screen.findByTestId('insights-allocation')).toBeTruthy();
    expect(await screen.findByTestId('insights-uploads')).toBeTruthy();
    // Lifetime: no range on the wire, day buckets.
    expect(api.getInsightsActivity).toHaveBeenCalledWith('camp-1', {}, 'tenant-1', 'account-1');
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
    renderPanel();
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
    renderPanel();
    await screen.findByTestId('insights-calls');
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByTestId('location').textContent).toBe('?from=2026-11-01&to=2026-11-03');
  });

  it('refuses a backwards range on screen and fetches nothing for it', async () => {
    renderPanel('?from=2026-11-03&to=2026-11-01');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('The start date is after the end date.');
    expect(within(screen.getByTestId('insights-calls')).getByText('Choose a valid range to see these figures.')).toBeTruthy();
    expect(api.getInsightsActivity).not.toHaveBeenCalled();
  });

  it('labels the roster as of now and the rest as following the range', async () => {
    renderPanel('?range=yesterday');
    expect(await screen.findByText(/roster and allocation are as of now; calls, agents, trends and health follow the range \(Yesterday\)/)).toBeTruthy();
    expect(screen.getByText(/Times in Asia\/Kolkata/)).toBeTruthy();
  });
});

describe('Insights — Refresh and Print', () => {
  it('Refresh re-reads every section and tells a screen reader it did', async () => {
    renderPanel();
    await screen.findByTestId('insights-calls');
    await waitFor(() => expect(api.getInsightsHealth).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('insights-announcement').textContent).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh insights' }));
    await waitFor(() => expect(api.getInsightsHealth).toHaveBeenCalledTimes(2));
    expect(api.getInsightsSummary).toHaveBeenCalledTimes(2);
    expect(api.getInsightsAllocation).toHaveBeenCalledTimes(2);
    expect(api.getInsightsUploads).toHaveBeenCalledTimes(2);
    expect(api.getInsightsActivity).toHaveBeenCalledTimes(2);
    expect(api.getInsightsTrends).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByTestId('insights-announcement').textContent).toMatch(/^Insights updated at /));
    expect(screen.getByTestId('insights-announcement').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByTestId('insights-updated').getAttribute('aria-live')).toBeNull();
  });

  it('re-reads when the shell’s Refresh token moves, and when the shell’s status changes', async () => {
    const view = renderPanel();
    await screen.findByTestId('insights-calls');
    await waitFor(() => expect(api.getInsightsActivity).toHaveBeenCalledTimes(1));

    view.rerender(
      <MemoryRouter initialEntries={['/agency/campaigns/camp-1/insights']}>
        <Routes>
          <Route path="/agency/campaigns/:id/insights" element={<InsightsPanel campaignId="camp-1" canRetry onRetry={vi.fn()} refreshToken={1} shellStatus="paused" />} />
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
    await screen.findByTestId('insights-calls');

    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(screen.getByRole('button', { name: 'Preparing…' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(print).not.toHaveBeenCalled();

    answerHealth(health());
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Print' })).toBeTruthy();
  });
});
