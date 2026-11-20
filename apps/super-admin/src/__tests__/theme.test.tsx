import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * AS14 in the super-admin console: it opens in light unless the operator chose dark, keeps that
 * choice in this browser (only a choice is stored, never the default), and the switch in the
 * sidebar moves between the two (`theme.ts`).
 */
vi.mock('../components/common/Logo', () => ({ Logo: () => <span data-testid="logo" /> }));

import { SA_THEME_CHOICE_KEY, applyTheme, initialTheme, readThemeChoice } from '../theme';
import { SuperAdminSidebar } from '../components/layout/SuperAdminSidebar';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
afterEach(() => vi.restoreAllMocks());

describe('the super-admin theme (AS14)', () => {
  it('opens in light when the operator never chose, and stores nothing for it', () => {
    expect(readThemeChoice()).toBeNull();
    expect(initialTheme()).toBe('light');
    applyTheme(initialTheme());
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(SA_THEME_CHOICE_KEY)).toBeNull();
  });

  it('opens in the saved choice: dark stays dark', () => {
    localStorage.setItem(SA_THEME_CHOICE_KEY, 'dark');
    expect(initialTheme()).toBe('dark');
    localStorage.setItem(SA_THEME_CHOICE_KEY, 'light');
    expect(initialTheme()).toBe('light');
  });

  it('reads anything else, or storage that throws, as no choice', () => {
    localStorage.setItem(SA_THEME_CHOICE_KEY, 'purple');
    expect(initialTheme()).toBe('light');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(initialTheme()).toBe('light');
  });

  it('the sidebar switch turns dark on and off, and saves each choice', () => {
    render(<MemoryRouter><SuperAdminSidebar /></MemoryRouter>);
    const toggle = screen.getByRole('button', { name: 'Dark theme' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(localStorage.getItem(SA_THEME_CHOICE_KEY)).toBe('dark');
    fireEvent.click(toggle);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem(SA_THEME_CHOICE_KEY)).toBe('light');
  });

  it('the switch shows the saved dark choice as on', () => {
    localStorage.setItem(SA_THEME_CHOICE_KEY, 'dark');
    render(<MemoryRouter><SuperAdminSidebar /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Dark theme' }).getAttribute('aria-pressed')).toBe('true');
  });
});
