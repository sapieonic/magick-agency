import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ getUsageCounts: vi.fn() }));
vi.mock('../../api/super-admin', () => ({ getUsageCounts: mocks.getUsageCounts }));

import {
  useSuperAdminUsageCounts,
  presetWindow,
  customWindow,
  windowProblem,
  USAGE_COUNTS_MAX_WINDOW_DAYS,
} from '../../hooks/useSuperAdminUsageCounts';

const EMPTY = { from: '', to: '', totals: { dials: 0, answered_calls: 0, connected_calls: 0, talk_seconds: 0, analysis_audio_seconds: 0 }, tenants: [] };
const DAY = 86_400_000;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUsageCounts.mockResolvedValue(EMPTY);
});

describe('presetWindow', () => {
  it('covers today and the days-1 days before it, ending at the start of tomorrow (TZ=UTC)', () => {
    const w = presetWindow(7, new Date('2026-03-10T15:30:00Z'));
    expect(w).toEqual({ from: '2026-03-04T00:00:00.000Z', to: '2026-03-11T00:00:00.000Z' });
    expect(Date.parse(w.to) - Date.parse(w.from)).toBe(7 * DAY);
  });
});

describe('customWindow', () => {
  it('makes the end EXCLUSIVE: the instant the picked end day finishes', () => {
    expect(customWindow('2026-03-01', '2026-03-03')).toEqual({
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-03-04T00:00:00.000Z',
    });
  });

  it('a single picked day is a 24h window, not an empty one', () => {
    const w = customWindow('2026-03-05', '2026-03-05')!;
    expect(Date.parse(w.to) - Date.parse(w.from)).toBe(DAY);
    expect(windowProblem(w)).toBeNull();
  });

  it('rolls over a month end', () => {
    expect(customWindow('2026-01-31', '2026-01-31')!.to).toBe('2026-02-01T00:00:00.000Z');
  });

  it('returns null for a missing or malformed day', () => {
    expect(customWindow('', '2026-03-05')).toBeNull();
    expect(customWindow('2026-03-05', 'nope')).toBeNull();
  });
});

describe('windowProblem', () => {
  it('asks for dates when there is no window', () => {
    expect(windowProblem(null)).toMatch(/Pick a start and an end/);
  });

  it('refuses an end before the start', () => {
    expect(windowProblem(customWindow('2026-03-05', '2026-03-01'))).toMatch(/on or before/);
  });

  it('accepts exactly 400 days and refuses 400 days + 1 ms (the server cap)', () => {
    const from = '2025-01-01T00:00:00.000Z';
    const at = new Date(Date.parse(from) + USAGE_COUNTS_MAX_WINDOW_DAYS * DAY).toISOString();
    const over = new Date(Date.parse(from) + USAGE_COUNTS_MAX_WINDOW_DAYS * DAY + 1).toISOString();
    expect(windowProblem({ from, to: at })).toBeNull();
    expect(windowProblem({ from, to: over })).toMatch(/at most 400 days/);
  });
});

describe('useSuperAdminUsageCounts', () => {
  const win = { from: '2026-03-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' };

  it('requests the window and returns the data', async () => {
    const { result } = renderHook(() => useSuperAdminUsageCounts({ window: win }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.getUsageCounts).toHaveBeenCalledWith(win);
    expect(result.current.data).toEqual(EMPTY);
    expect(result.current.windowError).toBeNull();
  });

  it('sends tenant_id and account_id when both are set', async () => {
    renderHook(() => useSuperAdminUsageCounts({ window: win, tenantId: 't-1', accountId: 'a-1' }));
    await waitFor(() => expect(mocks.getUsageCounts).toHaveBeenCalled());
    expect(mocks.getUsageCounts).toHaveBeenCalledWith({ ...win, tenant_id: 't-1', account_id: 'a-1' });
  });

  it('never sends account_id without a tenant (the server refuses it)', async () => {
    renderHook(() => useSuperAdminUsageCounts({ window: win, accountId: 'a-1' }));
    await waitFor(() => expect(mocks.getUsageCounts).toHaveBeenCalled());
    expect(mocks.getUsageCounts).toHaveBeenCalledWith(win);
  });

  it('refuses a window over 400 days BEFORE any request', async () => {
    const tooLong = { from: '2025-01-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' };
    const { result } = renderHook(() => useSuperAdminUsageCounts({ window: tooLong }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.windowError).toMatch(/at most 400 days/);
    expect(result.current.data).toBeNull();
    expect(mocks.getUsageCounts).not.toHaveBeenCalled();
  });

  it('does not request for a null window', async () => {
    const { result } = renderHook(() => useSuperAdminUsageCounts({ window: null }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.getUsageCounts).not.toHaveBeenCalled();
    expect(result.current.windowError).toBeTruthy();
  });

  it('reports a failure and retries on reload', async () => {
    mocks.getUsageCounts.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useSuperAdminUsageCounts({ window: win }));
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.data).toBeNull();

    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toEqual(EMPTY));
    expect(result.current.error).toBeNull();
    expect(mocks.getUsageCounts).toHaveBeenCalledTimes(2);
  });

  it('drops the previous payload when a filter changes, so a failure cannot show stale totals', async () => {
    const { result, rerender } = renderHook((p: { t?: string }) => useSuperAdminUsageCounts({ window: win, tenantId: p.t }), { initialProps: {} as { t?: string } });
    await waitFor(() => expect(result.current.data).toEqual(EMPTY));
    mocks.getUsageCounts.mockRejectedValueOnce(new Error('nope'));
    rerender({ t: 't-2' });
    await waitFor(() => expect(result.current.error).toBe('nope'));
    expect(result.current.data).toBeNull();
  });
});
