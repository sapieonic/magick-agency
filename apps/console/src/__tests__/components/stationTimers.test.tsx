import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { LAST_CALL_BANNER_MS, TimedBanner } from '../../components/agency/station/StationFrame';
import { CallLaterCard, nextCallLaterChange } from '../../components/agency/station/StationScreens';
import type { MyCallLaters } from '../../pages/agency/station/useMyDay';

/**
 * The station's timed leaves keep no clock they do not need: "The last call did not connect"
 * goes after its 6 s with one timer and leaves none behind, and the call-later list renders again
 * only when a minute changes what it says.
 */

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-20T10:00:00.000Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('02b’s timed banner', () => {
  it('shows for 6 seconds, then goes, and leaves no timer running', () => {
    const interval = vi.spyOn(window, 'setInterval');
    render(<TimedBanner at={Date.now()} icon={null} testId="last-call-banner">The last call did not connect.</TimedBanner>);
    expect(screen.getByTestId('last-call-banner')).toBeTruthy();
    expect(interval).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(LAST_CALL_BANNER_MS - 100);
    });
    expect(screen.getByTestId('last-call-banner')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByTestId('last-call-banner')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    interval.mockRestore();
  });
});

describe('the call-later list', () => {
  const list = (dueInMs: number[]): MyCallLaters => ({
    rows: dueInMs.map((ms, i) => ({ id: `r${i}`, dueAt: Date.now() + ms, name: `Customer ${i}`, overdue: false })),
    today: dueInMs.length,
    comesToMe: true,
    leftTodayGoesTo: null,
  });

  it('renders again once a minute at most, never on a quarter-second clock, and moves “in N min” on time', () => {
    const interval = vi.spyOn(window, 'setInterval');
    let renders = 0;
    const now = () => {
      renders += 1;
      return Date.now();
    };
    // Due in 2 minutes 30 seconds: "in 3 min" now, "in 2 min" in 30 seconds.
    render(<CallLaterCard list={list([150_000])} now={now} />);
    expect(screen.getByTestId('call-later-row').textContent).toContain('in 3 min');
    expect(interval).not.toHaveBeenCalled();
    const first = renders;
    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(renders).toBe(first);
    act(() => {
      vi.advanceTimersByTime(1_100);
    });
    expect(screen.getByTestId('call-later-row').textContent).toContain('in 2 min');
    expect(renders).toBe(first + 1);
    interval.mockRestore();
  });

  it('finds the next instant any row’s minutes change', () => {
    const t = Date.now();
    expect(nextCallLaterChange([{ dueAt: t + 150_000 }, { dueAt: t + 610_000 }], t)).toBe(t + 10_000);
    expect(nextCallLaterChange([{ dueAt: t - 45_000 }], t)).toBe(t + 15_000);
    expect(nextCallLaterChange([{ dueAt: t + 120_000 }], t)).toBe(t + 60_000);
    expect(nextCallLaterChange([], t)).toBeNull();
  });
});
