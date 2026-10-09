import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  getUsageCounts: vi.fn(),
  getTenantAccounts: vi.fn(),
  listTenants: vi.fn(),
}));
vi.mock('../../api/super-admin', () => ({
  getUsageCounts: mocks.getUsageCounts,
  getTenantAccounts: mocks.getTenantAccounts,
  listTenants: mocks.listTenants,
}));

import SAUsagePage, { formatSeconds } from '../../pages/super-admin/SAUsagePage';

const counts = (n: number) => ({ dials: n, answered_calls: n - 1, connected_calls: n - 2, talk_seconds: n * 61, analysis_audio_seconds: n * 3 });

const RESPONSE = {
  from: '2026-02-09T00:00:00.000Z',
  to: '2026-03-11T00:00:00.000Z',
  totals: { dials: 30, answered_calls: 27, connected_calls: 24, talk_seconds: 3661, analysis_audio_seconds: 90 },
  tenants: [
    {
      tenant_id: 't-1', tenant_name: 'Acme', counts: counts(10),
      accounts: [
        { account_id: 'a-1', account_name: 'Acme North', counts: counts(6) },
        { account_id: 'a-2', account_name: 'Acme South', counts: counts(4) },
      ],
    },
    { tenant_id: 't-2', tenant_name: 'Globex', counts: counts(20), accounts: [{ account_id: 'a-3', account_name: 'Globex Main', counts: counts(20) }] },
  ],
};

function renderPage(entry = '/usage') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes><Route path="/usage" element={<SAUsagePage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUsageCounts.mockResolvedValue(RESPONSE);
  mocks.getTenantAccounts.mockResolvedValue([{ id: 'a-1', name: 'Acme North' }, { id: 'a-2', name: 'Acme South' }]);
  mocks.listTenants.mockResolvedValue({
    tenants: [
      { id: 't-1', name: 'Acme', slug: 'acme' },
      { id: 't-2', name: 'Globex', slug: 'globex' },
    ],
  });
});

describe('formatSeconds', () => {
  it.each([
    [0, '0:00:00'],
    [59, '0:00:59'],
    [61, '0:01:01'],
    [3661, '1:01:01'],
    [360000, '100:00:00'],
    [-5, '0:00:00'],
  ])('%i s -> %s', (s, out) => expect(formatSeconds(s)).toBe(out));
});

