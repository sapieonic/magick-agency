import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { AgencyCampaign } from '../../types/agency-campaign';
import type { AgencyCampaignSeries } from '../../types/agency-campaign-series';

/**
 * The series read behind both charts of the campaign workspace.
 *
 * Four of the assertions below are about defects this repo has already shipped
 * once each, and none of them is visible in a screenshot:
 *
 * - **The window is derived, never seeded by an effect.** The campaign loads
 *   asynchronously, so a `useState` seeded from `defaultCampaignSeriesWindow`
 *   plus an effect that re-seeds it cannot tell a stale default from a choice
 *   the supervisor made in the meantime — and clobbers it. Here the chosen
 *   window is `null` until somebody picks one, so a campaign arriving later
 *   changes the DEFAULT and never a choice.
 * - **The request depends on the campaign's two date primitives, not on the
 *   campaign object.** The page above polls stats every 10s and hands down a
 *   fresh object each tick; depending on the object would re-request up to 92
 *   buckets every ten seconds.
 * - **An out-of-order response is discarded**, generation-guarded.
 * - **Nothing goes on the wire before `TenantContext` resolves**, because a
 *   request without `X-Account-Id` comes back as a 400 about a header this
 *   client never sent.
 *
 * The clock is fixed with fake timers so the `from` instants asserted here are
 * literals rather than something recomputed at test time. `waitFor` is
 * deliberately unused — it polls on a timer that fake timers hold still — and
 * settling is driven through `act` instead, which flushes the microtask queue
 * the promises actually resolve on.
 */

const mocks = vi.hoisted(() => ({
  getAgencyCampaignSeries: vi.fn(),
  useTenant: vi.fn(),
}));

vi.mock('../../api/agencyCampaignSeries', () => ({
  getAgencyCampaignSeries: mocks.getAgencyCampaignSeries,
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: mocks.useTenant,
}));

import { useCampaignSeries } from '../../hooks/useCampaignSeries';

const NOW = new Date('2026-08-27T15:30:00.000Z');

function campaign(over: Partial<AgencyCampaign> = {}): AgencyCampaign {
  return {
    id: 'camp-1',
    name: 'Renewals',
    status: 'running',
    started_at: '2026-06-01T09:00:00.000Z',
    ended_at: null,
    ...over,
  };
}

function payload(over: Partial<AgencyCampaignSeries> = {}): AgencyCampaignSeries {
  return { campaign_id: 'camp-1', bucket: 'day', buckets: [], ...over };
}

/** A promise plus its resolver, so a test can control settle ordering. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flush the microtasks a settled fetch resolves on, inside `act`. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The `from` each call went out with, in order. */
function fromsSent(): string[] {
  return mocks.getAgencyCampaignSeries.mock.calls.map((call) => String(call[1].from));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1' });
  mocks.getAgencyCampaignSeries.mockResolvedValue(payload());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useCampaignSeries — waiting for the tenant', () => {
  it('sends nothing while the tenant and account are unresolved', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: undefined, accountId: undefined });

    const { result } = renderHook(() => useCampaignSeries('camp-1', campaign()));
    await settle();

    expect(mocks.getAgencyCampaignSeries).not.toHaveBeenCalled();
    // Idle, not loading: the caller renders `AccountUnavailable` when resolution
    // settles with no account, so this must never become a permanent spinner.
    expect(result.current.state.status).toBe('idle');
  });

  it('sends nothing when the account alone is unresolved', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: undefined });

    renderHook(() => useCampaignSeries('camp-1', campaign()));
    await settle();

    expect(mocks.getAgencyCampaignSeries).not.toHaveBeenCalled();
  });

  it('sends nothing without a campaign id', async () => {
    renderHook(() => useCampaignSeries(undefined, campaign()));
    await settle();

    expect(mocks.getAgencyCampaignSeries).not.toHaveBeenCalled();
  });

  it('carries both ids on the request once they resolve', async () => {
    renderHook(() => useCampaignSeries('camp-1', campaign()));
    await settle();

    expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(1);
    expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledWith(
      'camp-1',
      { from: '2026-08-14T00:00:00.000Z', to: '2026-08-28T00:00:00.000Z', bucket: 'day' },
      'tenant-1',
      'account-1',
    );
  });
});

