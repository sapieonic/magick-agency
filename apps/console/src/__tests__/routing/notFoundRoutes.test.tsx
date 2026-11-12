import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * URLs that are not a page (B28): a section's root opens the section's first tab the reader may
 * open (`/agency/inbound` → Missed calls), and an unknown path under `/agency`, `/settings`,
 * `/app` or anywhere else signed-in says "page not found" inside the shell, with the way home,
 * instead of landing on Home with no word why. The old `/app/<page>` redirects are unchanged
 * (`SettingsHub.test.tsx`).
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string | undefined,
  missedAvailable: true,
}));

// Home's acknowledgements are the signed-in reader's (`useHomeAcks`).
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-1' } }) }));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ role: mocks.role, tenantId: 't-1', accountId: 'a-1' }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true, status: 'ready' }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => true, loading: false }),
}));
vi.mock('../../hooks/useMissedCallsAccess', () => ({
  useMissedCallsAccess: () => ({ available: mocks.missedAvailable, inboundOn: true, count: null, settled: true }),
}));
vi.mock('../../components/layout/ProfileMenu', () => ({ ProfileMenu: () => null }));

import NotFoundPage from '../../pages/NotFoundPage';
import LegacyAppRedirect from '../../pages/LegacyAppRedirect';
import { SectionLanding } from '../../components/layout/SectionLanding';
import { ConsoleTopBar } from '../../components/layout/ConsoleTopBar';
import { PageCrumbsProvider } from '../../components/layout/PageCrumbs';
import { CONSOLE_SECTIONS, sectionRootFor } from '../../utils/consoleNav';

function Where() {
  const { pathname, search, hash } = useLocation();
  return <div data-testid="where">{`${pathname}${search}${hash}`}</div>;
}

/** The shell's shape, as `App.tsx` declares it: the agency subtree, Settings, `/app`, the rest. */
function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PageCrumbsProvider>
        <ConsoleTopBar />
        <Routes>
          <Route path="/agency">
            <Route path="home" element={<Where />} />
            <Route path="inbound/missed" element={<Where />} />
            <Route path="inbound/summary" element={<Where />} />
            <Route path="inbound" element={<SectionLanding />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          <Route path="/settings">
            <Route path="team" element={<Where />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          <Route path="/app">
            <Route index element={<Where />} />
            <Route path="*" element={<LegacyAppRedirect />} />
          </Route>
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </PageCrumbsProvider>
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId('where').textContent;
const notFound = () => screen.queryByTestId('not-found');

beforeEach(() => {
  mocks.role = 'account_admin';
  mocks.missedAvailable = true;
});
afterEach(() => cleanup());

describe('a section’s root', () => {
  it('opens the section’s first tab, keeping the query and the hash', () => {
    renderAt('/agency/inbound?from=email#top');
    expect(where()).toBe('/agency/inbound/missed?from=email#top');
  });

  it('opens it for a reader who reads only their own missed calls, and while the rule is unread', () => {
    mocks.role = 'operator';
    renderAt('/agency/inbound/');
    expect(where()).toBe('/agency/inbound/missed');
    cleanup();
    mocks.missedAvailable = false;
    renderAt('/agency/inbound');
    // Missed calls says for itself what it says to someone it does not serve.
    expect(where()).toBe('/agency/inbound/missed');
  });
});

describe('a URL that is no page', () => {
  it.each(['/agency/whatever', '/agency/campaigns-old', '/settings/whatever', '/app/whatever', '/app/calls/dialer/history/1', '/calls', '/whatever/deeper'])(
    '%s says the page is not found, where it was opened, with the way home',
    (path) => {
      renderAt(path);
      expect(notFound()).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
      expect(screen.queryByTestId('where')).toBeNull();
      const home = within(notFound()!).getByRole('link', { name: 'Go to Home' });
      expect(home.getAttribute('href')).toBe('/agency/home');
    },
  );

  it('names itself in the breadcrumb', () => {
    renderAt('/agency/whatever');
    expect(screen.getByTestId('console-breadcrumb').textContent).toBe('Page not found');
    cleanup();
    renderAt('/settings/whatever');
    expect(screen.getByTestId('console-breadcrumb').textContent).toBe('Settings/Page not found');
  });

  it('sends someone Home is not for to their start page instead', () => {
    mocks.role = 'viewer';
    renderAt('/agency/whatever');
    const link = within(notFound()!).getByRole('link', { name: 'Go to your start page' });
    expect(link.getAttribute('href')).toBe('/');
  });

  it('leaves a real page and an old /app page alone', () => {
    renderAt('/agency/inbound/summary');
    expect(where()).toBe('/agency/inbound/summary');
    cleanup();
    renderAt('/app/team');
    expect(notFound()).toBeNull();
  });
});

/**
 * `App.tsx` itself, read as source (it pulls in Firebase and every lazy page, so it is not
 * rendered here): the routes above are the ones it declares.
 */
describe('the real route table', () => {
  const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (from: string, to: string) => app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from)));
  const agency = block('path="/agency"', '<Route path="/settings"');
  const settings = block('<Route path="/settings"', '<Route path="/app">');
  const afterApp = app.slice(app.indexOf('<Route path="/app">'));
  const NOT_FOUND = '<Route path="*" element={<NotFoundPage />} />';

  it('opens every section root with SectionLanding', () => {
    const roots = CONSOLE_SECTIONS.flatMap((s) => s.paths).filter((p) => sectionRootFor(p) !== null);
    expect(roots).toContain('/agency/inbound');
    for (const root of roots) {
      expect(agency, root).toContain(`<Route path="${root.replace('/agency/', '')}" element={<SectionLanding />} />`);
    }
  });

  it('says not found under /agency, under /settings and for any other signed-in URL', () => {
    expect(agency).toContain(NOT_FOUND);
    expect(settings).toContain(NOT_FOUND);
    expect(afterApp).toContain(NOT_FOUND);
    expect(app).not.toMatch(/<Navigate to="\/app"/);
  });
});
