import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Switch, SwitchRow } from '../../../components/campaign-setup';

/** A setting as a row with a switch on the right. */

describe('SwitchRow', () => {
  it('is a switch named by its label, described by its hint, that flips on a click', () => {
    const onChange = vi.fn();
    render(<SwitchRow label="Record calls" hint="Kept for 90 days." checked={false} onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Record calls', description: 'Kept for 90 days.' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('when disabled, shows the reason under the label and reads it with the switch', () => {
    const onChange = vi.fn();
    render(
      <SwitchRow
        label="Call summary"
        checked
        onChange={onChange}
        disabled
        disabledReason="Your account does not have call analysis."
        testId="summary-row"
      />,
    );
    const sw = screen.getByRole('switch', {
      name: 'Call summary',
      description: 'Your account does not have call analysis.',
    }) as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.disabled).toBe(true);
    expect(screen.getByTestId('summary-row-switch')).toBe(sw);
    fireEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the reason out while the row is enabled', () => {
    render(
      <SwitchRow
        label="Call summary"
        checked={false}
        onChange={() => {}}
        disabledReason="Your account does not have call analysis."
      />,
    );
    expect(screen.queryByText('Your account does not have call analysis.')).toBeNull();
  });

  it('puts a custom control in place of the switch, named by the row', () => {
    render(
      <SwitchRow
        label="Wrap-up time"
        checked={false}
        onChange={() => {}}
        control={({ labelId }) => (
          <select aria-labelledby={labelId} defaultValue="30">
            <option value="30">30 sec</option>
          </select>
        )}
      />,
    );
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Wrap-up time' })).toBeTruthy();
  });
});

describe('SwitchRow badge', () => {
  it('sits beside the label, outside it, so pressing it never flips the switch', () => {
    const onChange = vi.fn();
    const onBadge = vi.fn();
    render(
      <SwitchRow
        label="Record calls"
        checked={false}
        onChange={onChange}
        testId="record-row"
        badge={<button type="button" onClick={onBadge}>Reset</button>}
      />,
    );
    const badge = screen.getByRole('button', { name: 'Reset' });
    expect(badge.closest('label')).toBeNull();
    fireEvent.click(badge);
    expect(onBadge).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    // The switch is still named by the label alone.
    expect(screen.getByRole('switch', { name: 'Record calls' })).toBeTruthy();
  });
});

describe('Switch', () => {
  it('turns off when on', () => {
    const onChange = vi.fn();
    render(<Switch ariaLabel="Recording" checked onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Recording' }));
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
