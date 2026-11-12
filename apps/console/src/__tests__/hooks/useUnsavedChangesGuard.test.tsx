import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { StrictMode, useLayoutEffect, useState, type ReactNode } from 'react';
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';
import { UrlScopeProvider, useUrlScope } from '../../contexts/UrlScopeContext';
import { ScopedRouter } from '../../components/routing/ScopedRouter';

/**
 * Leaving a page with unsaved edits asks first: in-app navigation (held by the navigator),
 * Back and Forward (held in `UrlScopeProvider`'s history listener), and a full page load
 * (`beforeunload`).
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

/* ── One stack of blockers, forced redirects and steps within the page ─────── */

/** A form with its own guard; `name` tells two apart. */
function Guarded({ name }: { name: string }) {
  const [dirty, setDirty] = useState(false);
  const guard = useUnsavedChangesGuard(dirty);
  return (
    <div>
      <button type="button" onClick={() => setDirty(true)}>{`Edit ${name}`}</button>
      {guard.asking && (
        <div role="dialog" aria-label={`Leave ${name}?`}>
          <button type="button" onClick={guard.leave}>{`Leave ${name}`}</button>
          <button type="button" onClick={guard.stay}>{`Stay ${name}`}</button>
        </div>
      )}
    </div>
  );
}

/** Two guards on one page, each of which can be taken away. */
function TwoForms() {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(true);
  return (
    <div>
      {outer && <Guarded name="outer" />}
      {inner && <Guarded name="inner" />}
      <button type="button" onClick={() => setOuter(false)}>Close outer</button>
      <button type="button" onClick={() => setInner(false)}>Close inner</button>
      <Link to="/elsewhere">Elsewhere</Link>
    </div>
  );
}

/** The page's other ways to move: a hash pushed, a trailing slash, a forward step, a forced redirect. */
function MoreWays() {
  const navigate = useNavigate();
  const { go } = useUrlScope();
  return (
    <div>
      <button type="button" onClick={() => navigate({ hash: '#recording' })}>Push section</button>
      <button type="button" onClick={() => navigate('/agency/campaigns/c1/settings/')}>Trailing slash</button>
      <button type="button" onClick={() => navigate(1)}>Go forward</button>
      <button type="button" onClick={() => go({ tenantId: 'tenant-1', accountId: 'account-2' }, '/', { replace: true, force: true })}>
        Account taken away
      </button>
      <button type="button" onClick={() => go({ tenantId: 'tenant-1', accountId: 'account-2' }, '/')}>Other account</button>
      <Link to="/agency/campaigns/c1/calls">Calls</Link>
    </div>
  );
}

function renderWith(path: string, settings: ReactNode) {
  window.history.replaceState(null, '', '/before');
  window.history.pushState(null, '', `${SCOPE}${path}`);
  return render(
    <StrictMode>
      <UrlScopeProvider>
        <ScopedRouter>
          <Routes>
            <Route path="/agency/campaigns/:id/overview" element={<Link to="/agency/campaigns/c1/calls">Calls</Link>} />
            <Route path="/agency/campaigns/:id/calls" element={<Link to="/agency/campaigns/c1/settings">Settings</Link>} />
            <Route path="/agency/campaigns/:id/settings" element={settings} />
            <Route path="*" element={<p>Another page</p>} />
          </Routes>
          <Where />
          <Heard />
        </ScopedRouter>
      </UrlScopeProvider>
    </StrictMode>,
  );
}

const asked = (name: string) => screen.queryByRole('dialog', { name: `Leave ${name}?` });

describe('useUnsavedChangesGuard — two guards on one page', () => {
  function bothDirty() {
    renderWith('/agency/campaigns/c1/settings', <TwoForms />);
    fireEvent.click(screen.getByText('Edit outer'));
    fireEvent.click(screen.getByText('Edit inner'));
  }

  it('asks the newest first, then the other, and goes only when both let it', () => {
    bothDirty();
    fireEvent.click(screen.getByText('Elsewhere'));
    expect(asked('inner')).toBeTruthy();
    expect(asked('outer')).toBeNull();
    fireEvent.click(screen.getByText('Leave inner'));
    expect(asked('outer')).toBeTruthy();
    expect(where()).toBe('/agency/campaigns/c1/settings');
    fireEvent.click(screen.getByText('Leave outer'));
    expect(where()).toBe('/elsewhere');
  });

  it('the inner one closed first: the outer one still holds, and once it closes nothing does', () => {
    bothDirty();
    fireEvent.click(screen.getByText('Close inner'));
    fireEvent.click(screen.getByText('Elsewhere'));
    expect(asked('outer')).toBeTruthy();
    fireEvent.click(screen.getByText('Stay outer'));
    fireEvent.click(screen.getByText('Close outer'));
    fireEvent.click(screen.getByText('Elsewhere'));
    expect(where()).toBe('/elsewhere');
  });

  it('the inner one closed last: it still holds after the outer one went, and nothing holds after it', () => {
    bothDirty();
    fireEvent.click(screen.getByText('Close outer'));
    fireEvent.click(screen.getByText('Elsewhere'));
    expect(asked('inner')).toBeTruthy();
    expect(where()).toBe('/agency/campaigns/c1/settings');
    fireEvent.click(screen.getByText('Stay inner'));
    fireEvent.click(screen.getByText('Close inner'));
    fireEvent.click(screen.getByText('Elsewhere'));
    expect(where()).toBe('/elsewhere');
  });
});

