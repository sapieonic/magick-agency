import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { useLayoutEffect, useState } from 'react';
import {
  Link,
  MemoryRouter,
  Route,
  Router,
  Routes,
  UNSAFE_createBrowserHistory,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { useUnsavedChangesGuard } from '../../hooks/useUnsavedChangesGuard';

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

/** The console's own router: a plain `<Router>` over a browser history (`ScopedRouter`). */
function BrowserApp({ history }: { history: ReturnType<typeof UNSAFE_createBrowserHistory> }) {
  const [state, setState] = useState({ action: history.action, location: history.location });
  useLayoutEffect(() => history.listen(({ action, location }) => setState({ action, location })), [history]);
  return (
    <Router location={state.location} navigationType={state.action} navigator={history}>
      <Routes>
        <Route path="/settings" element={<Editor />} />
        <Route path="*" element={<p>Another page</p>} />
      </Routes>
      <Where />
    </Router>
  );
}

describe('useUnsavedChangesGuard — Back in the browser', () => {
  it('steps back to the page and asks; Leave goes back after all', async () => {
    window.history.replaceState(null, '', '/before');
    const history = UNSAFE_createBrowserHistory({ window, v5Compat: true });
    history.push('/settings');
    render(<BrowserApp history={history} />);
    expect(where()).toBe('/settings');

    fireEvent.click(screen.getByText('Edit'));
    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    // Back in the browser too, not only on screen.
    await waitFor(() => expect(window.location.pathname).toBe('/settings'));
    expect(where()).toBe('/settings');

    fireEvent.click(screen.getByText('Leave'));
    await waitFor(() => expect(where()).toBe('/before'));
    expect(window.location.pathname).toBe('/before');
  });

  it('lets Back go at once from a clean page', async () => {
    window.history.replaceState(null, '', '/before');
    const history = UNSAFE_createBrowserHistory({ window, v5Compat: true });
    history.push('/settings');
    render(<BrowserApp history={history} />);

    await act(async () => {
      window.history.back();
    });
    await waitFor(() => expect(where()).toBe('/before'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
