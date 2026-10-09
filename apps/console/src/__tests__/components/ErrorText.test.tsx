import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ErrorText } from '../../components/common/ErrorText';
import { appendRequestId } from '../../utils/errors';

const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  writeText.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe('ErrorText', () => {
  it('renders a plain message verbatim with no chip', () => {
    const { container } = render(<ErrorText message="Insufficient credits" />);
    expect(container.textContent).toBe('Insufficient credits');
    expect(screen.queryByText('Request ID')).toBeNull();
  });

  it('splits an embedded request id into a copyable chip rather than inline text', () => {
    render(<ErrorText message={appendRequestId('Something went wrong.', 'req_55')} />);
    // The id is NOT left collapsed into the message text.
    expect(screen.getByText('Something went wrong.')).toBeDefined();
    expect(screen.getByText('Request ID')).toBeDefined();
    expect(screen.getByText('req_55')).toBeDefined();
  });

  it('copies only the id (not the label) to the clipboard', async () => {
    render(<ErrorText message={appendRequestId('Failed.', 'req_55')} />);
    fireEvent.click(screen.getByRole('button', { name: /copy request id/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('req_55'));
  });

  it('renders a <span>-rooted chip (valid inside a <p> parent)', () => {
    // ErrorText is used inside <p> error containers; the chip must not introduce
    // a block element that would be invalid HTML there.
    const { container } = render(
      <p>
        <ErrorText message={appendRequestId('Boom.', 'req_1')} />
      </p>,
    );
    expect(container.querySelector('p div')).toBeNull();
  });
});
