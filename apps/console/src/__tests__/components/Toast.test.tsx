import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { Toast } from '../../components/common/Toast';
import type { ToastData } from '../../components/common/Toast';
import { appendRequestId } from '../../utils/errors';

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
