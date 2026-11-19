import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { allocationFacts, board, onBoard } from '../helpers/home';

/**
 * Callbacks (LF1): the gate (Live floor's), the coming-soon panel, each active campaign's late
 * callbacks from the shared board, worst first, each linking to the campaign's Callbacks tab.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string | undefined,
  getAgencyHomeBoard: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ role: mocks.role, tenantId: 't-1', accountId: 'a-1', accounts: [{ id: 'a-1', name: 'Pune' }] }),
}));
vi.mock('../../api/agencyHome', () => ({ getAgencyHomeBoard: mocks.getAgencyHomeBoard }));

import CallbacksPage from '../../pages/agency/CallbacksPage';
import { ApiError } from '../../api/client';
import { HOME_BOARD_ERROR, HOME_BOARD_REFUSED } from '../../hooks/useHomeBoard';
import { CALLBACKS_ERROR, CALLBACKS_REFUSED } from '../../utils/agency/liveFloor';

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/agency/callbacks']}>
      <Routes>
        <Route path="/agency/callbacks" element={<CallbacksPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.role = 'account_admin';
  mocks.getAgencyHomeBoard.mockResolvedValue(board([]));
});
afterEach(() => cleanup());

describe('Callbacks', () => {
  it.each(['viewer', 'operator', 'agent'] as const)('sends a %s back to /agency, reading nothing', async (role) => {
    mocks.role = role;
    renderPage();
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/agency'));
    expect(mocks.getAgencyHomeBoard).not.toHaveBeenCalled();
  });

  it('says the one list is coming, with the badge, and lists each campaign’s late callbacks, worst first', async () => {
    const away = onBoard('c2', { name: 'Gold loan' });
    away.allocation = allocationFacts({ callbacks_overdue: 4, callbacks_overdue_absent_owner: 3 });
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1', { name: 'Q4', overdue: 1 }), away, onBoard('c3', { name: 'Card', status: 'paused' })]));
    renderPage();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Callbacks');
    const soon = screen.getByTestId('callbacks-coming-soon');
    expect(within(soon).getByRole('heading').textContent).toBe('One list of every campaign’s callbacksComing soon');

    const list = await screen.findByTestId('callbacks-campaigns');
    expect(within(list).getAllByRole('listitem').map((li) => li.getAttribute('data-testid'))).toEqual([
      'callbacks-row-c2', 'callbacks-row-c1', 'callbacks-row-c3',
    ]);
    const gold = screen.getByTestId('callbacks-row-c2');
    expect(gold.textContent).toContain('4 late, 3 with an agent who is away');
    expect(within(gold).getByRole('link', { name: 'Open callbacks: Gold loan' }).getAttribute('href')).toBe('/agency/campaigns/c2/callbacks');
    expect(screen.getByTestId('callbacks-row-c3').textContent).toContain('None late');
    expect(screen.getByTestId('callbacks-summary').textContent).toBe('5 callbacks late across the active campaigns.');
    expect(mocks.getAgencyHomeBoard).toHaveBeenCalledTimes(1);
  });

  it('says so when none is late, and in its own words when the board does not load', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')]));
    const first = renderPage();
    expect((await screen.findByTestId('callbacks-summary')).textContent).toBe('No callback is late right now.');
    first.unmount();

    mocks.getAgencyHomeBoard.mockRejectedValue(new Error('Route not found'));
    renderPage();
    expect(await screen.findByText(CALLBACKS_ERROR)).toBeTruthy();
    expect(screen.queryByText(HOME_BOARD_ERROR)).toBeNull();
    expect(screen.queryByText(/Route not found/)).toBeNull();
    // The coming-soon panel does not depend on the read.
    expect(screen.getByTestId('callbacks-coming-soon')).toBeTruthy();
  });

  it('says in its own words when the server refuses the board, never Live floor’s', async () => {
    mocks.getAgencyHomeBoard.mockRejectedValue(new ApiError(403, { error: 'Forbidden' }));
    renderPage();
    expect(await screen.findByText(CALLBACKS_REFUSED)).toBeTruthy();
    expect(screen.queryByText(HOME_BOARD_REFUSED)).toBeNull();
  });

  it('gives no all-clear while a campaign’s callbacks are not known', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1', { name: 'Q4' }), onBoard('c2', { name: 'Gold', overdue: null })]));
    renderPage();
    expect((await screen.findByTestId('callbacks-summary')).textContent)
      .toBe('No late callbacks found, but 1 campaign’s callbacks aren’t known.');
    expect(screen.getByTestId('callbacks-row-c2').textContent).toContain('Not known');
  });

  it('never says “at least 0” past the board’s cap', async () => {
    mocks.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c1')], { active_total: 30 }));
    renderPage();
    expect((await screen.findByTestId('callbacks-summary')).textContent).toBe('No late callbacks found in the first 25 active campaigns.');
  });
});
