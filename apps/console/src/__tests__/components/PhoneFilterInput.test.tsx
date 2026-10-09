import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { PhoneFilterInput } from '../../components/common/PhoneFilterInput';

function getInput(container: HTMLElement) {
  return container.querySelector('input[type="tel"]') as HTMLInputElement;
}

// Query within the render container — this project has no global cleanup
// between tests, so document-wide queries can match stale DOM.
function getError(container: HTMLElement) {
  return container.querySelector('[class*="error"]');
}

describe('PhoneFilterInput', () => {
  it('applies the normalized E.164 number on Enter', () => {
    const onApply = vi.fn();
    const { container } = render(<PhoneFilterInput value={undefined} onApply={onApply} />);
    const input = getInput(container);
    fireEvent.change(input, { target: { value: '91 98765 43210' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onApply).toHaveBeenCalledWith('+919876543210');
    // The visible input reflects the normalized number
    expect(input.value).toBe('+919876543210');
  });

  it('applies on blur', () => {
    const onApply = vi.fn();
    const { container } = render(<PhoneFilterInput value={undefined} onApply={onApply} />);
    const input = getInput(container);
    fireEvent.change(input, { target: { value: '+1 (415) 555-2671' } });
    fireEvent.blur(input);
    expect(onApply).toHaveBeenCalledWith('+14155552671');
  });

  it('shows an error and does not apply for invalid input', () => {
    const onApply = vi.fn();
    const { container } = render(<PhoneFilterInput value={undefined} onApply={onApply} />);
    const input = getInput(container);
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onApply).not.toHaveBeenCalled();
    expect(getError(container)?.textContent).toMatch(/full number with country code/i);
  });

  it('clears the error while typing', () => {
    const onApply = vi.fn();
    const { container } = render(<PhoneFilterInput value={undefined} onApply={onApply} />);
    const input = getInput(container);
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(getError(container)).not.toBeNull();
    fireEvent.change(input, { target: { value: 'abc1' } });
    expect(getError(container)).toBeNull();
  });

  it('does not apply when input is empty and no filter is active', () => {
    const onApply = vi.fn();
    const { container } = render(<PhoneFilterInput value={undefined} onApply={onApply} />);
    fireEvent.keyDown(getInput(container), { key: 'Enter' });
    expect(onApply).not.toHaveBeenCalled();
  });

  it('clears the active filter when the input is emptied', () => {
    const onApply = vi.fn();
    const { container } = render(<PhoneFilterInput value="+919876543210" onApply={onApply} />);
    const input = getInput(container);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onApply).toHaveBeenCalledWith(undefined);
  });

  it('does not re-apply an unchanged value', () => {
    const onApply = vi.fn();
    const { container } = render(<PhoneFilterInput value="+919876543210" onApply={onApply} />);
    const input = getInput(container);
    fireEvent.blur(input);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('shows a clear button only when a filter is active, and clears on click', () => {
    const onApply = vi.fn();
    const { container, rerender } = render(<PhoneFilterInput value={undefined} onApply={onApply} />);
    expect(container.querySelector('button')).toBeNull();

    rerender(<PhoneFilterInput value="+919876543210" onApply={onApply} />);
    const clearBtn = container.querySelector('button') as HTMLButtonElement;
    expect(clearBtn).not.toBeNull();
    fireEvent.click(clearBtn);
    expect(onApply).toHaveBeenCalledWith(undefined);
    expect(getInput(container).value).toBe('');
  });
});
