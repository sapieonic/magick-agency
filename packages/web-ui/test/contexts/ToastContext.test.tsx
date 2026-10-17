import { describe, it, expect } from 'vitest';
import { memo } from 'react';
import { render, screen, act } from '@testing-library/react';
import { ToastProvider, useToast } from '../../src/contexts/ToastContext';

type ToastApi = ReturnType<typeof useToast>;

/** A consumer that counts its renders and hands its context value out. */
function countingConsumer() {
  const seen: { renders: number; api: ToastApi | null } = { renders: 0, api: null };
  const Consumer = memo(function Consumer() {
    seen.api = useToast();
    seen.renders += 1;
    return null;
  });
  return { seen, Consumer };
}

describe('ToastProvider', () => {
  it('shows a toast and an error toast in the portal', () => {
    const { seen, Consumer } = countingConsumer();
    render(<ToastProvider><Consumer /></ToastProvider>);

    act(() => seen.api!.showToast('Saved', 'success'));
    act(() => seen.api!.showErrorToast(new Error('Could not save')));

    expect(screen.getByText('Saved')).toBeTruthy();
    expect(screen.getByText('Could not save')).toBeTruthy();
  });

  it('keeps at most five toasts, dropping the oldest', () => {
    const { seen, Consumer } = countingConsumer();
    render(<ToastProvider><Consumer /></ToastProvider>);

    act(() => {
      for (let i = 1; i <= 6; i += 1) seen.api!.showToast(`toast ${i}`);
    });

    expect(screen.queryByText('toast 1')).toBeNull();
    expect(screen.getByText('toast 6')).toBeTruthy();
  });

  // The provider re-renders on every show and dismiss (its own state). Its
  // context value must not change with it, or every `useToast()` caller in the
  // app re-renders whenever any toast appears.
  it('does not re-render a consumer when showing a toast re-renders the provider', () => {
    const { seen, Consumer } = countingConsumer();
    render(<ToastProvider><Consumer /></ToastProvider>);
    const before = seen.renders;
    const api = seen.api;

    act(() => seen.api!.showToast('one'));
    act(() => seen.api!.showToast('two'));

    expect(screen.getByText('two')).toBeTruthy();
    expect(seen.renders).toBe(before);
    expect(seen.api).toBe(api);
  });
});
