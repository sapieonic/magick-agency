import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  setActiveAccountId: vi.fn(),
  reloadAccounts: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));

import { AccountSwitcher } from '../../components/layout/AccountSwitcher';
import type { TenantAccount } from '../../types/auth';

/**
 * **The narrowed-account-list warning.**
 *
 * `TenantContext` falls back from `GET /accounts` to `GET /accounts/mine` on any
 * rejection, which is right for recovery and was silent about the difference. An
 * `account_admin` signing in during a master restart got their own memberships
 * only — no `slug`/`settings`/`status` and possibly fewer accounts — while
 * resolution reported `'ready'`: no warning, no retry, and the narrowed selection
 * written to `localStorage`.
 *
 * This control is where the warning belongs because this control is what is wrong,
 * and the assertions below are about the two things a user needs: being told, and
 * having something to press.
 */

const ONE: TenantAccount[] = [{ id: 'acct-1', tenant_id: 't-1', name: 'Ops' }];
const TWO: TenantAccount[] = [
  { id: 'acct-1', tenant_id: 't-1', name: 'Ops' },
  { id: 'acct-2', tenant_id: 't-1', name: 'Sales' },
];

function setup({
  accounts = TWO,
  accountResolution = 'ready' as 'loading' | 'ready' | 'degraded' | 'error',
} = {}) {
  mocks.useTenant.mockReturnValue({
    accounts,
    accountId: 'acct-1',
    setActiveAccountId: mocks.setActiveAccountId,
    accountResolution,
    reloadAccounts: mocks.reloadAccounts,
  });
  return render(<AccountSwitcher />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('AccountSwitcher', () => {
  it('says nothing when the list is authoritative', () => {
    // The warning must not become wallpaper: an agent below `account.read` reaches
    // `/accounts/mine` by a legitimate 403 on every sign-in, and that resolves
    // `'ready'` precisely so this stays quiet.
    setup();
    expect(screen.queryByTestId('accounts-degraded')).toBeNull();
  });

  it('warns that the list may be incomplete when resolution degraded', () => {
    setup({ accountResolution: 'degraded' });

    const warning = screen.getByTestId('accounts-degraded');
    expect(warning.textContent).toContain('incomplete');
    // Still usable — the switcher itself is not blocked or hidden. `'degraded'`
    // means "you can work, but this list might be short", which is a caveat on a
    // control rather than an outage. Asserted by opening the dropdown, because the
    // list is not in the DOM until it does.
    fireEvent.click(screen.getByRole('button', { name: /Ops/ }));
    expect(screen.getByText('Sales')).toBeTruthy();
  });

  it('offers a retry that actually re-resolves', () => {
    setup({ accountResolution: 'degraded' });

    fireEvent.click(screen.getByTestId('accounts-degraded'));

    expect(mocks.reloadAccounts).toHaveBeenCalledTimes(1);
  });

  it('opens a scrollable searchable list and selects only on click', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Ops/ }));

    expect(screen.getByTestId('switcher-list')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Search accounts' })).toBeTruthy();

    fireEvent.wheel(screen.getByTestId('switcher-list'), { deltaY: 120 });
    expect(mocks.setActiveAccountId).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('option', { name: 'Sales' }));
    expect(mocks.setActiveAccountId).toHaveBeenCalledWith('acct-2');
    expect(screen.queryByTestId('switcher-list')).toBeNull();
  });

  it('filters accounts by name from the search box', () => {
    setup({
      accounts: [
        ...TWO,
        { id: 'acct-3', tenant_id: 't-1', name: 'Support' },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /Ops/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search accounts' }), {
      target: { value: 'sales' },
    });

    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: 'Sales' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Support' })).toBeNull();
  });

  it('returns focus to the trigger on Escape', () => {
    setup();
    const trigger = screen.getByRole('button', { name: /Ops/ });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search accounts' }), { key: 'Escape' });
    expect(screen.queryByTestId('switcher-list')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('warns in the single-account shape too', () => {
    /**
     * The shape that matters most, and the one that would have been missed. A list
     * narrowed to just the caller's own membership very often HAS one entry — so the
     * component renders its static-text branch, which otherwise reads as confident,
     * complete, and has nothing to click.
     */
    setup({ accounts: ONE, accountResolution: 'degraded' });

    expect(screen.getByText('Ops')).toBeTruthy();
    expect(screen.getByTestId('accounts-degraded')).toBeTruthy();
  });
});
