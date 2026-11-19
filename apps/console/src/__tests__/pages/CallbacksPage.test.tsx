import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { AgencyAccountCallback, AgencyCallbacksPage } from '@magick-agency/contracts/api/agency/callbacks';
import { board, onBoard } from '../helpers/home';

/**
 * Callbacks (LF1, LF22, LF32): the gate (Live floor's), the account's list from `GET /callbacks`
 * (tabs, the campaign filter, keyset paging), its rows (never a number), and its empty, loading and
 * error states in its own words; the summary line from the shared board.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string | undefined,
  getAgencyHomeBoard: vi.fn(),
  listAccountCallbacks: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ role: mocks.role, tenantId: 't-1', accountId: 'a-1', accounts: [{ id: 'a-1', name: 'Pune' }] }),
}));
vi.mock('../../api/agencyHome', () => ({ getAgencyHomeBoard: mocks.getAgencyHomeBoard }));
vi.mock('../../api/agencyFloorAssist', () => ({ listAccountCallbacks: mocks.listAccountCallbacks }));

import CallbacksPage from '../../pages/agency/CallbacksPage';
import { ApiError } from '../../api/client';
import { CALLBACKS_ERROR, CALLBACKS_REFUSED } from '../../utils/agency/liveFloor';

function Where() {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

function renderPage(entry = '/agency/callbacks') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/agency/callbacks" element={<><CallbacksPage /><Where /></>} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const callback = (id: string, over: Partial<AgencyAccountCallback> = {}): AgencyAccountCallback => ({
  contact_id: id,
  campaign_id: 'c1',
  campaign_name: 'Gold loan',
  assignment_mode: 'strict',
  customer_name: `Customer ${id}`,
  due_at: new Date(Date.now() - 30 * 60_000).toISOString(),
  owner: { user_id: 'n', name: 'Naveen G', live: false },
  source: 'outcome',
  ...over,
});

const page = (rows: AgencyAccountCallback[], next: string | null = null, due: 'overdue' | 'today' = 'overdue'): AgencyCallbacksPage => ({
  rows,
  next_cursor: next,
  limit: 50,
  due,
  as_of: new Date().toISOString(),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'account_admin';
  mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1', { name: 'Gold loan', overdue: 2 }), onBoard('c2', { name: 'Card' })]));
  mocks.listAccountCallbacks.mockResolvedValue(page([
    callback('k1'),
    callback('k2', { campaign_id: 'c2', campaign_name: 'Card', customer_name: null, owner: null, source: 'inbound' }),
    callback('k3', { owner: { user_id: 'd', name: 'Divya S', live: true } }),
  ]));
});
afterEach(() => cleanup());

describe('Callbacks', () => {
  it.each(['viewer', 'operator', 'agent'] as const)('sends a %s back to /agency, reading nothing', async (role) => {
    mocks.role = role;
    renderPage();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/agency'));
    expect(mocks.getAgencyHomeBoard).not.toHaveBeenCalled();
    expect(mocks.listAccountCallbacks).not.toHaveBeenCalled();
  });

  it('lists the account’s overdue callbacks: customer, campaign, due, owner and presence, source, a link; never a number', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Callbacks');
    expect(screen.queryByText('Coming soon')).toBeNull();
    const list = await screen.findByTestId('callbacks-list');
    expect(mocks.listAccountCallbacks).toHaveBeenCalledWith({ due: 'overdue' }, 't-1', 'a-1');
    expect(within(list).getAllByRole('listitem').map((li) => li.getAttribute('data-testid'))).toEqual([
      'callbacks-row-k1', 'callbacks-row-k2', 'callbacks-row-k3',
    ]);
    const first = screen.getByTestId('callbacks-row-k1');
    expect(first.textContent).toContain('Customer k1');
    expect(first.textContent).toContain('Gold loan');
    expect(first.textContent).toMatch(/Due\d{2}:\d{2} [ap]m/);
    expect(first.textContent).toContain('Naveen GAway');
    expect(first.textContent).toContain('Booked on a call');
    expect(within(first).getByRole('link', { name: 'Open contact: Customer k1, Gold loan' }).getAttribute('href')).toBe('/agency/campaigns/c1/contacts/k1');
    const pooled = screen.getByTestId('callbacks-row-k2');
    expect(pooled.textContent).toContain('No name on file');
    expect(pooled.textContent).toContain('Shared queue');
    expect(pooled.textContent).toContain('Missed inbound call');
    expect(screen.getByTestId('callbacks-row-k3').textContent).toContain('Divya SLive');
    // No digits that could be a phone number anywhere in the list.
    expect(list.textContent).not.toMatch(/\d{6,}/);
    expect((await screen.findByTestId('callbacks-summary')).textContent).toBe('2 callbacks late across the active campaigns.');
  });

  it('switches to Due later today, kept in the URL, reading page one again; arrow keys move between the tabs', async () => {
    renderPage();
    await screen.findByTestId('callbacks-list');
    const overdue = screen.getByRole('tab', { name: 'Overdue' });
    expect(overdue.getAttribute('aria-selected')).toBe('true');
    mocks.listAccountCallbacks.mockResolvedValue(page([], null, 'today'));
    fireEvent.click(screen.getByRole('tab', { name: 'Due later today' }));
    await waitFor(() => expect(mocks.listAccountCallbacks).toHaveBeenLastCalledWith({ due: 'today' }, 't-1', 'a-1'));
    expect((await screen.findByTestId('callbacks-empty')).textContent).toBe('No more callbacks are due today.');
    expect(screen.getByTestId('where').textContent).toBe('/agency/callbacks?due=today');
    const today = screen.getByRole('tab', { name: 'Due later today' });
    expect(today.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(today, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/agency/callbacks'));
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Overdue' }));
  });

  it('filters by campaign, kept in the URL, and opens on it', async () => {
    const first = renderPage();
    await screen.findByTestId('callbacks-list');
    mocks.listAccountCallbacks.mockResolvedValue(page([]));
    fireEvent.change(screen.getByLabelText('Campaign'), { target: { value: 'c2' } });
    await waitFor(() => expect(mocks.listAccountCallbacks).toHaveBeenLastCalledWith({ due: 'overdue', campaign_id: 'c2' }, 't-1', 'a-1'));
    expect((await screen.findByTestId('callbacks-empty')).textContent).toBe('No callback is overdue on Card right now.');
    expect(screen.getByTestId('where').textContent).toBe('/agency/callbacks?campaign=c2');
    first.unmount();

    mocks.listAccountCallbacks.mockClear();
    renderPage('/agency/callbacks?due=today&campaign=c1');
    await waitFor(() => expect(mocks.listAccountCallbacks).toHaveBeenCalledWith({ due: 'today', campaign_id: 'c1' }, 't-1', 'a-1'));
  });

  it('loads more from the cursor, appending, and keeps the rows when a page fails', async () => {
    mocks.listAccountCallbacks.mockResolvedValueOnce(page([callback('k1'), callback('k2')], 'cur-1'));
    renderPage();
    await screen.findByTestId('callbacks-list');
    mocks.listAccountCallbacks.mockRejectedValueOnce(new Error('network'));
    fireEvent.click(screen.getByTestId('callbacks-more'));
    expect(await screen.findByText('We couldn’t load more callbacks. Try again.')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    mocks.listAccountCallbacks.mockResolvedValueOnce(page([callback('k3')], null));
    fireEvent.click(screen.getByTestId('callbacks-more'));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(mocks.listAccountCallbacks).toHaveBeenLastCalledWith({ due: 'overdue', cursor: 'cur-1' }, 't-1', 'a-1');
    expect(screen.queryByTestId('callbacks-more')).toBeNull();
  });

  it('drops a late answer for a tab no longer shown', async () => {
    let answerOverdue: (value: AgencyCallbacksPage) => void = () => {};
    mocks.listAccountCallbacks.mockImplementationOnce(() => new Promise((resolve) => {
      answerOverdue = resolve;
    }));
    renderPage();
    mocks.listAccountCallbacks.mockResolvedValueOnce(page([], null, 'today'));
    fireEvent.click(screen.getByRole('tab', { name: 'Due later today' }));
    await screen.findByTestId('callbacks-empty');
    answerOverdue(page([callback('k1')]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId('callbacks-list')).toBeNull();
    expect(screen.getByTestId('callbacks-empty')).toBeTruthy();
  });

  it('says nothing is overdue only for what it read, and loads first', async () => {
    let answer: (value: AgencyCallbacksPage) => void = () => {};
    mocks.listAccountCallbacks.mockImplementationOnce(() => new Promise((resolve) => {
      answer = resolve;
    }));
    renderPage();
    expect(screen.queryByTestId('callbacks-empty')).toBeNull();
    answer(page([]));
    expect((await screen.findByTestId('callbacks-empty')).textContent).toBe('No callback is overdue right now.');
  });

  it('says in its own words when the list does not load or is refused, and Retry reads it again', async () => {
    mocks.listAccountCallbacks.mockRejectedValueOnce(new Error('Route not found'));
    const first = renderPage();
    expect(await screen.findByText(CALLBACKS_ERROR)).toBeTruthy();
    expect(screen.queryByText(/Route not found/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    expect(await screen.findByTestId('callbacks-list')).toBeTruthy();
    first.unmount();

    mocks.listAccountCallbacks.mockRejectedValueOnce(new ApiError(403, { error: 'Forbidden' }));
    renderPage();
    expect(await screen.findByText(CALLBACKS_REFUSED)).toBeTruthy();
  });

  it('gives no all-clear line while a campaign’s late callbacks are not known', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1', { name: 'Q4' }), onBoard('c2', { name: 'Gold', overdue: null })]));
    renderPage();
    expect((await screen.findByTestId('callbacks-summary')).textContent)
      .toBe('No late callbacks found, but 1 campaign’s callbacks aren’t known.');
  });
});
