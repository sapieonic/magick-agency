import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMediaQuery } from '../../hooks/useMediaQuery';

/** A fake MediaQueryList whose `matches` can be flipped and a synthetic 'change' fired. */
function mockMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  let listener: (() => void) | null = null;
  const removeEventListener = vi.fn();
  const addEventListener = vi.fn((event: string, cb: () => void) => {
    if (event === 'change') listener = cb;
  });

  window.matchMedia = vi.fn().mockReturnValue({
    get matches() {
      return matches;
    },
    media: '',
    addEventListener,
    removeEventListener,
  });

  return {
    addEventListener,
    removeEventListener,
    fireChange(next: boolean) {
      matches = next;
      act(() => listener?.());
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useMediaQuery', () => {
  it('reflects the initial match state', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery('(max-width: 768px)'));
    expect(result.current).toBe(true);
  });

  it('updates live as the viewport crosses the breakpoint in both directions', () => {
    const media = mockMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(max-width: 768px)'));
    expect(result.current).toBe(false);

    media.fireChange(true);
    expect(result.current).toBe(true);

    media.fireChange(false);
    expect(result.current).toBe(false);
  });

  it('subscribes to change events and unsubscribes on unmount', () => {
    const media = mockMatchMedia(false);
    const { unmount } = renderHook(() => useMediaQuery('(max-width: 768px)'));

    expect(media.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    unmount();

    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});
