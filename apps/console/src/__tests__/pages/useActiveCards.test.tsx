import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, cleanup, waitFor } from '@testing-library/react';
import type { AgencyHomeBoard } from '@magick-agency/contracts/api/agency/home';
import { board, onBoard } from '../helpers/home';
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * The Campaigns page's Active cards (`campaigns-home/useActiveCards.ts`, B28a): a campaign the
 * list still shows that a board read since no longer carries has left the active set, so the list
 * is read again, once per such board read, rather than leaving its card loading for good.
 */

const api = vi.hoisted(() => ({ getAgencyHomeBoard: vi.fn() }));
vi.mock('../../api/agencyHome', () => api);

import { useActiveCards } from '../../pages/agency/campaigns-home/useActiveCards';

const listed = (id: string, status = 'paused') => ({ id, name: `Campaign ${id}`, status }) as unknown as AgencyCampaign;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('a campaign the board has dropped', () => {
  it('reads the list again once, not on every render', async () => {
    api.getAgencyHomeBoard.mockResolvedValue(board([]));
    const reloadList = vi.fn().mockResolvedValue(undefined);
    let active = [listed('c1')];
    const { result, rerender } = renderHook(() => useActiveCards('t-1', 'a-1', 'account_admin', active, reloadList));
    await waitFor(() => expect(reloadList).toHaveBeenCalledTimes(1));
    expect(result.current.states['c1']).toEqual({ status: 'loading' });
    // The list answers the same again (a new array): no second read for the same board read.
    active = [listed('c1')];
    rerender();
    active = [listed('c1')];
    rerender();
    expect(reloadList).toHaveBeenCalledTimes(1);
  });

  it('is not a campaign just shown that the board has not been read for yet', async () => {
    api.getAgencyHomeBoard.mockResolvedValue(board([onBoard('c2', { status: 'paused' })]));
    const reloadList = vi.fn().mockResolvedValue(undefined);
    let active = [listed('c2')];
    const { result, rerender } = renderHook(() => useActiveCards('t-1', 'a-1', 'account_admin', active, reloadList));
    await waitFor(() => expect(result.current.states['c2']?.status).toBe('ready'));

    let answer: (value: AgencyHomeBoard) => void = () => {};
    api.getAgencyHomeBoard.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    active = [listed('c1'), listed('c2')];
    rerender();
    // The board read for it is on its way: nothing says c1 has gone.
    expect(api.getAgencyHomeBoard).toHaveBeenCalledTimes(2);
    expect(reloadList).not.toHaveBeenCalled();
    await act(async () => {
      answer(board([onBoard('c1', { status: 'paused' }), onBoard('c2', { status: 'paused' })]));
    });
    expect(result.current.states['c1']?.status).toBe('ready');
    expect(reloadList).not.toHaveBeenCalled();
  });
});
