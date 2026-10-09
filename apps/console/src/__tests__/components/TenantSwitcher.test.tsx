import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { Tenant } from '../../types/auth';

const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useTenant: vi.fn(),
  setActiveTenantId: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));

import { TenantSwitcher } from '../../components/layout/TenantSwitcher';

function tenant(id: string, name: string, slug: string): Tenant {
  return {
    id,
    name,
    slug,
    settings: {},
    status: 'active',
    created_at: '',
    updated_at: '',
  };
}

const ONE: Tenant[] = [tenant('t-1', 'Acme', 'acme')];
const MANY: Tenant[] = [
  tenant('t-1', 'Acme', 'acme'),
  tenant('t-2', 'Globex', 'globex'),
  tenant('t-3', 'Initech', 'initech'),
];

function setup(tenants: Tenant[] = MANY) {
  mocks.useAuth.mockReturnValue({ tenants });
  mocks.useTenant.mockReturnValue({
    activeTenant: tenants[0] ?? null,
    setActiveTenantId: mocks.setActiveTenantId,
  });
  return render(<TenantSwitcher />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('TenantSwitcher', () => {
  it('renders static text when there is only one tenant', () => {
    setup(ONE);
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('opens a scrollable searchable list and selects only on click', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Acme/ }));

    expect(screen.getByTestId('switcher-list')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Search tenants' })).toBeTruthy();
    expect(screen.getByText('Initech')).toBeTruthy();

    fireEvent.wheel(screen.getByTestId('switcher-list'), { deltaY: 120 });
    expect(mocks.setActiveTenantId).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('option', { name: /Globex/ }));
    expect(mocks.setActiveTenantId).toHaveBeenCalledWith('t-2');
    expect(screen.queryByTestId('switcher-list')).toBeNull();
  });

  it('filters tenants by name from the search box', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Acme/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tenants' }), {
      target: { value: 'initech' },
    });

    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /Initech/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Globex/ })).toBeNull();
  });

  it('stays open when blur has no relatedTarget (scrollbar / chrome click)', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Acme/ }));
    const switcher = screen.getByRole('button', { name: /Acme/ }).parentElement;
    expect(switcher).toBeTruthy();
    fireEvent.blur(switcher!, { relatedTarget: null });
    expect(screen.getByTestId('switcher-list')).toBeTruthy();
  });

  it('closes when Tab moves focus outside the switcher', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Acme/ }));
    const switcher = screen.getByRole('button', { name: /Acme/ }).parentElement;
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    fireEvent.blur(switcher!, { relatedTarget: outside });
    expect(screen.queryByTestId('switcher-list')).toBeNull();
    outside.remove();
  });

  it('returns focus to the trigger on Escape', () => {
    setup();
    const trigger = screen.getByRole('button', { name: /Acme/ });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search tenants' }), { key: 'Escape' });
    expect(screen.queryByTestId('switcher-list')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the trigger after selecting', () => {
    setup();
    const trigger = screen.getByRole('button', { name: /Acme/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /Globex/ }));
    expect(document.activeElement).toBe(trigger);
  });
});
