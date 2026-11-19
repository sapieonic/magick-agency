import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { RailPresenceRegion, breakTime } from '../../components/agency/RailPresenceRegion';

/**
 * The break countdown (LF6, LF26): a break whose reason has a limit counts DOWN from
 * `agent_state.since`, then says how far over it is in the warning tone; a break with none counts
 * up, as it always has. Driven by the region's own repaint tick and the faked clock, so these prove
 * the text moves with time and not just that it renders.
 */

const SINCE = '2026-11-19T12:00:00.000Z';
const T0 = Date.parse(SINCE);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function renderBreak(breakLimitMinutes: number | null, label = 'Tea') {
  return render(
    <RailPresenceRegion
      agentState="break"
      since={SINCE}
      clockOffsetMs={0}
      breakReasonLabel={label}
      breakLimitMinutes={breakLimitMinutes}
      busy={false}
      onGoAvailable={() => {}}
      onEndBreak={() => {}}
    />,
  );
}

const time = () => screen.getByTestId('break-elapsed').textContent;
const over = () => screen.getByTestId('break-time').getAttribute('data-over');

describe('a break with a limit', () => {
  it('counts down to the limit from the break’s start', () => {
    renderBreak(15);
    expect(time()).toBe('15:00 left');
    expect(over()).toBeNull();
    advance(4 * 60_000 + 39_000);
    expect(time()).toBe('10:21 left');
    expect(over()).toBeNull();
    expect(screen.getByTestId('break-time').textContent).toBe('Tea · 10:21 left');
  });

  it('turns to “over by N min” in the warning tone once the limit has passed, and keeps counting', () => {
    renderBreak(15);
    advance(15 * 60_000 + 1_000);
    expect(time()).toBe('over by 1 min');
    expect(over()).toBe('true');
    advance(2 * 60_000);
    expect(time()).toBe('over by 3 min');
    expect(over()).toBe('true');
  });

  it('counts from the server anchor, never from when the station rendered', () => {
    // Opened ten minutes into a fifteen-minute break: five minutes left, not fifteen.
    vi.setSystemTime(T0 + 10 * 60_000);
    renderBreak(15);
    expect(time()).toBe('5:00 left');
  });
});

describe('a break with no limit', () => {
  it('counts up, as before, with no warning tone however long it runs', () => {
    renderBreak(null, 'Training');
    expect(time()).toBe('0:00');
    advance(45 * 60_000);
    expect(time()).toBe('45:00');
    expect(over()).toBeNull();
  });
});

describe('breakTime', () => {
  it('reads a dash with no anchor, and rounds an overrun up to whole minutes begun', () => {
    expect(breakTime(null, 15)).toEqual({ text: '—', over: false });
    expect(breakTime(15 * 60_000, 15)).toEqual({ text: 'over by 1 min', over: true });
    expect(breakTime(16 * 60_000, 15)).toEqual({ text: 'over by 1 min', over: true });
    expect(breakTime(16 * 60_000 + 1, 15)).toEqual({ text: 'over by 2 min', over: true });
    expect(breakTime(60_000, null)).toEqual({ text: '1:00', over: false });
  });
});
