import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { appendRequestId } from '../../utils/errors';

const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
  writeText.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('ErrorAlert — request id handling', () => {
  it('renders a plain message with no request-id chip', () => {
    render(<ErrorAlert message="Insufficient credits" />);
    expect(screen.getByText('Insufficient credits')).toBeDefined();
    expect(screen.queryByText('Request ID')).toBeNull();
  });

  it('splits an embedded request id out of the message and shows a copy chip', () => {
    render(<ErrorAlert message={appendRequestId('Something went wrong.', 'req_42')} />);
    // The id is NOT rendered inline in the message paragraph.
    expect(screen.getByText('Something went wrong.')).toBeDefined();
    // It is surfaced as a labelled, copyable chip.
    expect(screen.getByText('Request ID')).toBeDefined();
    expect(screen.getByText('req_42')).toBeDefined();
  });

  it('prefers an explicit requestId prop', () => {
    render(<ErrorAlert message="Boom" requestId="req_explicit" />);
    expect(screen.getByText('req_explicit')).toBeDefined();
  });

  it('copies the request id to the clipboard', async () => {
    render(<ErrorAlert message={appendRequestId('Failed.', 'req_99')} />);
    fireEvent.click(screen.getByRole('button', { name: /copy request id/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('req_99'));
  });
});
