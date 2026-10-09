import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TriStateControl } from '../../components/super-admin/feature-flags/TriStateControl';
import type { TriState } from '../../components/super-admin/feature-flags/flagUtils';

afterEach(() => cleanup());

function renderControl(value: TriState, opts: { disabled?: boolean; inheritSub?: string } = {}) {
  const onSelect = vi.fn();
  render(
    <TriStateControl
      value={value}
      onSelect={onSelect}
      ariaLabel="My Flag availability"
      inheritSub={opts.inheritSub ?? 'Inherited (default: Off)'}
      disabled={opts.disabled}
    />,
  );
  return { onSelect };
}

describe('TriStateControl — rendering & aria', () => {
  it('labels the radiogroup and renders three radios', () => {
    renderControl('inherit');
    const group = screen.getByRole('radiogroup', { name: 'My Flag availability' });
    expect(group).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('marks exactly the active value aria-checked', () => {
    renderControl('on');
    expect(screen.getByRole('radio', { name: 'On' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('false');
  });

  it('roving tabindex: only the checked radio is in the tab order', () => {
    renderControl('off');
    expect(screen.getByRole('radio', { name: 'Off' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('radio', { name: 'On' }).getAttribute('tabindex')).toBe('-1');
    // The Inherit radio's name includes the (aria-hidden) sub-line.
    const inherit = screen.getAllByRole('radio')[0]!;
    expect(inherit.getAttribute('tabindex')).toBe('-1');
  });

  it('hides the attribution sub-line from assistive tech', () => {
    renderControl('inherit', { inheritSub: 'Inherited (env: On)' });
    expect(screen.getByText('Inherited (env: On)').getAttribute('aria-hidden')).toBe('true');
  });
});

describe('TriStateControl — pointer', () => {
  it('fires onSelect for each segment clicked', () => {
    const { onSelect } = renderControl('inherit');
    fireEvent.click(screen.getByRole('radio', { name: 'On' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    fireEvent.click(screen.getAllByRole('radio')[0]!); // Inherit
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual(['on', 'off', 'inherit']);
  });
});

describe('TriStateControl — keyboard (WAI-ARIA radiogroup)', () => {
  const group = () => screen.getByRole('radiogroup');

  it('ArrowRight / ArrowDown advance the selection', () => {
    const { onSelect } = renderControl('inherit');
    fireEvent.keyDown(group(), { key: 'ArrowRight' });
    fireEvent.keyDown(group(), { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenCalledWith('on');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('ArrowLeft / ArrowUp move backwards (wrapping)', () => {
    const { onSelect } = renderControl('inherit');
    fireEvent.keyDown(group(), { key: 'ArrowLeft' });
    fireEvent.keyDown(group(), { key: 'ArrowUp' });
    // inherit (idx 0) - 1 wraps to off (idx 2)
    expect(onSelect).toHaveBeenCalledWith('off');
    expect(onSelect).toHaveBeenCalledTimes(2);
  });

  it('wraps forward from the last option back to the first', () => {
    const { onSelect } = renderControl('off'); // idx 2
    fireEvent.keyDown(group(), { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenCalledWith('inherit');
  });

  it('Home selects Inherit, End selects Off', () => {
    const { onSelect } = renderControl('on');
    fireEvent.keyDown(group(), { key: 'Home' });
    expect(onSelect).toHaveBeenCalledWith('inherit');
    fireEvent.keyDown(group(), { key: 'End' });
    expect(onSelect).toHaveBeenCalledWith('off');
  });

  it('ignores unrelated keys', () => {
    const { onSelect } = renderControl('inherit');
    fireEvent.keyDown(group(), { key: 'a' });
    fireEvent.keyDown(group(), { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('TriStateControl — disabled', () => {
  it('does not fire onSelect on click or keyboard when disabled', () => {
    const { onSelect } = renderControl('inherit', { disabled: true });
    fireEvent.click(screen.getByRole('radio', { name: 'On' }));
    fireEvent.keyDown(screen.getByRole('radiogroup'), { key: 'ArrowRight' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('disables every segment button', () => {
    renderControl('inherit', { disabled: true });
    for (const r of screen.getAllByRole('radio')) {
      expect((r as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
