import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { reportRun } from '../helpers/reports';

/**
 * One run's page (`/agency/reports/:runId`, the "report ready" email's link): its
 * parameters, the status polled until it is terminal, the downloads (the files
 * route, then `window.location.assign`), the failure in the console's words, and
 * "Run again" (a new run, then its page).
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getReport: vi.fn(),
  /** The download's URL read: `downloadReportFile` calls the client itself. */
  apiFetch: vi.fn(),
  retryReport: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'sup-1', display_name: 'Asha', email: 'a@x' } }) }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({
  SOFTPHONE_FLAG: 'agency_softphone_enabled',
  useFeatureFlagEnabled: (flag: string) => flag === 'agency_reports_enabled',
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));
vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>('../../api/client');
  return { ...actual, apiFetch: mocks.apiFetch };
});
vi.mock('../../api/reports', async () => {
  const actual = await vi.importActual<typeof import('../../api/reports')>('../../api/reports');
  return { ...actual, getReport: mocks.getReport, retryReport: mocks.retryReport };
});

import ReportRunPage from '../../pages/agency/ReportRunPage';
import { REPORT_POLL_INTERVAL_MS } from '../../hooks/useReportRun';
import { ApiError } from '../../api/client';

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}</div>;
}

function renderRun(runId = 'run-1') {
  return render(
    <MemoryRouter initialEntries={[`/agency/reports/${runId}`]}>
      <Where />
      <Routes>
        <Route path="/agency/reports/:runId" element={<ReportRunPage />} />
        <Route path="/agency/reports" element={<div data-testid="list" />} />
      </Routes>
    </MemoryRouter>,
  );
}

const assign = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({ role: 'account_admin', tenantId: 't', accountId: 'a', accounts: [] });
  Object.defineProperty(window, 'location', { value: { ...originalLocation, assign }, configurable: true });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { value: originalLocation, configurable: true });
  vi.useRealTimers();
});

describe('ReportRunPage', () => {
  it('shows the run’s parameters', async () => {
    mocks.getReport.mockResolvedValue(reportRun());
    renderRun();
    expect(await screen.findByRole('heading', { name: 'Agent review: Priya S' })).toBeTruthy();
    const facts = screen.getByTestId('report-run-facts').textContent ?? '';
    expect(facts).toContain('9 Oct – 7 Nov 2026 (Asia/Kolkata)');
    expect(facts).toContain('PDF and Excel');
    expect(facts).toContain('Asha Supervisor');
    expect(facts).toContain('Available until');
    expect(mocks.getReport).toHaveBeenCalledWith('run-1', 't', 'a');
  });

  it('polls while preparing and shows the downloads once ready', async () => {
    vi.useFakeTimers();
    mocks.getReport
      .mockResolvedValueOnce(reportRun({ status: 'queued' }))
      .mockResolvedValueOnce(reportRun({ status: 'rendering' }))
      .mockResolvedValueOnce(reportRun({ status: 'ready' }));
    renderRun();
    await act(async () => {});
    expect(screen.getByTestId('report-status').textContent).toContain('Preparing…');
    expect(screen.getByTestId('report-run-pending')).toBeTruthy();
    expect(screen.queryByTestId('report-download-pdf')).toBeNull();
    expect(screen.queryByTestId('report-run-again')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(REPORT_POLL_INTERVAL_MS);
    });
    await act(async () => {
      vi.advanceTimersByTime(REPORT_POLL_INTERVAL_MS);
    });
    expect(mocks.getReport).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('report-status').textContent).toContain('Ready');
    expect(screen.getByTestId('report-download-pdf').textContent).toBe('PDF (2.4 MB)');
    expect(screen.getByTestId('report-download-xlsx').textContent).toBe('Excel (830 KB)');

    await act(async () => {
      vi.advanceTimersByTime(REPORT_POLL_INTERVAL_MS * 5);
    });
    expect(mocks.getReport).toHaveBeenCalledTimes(3);
  });

  it('downloads by fetching the file’s URL, then navigating to it', async () => {
    mocks.getReport.mockResolvedValue(reportRun());
    mocks.apiFetch.mockResolvedValue({ url: 'https://files.example/x.xlsx?sig=1', filename: 'x.xlsx', expires_at: 'z' });
    renderRun();
    fireEvent.click(await screen.findByTestId('report-download-xlsx'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://files.example/x.xlsx?sig=1'));
    expect(mocks.apiFetch).toHaveBeenCalledWith('/proxy/agency/reports/run-1/files/xlsx', {}, 't', 'a');
  });

  it('shows a refused download inline', async () => {
    mocks.getReport.mockResolvedValue(reportRun());
    mocks.apiFetch.mockRejectedValue(new ApiError(410, { code: 'report_expired', message: 'gone' }));
    renderRun();
    fireEvent.click(await screen.findByTestId('report-download-pdf'));
    expect((await screen.findByRole('alert')).textContent).toMatch(/expired and its files have been deleted/);
    expect(assign).not.toHaveBeenCalled();
  });

  it('says why a run failed, and Run again opens the new run', async () => {
    mocks.getReport.mockResolvedValue(reportRun({ status: 'failed', error: { code: 'render_timed_out', message: 'x' } }));
    mocks.retryReport.mockResolvedValue(reportRun({ id: 'run-2', status: 'queued' }));
    renderRun();
    expect((await screen.findByTestId('report-run-error')).textContent).toBe(
      'Building the files took too long and was stopped. Run it again.',
    );
    fireEvent.click(screen.getByTestId('report-run-again'));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/agency/reports/run-2'));
    expect(mocks.retryReport).toHaveBeenCalledWith('run-1', 't', 'a');
  });

  it('offers Run again on an expired run and shows a refusal inline', async () => {
    mocks.getReport.mockResolvedValue(reportRun({ status: 'expired' }));
    mocks.retryReport.mockRejectedValue(new ApiError(429, { code: 'report_queue_full', message: 'x' }));
    renderRun();
    expect(await screen.findByTestId('report-run-expired')).toBeTruthy();
    expect(screen.queryByTestId('report-download-pdf')).toBeNull();
    fireEvent.click(screen.getByTestId('report-run-again'));
    expect((await screen.findByTestId('report-run-again-error')).textContent).toMatch(/most reports being prepared/);
  });

  it('says what an agent’s own review leaves out, and when sheets were truncated', async () => {
    mocks.getReport.mockResolvedValue(reportRun({ audience: 'self', truncated: true }));
    renderRun();
    expect(await screen.findByText(/does not include comparisons with the rest of the floor/)).toBeTruthy();
    expect(screen.getByTestId('report-run-truncated')).toBeTruthy();
  });

  it('shows a run that is not there, with the way back', async () => {
    mocks.getReport.mockRejectedValue(new ApiError(404, { code: 'report_not_found', message: 'x' }));
    renderRun();
    expect(await screen.findByText('Report not available')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All reports' }).getAttribute('href')).toBe('/agency/reports');
  });

  it('sends a dedicated agent to their own frame', async () => {
    mocks.useTenant.mockReturnValue({ role: 'agent', tenantId: 't', accountId: 'a', accounts: [] });
    mocks.getReport.mockResolvedValue(reportRun());
    renderRun('run-7');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/dialer/reports/run-7'));
  });
});
