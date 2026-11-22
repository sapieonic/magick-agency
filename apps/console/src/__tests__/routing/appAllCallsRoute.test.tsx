import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Outlet, useLocation } from 'react-router-dom';

/**
 * All calls through the REAL route table (`App.tsx`), not a table a test wrote for itself:
 * `/agency/calls` opens the page, and the old Soft-phone calls URL lands on it with the Soft
 * phone chip on and its query kept (CL34, CL35). The page's own test mounts its own `<Route>`,
 * which is how the route once went missing from `App.tsx` with every test green.
 *
 * Only the frame around the table is stood in for: the providers, the router's scope prefix,
 * the guards (each has its own test) and the shell's chrome. The `<Routes>` block is App's.
 */

const mocks = vi.hoisted(() => ({
  at: '/agency/calls',
  passThrough: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../../contexts/AuthContext', () => ({ AuthProvider: mocks.passThrough, useAuth: () => ({ user: { id: 'u-1' } }) }));
vi.mock('../../contexts/TenantContext', () => ({
  TenantProvider: mocks.passThrough,
  useTenant: () => ({ role: 'account_admin', tenantId: 't-1', accountId: 'a-1' }),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  FeatureFlagsProvider: mocks.passThrough,
  useFeatureFlags: () => ({ isEnabled: () => true, status: 'ready' }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  GovernanceProvider: mocks.passThrough,
  useGovernance: () => ({ isEnabled: () => true, loading: false }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ ThemeProvider: mocks.passThrough }));
vi.mock('../../contexts/UrlScopeContext', () => ({ UrlScopeProvider: mocks.passThrough }));
vi.mock('../../components/routing/ScopedRouter', () => ({
  ScopedRouter: ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[mocks.at]}>{children}</MemoryRouter>,
}));
vi.mock('../../components/routing/ScopeGate', () => ({ ScopeGate: () => <Outlet /> }));
vi.mock('../../components/auth/RequireAuth', () => ({ default: mocks.passThrough }));
vi.mock('../../components/auth/RequireCapability', () => ({ default: mocks.passThrough }));
vi.mock('../../components/auth/RequireFlag', () => ({ default: mocks.passThrough }));
vi.mock('../../components/layout/ConsoleShell', () => ({ ConsoleShell: () => <Outlet /> }));
vi.mock('../../components/layout/AgencyArea', () => ({ AgencyArea: () => <Outlet /> }));
vi.mock('../../hooks/usePermission', () => ({ usePermission: () => true }));
// The list itself is `AllCallsPage.test.tsx`'s; here it only says which page and URL were reached.
vi.mock('../../pages/agency/AgencyCampaignAttemptsPage', () => ({
  default: () => null,
  CallLogList: ({ scope }: { scope: { kind: string } }) => {
    const { pathname, search } = useLocation();
    return <div data-testid="all-calls">{`${scope.kind} ${pathname}${search}`}</div>;
  },
}));

import App from '../../App';

afterEach(cleanup);

describe('All calls in the real route table', () => {
  it('opens All calls at /agency/calls', async () => {
    mocks.at = '/agency/calls';
    render(<App />);
    expect((await screen.findByTestId('all-calls')).textContent).toBe('account /agency/calls');
    expect(screen.queryByText(/page not found/i)).toBeNull();
  });

  it('sends the old Soft-phone calls URL to All calls with the Soft phone chip on, its query kept', async () => {
    mocks.at = '/agency/softphone?x=1';
    render(<App />);
    const text = (await screen.findByTestId('all-calls')).textContent ?? '';
    const [kind, url] = text.split(' ');
    expect(kind).toBe('account');
    const reached = new URL(url!, 'http://console.test');
    expect(reached.pathname).toBe('/agency/calls');
    expect(reached.searchParams.get('type')).toBe('soft_phone');
    expect(reached.searchParams.get('x')).toBe('1');
  });
});