describe('useCampaignSeries — the window in force', () => {
  it('uses the campaign’s own default until somebody chooses', async () => {
    const finished = campaign({ status: 'completed', ended_at: '2026-07-04T00:00:00.000Z' });
    const { result } = renderHook(() => useCampaignSeries('camp-1', finished));
    await settle();

    expect(result.current.window).toBe('life');
  });

  it('follows a default that changes when the campaign finally loads', async () => {
    // Nothing has been chosen, so there is nothing to clobber — which is exactly
    // what the re-seeding effect was trying and failing to do.
    const { result, rerender } = renderHook(
      ({ row }: { row: AgencyCampaign | null }) => useCampaignSeries('camp-1', row),
      { initialProps: { row: null as AgencyCampaign | null } },
    );
    await settle();
    expect(result.current.window).toBe('14d');

    rerender({ row: campaign({ status: 'completed', ended_at: '2026-07-04T00:00:00.000Z' }) });
    await settle();
    expect(result.current.window).toBe('life');
  });

  it('keeps a supervisor’s choice when the campaign object changes under it', async () => {
    /**
     * The defect the hook's docstring describes. An effect that re-seeds the
     * window from the campaign runs AFTER a render that has already issued a
     * request, and cannot tell a stale default from a deliberate choice.
     */
    const { result, rerender } = renderHook(
      ({ row }: { row: AgencyCampaign | null }) => useCampaignSeries('camp-1', row),
      { initialProps: { row: null as AgencyCampaign | null } },
    );
    await settle();

    act(() => result.current.setWindow('7d'));
    await settle();
    expect(result.current.window).toBe('7d');

    // The campaign arrives, and its default would be `life`.
    rerender({ row: campaign({ status: 'completed', ended_at: '2026-07-04T00:00:00.000Z' }) });
    await settle();

    expect(result.current.window).toBe('7d');
    // Still seven days — but now the seven ending on the campaign's own last
    // day, which is the range moving under a window that did not.
    expect(fromsSent().at(-1)).toBe('2026-06-28T00:00:00.000Z');
    expect(mocks.getAgencyCampaignSeries.mock.calls.at(-1)?.[1].to)
      .toBe('2026-07-05T00:00:00.000Z');
  });

  it('re-requests with a different from when the window changes', async () => {
    const { result } = renderHook(() => useCampaignSeries('camp-1', campaign()));
    await settle();
    expect(fromsSent()).toEqual(['2026-08-14T00:00:00.000Z']);

    act(() => result.current.setWindow('30d'));
    await settle();

    expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(2);
    expect(fromsSent()).toEqual([
      '2026-08-14T00:00:00.000Z',
      '2026-07-29T00:00:00.000Z',
    ]);
  });
});

