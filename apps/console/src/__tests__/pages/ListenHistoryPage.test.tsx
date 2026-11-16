import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { historyEntry } from '../helpers/listenHistory';

/**
 * The account's Listening history (`docs/listening.md` §12, LS19) at `/agency/listening-history`:
 * every column in words, the link to the call where there is one, the filters as the route's
 * query, keyset paging, the CSV with the same filters and its truncation, and the states: a
 * refusal that is final (`feature_disabled`), one that is not (`503 listen_unavailable`, read
 * again on its own), empty, loading and a reader below `agency.supervise`.
 */

const mocks = vi.hoisted(() => ({
  listListenHistory: vi.fn(),
  downloadListenHistoryCsv: vi.fn(),
  listTenantMembers: vi.fn(),
  showToast: vi.fn(),
  showErrorToast: vi.fn(),
  downloadBlob: vi.fn(),
  role: 'account_admin' as string,
}));

vi.mock('../../api/listenHistory', () => ({
  listListenHistory: mocks.listListenHistory,
  downloadListenHistoryCsv: mocks.downloadListenHistoryCsv,
}));
vi.mock('../../api/tenants', () => ({ listTenantMembers: mocks.listTenantMembers }));
vi.mock('../../utils/agency/insights/csv', () => ({ downloadBlob: mocks.downloadBlob }));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 't-1', accountId: 'a-1', role: mocks.role }),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: mocks.showErrorToast }),
}));

import ListenHistoryPage from '../../pages/agency/live/ListenHistoryPage';

const ANITA_PRIYA = historyEntry();
const WITHHELD = historyEntry({
  id: 'l-2',
  listen_ids: ['l-2', 'l-3'],
  call_id: 'call-2',
  origin: 'inbound',
  correlation_id: 'in-2',
  campaign_id: null,
  campaign_name: null,
  inbound_route_name: 'Support line',
  listener_user_id: 'sup-2',
  listener_name: 'Rohan Shah',
  agent_user_id: 'u-2',
  agent_name: 'Arjun Nair',
  customer_name: null,
  customer_phone_masked: null,
  customer_phone_withheld: true,
  started_at: '2026-11-16T09:00:00.000Z',
  ended_at: '2026-11-16T09:00:45.000Z',
  listened_seconds: 45,
  end_reason: 'access_unverified',
});
const GONE = historyEntry({
  id: 'l-4',
  call_id: 'call-4',
  origin: 'manual',
  correlation_id: 'man-4',
  campaign_id: null,
  customer_name: null,
  customer_phone_masked: null,
  customer_phone_withheld: false,
  started_at: '2026-11-15T09:00:00.000Z',
});
const OPEN = historyEntry({ id: 'l-5', call_id: 'call-5', ended_at: null, listened_seconds: null, end_reason: null, started_at: '2026-11-16T10:05:00.000Z' });

function member(id: string, name: string, role: string) {
  return { membership: { id: `m-${id}`, user_id: id, role, account_id: null, status: 'active' }, user: { id, email: `${id}@example.com`, display_name: name } };
}

async function renderPage() {
  const view = render(
    <MemoryRouter>
      <ListenHistoryPage />
    </MemoryRouter>,
  );
  await act(async () => {});
  return view;
}

