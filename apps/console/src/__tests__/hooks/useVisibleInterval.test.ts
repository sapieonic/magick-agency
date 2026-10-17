import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVisibleInterval } from '../../hooks/useVisibleInterval';
import { useRefetchOnReturn } from '../../hooks/useRefetchOnReturn';

function setVisibility(value: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
});

describe('useVisibleInterval', () => {
  it('ticks every interval while enabled and visible', async () => {
    const fn = vi.fn();
    renderHook(() => useVisibleInterval(fn, 1000, true));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does nothing while disabled', async () => {
    const fn = vi.fn();
    renderHook(() => useVisibleInterval(fn, 1000, false));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(fn).not.toHaveBeenCalled();
  });

  it('skips ticks while the page is hidden rather than queueing them', async () => {
    const fn = vi.fn();
    renderHook(() => useVisibleInterval(fn, 1000, true));
    setVisibility('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fn).not.toHaveBeenCalled();
    setVisibility('visible');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('never starts a tick while the previous promise is unsettled — even one that rejects', async () => {
    let settle!: () => void;
    const fn = vi.fn(() => new Promise<void>((_, reject) => { settle = () => reject(new Error('x')); }));
    renderHook(() => useVisibleInterval(fn, 1000, true));
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(fn).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle();
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('calls the latest closure without restarting the interval', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }) => useVisibleInterval(fn, 1000, true), {
      initialProps: { fn: first },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    rerender({ fn: second });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('useRefetchOnReturn', () => {
  it('calls on visibilitychange and on focus, only while visible', () => {
    const fn = vi.fn();
    renderHook(() => useRefetchOnReturn(fn));

    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    expect(fn).toHaveBeenCalledTimes(2);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('stops listening on unmount', () => {
    const fn = vi.fn();
    const { unmount } = renderHook(() => useRefetchOnReturn(fn));
    unmount();
    window.dispatchEvent(new Event('focus'));
    expect(fn).not.toHaveBeenCalled();
  });
});
