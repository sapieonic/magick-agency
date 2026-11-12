import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { StrictMode, useLayoutEffect, useState } from 'react';
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { UrlScopeProvider } from '../../contexts/UrlScopeContext';
import { ScopedRouter } from '../../components/routing/ScopedRouter';

/**
 * Leaving a page with unsaved edits asks first: in-app navigation (held by the navigator),
 * Back and Forward (a capture-phase `popstate`), and a full page load (`beforeunload`).
 */

function Editor() {
  const [dirty, setDirty] = useState(false);
  const guard = useUnsavedChangesGuard(dirty);
  const navigate = useNavigate();
  return (
    <div>
      <button type="button" onClick={() => setDirty(true)}>Edit</button>
      <button type="button" onClick={() => setDirty(false)}>Save</button>
      <Link to="/elsewhere">Elsewhere</Link>
      <button type="button" onClick={() => navigate({ hash: '#recording' }, { replace: true })}>Section</button>
      <button type="button" onClick={() => navigate(-1)}>Go back</button>
      <span data-testid="dirty">{dirty ? 'unsaved' : 'clean'}</span>
      {guard.asking && (
        <div role="dialog">
          <button type="button" onClick={guard.leave}>Leave</button>
          <button type="button" onClick={guard.stay}>Stay</button>
        </div>
      )}
    </div>
  );
}

function Where() {
  const { pathname, hash } = useLocation();
  return <span data-testid="where">{`${pathname}${hash}`}</span>;
}

