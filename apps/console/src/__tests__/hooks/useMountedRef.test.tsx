import { describe, it, expect, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { renderHook, cleanup } from '@testing-library/react';
import { useMountedRef } from '../../hooks/useMountedRef';
import { useLatestRef } from '../../hooks/useLatestRef';

afterEach(cleanup);

describe('useMountedRef', () => {
  it('is true while mounted and false once unmounted', () => {
    const { result, unmount } = renderHook(() => useMountedRef());
    const mounted = result.current;
    expect(mounted.current).toBe(true);
    unmount();
    expect(mounted.current).toBe(false);
  });

  it('is still true after StrictMode’s setup → cleanup → setup', () => {
    // The reason it is set on the way IN: a cleanup-only flag reads `false` for
    // the life of a StrictMode page, and every guarded response is thrown away.
    const { result } = renderHook(() => useMountedRef(), { wrapper: StrictMode });
    expect(result.current.current).toBe(true);
  });
});

describe('useLatestRef', () => {
  it('keeps one ref and always holds the latest render’s value', () => {
    const { result, rerender } = renderHook(({ value }) => useLatestRef(value), {
      initialProps: { value: 'first' },
    });
    const ref = result.current;
    rerender({ value: 'second' });
    expect(result.current).toBe(ref);
    expect(ref.current).toBe('second');
  });
});