describe('useUnsavedChangesGuard — what it lets through', () => {
  let restore: () => void = () => {};
  beforeEach(() => {
    restore = runPopStateListenersInAddedOrder();
  });
  afterEach(() => {
    restore();
  });

  /** Calls, then Settings (an entry the router numbered behind it), then an edit. */
  function dirtyWithMore() {
    renderWith(
      '/agency/campaigns/c1/calls',
      <>
        <Editor />
        <MoreWays />
      </>,
    );
    fireEvent.click(screen.getByText('Settings'));
    fireEvent.click(screen.getByText('Edit'));
  }

  it('never holds a forced redirect (the open account taken away), though it holds a plain move between accounts', () => {
    dirtyWithMore();
    fireEvent.click(screen.getByText('Other account'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByText('Stay'));
    fireEvent.click(screen.getByText('Account taken away'));
    expect(window.location.pathname).toBe('/t/tenant-1/a/account-2');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lets the same page with a trailing slash through', () => {
    dirtyWithMore();
    fireEvent.click(screen.getByText('Trailing slash'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.location.pathname).toBe(`${SCOPE}/agency/campaigns/c1/settings/`);
  });

  it('lets Back through between two entries of the same page that the router numbered', async () => {
    dirtyWithMore();
    fireEvent.click(screen.getByText('Push section'));
    expect(where()).toBe('/agency/campaigns/c1/settings#recording');
    heard = [];
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(where()).toBe('/agency/campaigns/c1/settings'));
    expect(heard).toEqual(['/agency/campaigns/c1/settings']);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('dirty').textContent).toBe('unsaved');
  });

  it('after a Leave whose step went nowhere (no entry ahead), still holds the next Back', async () => {
    dirtyWithMore();
    fireEvent.click(screen.getByText('Go forward'));
    fireEvent.click(screen.getByText('Leave'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(where()).toBe('/agency/campaigns/c1/settings');
    heard = [];
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    expect(heard).toEqual([]);
    expect(window.location.pathname).toBe(`${SCOPE}/agency/campaigns/c1/settings`);
  });
});

/**
 * Chromium takes history steps one after another, each popstate a task of its own: a step asked
 * for in a popstate listener waits behind one the person already took. happy-dom takes each at
 * once, inside the call; this queues them as Chromium does.
 */
function takeStepsOneAtATime() {
  const original = { go: window.history.go, back: window.history.back, forward: window.history.forward };
  const go = original.go.bind(window.history);
  const queue: number[] = [];
  let busy = false;
  const next = () => {
    const delta = queue.shift();
    if (delta === undefined) {
      busy = false;
      return;
    }
    go(delta);
    setTimeout(next, 0);
  };
  const take = (delta: number) => {
    queue.push(delta);
    if (!busy) {
      busy = true;
      setTimeout(next, 0);
    }
  };
  window.history.go = (delta?: number) => take(delta ?? 0);
  window.history.back = () => take(-1);
  window.history.forward = () => take(1);
  return () => Object.assign(window.history, original);
}

describe('useUnsavedChangesGuard — Back twice before the page is put back', () => {
  let restore: () => void = () => {};
  beforeEach(() => {
    const listeners = runPopStateListenersInAddedOrder();
    const steps = takeStepsOneAtATime();
    restore = () => {
      steps();
      listeners();
    };
  });
  afterEach(() => {
    restore();
  });

  const settle = () => act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('puts the browser back on the page, asks once, and never tells the router', async () => {
    // Overview, Calls, Settings, then a page ahead and Back to Settings: an entry on each side.
    renderWith('/agency/campaigns/c1/overview', <Editor />);
    fireEvent.click(screen.getByText('Calls'));
    fireEvent.click(screen.getByText('Settings'));
    fireEvent.click(screen.getByText('Elsewhere'));
    await act(async () => {
      window.history.back();
    });
    await settle();
    expect(where()).toBe('/agency/campaigns/c1/settings');
    fireEvent.click(screen.getByText('Edit'));
    heard = [];

    await act(async () => {
      window.history.back();
      window.history.back();
    });
    await settle();

    expect(window.location.pathname).toBe(`${SCOPE}/agency/campaigns/c1/settings`);
    expect(heard).toEqual([]);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByTestId('dirty').textContent).toBe('unsaved');

    fireEvent.click(screen.getByText('Leave'));
    await settle();
    expect(where()).toBe('/agency/campaigns/c1/calls');
  });
});
