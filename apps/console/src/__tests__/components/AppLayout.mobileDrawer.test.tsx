import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * AppLayout — mobile navigation drawer lifecycle (86d3nxc9n). Covers: the closed
 * drawer being pulled out of the mobile focus/accessibility tree, the open drawer
 * isolating background content and trapping focus, Escape/overlay/close/route
 * selection all closing it and restoring focus, and the toggle reporting its
 * expanded/controlled state.
 */

vi.mock('../../hooks/usePostHogIdentify', () => ({ usePostHogIdentify: () => {} }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1', display_name: 'Test User', email: 't@example.com' }, loading: false }),
}));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 'tenant-1', accountId: 'account-1' }),
}));
vi.mock('../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }),
}));
vi.mock('../../components/layout/TenantSwitcher', () => ({ TenantSwitcher: () => null }));
vi.mock('../../components/layout/AccountSwitcher', () => ({ AccountSwitcher: () => null }));
// PORT NOTE (magick-agency): cusui also stubbed `CreditBadge`, which is not ported.
vi.mock('../../components/common/GlobalSearch', () => ({ GlobalSearch: () => null }));

// Sidebar's own contents (nav sections, permissions, governance...) aren't under
// test here — stand in with two focusable controls so the drawer's focus trap
// and "route selection closes it" behavior can be exercised generically.
vi.mock('../../components/layout/Sidebar', () => ({
  Sidebar: ({ onClose }: { onClose?: () => void }) => (
    <div>
      <button type="button" onClick={onClose}>Close menu</button>
      <a href="#calls" onClick={onClose}>Calls</a>
    </div>
  ),
}));

import { AppLayout } from '../../components/layout/AppLayout';

const MOBILE_MEDIA = '(max-width: 768px)';

function mockMatchMedia(isMobile: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === MOBILE_MEDIA ? isMobile : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function renderLayout() {
  return render(
    <MemoryRouter initialEntries={['/app']}>
      <Routes>
        <Route path="/app" element={<AppLayout />}>
          <Route index element={<div>Dashboard content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function getDrawer() {
  return document.getElementById('app-mobile-sidebar')!;
}

function getToggle() {
  return screen.getByRole('button', { name: 'Toggle menu' });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AppLayout — mobile drawer (86d3nxc9n)', () => {
  beforeEach(() => mockMatchMedia(true));

  it('starts closed, inert, and out of the a11y tree, with the toggle reporting collapsed state', () => {
    renderLayout();
    const drawer = getDrawer();
    expect(drawer.inert).toBe(true);
    expect(drawer.getAttribute('role')).toBe('dialog');

    const toggle = getToggle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('app-mobile-sidebar');
  });

  it('opening isolates the background, un-inerts the drawer, and reports expanded', async () => {
    renderLayout();
    fireEvent.click(getToggle());

    const drawer = getDrawer();
    expect(drawer.inert).toBe(false);
    expect(getToggle().getAttribute('aria-expanded')).toBe('true');

    // Background content (topbar + main) is isolated while the drawer is open.
    // `inert` propagates to descendants but the property only reflects the
    // attribute on the element it was actually set on — the main wrapper.
    const mainWrapper = screen.getByText('Dashboard content').closest('main')!.parentElement!;
    expect(mainWrapper.inert).toBe(true);

    // Focus moves into the drawer.
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Close menu');
    });
  });

  it('Escape closes the drawer, re-inerts it, un-isolates the background, and restores focus to the toggle', async () => {
    renderLayout();
    const toggle = getToggle();
    // Real clicks/keyboard activation focus the button first; fireEvent.click alone
    // doesn't, so focus it explicitly to exercise the "restore focus" behavior.
    act(() => toggle.focus());
    fireEvent.click(toggle);
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Close menu'));

    fireEvent.keyDown(getDrawer(), { key: 'Escape' });

    expect(getDrawer().inert).toBe(true);
    expect(getToggle().getAttribute('aria-expanded')).toBe('false');
    const mainWrapper = screen.getByText('Dashboard content').closest('main')!.parentElement!;
    expect(mainWrapper.inert).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });

  it('clicking the overlay closes the drawer', async () => {
    const { container } = renderLayout();
    fireEvent.click(getToggle());
    await waitFor(() => expect(getDrawer().inert).toBe(false));

    const overlay = container.querySelector('[class*="overlay"]')!;
    fireEvent.click(overlay);

    expect(getDrawer().inert).toBe(true);
  });

  it('route selection (a nav link inside the drawer) closes it', async () => {
    renderLayout();
    fireEvent.click(getToggle());
    await waitFor(() => expect(getDrawer().inert).toBe(false));

    fireEvent.click(screen.getByText('Calls'));

    expect(getDrawer().inert).toBe(true);
  });

  it('the close control inside the drawer closes it', async () => {
    renderLayout();
    fireEvent.click(getToggle());
    await waitFor(() => expect(getDrawer().inert).toBe(false));

    fireEvent.click(screen.getByText('Close menu'));

    expect(getDrawer().inert).toBe(true);
  });

  it('traps Tab focus within the open drawer, cycling from the last control back to the first', async () => {
    renderLayout();
    fireEvent.click(getToggle());
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Close menu'));

    const lastLink = screen.getByText('Calls');
    act(() => lastLink.focus());
    fireEvent.keyDown(getDrawer(), { key: 'Tab' });

    expect(document.activeElement?.textContent).toBe('Close menu');
  });
});

describe('AppLayout — desktop (no drawer semantics)', () => {
  beforeEach(() => mockMatchMedia(false));

  it('never marks the sidebar inert and does not apply dialog semantics', () => {
    renderLayout();
    const drawer = getDrawer();
    expect(drawer.inert).toBe(false);
    expect(drawer.getAttribute('role')).toBeNull();
  });
});
