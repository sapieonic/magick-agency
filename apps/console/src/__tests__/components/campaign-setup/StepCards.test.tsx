import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StepCards, type StepCardItem, type StepCardsProps } from '../../../components/campaign-setup';

/** The step bar of the campaign setup (CS1): a sequence for New campaign, tabs for Settings. */

const STEPS: readonly StepCardItem[] = [
  { id: 'name', title: 'Name & number', subtitle: 'Who customers see' },
  { id: 'customers', title: 'Customers', subtitle: 'Upload the list' },
  { id: 'purpose', title: 'Purpose & buttons', subtitle: 'What agents can pick' },
  { id: 'agents', title: 'Agents & timing', subtitle: 'Who calls, and when' },
];

function setup(props: Partial<StepCardsProps> = {}) {
  const onSelect = vi.fn();
  render(<StepCards steps={STEPS} current="customers" label="Campaign setup" onSelect={onSelect} {...props} />);
  return { onSelect };
}

describe('StepCards as a sequence', () => {
  it('is a named nav whose current step, and only that one, is aria-current="step"', () => {
    setup();
    expect(screen.getByRole('navigation', { name: 'Campaign setup' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    const current = screen.getByRole('button', { name: 'Customers' });
    expect(current.getAttribute('aria-current')).toBe('step');
    const marked = screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-current'));
    expect(marked).toEqual([current]);
  });

  it('reads the subtitle as the description, and selects on a click', () => {
    const { onSelect } = setup();
    const step = screen.getByRole('button', { name: 'Purpose & buttons', description: 'What agents can pick' });
    fireEvent.click(step);
    expect(onSelect).toHaveBeenCalledWith('purpose');
  });

  it('names a step that needs fixing, and shows a number only where nothing else is due', () => {
    setup({ invalid: new Set(['name']), completed: new Set(['name', 'customers']) });
    const invalid = screen.getByRole('button', { name: 'Name & number, needs fixing' });
    expect(invalid.getAttribute('data-invalid')).toBe('true');
    // Complete but current: still its number, not a tick.
    const current = screen.getByRole('button', { name: 'Customers' });
    expect(current.hasAttribute('data-complete')).toBe(false);
    expect(current.textContent).toContain('2');
    expect(screen.getByRole('button', { name: 'Purpose & buttons' }).textContent).toContain('3');
  });

  it('renders an unreachable step disabled, never hidden', () => {
    const { onSelect } = setup({ disabled: new Set(['agents']) });
    const agents = screen.getByRole('button', { name: 'Agents & timing' }) as HTMLButtonElement;
    expect(agents.disabled).toBe(true);
    fireEvent.click(agents);
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('StepCards as tabs', () => {
  const tabs = (props: Partial<StepCardsProps> = {}) => setup({ mode: 'tabs', idPrefix: 'cs', ...props });

  it('is a named tablist of tabs wired to their panels', () => {
    tabs();
    expect(screen.getByRole('tablist', { name: 'Campaign setup' })).toBeTruthy();
    const all = screen.getAllByRole('tab');
    expect(all).toHaveLength(4);
    const current = screen.getByRole('tab', { name: 'Customers' });
    expect(current.getAttribute('aria-selected')).toBe('true');
    expect(current.id).toBe('cs-tab-customers');
    expect(current.getAttribute('aria-controls')).toBe('cs-panel-customers');
    expect(screen.getByRole('tab', { name: 'Name & number' }).getAttribute('aria-selected')).toBe('false');
    expect(current.hasAttribute('aria-current')).toBe(false);
  });

  it('keeps only the current tab in the Tab order', () => {
    tabs();
    const order = screen.getAllByRole('tab').map((t) => t.getAttribute('tabindex'));
    expect(order).toEqual(['-1', '0', '-1', '-1']);
  });

  it('moves focus and selects on the arrow keys, wrapping and skipping disabled tabs', () => {
    const { onSelect } = tabs({ disabled: new Set(['purpose']) });
    const current = screen.getByRole('tab', { name: 'Customers' });
    current.focus();
    fireEvent.keyDown(current, { key: 'ArrowRight' });
    const agents = screen.getByRole('tab', { name: 'Agents & timing' });
    expect(document.activeElement).toBe(agents);
    expect(onSelect).toHaveBeenLastCalledWith('agents');

    fireEvent.keyDown(agents, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Name & number' }));
    expect(onSelect).toHaveBeenLastCalledWith('name');

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenLastCalledWith('agents');
  });

  it('goes to the ends on Home and End', () => {
    const { onSelect } = tabs();
    const current = screen.getByRole('tab', { name: 'Customers' });
    current.focus();
    fireEvent.keyDown(current, { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith('agents');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith('name');
  });

  it('with manual activation, an arrow moves focus only', () => {
    const { onSelect } = tabs({ activation: 'manual' });
    const current = screen.getByRole('tab', { name: 'Customers' });
    current.focus();
    fireEvent.keyDown(current, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Purpose & buttons' }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('names an invalid tab as needing fixing', () => {
    tabs({ invalid: new Set(['agents']) });
    expect(screen.getByRole('tab', { name: 'Agents & timing, needs fixing' })).toBeTruthy();
  });

  it('marks a tab holding an unsaved change with a dot, and says so in its name', () => {
    tabs({ unsaved: new Set(['name', 'agents']), invalid: new Set(['agents']) });
    const name = screen.getByRole('tab', { name: 'Name & number, unsaved changes' });
    expect(name.hasAttribute('data-unsaved')).toBe(true);
    expect(name.querySelector('[aria-hidden="true"] > span')).not.toBeNull();
    expect(screen.getByRole('tab', { name: 'Agents & timing, needs fixing, unsaved changes' })).toBeTruthy();
    const customers = screen.getByRole('tab', { name: 'Customers' });
    expect(customers.hasAttribute('data-unsaved')).toBe(false);
    expect(customers.querySelector('[aria-hidden="true"] > span')).toBeNull();
  });
});
