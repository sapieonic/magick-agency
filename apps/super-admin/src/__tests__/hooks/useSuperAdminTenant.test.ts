import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ getTenantDetail: vi.fn() }));
vi.mock('../../api/super-admin', () => ({ getTenantDetail: mocks.getTenantDetail }));

import { useSuperAdminTenant } from '../../hooks/useSuperAdminTenant';

const DETAIL = { tenant: { id: 't-1', name: 'Acme' }, members: [] };

describe('useSuperAdminTenant — a silent refetch must not blank the page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTenantDetail.mockResolvedValue(DETAIL);
  });

  it('routes a silent failure to refreshError, keeping data and leaving error null', async () => {
    // `SATenantDetailPage` early-returns a full-page ErrorAlert on `error`, so
    // flipping it unmounts the tenant view — the same disappearance
    // `{ silent: true }` was added to avoid, arriving through the other flag.
    // A reconcile that succeeded and whose follow-up GET then 500'd would take
    // the result note with it and read as if the repair had failed.
    const { result } = renderHook(() => useSuperAdminTenant('t-1'));
    await waitFor(() => expect(result.current.data).toEqual(DETAIL));

    mocks.getTenantDetail.mockRejectedValueOnce(new Error('Request Failed'));
    await act(async () => { await result.current.reload({ silent: true }); });

    expect(result.current.error).toBeNull();
    expect(result.current.refreshError).toBe('Request Failed');
    // The figures the operator was looking at are still on screen.
    expect(result.current.data).toEqual(DETAIL);
    // And no spinner: `loading` gates a full-page replacement too.
    expect(result.current.loading).toBe(false);
  });

  it('still fails the page loudly on a NON-silent load', async () => {
    // The distinction has to cut both ways. An initial load has nothing to keep
    // on screen, so its failure must be the full-page error — routing it to
    // `refreshError` would leave a blank page with an explanation nobody sees.
    mocks.getTenantDetail.mockRejectedValue(new Error('Not Found'));
    const { result } = renderHook(() => useSuperAdminTenant('t-1'));

    await waitFor(() => expect(result.current.error).toBe('Not Found'));
    expect(result.current.refreshError).toBeNull();
  });

  it('clears a stale refreshError once a silent refetch succeeds', async () => {
    const { result } = renderHook(() => useSuperAdminTenant('t-1'));
    await waitFor(() => expect(result.current.data).toEqual(DETAIL));

    mocks.getTenantDetail.mockRejectedValueOnce(new Error('Request Failed'));
    await act(async () => { await result.current.reload({ silent: true }); });
    expect(result.current.refreshError).toBe('Request Failed');

    await act(async () => { await result.current.reload({ silent: true }); });
    expect(result.current.refreshError).toBeNull();
  });
});