const rowOf = (id: string) => within(screen.getByTestId(`listen-history-row-${id}`));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  Object.values(mocks).forEach((m) => typeof m === 'function' && m.mockReset());
  mocks.role = 'account_admin';
  mocks.listListenHistory.mockResolvedValue({ entries: [ANITA_PRIYA, WITHHELD, GONE], next_cursor: null });
  mocks.listTenantMembers.mockResolvedValue([
    member('sup-1', 'Anita Kapoor', 'account_admin'),
    member('sup-2', 'Rohan Shah', 'tenant_admin'),
    member('u-1', 'Priya Sharma', 'agent'),
    member('u-2', 'Arjun Nair', 'agent'),
  ]);
  mocks.downloadListenHistoryCsv.mockResolvedValue({
    blob: new Blob(['started_at\n']),
    filename: 'listening-history-2026-11-16.csv',
    truncated: false,
    reason: null,
    rowLimit: null,
    rows: 3,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('/agency/listening-history', () => {
  it('lists each listen in words, newest first, under an h1', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Listening history' })).toBeTruthy();
    expect(mocks.listListenHistory).toHaveBeenCalledWith({ limit: 50 }, 't-1', 'a-1');
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Supervisor', 'Agent', 'Call type', 'Customer', 'Started', 'Time listened', 'How it ended', 'Call']);

    const first = rowOf('l-1');
    expect(first.getByText('Anita Kapoor')).toBeTruthy();
    expect(first.getByText('Priya Sharma')).toBeTruthy();
    expect(first.getByText('Dialler')).toBeTruthy();
    expect(first.getByText('Rahul Mehta')).toBeTruthy();
    expect(first.getByText('****4321')).toBeTruthy();
    expect(first.getByText('2m 10s')).toBeTruthy();
    expect(first.getByText('Stopped by the supervisor')).toBeTruthy();
    const link = first.getByRole('link');
    expect(link.getAttribute('href')).toBe('/agency/campaigns/camp-1/attempts/att-1');
    expect(link.getAttribute('aria-label')).toBe('Open call: Anita Kapoor listening to Priya Sharma');

    expect(screen.getByTestId('listen-history-count').textContent).toBe('Showing 3 listens');
  });

  it('a withheld caller reads "Withheld"; an inbound call and a call whose row is gone have no link', async () => {
    await renderPage();
    const withheld = rowOf('l-2');
    expect(withheld.getByText('Withheld')).toBeTruthy();
    expect(withheld.getByText('Unknown caller')).toBeTruthy();
    expect(withheld.getByText('Inbound: Support line')).toBeTruthy();
    expect(withheld.getByText('Access could not be checked')).toBeTruthy();
    expect(withheld.queryByRole('link')).toBeNull();
    const gone = rowOf('l-4');
    expect(gone.getByText('Soft phone')).toBeTruthy();
    expect(gone.queryByRole('link')).toBeNull();
    expect(gone.getByText('Call no longer available')).toBeTruthy();
  });

  it('a listen still open is "Listening now"', async () => {
    mocks.listListenHistory.mockResolvedValue({ entries: [OPEN], next_cursor: null });
    await renderPage();
    expect(rowOf('l-5').getAllByText('Listening now')).toHaveLength(2);
  });

  it('keeps the table (customers’ names and masked numbers) inside a ph-no-capture boundary (CH6)', async () => {
    await renderPage();
    const boundary = screen.getByTestId('listen-history');
    expect(boundary.classList.contains('ph-no-capture')).toBe(true);
    expect(screen.getByText('Rahul Mehta').closest('.ph-no-capture')).toBe(boundary);
    expect(screen.getByText('****4321').closest('.ph-no-capture')).toBe(boundary);
  });

  it('filters by supervisor, agent and date range, as the route’s query', async () => {
    await renderPage();
    const supervisor = screen.getByTestId('listen-history-supervisor') as HTMLSelectElement;
    expect([...supervisor.options].map((o) => o.textContent)).toEqual(['All supervisors', 'Anita Kapoor', 'Rohan Shah']);
    fireEvent.change(supervisor, { target: { value: 'sup-1' } });
    fireEvent.change(screen.getByTestId('listen-history-agent'), { target: { value: 'u-1' } });
    fireEvent.change(screen.getByTestId('listen-history-from'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByTestId('listen-history-to'), { target: { value: '2026-11-16' } });
    mocks.listListenHistory.mockResolvedValue({ entries: [ANITA_PRIYA], next_cursor: null });
    await act(async () => {
      fireEvent.click(screen.getByTestId('listen-history-apply'));
    });
    expect(mocks.listListenHistory).toHaveBeenLastCalledWith(
      {
        listener_user_id: 'sup-1',
        agent_user_id: 'u-1',
        from: new Date('2026-11-01T00:00:00').toISOString(),
        to: new Date('2026-11-17T00:00:00').toISOString(),
        limit: 50,
      },
      't-1',
      'a-1',
    );
    expect(screen.queryByTestId('listen-history-row-l-2')).toBeNull();
    expect(screen.getByText('3 active')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId('listen-history-clear'));
    });
    expect(mocks.listListenHistory).toHaveBeenLastCalledWith({ limit: 50 }, 't-1', 'a-1');
  });

  it('refuses a date range the wrong way round before asking', async () => {
    await renderPage();
    fireEvent.change(screen.getByTestId('listen-history-from'), { target: { value: '2026-11-16' } });
    fireEvent.change(screen.getByTestId('listen-history-to'), { target: { value: '2026-11-01' } });
    expect(screen.getByRole('alert').textContent).toContain('The “From” date is after the “To” date');
    expect((screen.getByTestId('listen-history-apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it('pages on with the cursor, keeping the filters, and adds the older listens', async () => {
    mocks.listListenHistory.mockResolvedValueOnce({ entries: [ANITA_PRIYA], next_cursor: 'cur-2' });
    await renderPage();
    expect(screen.getByTestId('listen-history-count').textContent).toBe('Showing 1 listen — there are more');
    mocks.listListenHistory.mockResolvedValueOnce({ entries: [WITHHELD], next_cursor: null });
    await act(async () => {
      fireEvent.click(screen.getByTestId('listen-history-more'));
    });
    expect(mocks.listListenHistory).toHaveBeenLastCalledWith({ cursor: 'cur-2', limit: 50 }, 't-1', 'a-1');
    expect(screen.getByTestId('listen-history-row-l-1')).toBeTruthy();
    expect(screen.getByTestId('listen-history-row-l-2')).toBeTruthy();
    expect(screen.queryByTestId('listen-history-more')).toBeNull();
  });

  it('empty: says what will appear; filtered: says how to widen', async () => {
    mocks.listListenHistory.mockResolvedValue({ entries: [], next_cursor: null });
    await renderPage();
    expect(screen.getByText('No listens yet')).toBeTruthy();
    fireEvent.change(screen.getByTestId('listen-history-agent'), { target: { value: 'u-1' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('listen-history-apply'));
    });
    expect(screen.getByText('Nothing matches those filters')).toBeTruthy();
  });

  it('shows a spinner while the first page is on its way', async () => {
    mocks.listListenHistory.mockImplementation(() => new Promise(() => {}));
    await renderPage();
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByTestId('listen-history-table')).toBeNull();
  });
});

describe('refusals', () => {
  it('listening turned off for the account (403 feature_disabled) is final: said, not asked again', async () => {
    mocks.listListenHistory.mockRejectedValue(Object.assign(new Error('off'), { statusCode: 403, details: { code: 'feature_disabled' } }));
    await renderPage();
    expect(screen.getByText('Listening is turned off for this account.')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.listListenHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('listen-history-export')).toBeNull();
  });

  it('the flag could not be read (503 listen_unavailable): says so and asks again by itself', async () => {
    mocks.listListenHistory.mockRejectedValueOnce(
      Object.assign(new Error('unavailable'), { statusCode: 503, details: { code: 'listen_unavailable' } }),
    );
    await renderPage();
    expect(screen.getByTestId('listen-history-error').textContent).toContain('Could not load the listening history. Retrying…');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.listListenHistory).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('listen-history-error')).toBeNull();
    expect(screen.getByTestId('listen-history-row-l-1')).toBeTruthy();
  });

  it('any other failure says so with Try again, and does not loop', async () => {
    mocks.listListenHistory.mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }));
    await renderPage();
    expect(screen.getByTestId('listen-history-error').textContent).toContain('Could not load the listening history.');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.listListenHistory).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('listen-history-error')).getByRole('button'));
    });
    expect(mocks.listListenHistory).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('listen-history-row-l-1')).toBeTruthy();
  });

  it('a reader below agency.supervise reads nothing', async () => {
    mocks.role = 'operator';
    await renderPage();
    expect(screen.getByText('The listening history is for supervisors. Ask an account admin if you need to see it.')).toBeTruthy();
    expect(mocks.listListenHistory).not.toHaveBeenCalled();
  });
});