describe('SAUsagePage', () => {
  it('defaults to the last 30 days and asks the server for a half-open window', async () => {
    renderPage();
    await waitFor(() => expect(mocks.getUsageCounts).toHaveBeenCalled());
    const q = mocks.getUsageCounts.mock.calls[0]![0] as { from: string; to: string };
    expect(Date.parse(q.to) - Date.parse(q.from)).toBe(30 * 86_400_000);
    expect(q).not.toHaveProperty('tenant_id');
    expect(screen.getByRole('button', { name: 'Last 30 days' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows the exact totals, with the second count in the subtitle', async () => {
    renderPage();
    await screen.findByText('Talk time');
    expect(screen.getByText('1:01:01')).toBeTruthy();
    expect(screen.getByText('3,661 s')).toBeTruthy();
    expect(screen.getByText('30')).toBeTruthy();
  });

  it('lists a row per tenant, and account rows only when "Show accounts" is on', async () => {
    renderPage();
    await screen.findByText('Acme');
    expect(screen.getByText('Globex')).toBeTruthy();
    expect(screen.queryByText('Acme North')).toBeNull();

    fireEvent.click(screen.getByLabelText('Show accounts'));
    expect(await screen.findByText('Acme North')).toBeTruthy();
    expect(screen.getByText('Acme South')).toBeTruthy();
    expect(screen.getByText('Globex Main')).toBeTruthy();
  });

  it('puts the exact seconds in the title of a duration cell', async () => {
    renderPage();
    await screen.findByText('Acme');
    const row = screen.getByText('Acme').closest('tr')!;
    // 10 dials -> 610 talk seconds -> 0:10:10
    expect(within(row).getByTitle('610 s').textContent).toBe('0:10:10');
  });

  it('says counts only, nothing charged, and that the window is on the dial time', async () => {
    renderPage();
    await screen.findByText('Acme');
    expect(screen.getByText(/nothing is charged/i)).toBeTruthy();
    expect(screen.getByText(/dial time/i)).toBeTruthy();
  });

  it('shows an empty state when no tenant has activity', async () => {
    mocks.getUsageCounts.mockResolvedValue({ ...RESPONSE, totals: counts(0), tenants: [] });
    renderPage();
    expect(await screen.findByText('No activity in this window')).toBeTruthy();
  });

  it('shows the error with a retry that asks again', async () => {
    mocks.getUsageCounts.mockRejectedValueOnce(new Error('Failed hard'));
    renderPage();
    expect(await screen.findByText(/Failed hard/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('Acme');
    expect(mocks.getUsageCounts).toHaveBeenCalledTimes(2);
  });

  it('reads the preset from the URL', async () => {
    renderPage('/usage?period=7d');
    await waitFor(() => expect(mocks.getUsageCounts).toHaveBeenCalled());
    const q = mocks.getUsageCounts.mock.calls[0]![0] as { from: string; to: string };
    expect(Date.parse(q.to) - Date.parse(q.from)).toBe(7 * 86_400_000);
    expect(screen.getByRole('button', { name: 'Last 7 days' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('switching preset re-requests with the new span', async () => {
    renderPage();
    await screen.findByText('Acme');
    fireEvent.click(screen.getByRole('button', { name: 'Last 90 days' }));
    await waitFor(() => expect(mocks.getUsageCounts).toHaveBeenCalledTimes(2));
    const q = mocks.getUsageCounts.mock.calls[1]![0] as { from: string; to: string };
    expect(Date.parse(q.to) - Date.parse(q.from)).toBe(90 * 86_400_000);
  });

  it('a custom range sends the day AFTER the picked end day as `to`', async () => {
    renderPage('/usage?period=custom&from=2026-03-01&to=2026-03-03');
    await waitFor(() => expect(mocks.getUsageCounts).toHaveBeenCalled());
    expect(mocks.getUsageCounts).toHaveBeenCalledWith({
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-03-04T00:00:00.000Z',
    });
  });

  it('refuses a custom range over 400 days with a message and no request', async () => {
    renderPage('/usage?period=custom&from=2025-01-01&to=2026-03-01');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/at most 400 days/);
    expect(mocks.getUsageCounts).not.toHaveBeenCalled();
  });

  it('refuses an end date before the start with no request', async () => {
    renderPage('/usage?period=custom&from=2026-03-05&to=2026-03-01');
    expect((await screen.findByRole('alert')).textContent).toMatch(/on or before/);
    expect(mocks.getUsageCounts).not.toHaveBeenCalled();
  });

  it('offers the account filter only once a tenant is chosen', async () => {
    renderPage();
    await screen.findByText('Acme');
    expect(screen.queryByLabelText('Account')).toBeNull();
    expect(mocks.getTenantAccounts).not.toHaveBeenCalled();
  });

  it('with ?tenant= it loads that tenant\'s accounts and sends tenant_id', async () => {
    renderPage('/usage?tenant=t-1');
    const select = await screen.findByLabelText('Account');
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Acme North' })).toBeTruthy());
    expect(mocks.getTenantAccounts).toHaveBeenCalledWith('t-1');
    expect(mocks.getUsageCounts.mock.calls[0]![0]).toMatchObject({ tenant_id: 't-1' });
    expect(mocks.getUsageCounts.mock.calls[0]![0]).not.toHaveProperty('account_id');
  });

  it('choosing an account sends account_id with the tenant', async () => {
    renderPage('/usage?tenant=t-1');
    const select = await screen.findByLabelText('Account');
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Acme South' })).toBeTruthy());
    fireEvent.change(select, { target: { value: 'a-2' } });
    await waitFor(() => expect(mocks.getUsageCounts).toHaveBeenLastCalledWith(
      expect.objectContaining({ tenant_id: 't-1', account_id: 'a-2' }),
    ));
  });

  it('ignores a stray ?account= without a tenant (the server would 400)', async () => {
    renderPage('/usage?account=a-2');
    await waitFor(() => expect(mocks.getUsageCounts).toHaveBeenCalled());
    expect(mocks.getUsageCounts.mock.calls[0]![0]).not.toHaveProperty('account_id');
  });
});
