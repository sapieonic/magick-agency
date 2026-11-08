import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { REPORT_SUBSCRIPTION_MAX_RECIPIENTS } from '@magick-agency/contracts/api/agency/reports';
import { member, reportSubscription } from '../helpers/reports';

/**
 * Scheduled reports (`docs/reports.md`, supervisors only): the list (cadence in
 * words, recipients, next send, last run, enabled), pause and resume, delete behind
 * an in-page confirmation (never `window.confirm`), run now; and the form: the
 * cadence's own day field, the subject pickers, the recipient cap, what it sends.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  showToast: vi.fn(),
  listReportSubscriptions: vi.fn(),
  createReportSubscription: vi.fn(),
  updateReportSubscription: vi.fn(),
  deleteReportSubscription: vi.fn(),
  runReportSubscriptionNow: vi.fn(),
  listTenantMembers: vi.fn(),
  listAgencyCampaigns: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));
vi.mock('../../api/reports', async () => {
  const actual = await vi.importActual<typeof import('../../api/reports')>('../../api/reports');
  return {
    ...actual,
    listReportSubscriptions: mocks.listReportSubscriptions,
    createReportSubscription: mocks.createReportSubscription,
    updateReportSubscription: mocks.updateReportSubscription,
    deleteReportSubscription: mocks.deleteReportSubscription,
    runReportSubscriptionNow: mocks.runReportSubscriptionNow,
  };
});
vi.mock('../../api/tenants', () => ({ listTenantMembers: mocks.listTenantMembers }));
vi.mock('../../api/agencyCampaigns', () => ({ listAgencyCampaigns: mocks.listAgencyCampaigns }));
vi.mock('../../utils/reports/reportWindow', async () => {
  const actual = await vi.importActual<typeof import('../../utils/reports/reportWindow')>('../../utils/reports/reportWindow');
  return { ...actual, browserZone: () => 'Europe/London' };
});

import { SubscriptionsPanel } from '../../components/agency/reports/SubscriptionsPanel';
import { agentOptions, recipientOptions } from '../../components/agency/reports/SubscriptionFormDialog';
import { ApiError } from '../../api/client';

const MEMBERS = [
  member('account_admin', 'Asha Supervisor', { userId: 'sup-1' }),
  member('tenant_admin', 'Ravi Admin', { userId: 'sup-2', accountId: null }),
  member('agent', 'Priya S', { userId: 'agent-1' }),
  member('agent', 'Other Account Agent', { userId: 'agent-x', accountId: 'account-2' }),
  member('account_admin', 'Revoked Sup', { userId: 'sup-x', status: 'revoked' }),
];

function renderPanel() {
  return render(
    <MemoryRouter>
      <SubscriptionsPanel />
    </MemoryRouter>,
  );
}

const row = () => screen.getByTestId('subscription-row');
const confirmSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  window.confirm = confirmSpy;
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'account_admin',
    accounts: [{ id: 'account-1', name: 'North' }],
    membership: { user_id: 'sup-1' },
  });
  mocks.listReportSubscriptions.mockResolvedValue({ subscriptions: [reportSubscription()] });
  mocks.listTenantMembers.mockResolvedValue(MEMBERS);
  mocks.listAgencyCampaigns.mockResolvedValue([
    { id: 'camp-1', name: 'October dues', status: 'running', default_timezone: 'Asia/Kolkata' },
  ]);
});

describe('the list', () => {
  it('shows the subject, the cadence in words, recipients, next send, last run and the switch', async () => {
    renderPanel();
    await screen.findByTestId('subscription-row');
    expect(row().textContent).toContain('October dues');
    expect(row().textContent).toContain('Campaign report');
    expect(within(row()).getByTestId('subscription-cadence').textContent).toBe('Weekly on Monday at 08:30 (Asia/Kolkata)');
    expect(row().textContent).toContain('Asha Supervisor, Ravi Admin');
    expect(within(row()).getByTestId('report-status').getAttribute('data-status')).toBe('ready');
    expect((within(row()).getByRole('switch') as HTMLInputElement).checked).toBe(true);
  });

  it('pauses and resumes with a PATCH of enabled', async () => {
    mocks.updateReportSubscription.mockResolvedValue(reportSubscription({ enabled: false, next_run_at: null }));
    renderPanel();
    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() =>
      expect(mocks.updateReportSubscription).toHaveBeenCalledWith('sub-1', { enabled: false }, 'tenant-1', 'account-1'),
    );
    await waitFor(() => expect(row().textContent).toContain('Paused'));
    mocks.updateReportSubscription.mockResolvedValue(reportSubscription());
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() =>
      expect(mocks.updateReportSubscription).toHaveBeenLastCalledWith('sub-1', { enabled: true }, 'tenant-1', 'account-1'),
    );
  });

  it('deletes only after the in-page confirmation, never window.confirm', async () => {
    mocks.deleteReportSubscription.mockResolvedValue(undefined);
    renderPanel();
    await screen.findByTestId('subscription-row');
    fireEvent.click(within(row()).getByRole('button', { name: 'Delete' }));
    expect(mocks.deleteReportSubscription).not.toHaveBeenCalled();
    expect(within(row()).getByText('Delete this scheduled report?')).toBeTruthy();

    fireEvent.click(within(row()).getByRole('button', { name: 'Keep it' }));
    expect(within(row()).queryByText('Delete this scheduled report?')).toBeNull();

    fireEvent.click(within(row()).getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByTestId('subscription-confirm-delete'));
    await waitFor(() => expect(mocks.deleteReportSubscription).toHaveBeenCalledWith('sub-1', 'tenant-1', 'account-1'));
    await waitFor(() => expect(screen.queryByTestId('subscription-row')).toBeNull());
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('runs one now and toasts the email and a link to the run', async () => {
    mocks.runReportSubscriptionNow.mockResolvedValue({ id: 'run-5' });
    renderPanel();
    await screen.findByTestId('subscription-row');
    fireEvent.click(within(row()).getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled());
    expect(mocks.runReportSubscriptionNow).toHaveBeenCalledWith('sub-1', 'tenant-1', 'account-1');
    expect(mocks.showToast.mock.calls[0]![0]).toBe('The report is being prepared. We’ll email you when it’s ready.');
    expect(mocks.showToast.mock.calls[0]![3].label).toBe('View report');
  });

  it('shows a refused action on its row', async () => {
    mocks.runReportSubscriptionNow.mockRejectedValue(new ApiError(429, { code: 'report_queue_full', message: 'x' }));
    renderPanel();
    await screen.findByTestId('subscription-row');
    fireEvent.click(within(row()).getByRole('button', { name: 'Run now' }));
    expect((await within(row()).findByRole('alert')).textContent).toMatch(/most reports being prepared/);
  });

  it('offers the first one from an empty list', async () => {
    mocks.listReportSubscriptions.mockResolvedValue({ subscriptions: [] });
    renderPanel();
    expect(await screen.findByText('No scheduled reports')).toBeTruthy();
    expect(screen.getByTestId('subscription-new')).toBeTruthy();
  });
});

describe('the form', () => {
  async function openNew() {
    renderPanel();
    await screen.findByTestId('subscription-row');
    fireEvent.click(screen.getByTestId('subscription-new'));
    return screen.getByRole('dialog', { name: 'New scheduled report' });
  }

  it('shows the day field of the chosen cadence only, months up to the 28th', async () => {
    await openNew();
    expect(screen.getByLabelText('Day of the week')).toBeTruthy();
    expect(screen.queryByLabelText('Day of the month')).toBeNull();

    fireEvent.click(screen.getByLabelText('Monthly'));
    const monthday = screen.getByLabelText('Day of the month') as HTMLSelectElement;
    expect(screen.queryByLabelText('Day of the week')).toBeNull();
    expect(Array.from(monthday.options).map((o) => o.value)).toEqual(Array.from({ length: 28 }, (_, i) => String(i + 1)));

    fireEvent.click(screen.getByLabelText('Daily'));
    expect(screen.queryByLabelText('Day of the week')).toBeNull();
    expect(screen.queryByLabelText('Day of the month')).toBeNull();
    expect(screen.getByTestId('subscription-cadence-preview').textContent).toBe('Daily at 08:30 (Europe/London)');
  });

  it('creates an agent review subscription with the weekly day and the zone', async () => {
    mocks.createReportSubscription.mockResolvedValue(reportSubscription({ id: 'sub-2', kind: 'agent' }));
    await openNew();
    await waitFor(() => expect(screen.getByLabelText('Agent').tagName).toBe('SELECT'));
    // Only members on this account who can open a station; not another account's agent.
    const agentOptionsShown = Array.from((screen.getByLabelText('Agent') as HTMLSelectElement).options).map((o) => o.text);
    expect(agentOptionsShown).toEqual(['Choose an agent', 'Asha Supervisor', 'Priya S', 'Ravi Admin']);
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'agent-1' } });
    fireEvent.change(screen.getByLabelText('Day of the week'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '18:15' } });
    fireEvent.click(screen.getByTestId('subscription-recipient-sup-2'));
    fireEvent.click(screen.getByTestId('subscription-save'));
    await waitFor(() => expect(mocks.createReportSubscription).toHaveBeenCalled());
    expect(mocks.createReportSubscription.mock.calls[0]![0]).toEqual({
      kind: 'agent',
      subject_id: 'agent-1',
      cadence: 'weekly',
      send_local_time: '18:15',
      send_weekday: 5,
      send_monthday: null,
      timezone: 'Europe/London',
      formats: ['pdf', 'xlsx'],
      recipient_user_ids: ['sup-1', 'sup-2'],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows a campaign’s own zone and sends none', async () => {
    mocks.createReportSubscription.mockResolvedValue(reportSubscription({ id: 'sub-3' }));
    await openNew();
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'campaign' } });
    await waitFor(() => expect(screen.getByLabelText('Campaign').tagName).toBe('SELECT'));
    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: 'camp-1' } });
    expect(screen.queryByLabelText('Time zone')).toBeNull();
    expect(screen.getByTestId('subscription-campaign-zone').textContent).toBe('Asia/Kolkata, the campaign’s time zone');
    fireEvent.click(screen.getByLabelText('Monthly'));
    fireEvent.change(screen.getByLabelText('Day of the month'), { target: { value: '28' } });
    fireEvent.click(screen.getByTestId('subscription-save'));
    await waitFor(() => expect(mocks.createReportSubscription).toHaveBeenCalled());
    const body = mocks.createReportSubscription.mock.calls[0]![0];
    expect(body).toMatchObject({ kind: 'campaign', subject_id: 'camp-1', cadence: 'monthly', send_monthday: 28, send_weekday: null });
    expect(body).not.toHaveProperty('timezone');
  });

  it('needs a subject, a format and a recipient before it sends', async () => {
    await openNew();
    await waitFor(() => expect(screen.getByLabelText('Agent').tagName).toBe('SELECT'));
    fireEvent.click(screen.getByLabelText('PDF'));
    fireEvent.click(screen.getByLabelText('Excel'));
    fireEvent.click(screen.getByTestId('subscription-recipient-sup-1'));
    fireEvent.click(screen.getByTestId('subscription-save'));
    expect(screen.getByTestId('subscription-subject-error').textContent).toBe('Choose an agent.');
    expect(screen.getByTestId('subscription-formats-error').textContent).toBe('Choose at least one format.');
    expect(screen.getByTestId('subscription-recipients-error').textContent).toBe('Choose at least one recipient.');
    expect(mocks.createReportSubscription).not.toHaveBeenCalled();
  });

  it(`stops adding recipients at ${REPORT_SUBSCRIPTION_MAX_RECIPIENTS}`, async () => {
    const many = Array.from({ length: REPORT_SUBSCRIPTION_MAX_RECIPIENTS + 2 }, (_, i) =>
      member('account_admin', `Supervisor ${String(i).padStart(2, '0')}`, { userId: `s-${i}` }),
    );
    mocks.listTenantMembers.mockResolvedValue(many);
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'account_admin',
      accounts: [],
      membership: { user_id: 'nobody' },
    });
    await openNew();
    await waitFor(() => expect(screen.getByTestId('subscription-recipient-s-0')).toBeTruthy());
    for (let i = 0; i < REPORT_SUBSCRIPTION_MAX_RECIPIENTS; i += 1) {
      fireEvent.click(screen.getByTestId(`subscription-recipient-s-${i}`));
    }
    const extra = screen.getByTestId(`subscription-recipient-s-${REPORT_SUBSCRIPTION_MAX_RECIPIENTS}`) as HTMLInputElement;
    expect(extra.disabled).toBe(true);
    fireEvent.click(extra);
    expect(extra.checked).toBe(false);
    expect(screen.getByTestId('subscription-recipient-cap')).toBeTruthy();
    // One unticked frees a place again.
    fireEvent.click(screen.getByTestId('subscription-recipient-s-0'));
    expect(extra.disabled).toBe(false);
  });

  it('edits with the kind and subject fixed, and PATCHes only what changed', async () => {
    mocks.updateReportSubscription.mockResolvedValue(reportSubscription({ cadence: 'daily', send_weekday: null }));
    renderPanel();
    await screen.findByTestId('subscription-row');
    fireEvent.click(within(row()).getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('dialog', { name: 'Edit scheduled report' })).toBeTruthy();
    expect(screen.getByTestId('subscription-fixed-subject').textContent).toBe('Campaign report: October dues');
    expect(screen.queryByLabelText('Report')).toBeNull();
    fireEvent.click(screen.getByLabelText('Daily'));
    fireEvent.click(screen.getByTestId('subscription-save'));
    await waitFor(() => expect(mocks.updateReportSubscription).toHaveBeenCalled());
    const [id, patch] = mocks.updateReportSubscription.mock.calls[0]!;
    expect(id).toBe('sub-1');
    // The cadence and the weekday it no longer has; not the time, formats or recipients.
    expect(patch).toEqual({ cadence: 'daily', send_weekday: null });
    await waitFor(() => expect(within(row()).getByTestId('subscription-cadence').textContent).toBe('Daily at 08:30 (Asia/Kolkata)'));
  });

  async function openEdit() {
    renderPanel();
    await screen.findByTestId('subscription-row');
    fireEvent.click(within(row()).getByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(screen.getByTestId('subscription-recipient-sup-1')).toBeTruthy());
  }

  it('sends a recipients-and-formats edit without any schedule field', async () => {
    mocks.updateReportSubscription.mockResolvedValue(reportSubscription());
    await openEdit();
    fireEvent.click(screen.getByTestId('subscription-recipient-sup-2'));
    fireEvent.click(screen.getByLabelText('Excel'));
    fireEvent.click(screen.getByTestId('subscription-save'));
    await waitFor(() => expect(mocks.updateReportSubscription).toHaveBeenCalled());
    expect(mocks.updateReportSubscription.mock.calls[0]![1]).toEqual({ formats: ['pdf'], recipient_user_ids: ['sup-1'] });
  });

  it('sends only the zone of an agent review whose zone changed', async () => {
    mocks.listReportSubscriptions.mockResolvedValue({
      subscriptions: [reportSubscription({ kind: 'agent', subject: { id: 'agent-1', name: 'Priya S' }, timezone: 'Asia/Kolkata' })],
    });
    mocks.updateReportSubscription.mockResolvedValue(reportSubscription({ kind: 'agent', timezone: 'Europe/London' }));
    await openEdit();
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Europe/London' } });
    fireEvent.click(screen.getByTestId('subscription-save'));
    await waitFor(() => expect(mocks.updateReportSubscription).toHaveBeenCalled());
    expect(mocks.updateReportSubscription.mock.calls[0]![1]).toEqual({ timezone: 'Europe/London' });
  });

  it('closes an edit that changed nothing without a request', async () => {
    await openEdit();
    // Untick and tick again: the same set, in another order.
    fireEvent.click(screen.getByTestId('subscription-recipient-sup-1'));
    fireEvent.click(screen.getByTestId('subscription-recipient-sup-1'));
    fireEvent.click(screen.getByTestId('subscription-save'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mocks.updateReportSubscription).not.toHaveBeenCalled();
  });

  it('shows the server’s refusal in the form', async () => {
    mocks.createReportSubscription.mockRejectedValue(new ApiError(400, { code: 'report_recipient_invalid', message: 'x' }));
    await openNew();
    await waitFor(() => expect(screen.getByLabelText('Agent').tagName).toBe('SELECT'));
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'agent-1' } });
    fireEvent.click(screen.getByTestId('subscription-save'));
    expect((await screen.findByTestId('subscription-submit-error')).textContent).toMatch(/Recipients must be supervisors/);
  });
});

describe('the pickers', () => {
  it('offer agents and recipients from active memberships on this account only', () => {
    expect(agentOptions(MEMBERS, 'account-1').map((m) => m.userId)).toEqual(['sup-1', 'agent-1', 'sup-2']);
    expect(recipientOptions(MEMBERS, 'account-1').map((m) => m.userId)).toEqual(['sup-1', 'sup-2']);
  });
});
