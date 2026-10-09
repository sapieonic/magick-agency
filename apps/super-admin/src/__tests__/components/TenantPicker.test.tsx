import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TenantPicker } from '../../components/super-admin/TenantPicker';

const TENANTS = [
  { id: 't-1', name: 'Pacific Trading', slug: 'pacific-trading' },
  { id: 't-2', name: 'Acme Corporation', slug: 'acme-corp' },
  { id: 't-3', name: 'Globex', slug: 'globex' },
];

function renderPicker(props: Partial<Parameters<typeof TenantPicker>[0]> = {}) {
  const onChange = props.onChange ?? vi.fn();
  render(
    <TenantPicker tenants={TENANTS} value="" {...props} onChange={onChange} />,
  );
  return { onChange, input: screen.getByRole('combobox') };
}

function open(input: HTMLElement) {
  fireEvent.focus(input);
}

describe('TenantPicker', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { cleanup(); });

  it('lists every tenant when opened with no query', () => {
    const { input } = renderPicker();
    open(input);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByText('3 of 3 tenants')).toBeTruthy();
  });

  it('filters the list as the super admin types', () => {
    const { input } = renderPicker();
    open(input);
    fireEvent.change(input, { target: { value: 'acme' } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain('Acme Corporation');
    expect(screen.getByText('1 of 3 tenants')).toBeTruthy();
  });

  it('filters by slug and by id', () => {
    const { input } = renderPicker();
    open(input);
    fireEvent.change(input, { target: { value: 'globex' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.change(input, { target: { value: 't-1' } });
    expect(screen.getAllByRole('option')[0]!.textContent).toContain('Pacific Trading');
  });

  it('selects a tenant on click', () => {
    const { input, onChange } = renderPicker();
    open(input);
    fireEvent.change(input, { target: { value: 'acme' } });
    fireEvent.click(screen.getByRole('option', { name: /Acme Corporation/ }));
    expect(onChange).toHaveBeenCalledWith('t-2');
    // Menu closes after selecting.
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('supports arrow-key navigation and Enter to select', () => {
    const { input, onChange } = renderPicker();
    open(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // t-1 → t-2
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('t-2');
  });

  it('wraps arrow-up from the first option to the last', () => {
    const { input, onChange } = renderPicker();
    open(input);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('t-3');
  });

  it('closes on Escape without changing the selection', () => {
    const { input, onChange } = renderPicker({ value: 't-2' });
    open(input);
    fireEvent.change(input, { target: { value: 'glob' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
    // Query is discarded; the field falls back to the selected tenant's name.
    expect((input as HTMLInputElement).value).toBe('Acme Corporation');
  });

  it('explains an empty result rather than showing a blank list', () => {
    const { input } = renderPicker();
    open(input);
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No tenant matches/)).toBeTruthy();
    expect(screen.getByText('No tenants match')).toBeTruthy();
  });

  it('marks the current selection and clears it via the clear button', () => {
    const { input, onChange } = renderPicker({ value: 't-3' });
    expect((input as HTMLInputElement).value).toBe('Globex');
    open(input);
    expect(screen.getByRole('option', { name: /Globex/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Clear tenant filter' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('jumps to the first/last option with Home and End', () => {
    const { input, onChange } = renderPicker();
    open(input);
    fireEvent.keyDown(input, { key: 'End' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('t-3');

    open(input);
    fireEvent.keyDown(input, { key: 'End' });
    fireEvent.keyDown(input, { key: 'Home' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('t-1');
  });

  it('keeps Enter on the last visible option after the list shrinks', () => {
    const { input, onChange } = renderPicker();
    open(input);
    fireEvent.keyDown(input, { key: 'End' }); // active = t-3, index 2
    fireEvent.change(input, { target: { value: 'pacific' } }); // one result left
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('t-1');
  });

  it('flags a selected id that is not in the tenant list, and still offers Clear', () => {
    const { input, onChange } = renderPicker({ value: 'deleted-tenant' });
    expect((input as HTMLInputElement).value).toBe('');
    expect((input as HTMLInputElement).placeholder).toBe('Tenant not found — search to pick one');

    fireEvent.click(screen.getByRole('button', { name: 'Clear tenant filter' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('does not cry "not found" while the tenant list is still loading', () => {
    render(<TenantPicker tenants={[]} value="t-9" onChange={vi.fn()} loading />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(input.placeholder).toBe('Loading tenants…');
    expect(screen.queryByRole('button', { name: 'Clear tenant filter' })).toBeNull();
  });

  it('shows a loading placeholder and stays inert while tenants load', () => {
    render(<TenantPicker tenants={[]} value="" onChange={vi.fn()} loading />);
    const input = screen.getByRole('combobox') as HTMLInputElement;
    expect(input.placeholder).toBe('Loading tenants…');
    expect(input.disabled).toBe(true);
  });

  it('has no aria-label by default, leaving the accessible name to a caller-owned <label>', () => {
    const { input } = renderPicker();
    expect(input.getAttribute('aria-label')).toBeNull();
  });

  it('takes an accessible name from ariaLabel for callers with no visible <label>', () => {
    renderPicker({ ariaLabel: 'Filter by tenant' });
    expect(screen.getByRole('combobox', { name: 'Filter by tenant' })).toBeTruthy();
  });
});