describe('useCampaignSeries — it does not poll', () => {
  it('does not re-request for a fresh campaign object with the same dates', async () => {
    /**
     * The page above re-renders this every 10s with a new object off the stats
     * poll. Depending on the object rather than on `started_at` / `ended_at`
     * would re-request up to 92 buckets every tick to redraw a shape over days
     * that has not moved.
     */
    const { rerender } = renderHook(
      ({ row }: { row: AgencyCampaign }) => useCampaignSeries('camp-1', row),
      { initialProps: { row: campaign() } },
    );
    await settle();
    expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(1);

    /*
      A different OBJECT with identical dates and status. The fixture used to
      change `status` here to stand in for "something else on the row moved",
      which was misleading once the range began reading it: a status change is a
      real event, not poll noise. `name` and the counters are what actually
      churn on a tick.
    */
    rerender({ row: campaign({ name: 'Renewals (Q3)' }) });
    await settle();
    rerender({ row: campaign() });
    await settle();

    expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(1);
  });

  it('DOES re-read when the campaign finishes while the page is open', async () => {
    /*
      The other side of that: a supervisor pressing Stop changes the default
      window (a finished campaign opens on its whole life) and clears
      "today is still in progress". Both are decided from the status, so the
      status has to be a dependency — it just must not be one the poll moves.
    */
    const { rerender } = renderHook(
      ({ row }: { row: AgencyCampaign }) => useCampaignSeries('camp-1', row),
      { initialProps: { row: campaign({ status: 'running' }) } },
    );
    await settle();
    expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(1);

    rerender({ row: campaign({ status: 'stopped' }) });
    await settle();
    expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(2);
  });

  it('does re-request when the campaign actually ends', async () => {
    const { rerender } = renderHook(
      ({ row }: { row: AgencyCampaign }) => useCampaignSeries('camp-1', row),
      { initialProps: { row: campaign() } },
    );
    await settle();

    rerender({ row: campaign({ status: 'completed', ended_at: '2026-08-20T11:00:00.000Z' }) });
    await settle();

    expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(2);
    // The range now ends on the campaign's own last day rather than today.
    expect(mocks.getAgencyCampaignSeries.mock.calls.at(-1)?.[1].to)
      .toBe('2026-08-21T00:00:00.000Z');
  });

  it('re-requests on reload, which the page’s Refresh calls', async () => {
    const { result } = renderHook(() => useCampaignSeries('camp-1', campaign()));
    await settle();
    expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(1);

    act(() => result.current.reload());
    await settle();

    expect(mocks.getAgencyCampaignSeries).toHaveBeenCalledTimes(2);
    expect(result.current.state.status).toBe('ready');
  });
});

describe('useCampaignSeries — settling', () => {
  it('keeps the range the answer was requested with, not one recomputed later', async () => {
    // The notes beside the chart describe the data on screen, and a range
    // recomputed from a fresh `new Date()` at render can describe a different
    // one — across midnight, it does.
    const { result } = renderHook(() => useCampaignSeries('camp-1', campaign()));
    await settle();

    expect(result.current.state).toMatchObject({
      status: 'ready',
      range: {
        from: '2026-08-14T00:00:00.000Z',
        to: '2026-08-28T00:00:00.000Z',
        days: 14,
        clamped: false,
        partialToday: true,
      },
    });
  });

  it('discards a slow earlier response when a newer request has already answered', async () => {
    const first = deferred<AgencyCampaignSeries>();
    const second = deferred<AgencyCampaignSeries>();
    mocks.getAgencyCampaignSeries
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useCampaignSeries('camp-1', campaign()));
    await settle();

    act(() => result.current.setWindow('7d'));
    await settle();

    // The newer request answers first…
    await act(async () => {
      second.resolve(payload({ buckets: [bucketRow('2026-08-27')] }));
      await Promise.resolve();
    });
    // …then the stale one lands and must be ignored.
    await act(async () => {
      first.resolve(payload({ buckets: [bucketRow('1999-01-01')] }));
      await Promise.resolve();
    });
    await settle();

    expect(result.current.state.status).toBe('ready');
    expect(
      result.current.state.status === 'ready'
        ? result.current.state.series.buckets.map((b) => b.bucket_start)
        : null,
    ).toEqual(['2026-08-27']);
    // And the range on screen is the newer request's, not the abandoned one's.
    expect(
      result.current.state.status === 'ready' ? result.current.state.range.days : null,
    ).toBe(7);
  });

  it('shows the server’s own sentence when the read fails', async () => {
    // A master that predates the route answers 404, and that message is the
    // truthful one to show — this console cannot tell it from a typo'd id.
    mocks.getAgencyCampaignSeries.mockRejectedValue(new Error('Route not found'));

    const { result } = renderHook(() => useCampaignSeries('camp-1', campaign()));
    await settle();

    expect(result.current.state).toEqual({ status: 'error', message: 'Route not found' });
  });

  it('falls back to its own sentence for a rejection that is not an Error', async () => {
    mocks.getAgencyCampaignSeries.mockRejectedValue('nope');

    const { result } = renderHook(() => useCampaignSeries('camp-1', campaign()));
    await settle();

    expect(result.current.state).toEqual({
      status: 'error',
      message: 'Could not load the day-by-day figures.',
    });
  });
});

function bucketRow(bucket_start: string) {
  return { bucket_start, attempts: 0, connected: 0, successes: 0, talk_seconds: 0, wrapup_seconds: 0 };
}
