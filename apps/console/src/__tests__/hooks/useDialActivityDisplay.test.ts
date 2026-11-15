import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { DIAL_GAP_HOLD_MS, useDialActivityDisplay } from '../../hooks/useDialActivityDisplay';
import type { AgencyDialActivity } from '../../types/agency';

/**
 * The gap hold: "Dialling a customer…" stays up for {@link DIAL_GAP_HOLD_MS} after a hidden
 * dial ends, so the screen does not flick to "Waiting for a call" between one dial and the
 * next, and is dropped at once by anything that makes it untrue.
 */

type Props = { activity: AgencyDialActivity | null; eligible: boolean; nothingDue?: boolean };

const ringing = (n: number): AgencyDialActivity => ({ ringing: true, unanswered_in_a_row: n });
const ended = (n: number): AgencyDialActivity => ({ ringing: false, unanswered_in_a_row: n });

function mount(initial: Props) {
  return renderHook((p: Props) => useDialActivityDisplay(p.activity, p.eligible, p.nothingDue ?? false), {
    initialProps: initial,
  });
}

describe('useDialActivityDisplay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows nothing with no activity, or count 0 and nothing ringing', () => {
    const view = mount({ activity: null, eligible: true });
    expect(view.result.current).toBeNull();
    view.rerender({ activity: ended(0), eligible: true });
    expect(view.result.current).toBeNull();
  });

  it('shows the count while plain waiting', () => {
    const view = mount({ activity: ended(3), eligible: true });
    expect(view.result.current).toEqual({ dialling: false, unansweredInARow: 3 });
  });

  it('holds "dialling" for the gap, never on the very render the dial ends, then lets go', () => {
    const view = mount({ activity: ringing(0), eligible: true });
    expect(view.result.current).toEqual({ dialling: true, unansweredInARow: 0 });

    view.rerender({ activity: ended(1), eligible: true });
    // The same render: no frame of "Waiting for a call" between two dials.
    expect(view.result.current).toEqual({ dialling: true, unansweredInARow: 1 });

    act(() => { vi.advanceTimersByTime(DIAL_GAP_HOLD_MS - 1); });
    expect(view.result.current?.dialling).toBe(true);

    act(() => { vi.advanceTimersByTime(1); });
    expect(view.result.current).toEqual({ dialling: false, unansweredInARow: 1 });
  });

  it('the next dial inside the gap carries straight on', () => {
    const view = mount({ activity: ringing(0), eligible: true });
    view.rerender({ activity: ended(1), eligible: true });
    act(() => { vi.advanceTimersByTime(1000); });
    view.rerender({ activity: ringing(1), eligible: true });
    expect(view.result.current).toEqual({ dialling: true, unansweredInARow: 1 });
    // The first gap's timer is gone: still dialling well past where it would have ended.
    act(() => { vi.advanceTimersByTime(DIAL_GAP_HOLD_MS * 2); });
    expect(view.result.current?.dialling).toBe(true);
  });

  it('a reserved (activity cleared) drops the hold at once', () => {
    const view = mount({ activity: ringing(2), eligible: true });
    view.rerender({ activity: ended(3), eligible: true });
    view.rerender({ activity: null, eligible: true });
    expect(view.result.current).toBeNull();
  });

  it('leaving the slot (break, paused campaign, a call on screen) drops the hold and does not resume it', () => {
    const view = mount({ activity: ringing(0), eligible: true });
    view.rerender({ activity: ended(1), eligible: true });
    view.rerender({ activity: ended(1), eligible: false });
    expect(view.result.current).toBeNull();
    view.rerender({ activity: ended(1), eligible: true });
    expect(view.result.current).toEqual({ dialling: false, unansweredInARow: 1 });
  });

  it('the queue stating nothing due ends the hold at once: no next dial is coming', () => {
    const view = mount({ activity: ringing(0), eligible: true });
    view.rerender({ activity: ended(1), eligible: true });
    expect(view.result.current?.dialling).toBe(true);
    view.rerender({ activity: ended(1), eligible: true, nothingDue: true });
    expect(view.result.current).toEqual({ dialling: false, unansweredInARow: 1 });
    expect(vi.getTimerCount()).toBe(0);
    // Something falling due again does not bring the hold back.
    view.rerender({ activity: ended(1), eligible: true, nothingDue: false });
    expect(view.result.current).toEqual({ dialling: false, unansweredInARow: 1 });
  });

  it('a dial ending while nothing is due starts no hold', () => {
    const view = mount({ activity: ringing(0), eligible: true, nothingDue: true });
    view.rerender({ activity: ended(1), eligible: true, nothingDue: true });
    expect(view.result.current).toEqual({ dialling: false, unansweredInARow: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a ringing dial outranks the queue: "dialling" while nothing is due', () => {
    const view = mount({ activity: ended(2), eligible: true, nothingDue: true });
    view.rerender({ activity: ringing(2), eligible: true, nothingDue: true });
    expect(view.result.current).toEqual({ dialling: true, unansweredInARow: 2 });
  });

  it('a dial ringing while the slot is not shown is not shown', () => {
    const view = mount({ activity: ringing(0), eligible: false });
    expect(view.result.current).toBeNull();
  });

  it('cleans its timer up on unmount', () => {
    const view = mount({ activity: ringing(0), eligible: true });
    view.rerender({ activity: ended(1), eligible: true });
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
