import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { AgencyReportRun } from '@magick-agency/contracts/api/agency/reports';
import { reportRun } from '../helpers/reports';

/**
 * The run poller (`hooks/useReportRun.ts`): 3 s after each new status while the run
 * is queued, assembling or rendering, backing off to 6, 12, ... 30 s while the status
 * stays put; never again once it is ready, failed or expired, or once the component
 * unmounts; nothing while the tab is hidden and one read when it comes back; a
 * transient failure retries, a refusal that waiting cannot change stops.
 */

const mocks = vi.hoisted(() => ({ getReport: vi.fn(), useTenant: vi.fn() }));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/reports', async () => {
  const actual = await vi.importActual<typeof import('../../api/reports')>('../../api/reports');
  return { ...actual, getReport: mocks.getReport };
});

import { REPORT_POLL_INTERVAL_MS, REPORT_POLL_MAX_INTERVAL_MS, useReportRun } from '../../hooks/useReportRun';
import { ApiError } from '../../api/client';

/** Let the resolved promise's `.then` run. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function tick(ms = REPORT_POLL_INTERVAL_MS) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await flush();
}

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
}

async function becomeVisible() {
  setVisibility('visible');
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({ tenantId: 't', accountId: 'a' });
});

afterEach(() => {
  setVisibility('visible');
  vi.useRealTimers();
});

function answers(...statuses: AgencyReportRun['status'][]) {
  for (const status of statuses) mocks.getReport.mockResolvedValueOnce(reportRun({ status }));
}

describe('useReportRun', () => {
  it('reads at once, then every 3 s while pending, and stops at ready', async () => {
    answers('queued', 'assembling', 'rendering', 'ready');
    const { result } = renderHook(() => useReportRun('run-1'));
    expect(result.current.loading).toBe(true);
    await flush();
    expect(mocks.getReport).toHaveBeenCalledTimes(1);
    expect(mocks.getReport).toHaveBeenCalledWith('run-1', 't', 'a');
    expect(result.current.run?.status).toBe('queued');

    await tick(REPORT_POLL_INTERVAL_MS - 1);
    expect(mocks.getReport).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(mocks.getReport).toHaveBeenCalledTimes(2);
    await tick();
    await tick();
    expect(mocks.getReport).toHaveBeenCalledTimes(4);
    expect(result.current.run?.status).toBe('ready');

    await tick(REPORT_POLL_INTERVAL_MS * 5);
    expect(mocks.getReport).toHaveBeenCalledTimes(4);
  });

  it.each(['failed', 'expired'] as const)('stops at %s', async (status) => {
    answers('rendering', status);
    renderHook(() => useReportRun('run-1'));
    await flush();
    await tick();
    expect(mocks.getReport).toHaveBeenCalledTimes(2);
    await tick(REPORT_POLL_INTERVAL_MS * 4);
    expect(mocks.getReport).toHaveBeenCalledTimes(2);
  });

  it('stops polling when unmounted', async () => {
    mocks.getReport.mockResolvedValue(reportRun({ status: 'queued' }));
    const { unmount } = renderHook(() => useReportRun('run-1'));
    await flush();
    expect(mocks.getReport).toHaveBeenCalledTimes(1);
    unmount();
    await tick(REPORT_POLL_INTERVAL_MS * 5);
    expect(mocks.getReport).toHaveBeenCalledTimes(1);
  });

  it('never reads a run handed in already finished', async () => {
    renderHook(() => useReportRun('run-1', { initial: reportRun({ status: 'ready' }) }));
    await tick(REPORT_POLL_INTERVAL_MS * 3);
    expect(mocks.getReport).not.toHaveBeenCalled();
  });

  it('waits one interval before re-reading a run handed in pending', async () => {
    answers('ready');
    const { result } = renderHook(() => useReportRun('run-1', { initial: reportRun({ status: 'queued' }) }));
    expect(result.current.run?.status).toBe('queued');
    expect(result.current.loading).toBe(false);
    await flush();
    expect(mocks.getReport).not.toHaveBeenCalled();
    await tick();
    expect(mocks.getReport).toHaveBeenCalledTimes(1);
    expect(result.current.run?.status).toBe('ready');
  });

  it('retries a transient failure at the next interval', async () => {
    mocks.getReport.mockRejectedValueOnce(new ApiError(503, { message: 'down' }));
    answers('ready');
    const { result } = renderHook(() => useReportRun('run-1'));
    await flush();
    expect(result.current.error).toMatch(/\S/);
    await tick();
    expect(mocks.getReport).toHaveBeenCalledTimes(2);
    expect(result.current.run?.status).toBe('ready');
    expect(result.current.error).toBeNull();
  });

  it('stops on a refusal that waiting cannot change, and says why', async () => {
    mocks.getReport.mockRejectedValueOnce(new ApiError(404, { error: 'Not Found', code: 'report_not_found', message: 'x' }));
    const { result } = renderHook(() => useReportRun('run-1'));
    await flush();
    expect(result.current.error).toBe('This report doesn’t exist, or you don’t have access to it.');
    await tick(REPORT_POLL_INTERVAL_MS * 4);
    expect(mocks.getReport).toHaveBeenCalledTimes(1);
  });

  it('honours a longer Retry-After on a 429', async () => {
    mocks.getReport.mockRejectedValueOnce(new ApiError(429, { message: 'slow down' }, undefined, 10));
    answers('ready');
    renderHook(() => useReportRun('run-1'));
    await flush();
    await tick(REPORT_POLL_INTERVAL_MS);
    expect(mocks.getReport).toHaveBeenCalledTimes(1);
    await tick(10_000 - REPORT_POLL_INTERVAL_MS);
    expect(mocks.getReport).toHaveBeenCalledTimes(2);
  });

  it('reload reads again at once after polling stopped', async () => {
    mocks.getReport.mockRejectedValueOnce(new ApiError(404, { code: 'report_not_found' }));
    answers('ready');
    const { result } = renderHook(() => useReportRun('run-1'));
    await flush();
    act(() => result.current.reload());
    await flush();
    expect(mocks.getReport).toHaveBeenCalledTimes(2);
    expect(result.current.run?.status).toBe('ready');
  });

  it('backs off while the status stays put: 3 s, 6, 12, 24, then 30 s at most', async () => {
    mocks.getReport.mockResolvedValue(reportRun({ status: 'rendering' }));
    renderHook(() => useReportRun('run-1'));
    await flush();
    expect(mocks.getReport).toHaveBeenCalledTimes(1);
    // The first answer is a new status: 3 s. Each same answer after doubles the wait.
    let calls = 1;
    for (const wait of [3_000, 6_000, 12_000, 24_000, REPORT_POLL_MAX_INTERVAL_MS, REPORT_POLL_MAX_INTERVAL_MS]) {
      await tick(wait - 1);
      expect(mocks.getReport).toHaveBeenCalledTimes(calls);
      await tick(1);
      calls += 1;
      expect(mocks.getReport).toHaveBeenCalledTimes(calls);
    }
  });

  it('starts again at 3 s when the status changes', async () => {
    answers('queued', 'queued', 'queued', 'rendering', 'rendering');
    renderHook(() => useReportRun('run-1'));
    await flush();
    await tick(3_000);
    await tick(6_000);
    expect(mocks.getReport).toHaveBeenCalledTimes(3);
    // queued again: 12 s. The 4th answer is rendering, so the next wait is 3 s.
    await tick(12_000);
    expect(mocks.getReport).toHaveBeenCalledTimes(4);
    await tick(3_000);
    expect(mocks.getReport).toHaveBeenCalledTimes(5);
  });

  it('sends nothing while the tab is hidden, and reads once when it comes back', async () => {
    mocks.getReport.mockResolvedValue(reportRun({ status: 'queued' }));
    const { result } = renderHook(() => useReportRun('run-1'));
    await flush();
    expect(mocks.getReport).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await tick(REPORT_POLL_MAX_INTERVAL_MS * 10);
    expect(mocks.getReport).toHaveBeenCalledTimes(1);

    mocks.getReport.mockResolvedValue(reportRun({ status: 'ready' }));
    await becomeVisible();
    expect(mocks.getReport).toHaveBeenCalledTimes(2);
    expect(result.current.run?.status).toBe('ready');

    // A second visibilitychange with nothing due sends nothing.
    await becomeVisible();
    await tick(REPORT_POLL_MAX_INTERVAL_MS * 2);
    expect(mocks.getReport).toHaveBeenCalledTimes(2);
  });

  it('a tab coming back before the next read falls due waits for it', async () => {
    mocks.getReport.mockResolvedValue(reportRun({ status: 'queued' }));
    renderHook(() => useReportRun('run-1'));
    await flush();
    setVisibility('hidden');
    await tick(1_000);
    await becomeVisible();
    expect(mocks.getReport).toHaveBeenCalledTimes(1);
    await tick(2_000);
    expect(mocks.getReport).toHaveBeenCalledTimes(2);
  });
});
