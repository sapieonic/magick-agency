import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCompareRead } from '../../hooks/useCompareRead';

/**
 * `useCompareRead`'s failure while the same key is read again: kept, as the answer is, so a page
 * can hold its words up until the next read answers; a new key starts with none.
 */

describe('useCompareRead', () => {
  it('keeps the last error while the same key is read again, and clears it once that read answers', async () => {
    const refusal = new Error('busy');
    let answer: (value: string) => void = () => {};
    const read = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(refusal)
      .mockImplementationOnce(() => new Promise<string>((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useCompareRead('k', read));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe(refusal);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('loading'));
    expect(result.current.error).toBe(refusal);
    expect(result.current.doneKey).toBe('k');

    await act(async () => answer('figures'));
    expect(result.current).toMatchObject({ status: 'ready', data: 'figures', error: null });
  });

  it('starts a new key with no error', async () => {
    const refusal = new Error('refused');
    const read = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(refusal)
      .mockImplementationOnce(() => new Promise<string>(() => {}));
    const { result, rerender } = renderHook(({ key }) => useCompareRead(key, read), { initialProps: { key: 'a' } });
    await waitFor(() => expect(result.current.status).toBe('error'));
    rerender({ key: 'b' });
    await waitFor(() => expect(result.current.status).toBe('loading'));
    expect(result.current.error).toBeNull();
    expect(result.current.doneKey).toBe('a');
  });
});
