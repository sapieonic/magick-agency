import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { Toast } from '../../src/components/Toast';
import type { ToastData } from '../../src/components/Toast';
import { appendRequestId } from '../../src/errors';

const writeText = vi.fn();

function toast(partial: Partial<ToastData>): ToastData {
  return { id: 't1', message: 'msg', type: 'error', duration: 100000, ...partial };
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  writeText.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('Toast — request id chip', () => {
  it('shows only the message text (no chip) for a plain error', () => {
    render(<Toast toast={toast({ message: 'Insufficient credits' })} onDismiss={vi.fn()} />);
    expect(screen.getByText('Insufficient credits')).toBeDefined();
    expect(screen.queryByText('Request ID')).toBeNull();
  });

  it('splits an embedded request id into a copyable chip', async () => {
    const message = appendRequestId('Something went wrong.', 'req_77');
    render(<Toast toast={toast({ message })} onDismiss={vi.fn()} />);

    expect(screen.getByText('Something went wrong.')).toBeDefined();
    expect(screen.getByText('Request ID')).toBeDefined();
    expect(screen.getByText('req_77')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /copy request id/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('req_77'));
  });
});

describe('Toast — action button', () => {
  it('renders no action button when the toast has none', () => {
    render(<Toast toast={toast({ message: 'Saved', type: 'success' })} onDismiss={vi.fn()} />);
    expect(screen.queryAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Dismiss notification']);
  });

  it('runs the action and dismisses the toast when its button is pressed', async () => {
    const onClick = vi.fn();
    const onDismiss = vi.fn();
    render(
      <Toast
        toast={toast({ message: 'Report queued', type: 'success', action: { label: 'View report', onClick } })}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'View report' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith('t1'));
  });
});