function renderMemory() {
  return render(
    <MemoryRouter initialEntries={['/before', '/settings']} initialIndex={1}>
      <Routes>
        <Route path="/settings" element={<Editor />} />
        <Route path="*" element={<p>Another page</p>} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId('where').textContent;

afterEach(cleanup);

describe('useUnsavedChangesGuard — in-app navigation', () => {
  it('lets a clean page go at once', () => {
    renderMemory();
    fireEvent.click(screen.getByText('Elsewhere'));
    expect(where()).toBe('/elsewhere');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('holds a link away from unsaved edits and asks; Stay keeps the page', () => {
    renderMemory();
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Elsewhere'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(where()).toBe('/settings');

    fireEvent.click(screen.getByText('Stay'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(where()).toBe('/settings');
  });

  it('Leave carries out the navigation that was held', () => {
    renderMemory();
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Elsewhere'));
    fireEvent.click(screen.getByText('Leave'));
    expect(where()).toBe('/elsewhere');
    expect(screen.getByText('Another page')).toBeTruthy();
  });

  it('holds navigate(-1) too', () => {
    renderMemory();
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Go back'));
    expect(where()).toBe('/settings');
    fireEvent.click(screen.getByText('Leave'));
    expect(where()).toBe('/before');
  });

  it('lets a change of hash on the same page through (the section nav)', () => {
    renderMemory();
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Section'));
    expect(where()).toBe('/settings#recording');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stops holding once the edits are saved', () => {
    renderMemory();
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.click(screen.getByText('Save'));
    fireEvent.click(screen.getByText('Elsewhere'));
    expect(where()).toBe('/elsewhere');
  });
});

describe('useUnsavedChangesGuard — a full page load', () => {
  const unload = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('asks the browser to confirm only while there are unsaved edits', () => {
    renderMemory();
    expect(unload()).toBe(false);
    fireEvent.click(screen.getByText('Edit'));
    expect(unload()).toBe(true);
    fireEvent.click(screen.getByText('Save'));
    expect(unload()).toBe(false);
  });
});

/**
 * Chromium runs a window's `popstate` listeners in the order they were added, capture phase
 * or not; happy-dom, like the DOM spec, runs capture listeners first. The guard once relied on
 * the spec's order (a capture listener of its own) and Back left the page in the browser while
 * every test here passed. These tests add listeners the way Chromium runs them.
 */
function runPopStateListenersInAddedOrder() {
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  const bubble = (type: string, options?: boolean | AddEventListenerOptions | EventListenerOptions) =>
    (type === 'popstate' && options !== undefined
      ? (typeof options === 'boolean' ? false : { ...options, capture: false })
      : options);
  window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) =>
    add(type, listener, bubble(type, options))) as typeof window.addEventListener;
  window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) =>
    remove(type, listener, bubble(type, options))) as typeof window.removeEventListener;
  return () => {
    window.addEventListener = add as typeof window.addEventListener;
    window.removeEventListener = remove as typeof window.removeEventListener;
  };
}

/** Every location the router heard: a held Back must never reach it. */
let heard: string[] = [];

function Heard() {
  const location = useLocation();
  useLayoutEffect(() => {
    heard.push(`${location.pathname}${location.hash}`);
  }, [location]);
  return null;
}

function Overview() {
  return <Link to="/agency/campaigns/c1/settings">Settings</Link>;
}

const SCOPE = '/t/tenant-1/a/account-1';

/**
 * The console's own wiring: `UrlScopeProvider`'s history, whose one listener is added when the
 * app mounts, and `ScopedRouter` over it with the URL's scope as the basename.
 */
function renderConsole(path: string) {
  window.history.replaceState(null, '', '/before');
  window.history.pushState(null, '', `${SCOPE}${path}`);
  return render(
    <StrictMode>
      <UrlScopeProvider>
        <ScopedRouter>
          <Routes>
            <Route path="/agency/campaigns/:id/overview" element={<Overview />} />
            <Route path="/agency/campaigns/:id/settings" element={<Editor />} />
            <Route path="*" element={<p>Another page</p>} />
          </Routes>
          <Where />
          <Heard />
        </ScopedRouter>
      </UrlScopeProvider>
    </StrictMode>,
  );
}

describe('useUnsavedChangesGuard — Back and Forward in the browser', () => {
  let restore: () => void = () => {};
  beforeEach(() => {
    restore = runPopStateListenersInAddedOrder();
  });
  afterEach(() => {
    restore();
  });

  /** Overview (a full page load), then the Settings tab, then an edit. */
  async function editAfterTab() {
    renderConsole('/agency/campaigns/c1/overview');
    fireEvent.click(screen.getByText('Settings'));
    expect(where()).toBe('/agency/campaigns/c1/settings');
    fireEvent.click(screen.getByText('Edit'));
    heard = [];
  }

  it('Back steps back to the page and asks; Stay keeps the edits', async () => {
    await editAfterTab();
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    // Back in the address bar too, not only on screen.
    await waitFor(() => expect(window.location.pathname).toBe(`${SCOPE}/agency/campaigns/c1/settings`));
    // The page never left: the router never heard of the step, and the edits are still there.
    expect(heard).toEqual([]);
    expect(screen.getByTestId('dirty').textContent).toBe('unsaved');

    fireEvent.click(screen.getByText('Stay'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(where()).toBe('/agency/campaigns/c1/settings');
  });

  it('Leave goes back after all', async () => {
    await editAfterTab();
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await waitFor(() => expect(window.location.pathname).toBe(`${SCOPE}/agency/campaigns/c1/settings`));

    fireEvent.click(screen.getByText('Leave'));
    await waitFor(() => expect(where()).toBe('/agency/campaigns/c1/overview'));
    expect(window.location.pathname).toBe(`${SCOPE}/agency/campaigns/c1/overview`);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('holds navigate(-1), and Leave is not held a second time', async () => {
    await editAfterTab();
    fireEvent.click(screen.getByText('Go back'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(where()).toBe('/agency/campaigns/c1/settings');

    fireEvent.click(screen.getByText('Leave'));
    await waitFor(() => expect(where()).toBe('/agency/campaigns/c1/overview'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lets Back go at once from a clean page', async () => {
    renderConsole('/agency/campaigns/c1/overview');
    fireEvent.click(screen.getByText('Settings'));
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(where()).toBe('/agency/campaigns/c1/overview'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lets a step within the page through: a section hash, then Back to the page without it', async () => {
    renderConsole('/agency/campaigns/c1/settings');
    fireEvent.click(screen.getByText('Edit'));
    await act(async () => {
      window.history.pushState(null, '', `${SCOPE}/agency/campaigns/c1/settings#recording`);
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    await waitFor(() => expect(where()).toBe('/agency/campaigns/c1/settings#recording'));
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(where()).toBe('/agency/campaigns/c1/settings'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('dirty').textContent).toBe('unsaved');
  });
});
