import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { AgencyReportRunPage } from '@magick-agency/contracts/api/agency/reports';
import { reportRun, reportSubscription } from '../helpers/reports';

/**
 * The Reports page (`docs/reports.md`): History, keyset-paged by "Load more", with
 * a kind filter and "Only mine" for supervisors; Subscriptions for supervisors only;
 * an agent sees their own runs and the self-export entry; the flag off shows the
 * unavailable screen; a dedicated agent is sent to their own frame.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  flags: { agency_reports_enabled: true } as Record<string, boolean>,
  listReports: vi.fn(),
  getReport: vi.fn(),
  listReportSubscriptions: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'sup-1', display_name: 'Asha', email: 'a@x' } }) }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({
  SOFTPHONE_FLAG: 'agency_softphone_enabled',
  useFeatureFlagEnabled: (flag: string) => mocks.flags[flag] === true,
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }),
}));
vi.mock('../../components/common/CapabilityUnavailable', () => ({
  CapabilityUnavailable: () => <div data-testid="capability-unavailable" />,
}));
vi.mock('../../api/reports', async () => {
  const actual = await vi.importActual<typeof import('../../api/reports')>('../../api/reports');
  return {
    ...actual,
    listReports: mocks.listReports,
    getReport: mocks.getReport,
    listReportSubscriptions: mocks.listReportSubscriptions,
  };
});

import ReportsPage, { AgentReportsPage } from '../../pages/agency/ReportsPage';

function Where() {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}`}</div>;
}

function renderAt(path = '/agency/reports') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/agency/reports" element={<ReportsPage />} />
        <Route path="/dialer/reports" element={<AgentReportsPage />} />
        <Route path="/agency/reports/:runId" element={<div data-testid="run-page" />} />
      </Routes>
    </MemoryRouter>,
  );
}

function tenant(role: string) {
  mocks.useTenant.mockReturnValue({
    role,
    tenantId: 'tenant-1',
    accountId: 'account-1',
    accounts: [{ id: 'account-1', name: 'North' }],
    accountResolution: 'ready',
    accountError: null,
    reloadAccounts: vi.fn(),
  });
}

const page = (runs: AgencyReportRunPage['runs'], next: string | null = null): AgencyReportRunPage => ({ runs, next_cursor: next });
const rows = () => screen.queryAllByTestId('report-history-row');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flags = { agency_reports_enabled: true };
  tenant('account_admin');
  mocks.listReportSubscriptions.mockResolvedValue({ subscriptions: [reportSubscription()] });
});

describe('History', () => {
  it('lists runs newest first with kind, subject, window, requester, status and downloads', async () => {
    mocks.listReports.mockResolvedValue(
      page([
        reportRun({ id: 'r1' }),
        reportRun({ id: 'r2', kind: 'campaign', subject: { id: 'c', name: 'October dues' }, status: 'failed', requested_by: null, subscription_id: 'sub-1' }),
      ]),
    );
    renderAt();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(mocks.listReports).toHaveBeenCalledWith({ limit: 25 }, 'tenant-1', 'account-1');
    const [first, second] = rows() as [HTMLElement, HTMLElement];
    expect(first.textContent).toContain('Agent review');
    expect(first.textContent).toContain('Priya S');
    expect(first.textContent).toContain('9 Oct – 7 Nov 2026');
    expect(first.textContent).toContain('Asia/Kolkata');
    expect(first.textContent).toContain('Asha Supervisor');
    expect(within(first).getByTestId('report-status').getAttribute('data-status')).toBe('ready');
    expect(within(first).getByTestId('report-download-pdf')).toBeTruthy();
    expect(within(first).getByRole('link', { name: 'Priya S' }).getAttribute('href')).toBe('/agency/reports/r1');
    expect(second.textContent).toContain('Campaign report');
    expect(second.textContent).toContain('Scheduled');
    expect(within(second).queryByTestId('report-download-pdf')).toBeNull();
  });

  it('pages by the server’s cursor with Load more, and stops on the last page', async () => {
    mocks.listReports
      .mockResolvedValueOnce(page([reportRun({ id: 'r1' })], 'cursor-2'))
      .mockResolvedValueOnce(page([reportRun({ id: 'r2' })], null));
    renderAt();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(mocks.listReports).toHaveBeenLastCalledWith({ cursor: 'cursor-2', limit: 25 }, 'tenant-1', 'account-1');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('re-reads from the first page when the kind filter changes', async () => {
    mocks.listReports.mockResolvedValue(page([reportRun({ id: 'r1' })], 'cursor-2'));
    renderAt();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'campaign' } });
    await waitFor(() => expect(mocks.listReports).toHaveBeenLastCalledWith({ limit: 25, kind: 'campaign' }, 'tenant-1', 'account-1'));
  });

  it('Only mine keeps the runs the signed-in supervisor requested', async () => {
    mocks.listReports.mockResolvedValue(
      page([
        reportRun({ id: 'mine' }),
        reportRun({ id: 'theirs', requested_by: { user_id: 'sup-2', name: 'Ravi' } }),
        reportRun({ id: 'scheduled', requested_by: null, subscription_id: 'sub-1' }),
      ]),
    );
    renderAt();
    await waitFor(() => expect(rows()).toHaveLength(3));
    fireEvent.click(screen.getByLabelText('Only mine'));
    expect(rows().map((r) => r.getAttribute('data-run-id'))).toEqual(['mine']);
  });

  it('says so when there are no reports yet', async () => {
    mocks.listReports.mockResolvedValue(page([]));
    renderAt();
    expect(await screen.findByText('No reports yet')).toBeTruthy();
  });

  it('shows a failed read with a retry', async () => {
    mocks.listReports.mockRejectedValueOnce(new Error('Network down')).mockResolvedValueOnce(page([reportRun()]));
    renderAt();
    expect(await screen.findByText('Network down')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(rows()).toHaveLength(1));
  });
});

describe('who sees what', () => {
  it('names the list Exports, as its tab does; one file is still a report', async () => {
    mocks.listReports.mockResolvedValue(page([]));
    renderAt();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Exports');
    expect(screen.getByRole('tablist', { name: 'Exports' })).toBeTruthy();
    expect(screen.getByTestId('report-entry-reports_page').textContent).toBe('Export account report');
  });

  it('gives a supervisor both tabs, the account export, and the subscriptions list', async () => {
    mocks.listReports.mockResolvedValue(page([]));
    renderAt();
    expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('report-entry-reports_page').textContent).toBe('Export account report');
    fireEvent.click(screen.getByRole('tab', { name: 'Subscriptions' }));
    expect(await screen.findByTestId('subscription-row')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/agency/reports?tab=subscriptions');
  });

  it('gives a viewer only their history, no filters, no tabs, and only the self export', async () => {
    tenant('viewer');
    mocks.listReports.mockResolvedValue(page([reportRun()]));
    renderAt('/agency/reports?tab=subscriptions');
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByLabelText('Kind')).toBeNull();
    expect(screen.queryByLabelText('Only mine')).toBeNull();
    expect(mocks.listReportSubscriptions).not.toHaveBeenCalled();
    expect(screen.getByTestId('report-entry-reports_page').textContent).toBe('Export my review');
  });

  it('sends a dedicated agent on the agency path to their own frame', async () => {
    tenant('agent');
    mocks.listReports.mockResolvedValue(page([]));
    renderAt('/agency/reports');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/dialer/reports'));
  });

  it('serves a dedicated agent My reports in their frame, with the agent nav', async () => {
    tenant('agent');
    mocks.listReports.mockResolvedValue(page([]));
    renderAt('/dialer/reports');
    expect(await screen.findByRole('heading', { name: 'My reports' })).toBeTruthy();
    expect(screen.getByTestId('agent-nav-reports').getAttribute('data-current')).toBe('true');
    expect(screen.getByTestId('report-entry-reports_page').textContent).toBe('Export my review');
  });

  it('shows the unavailable screen, and reads nothing, while the flag is off', () => {
    mocks.flags = {};
    renderAt();
    expect(screen.getByTestId('capability-unavailable')).toBeTruthy();
    expect(mocks.listReports).not.toHaveBeenCalled();
  });
});
