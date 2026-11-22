import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PillGroup, type PillOption } from '../../../components/campaign-setup';

/** Pills: toggle buttons with aria-pressed (multi), a radio group (single). */

const DAYS: readonly PillOption<'mon' | 'tue' | 'wed'>[] = [
  { value: 'mon', label: 'M', ariaLabel: 'Monday' },
  { value: 'tue', label: 'T', ariaLabel: 'Tuesday' },
  { value: 'wed', label: 'W', ariaLabel: 'Wednesday', disabled: true },
];

describe('PillGroup, multi', () => {
  it('is a named group of pressed and unpressed buttons', () => {
    render(<PillGroup multiple legend="Days" options={DAYS} value={['tue']} onChange={() => {}} />);
    expect(screen.getByRole('group', { name: 'Days' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Monday' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Tuesday' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('adds a pill in the options’ order and removes a pressed one', () => {
    const onChange = vi.fn();
    render(<PillGroup multiple legend="Days" options={DAYS} value={['tue']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
    expect(onChange).toHaveBeenLastCalledWith(['mon', 'tue']);
    fireEvent.click(screen.getByRole('button', { name: 'Tuesday' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('does not toggle a disabled pill', () => {
    const onChange = vi.fn();
    render(<PillGroup multiple legend="Days" options={DAYS} value={[]} onChange={onChange} />);
    const wed = screen.getByRole('button', { name: 'Wednesday' }) as HTMLButtonElement;
    expect(wed.disabled).toBe(true);
    fireEvent.click(wed);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('PillGroup, single', () => {
  const HOURS: readonly PillOption<'9-6' | '9-8' | 'custom'>[] = [
    { value: '9-6', label: '9 AM – 6 PM' },
    { value: '9-8', label: '9 AM – 8 PM' },
    { value: 'custom', label: 'Custom' },
  ];

  it('is a radio group that reports the pick', () => {
    const onChange = vi.fn();
    render(<PillGroup legend="When to call" options={HOURS} value="9-8" onChange={onChange} />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([false, true, false]);
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    expect(onChange).toHaveBeenCalledWith('custom');
  });
});
