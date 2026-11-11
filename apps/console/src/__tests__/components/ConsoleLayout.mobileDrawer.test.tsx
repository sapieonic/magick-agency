import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

/**
 * ConsoleLayout (decision B28) — the mobile navigation drawer lifecycle, carried over from the
 * old `/app` shell, which now applies to every page of the console. Covers: the closed
 * drawer being pulled out of the mobile focus/accessibility tree, the open drawer
 * isolating background content and trapping focus, Escape/overlay/close/route
 * selection all closing it and restoring focus, and the toggle reporting its
 * expanded/controlled state.
 */

const layoutMocks = vi.hoisted(() => ({ useProductSurface: vi.fn() }));

vi.mock('../../hooks/usePostHogIdentify', () => ({ usePostHogIdentify: () => {} }));
vi.mock('../../analytics/useProductSurface', () => ({ useProductSurface: layoutMocks.useProductSurface }));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 'tenant-1', accountId: 'account-1' }),
}));
vi.mock('../../components/layout/ConsoleTopBar', () => ({
  ConsoleTopBar: ({ onMenuClick, menuExpanded, menuControls }: { onMenuClick?: () => void; menuExpanded?: boolean; menuControls?: string }) => (
    <button type="button" aria-label="Toggle menu" aria-expanded={menuExpanded} aria-controls={menuControls} onClick={onMenuClick} />
  ),
}));
vi.mock('../../components/common/GlobalSearch', () => ({ GlobalSearch: () => <div data-testid="global-search" /> }));

// The sidebar's own contents (sections, permissions, governance...) aren't under
// test here — stand in with two focusable controls so the drawer's focus trap
// and "route selection closes it" behavior can be exercised generically.
vi.mock('../../components/layout/ConsoleSidebar', () => ({
  ConsoleSidebar: ({ onClose }: { onClose?: () => void }) => (
    <div>
      <button type="button" onClick={onClose}>Close menu</button>
      <a href="#calls" onClick={onClose}>Calls</a>
    </div>
  ),
}));

import { ConsoleLayout } from '../../components/layout/ConsoleLayout';

const MOBILE_MEDIA = '(max-width: 768px)';

function mockMatchMedia(isMobile: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === MOBILE_MEDIA ? isMobile : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function renderLayout(path = '/settings/team') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ConsoleLayout />}>
          <Route path="/settings/team" element={<div>Dashboard content</div>} />
          <Route path="/agency/campaigns" element={<div>Dashboard content</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function getDrawer() {
  return document.getElementById('console-mobile-sidebar')!;
}

function getToggle() {
  return screen.getByRole('button', { name: 'Toggle menu' });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ConsoleLayout — mobile drawer', () => {
  beforeEach(() => mockMatchMedia(true));

  it('starts closed, inert, and out of the a11y tree, with the toggle reporting collapsed state', () => {
    renderLayout();
    const drawer = getDrawer();
    expect(drawer.inert).toBe(true);
    expect(drawer.getAttribute('role')).toBe('dialog');

    const toggle = getToggle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('console-mobile-sidebar');
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

describe('ConsoleLayout — desktop (no drawer semantics)', () => {
  beforeEach(() => mockMatchMedia(false));

  it('never marks the sidebar inert and does not apply dialog semantics', () => {
    renderLayout();
    const drawer = getDrawer();
    expect(drawer.inert).toBe(false);
    expect(drawer.getAttribute('role')).toBeNull();
  });
});

describe('ConsoleLayout — one shell for both zones', () => {
  beforeEach(() => mockMatchMedia(false));

  it('mounts the ⌘K palette on every page, Settings and work alike', () => {
    renderLayout('/settings/team');
    expect(screen.getByTestId('global-search')).toBeTruthy();
    cleanup();
    renderLayout('/agency/campaigns');
    expect(screen.getByTestId('global-search')).toBeTruthy();
  });

  it("claims 'agency' on the work pages and 'ai' on Settings, as the two old shells did", () => {
    renderLayout('/agency/campaigns');
    expect(layoutMocks.useProductSurface).toHaveBeenLastCalledWith('agency');
    cleanup();
    renderLayout('/settings/team');
    expect(layoutMocks.useProductSurface).toHaveBeenLastCalledWith('ai');
  });
});

describe('ConsoleLayout — widening past the phone breakpoint with the drawer open', () => {
  /** A media query whose answer the test changes, telling its listeners as a browser would. */
  function liveMatchMedia(initial: boolean) {
    let mobile = initial;
    const listeners = new Set<() => void>();
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      get matches() {
        return query === MOBILE_MEDIA ? mobile : false;
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }));
    return (next: boolean) => {
      mobile = next;
      act(() => listeners.forEach((fn) => fn()));
    };
  }

  it('leaves nothing inert, keeps focus where it was in the sidebar, and forgets the drawer', async () => {
    const resize = liveMatchMedia(true);
    renderLayout();
    const toggle = getToggle();
    act(() => toggle.focus());
    fireEvent.click(toggle);
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Close menu'));
    const focused = document.activeElement;

    resize(false);

    const mainWrapper = screen.getByText('Dashboard content').closest('main')!.parentElement!;
    expect(getDrawer().inert).toBe(false);
    expect(mainWrapper.inert).toBe(false);
    expect(getDrawer().getAttribute('role')).toBeNull();
    // Not thrown back to the toggle, which a desktop hides.
    expect(document.activeElement).toBe(focused);
    expect(getToggle().getAttribute('aria-expanded')).toBe('false');

    // Back to a phone: the drawer is closed, not reopened.
    resize(true);
    expect(getDrawer().inert).toBe(true);
    expect(mainWrapper.inert).toBe(false);
  });
});
