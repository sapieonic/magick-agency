import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgencyInboundSummary } from '@magick-agency/contracts/api/agency/inbound';

/**
 * The inbound summary (`docs/inbound.md` §11): supervisors only; the range presets and a custom
 * pair of dates, cut at local midnights (TZ is pinned to UTC for the run); the tiles and the
 * per-agent table as the server's numbers say; nothing yet is "no calls"; a bad custom range is
 * refused before any read. And the range helper on its own.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  access: { available: true, inboundOn: true, count: null, settled: true } as Record<string, unknown>,
  getInboundSummary: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useMissedCallsAccess', () => ({ useMissedCallsAccess: () => mocks.access }));
vi.mock('../../components/common/CapabilityUnavailable', () => ({
  CapabilityUnavailable: () => <div data-testid="capability-unavailable" />,
}));
vi.mock('../../components/common/PageDescription', () => ({ PageDescription: () => null }));
vi.mock('../../api/inbound', () => ({ getInboundSummary: mocks.getInboundSummary }));

import InboundSummaryPage from '../../pages/agency/InboundSummaryPage';
import { inboundSummaryRange } from '../../utils/inbound/inboundSummary';

const NOW = new Date('2026-11-09T15:30:00Z');

function summary(o: Partial<AgencyInboundSummary> = {}): AgencyInboundSummary {
  return {
    from: '2026-11-03T00:00:00.000Z', to: '2026-11-10T00:00:00.000Z', calls: 14, open_hours_calls: 11, after_hours: 2,
    answered: 5, answer_rate_pct: 45.5, abandoned: 2, abandon_rate_pct: 18.2, avg_answer_seconds: 40, p90_answer_seconds: 76,
    voicemails: 2, overflow: 2, not_served: 0, sticky_calls: 4, sticky_answered: 2, sticky_hit_rate_pct: 50, missed: 8,
    missed_handled: 1,
    agents: [
      { user_id: 'u-1', name: 'Asha', answered: 3, talk_seconds: 180 },
      { user_id: 'u-2', name: null, answered: 2, talk_seconds: 125 },
    ],
    ...o,
  };
}

async function renderPage(role = 'account_admin') {
  mocks.useTenant.mockReturnValue({ role, tenantId: 'tenant-1', accountId: 'account-1' });
  render(<MemoryRouter><InboundSummaryPage /></MemoryRouter>);
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.access = { available: true, inboundOn: true, count: null, settled: true };
  mocks.getInboundSummary.mockResolvedValue(summary());
});

describe('the range', () => {
  it('cuts the presets at local midnights up to the end of today', () => {
    expect(inboundSummaryRange('today', NOW)).toEqual({ ok: true, from: new Date('2026-11-09T00:00:00Z'), to: new Date('2026-11-10T00:00:00Z') });
    expect(inboundSummaryRange('7d', NOW)).toEqual({ ok: true, from: new Date('2026-11-03T00:00:00Z'), to: new Date('2026-11-10T00:00:00Z') });
    expect(inboundSummaryRange('30d', NOW)).toEqual({ ok: true, from: new Date('2026-10-11T00:00:00Z'), to: new Date('2026-11-10T00:00:00Z') });
  });

  it('takes two dates inclusive, and refuses a missing, reversed or too long range', () => {
    expect(inboundSummaryRange('custom', NOW, { from: '2026-11-01', to: '2026-11-02' }))
      .toEqual({ ok: true, from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-03T00:00:00Z') });
    expect(inboundSummaryRange('custom', NOW, { from: '2026-08-09', to: '2026-11-09' }).ok).toBe(true);
    expect(inboundSummaryRange('custom', NOW, { from: '2026-08-08', to: '2026-11-09' }))
      .toEqual({ ok: false, problem: 'Choose at most 93 days.' });
    expect(inboundSummaryRange('custom', NOW, { from: '2026-11-05', to: '2026-11-01' }).ok).toBe(false);
    expect(inboundSummaryRange('custom', NOW, { from: '', to: '2026-11-01' }).ok).toBe(false);
    expect(inboundSummaryRange('custom', NOW, { from: '2026-02-30', to: '2026-03-01' }).ok).toBe(false);
  });
});

describe('the page', () => {
  it('reads the last 7 days first and shows the tiles and the agents', async () => {
    await renderPage();
    expect(mocks.getInboundSummary).toHaveBeenCalledWith(
      { from: '2026-11-03T00:00:00.000Z', to: '2026-11-10T00:00:00.000Z' }, 'tenant-1', 'account-1');
    expect(screen.getByTestId('summary-preset-7d').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('summary-calls').textContent).toBe('1411 while open · 2 out of hours');
    expect(screen.getByTestId('summary-answered').textContent).toBe('45.5%5 of 11 while open');
    expect(screen.getByTestId('summary-abandoned').textContent).toBe('18.2%2 callers');
    expect(screen.getByTestId('summary-answer-time').textContent).toBe('40saverage · 9 in 10 within 1m 16s');
    expect(screen.getByTestId('summary-sticky').textContent).toBe('50%2 of 4 callers with an agent of their own');
    expect(screen.getByTestId('summary-missed').textContent).toBe('1 of 8');
    const asha = within(screen.getByTestId('summary-agent-u-1'));
    expect(asha.getByText('Asha')).toBeTruthy();
    expect(asha.getByText('3:00')).toBeTruthy();
    expect(asha.getByText('1:00')).toBeTruthy();
    // A name the server could not give: a former member. 125 s over 2 calls rounds to 1:03.
    const gone = within(screen.getByTestId('summary-agent-u-2'));
    expect(gone.getByText('Former member')).toBeTruthy();
    expect(gone.getByText('1:03')).toBeTruthy();
  });

  it('switches preset, and reads a custom range only when it is valid and applied', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('summary-preset-today'));
    await waitFor(() => expect(mocks.getInboundSummary).toHaveBeenLastCalledWith(
      { from: '2026-11-09T00:00:00.000Z', to: '2026-11-10T00:00:00.000Z' }, 'tenant-1', 'account-1'));
    const reads = mocks.getInboundSummary.mock.calls.length;
    fireEvent.click(screen.getByTestId('summary-preset-custom'));
    fireEvent.change(screen.getByTestId('summary-from'), { target: { value: '2026-11-05' } });
    fireEvent.change(screen.getByTestId('summary-to'), { target: { value: '2026-11-01' } });
    expect(screen.getByTestId('summary-range-problem').textContent).toContain('The start date is after the end date');
    expect((screen.getByTestId('summary-apply') as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.getInboundSummary.mock.calls.length).toBe(reads);
    fireEvent.change(screen.getByTestId('summary-to'), { target: { value: '2026-11-06' } });
    fireEvent.click(screen.getByTestId('summary-apply'));
    await waitFor(() => expect(mocks.getInboundSummary).toHaveBeenLastCalledWith(
      { from: '2026-11-05T00:00:00.000Z', to: '2026-11-07T00:00:00.000Z' }, 'tenant-1', 'account-1'));
  });

  it('says there were no calls, with no rates, rather than a page of zeros', async () => {
    mocks.getInboundSummary.mockResolvedValue(summary({
      calls: 0, open_hours_calls: 0, after_hours: 0, answered: 0, answer_rate_pct: null, agents: [],
    }));
    await renderPage();
    expect(screen.getByText('No inbound calls on these days')).toBeTruthy();
    expect(screen.queryByTestId('inbound-summary')).toBeNull();
  });

  it('a dash, not 0%, when a rate has nothing to divide by', async () => {
    mocks.getInboundSummary.mockResolvedValue(summary({ sticky_calls: 0, sticky_answered: 0, sticky_hit_rate_pct: null }));
    await renderPage();
    expect(screen.getByTestId('summary-sticky').textContent).toBe('—0 of 0 callers with an agent of their own');
  });

  it('is a supervisor`s, and follows the Missed list`s visibility with inbound off', async () => {
    await renderPage('agent');
    expect(screen.getByTestId('capability-unavailable')).toBeTruthy();
    expect(mocks.getInboundSummary).not.toHaveBeenCalled();
  });

  it('is unavailable with inbound off and nothing to read', async () => {
    mocks.access = { available: false, inboundOn: false, count: { open: 0, open_capped: false, has_rows: false }, settled: true };
    await renderPage();
    expect(screen.getByTestId('capability-unavailable')).toBeTruthy();
    expect(mocks.getInboundSummary).not.toHaveBeenCalled();
  });
});
