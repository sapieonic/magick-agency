import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { reportRun } from '../helpers/reports';

/**
 * The export dialog (`docs/reports.md`): the presets compute the right local dates
 * in the report's zone; a custom window is held to the contract's rule (at most 30
 * days, or exactly one calendar month); at least one format; the request it sends
 * per kind (agent and account carry the zone, campaign does not and shows the
 * campaign's); the 202 toast with its link; the server's refusals inline; Escape.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  createReport: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));
vi.mock('../../api/reports', async () => {
  const actual = await vi.importActual<typeof import('../../api/reports')>('../../api/reports');
  return { ...actual, createReport: mocks.createReport };
});
vi.mock('../../utils/reports/reportWindow', async () => {
  const actual = await vi.importActual<typeof import('../../utils/reports/reportWindow')>('../../utils/reports/reportWindow');
  // The browser's zone, pinned: the unit project runs in UTC.
  return { ...actual, browserZone: () => 'Asia/Kolkata' };
});

import { ExportReportDialog, type ExportReportTarget } from '../../components/agency/reports/ExportReportDialog';
import { ApiError } from '../../api/client';

// 20:00 UTC on Sunday 8 Nov 2026: already Monday 9 Nov in Kolkata, still 8 Nov in New York.
const NOW = new Date('2026-11-08T20:00:00Z');

const AGENT: ExportReportTarget = { kind: 'agent', subject: { id: 'agent-1', name: 'Priya S' } };
const CAMPAIGN: ExportReportTarget = {
  kind: 'campaign',
  subject: { id: 'camp-1', name: 'October dues' },
  campaignTimezone: 'America/New_York',
};

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

function renderDialog(target: ExportReportTarget = AGENT, onClose = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/agency/analytics']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <Where />
              <ExportReportDialog open onClose={onClose} target={target} entry="agent_record" now={NOW} />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { onClose };
}

const submit = () => fireEvent.click(screen.getByTestId('report-export-submit'));
const sent = () => mocks.createReport.mock.calls[0]![0];
const choose = (label: string) => fireEvent.click(screen.getByLabelText(label));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin' });
  mocks.createReport.mockResolvedValue(reportRun({ id: 'run-42', status: 'queued' }));
});

describe('ExportReportDialog — the window', () => {
  it('opens on Last 7 days, ending today in the chosen zone', async () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Export agent review' })).toBeTruthy();
    expect((screen.getByLabelText('Last 7 days') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('report-window-summary').textContent).toBe('3 Nov – 9 Nov 2026');
    submit();
    await waitFor(() => expect(mocks.createReport).toHaveBeenCalled());
    expect(sent()).toMatchObject({ from: '2026-11-03', to: '2026-11-09', timezone: 'Asia/Kolkata' });
  });

  it.each([
    ['Last 30 days', '2026-10-11', '2026-11-09'],
    ['Previous week', '2026-11-02', '2026-11-08'],
    ['Previous month', '2026-10-01', '2026-10-31'],
  ])('%s sends %s to %s', async (label, from, to) => {
    renderDialog();
    choose(label);
    submit();
    await waitFor(() => expect(mocks.createReport).toHaveBeenCalled());
    expect(sent()).toMatchObject({ from, to });
  });

  it('recomputes today when the zone changes', async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'America/New_York' } });
    expect(screen.getByTestId('report-window-summary').textContent).toBe('2 Nov – 8 Nov 2026');
    submit();
    await waitFor(() => expect(mocks.createReport).toHaveBeenCalled());
    expect(sent()).toMatchObject({ from: '2026-11-02', to: '2026-11-08', timezone: 'America/New_York' });
  });

  it('holds a custom window to the shared rule: 31 days across two months is refused', async () => {
    renderDialog();
    choose('Custom');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-09' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-08' } });
    expect(screen.getByTestId('report-window-error').textContent).toMatch(/at most 30 days, or exactly one calendar month/);
    expect(screen.getByLabelText('From').getAttribute('aria-invalid')).toBe('true');
    submit();
    await act(async () => {});
    expect(mocks.createReport).not.toHaveBeenCalled();
  });

  it('accepts a custom window of exactly one 31-day calendar month', async () => {
    renderDialog();
    choose('Custom');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-31' } });
    expect(screen.queryByTestId('report-window-error')).toBeNull();
    submit();
    await waitFor(() => expect(mocks.createReport).toHaveBeenCalled());
    expect(sent()).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('refuses a custom end after today, and an empty custom window on submit', async () => {
    renderDialog();
    choose('Custom');
    submit();
    expect(screen.getByTestId('report-window-error').textContent).toBe('Choose a start and an end date.');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-10' } });
    expect(screen.getByTestId('report-window-error').textContent).toMatch(/no later than today/);
    expect(mocks.createReport).not.toHaveBeenCalled();
  });
});

describe('ExportReportDialog — zone, formats and email', () => {
  it('shows a campaign report’s zone read-only and sends no timezone', async () => {
    renderDialog(CAMPAIGN);
    expect(screen.queryByLabelText('Time zone')).toBeNull();
    expect(screen.getByTestId('report-campaign-zone').textContent).toBe(
      'Days are cut in America/New_York, the campaign’s time zone.',
    );
    // Today in New York is still 8 Nov.
    expect(screen.getByTestId('report-window-summary').textContent).toBe('2 Nov – 8 Nov 2026');
    submit();
    await waitFor(() => expect(mocks.createReport).toHaveBeenCalled());
    expect(sent()).toEqual({
      kind: 'campaign',
      subject_id: 'camp-1',
      from: '2026-11-02',
      to: '2026-11-08',
      formats: ['pdf', 'xlsx'],
    });
  });

  it('names no zone for a campaign whose zone is unknown, and bounds dates by the browser’s', async () => {
    renderDialog({ ...CAMPAIGN, campaignTimezone: null });
    expect(screen.getByTestId('report-campaign-zone').textContent).toBe('Days are cut in the campaign’s time zone.');
    // The browser is in Kolkata, where it is already 9 Nov (UTC would still say 8 Nov).
    expect(screen.getByTestId('report-window-summary').textContent).toBe('3 Nov – 9 Nov 2026');
    submit();
    await waitFor(() => expect(mocks.createReport).toHaveBeenCalled());
    expect(sent()).toEqual({
      kind: 'campaign',
      subject_id: 'camp-1',
      from: '2026-11-03',
      to: '2026-11-09',
      formats: ['pdf', 'xlsx'],
    });
  });

  it('requires at least one format', async () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText('PDF'));
    fireEvent.click(screen.getByLabelText('Excel'));
    submit();
    expect(screen.getByTestId('report-format-error').textContent).toBe('Choose at least one format.');
    await act(async () => {});
    expect(mocks.createReport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Excel'));
    submit();
    await waitFor(() => expect(mocks.createReport).toHaveBeenCalled());
    expect(sent().formats).toEqual(['xlsx']);
  });

  it('sends email_me only when asked', async () => {
    renderDialog();
    fireEvent.click(screen.getByLabelText('Email me when it’s ready'));
    submit();
    await waitFor(() => expect(mocks.createReport).toHaveBeenCalled());
    expect(sent()).toMatchObject({ kind: 'agent', subject_id: 'agent-1', email_me: true });
  });

  it('says what an agent’s own review leaves out', () => {
    renderDialog({ ...AGENT, selfAudience: true });
    expect(screen.getByRole('dialog', { name: 'Export my review' })).toBeTruthy();
    expect(screen.getByTestId('report-self-note').textContent).toMatch(/does not include comparisons with the rest of the floor/);
  });
});

describe('ExportReportDialog — submission', () => {
  it('on 202 closes, and toasts a link that opens the run', async () => {
    const { onClose } = renderDialog();
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    const [message, type, , action] = mocks.showToast.mock.calls[0]!;
    expect(message).toBe('Your agent review is being prepared.');
    expect(type).toBe('success');
    expect(action.label).toBe('View report');
    act(() => action.onClick());
    expect(screen.getByTestId('where').textContent).toBe('/agency/reports/run-42');
  });

  it('links a dedicated agent to their own frame', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'agent' });
    renderDialog({ ...AGENT, selfAudience: true });
    submit();
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());
    act(() => mocks.showToast.mock.calls[0]![3].onClick());
    expect(screen.getByTestId('where').textContent).toBe('/dialer/reports/run-42');
  });

  it.each([
    ['report_queue_full', 429, /most reports being prepared at once/],
    ['report_rate_limited', 429, /several reports in the last minute/],
    ['report_window_too_long', 400, /at most 30 days/],
    ['feature_disabled', 403, /aren’t turned on/],
  ])('shows %s inline and stays open', async (code, status, words) => {
    mocks.createReport.mockRejectedValue(new ApiError(status, { error: 'x', code, message: 'server words' }));
    const { onClose } = renderDialog();
    submit();
    const error = await screen.findByTestId('report-submit-error');
    expect(error.textContent).toMatch(words);
    expect(error.getAttribute('role')).toBe('alert');
    expect(onClose).not.toHaveBeenCalled();
    expect(mocks.showToast).not.toHaveBeenCalled();
    // The button is usable again for a second try.
    expect((screen.getByTestId('report-export-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('closes on Escape', () => {
    const { onClose } = renderDialog();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('labels every field', () => {
    renderDialog();
    for (const input of Array.from(document.querySelectorAll('input, select'))) {
      const id = input.getAttribute('id');
      const labelled = input.closest('label') !== null || (id !== null && document.querySelector(`label[for="${id}"]`) !== null);
      expect(labelled, input.outerHTML).toBe(true);
    }
  });
});
