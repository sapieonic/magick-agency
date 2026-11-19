import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNow, usePageVisible } from '../../hooks/useNow';

/** The shared repainting clock (`useNow`) and the page's visibility (`usePageVisible`). */

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-18T10:00:00Z'));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
afterEach(() => vi.useRealTimers());

describe('useNow', () => {
  it('moves on its period, and not between', () => {
    const start = Date.now();
    const { result } = renderHook(() => useNow(5_000));
    expect(result.current).toBe(start);
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(result.current).toBe(start);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(start + 5_000);
  });

  it('stands still while inactive, and reads the time again at once when it activates', () => {
    const start = Date.now();
    const { result, rerender } = renderHook(({ active }) => useNow(1_000, active), { initialProps: { active: false } });
    act(() => {
      vi.advanceTimersByTime(10_500);
    });
    expect(result.current).toBe(start);
    rerender({ active: true });
    expect(result.current).toBe(start + 10_500);
  });
});

describe('usePageVisible', () => {
  it('follows the page’s visibility', () => {
    const { result } = renderHook(() => usePageVisible());
    expect(result.current).toBe(true);
    setVisibility('hidden');
    expect(result.current).toBe(false);
    setVisibility('visible');
    expect(result.current).toBe(true);
  });
});
