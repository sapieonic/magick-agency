import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SwitcherDropdown } from '../../components/layout/SwitcherDropdown';

const ITEMS = [
  { id: 't-1', name: 'Acme', subtitle: 'acme' },
  { id: 't-2', name: 'Globex', subtitle: 'globex' },
  { id: 't-3', name: 'Initech', subtitle: 'initech' },
];

function renderDropdown(
  props: Partial<Parameters<typeof SwitcherDropdown>[0]> = {},
) {
  const onSelect = props.onSelect ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  render(
    <SwitcherDropdown
      label="Switch tenant"
      items={ITEMS}
      activeId="t-1"
      searchPlaceholder="Search tenants…"
      searchAriaLabel="Search tenants"
      listAriaLabel="Tenants"
      emptyNoun="tenant"
      {...props}
      onSelect={onSelect}
      onClose={onClose}
    />,
  );
  return { onSelect, onClose };
}

afterEach(() => {
  cleanup();
});

describe('SwitcherDropdown', () => {
  it('lists every item until the user types', () => {
    renderDropdown();
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByRole('option', { name: /Acme/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('filters the list as the user types', () => {
    renderDropdown();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tenants' }), {
      target: { value: 'glob' },
    });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain('Globex');
  });

  it('explains an empty result rather than showing a blank list', () => {
    renderDropdown();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tenants' }), {
      target: { value: 'zzz' },
    });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No tenant matches/)).toBeTruthy();
  });

  it('selects on click, not on wheel', () => {
    const { onSelect } = renderDropdown();
    fireEvent.wheel(screen.getByTestId('switcher-list'), { deltaY: 80 });
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('option', { name: /Globex/ }));
    expect(onSelect).toHaveBeenCalledWith('t-2');
  });

  it('does not switch org from Enter in the search field', () => {
    // Native Enter/Space on a focused option still selects. Enter in the
    // filter box with no highlighted row must not pick the first match —
    // setActiveTenantId reloads the app.
    const { onSelect } = renderDropdown();
    const search = screen.getByRole('textbox', { name: 'Search tenants' });

    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: 'ini' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('moves focus through the list with arrow keys and returns to search', () => {
    renderDropdown();
    const search = screen.getByRole('textbox', { name: 'Search tenants' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: /Acme/ }));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('option', { name: /Globex/ }));

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(search);
  });

  it('closes on Escape from the search field without selecting', () => {
    const { onSelect, onClose } = renderDropdown();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search tenants' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps options out of sequential Tab order', () => {
    renderDropdown();
    for (const option of screen.getAllByRole('option')) {
      expect(option.getAttribute('tabindex')).toBe('-1');
    }
  });
});