describe('the CSV', () => {
  it('exports with the filters in force and saves the server’s file name', async () => {
    await renderPage();
    fireEvent.change(screen.getByTestId('listen-history-supervisor'), { target: { value: 'sup-2' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('listen-history-apply'));
    });
    // A draft not applied is not exported.
    fireEvent.change(screen.getByTestId('listen-history-agent'), { target: { value: 'u-1' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('listen-history-export'));
    });
    expect(mocks.downloadListenHistoryCsv).toHaveBeenCalledWith({ listener_user_id: 'sup-2' }, 't-1', 'a-1');
    expect(mocks.downloadBlob).toHaveBeenCalledWith('listening-history-2026-11-16.csv', expect.any(Blob));
    expect(mocks.showToast).toHaveBeenCalledWith('Export downloaded.', 'success');
  });

  it('says what is missing from a file cut short', async () => {
    mocks.downloadListenHistoryCsv.mockResolvedValue({
      blob: new Blob(['x']), filename: 'f.csv', truncated: true, reason: 'row_limit', rowLimit: 10_000, rows: 10_000,
    });
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId('listen-history-export'));
    });
    expect(mocks.downloadBlob).toHaveBeenCalled();
    expect(mocks.showToast).toHaveBeenCalledWith(
      'Only the newest 10,000 listens were exported. Narrow the date range and export again to get the rest.',
      'error',
    );
  });

  it('a refused export is said, and nothing is saved', async () => {
    const refusal = Object.assign(new Error('off'), { statusCode: 403, details: { code: 'feature_disabled' } });
    mocks.downloadListenHistoryCsv.mockRejectedValue(refusal);
    await renderPage();
    await act(async () => {
      fireEvent.click(screen.getByTestId('listen-history-export'));
    });
    expect(mocks.downloadBlob).not.toHaveBeenCalled();
    expect(mocks.showErrorToast).toHaveBeenCalledWith(refusal, 'Could not export the listening history.');
  });
});
