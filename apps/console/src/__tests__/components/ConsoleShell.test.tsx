import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * `ConsoleShell` (decision B28): the console layout behind `AgentLanding`, which keeps a
 * DEDICATED agent out of the shell on Settings and `/app` (as the old `/app` shell did) and is
 * switched off on `/agency`, whose pages send an agent to their own `/dialer/*` twin.
 */

const mocks = vi.hoisted(() => ({ role: 'agent' as string }));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: () => ({ role: mocks.role }) }));
vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: () => ({ isEnabled: () => true, loading: false }) }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => true, status: 'ready' }),
}));

vi.mock('../../components/layout/ConsoleLayout', async () => {
  const { Outlet } = await import('react-router-dom');
  return { ConsoleLayout: () => <div data-testid="shell"><Outlet /></div> };
});

import { ConsoleShell } from '../../components/layout/ConsoleShell';

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ConsoleShell />}>
          <Route path="/settings/*" element={<div data-testid="page" />} />
          <Route path="/agency/*" element={<div data-testid="page" />} />
          <Route path="/app/*" element={<div data-testid="page" />} />
        </Route>
        <Route path="/dialer" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.role = 'agent';
});
afterEach(() => cleanup());

describe('ConsoleShell — a dedicated agent', () => {
  it.each(['/settings/notifications', '/app', '/app/team'])('is sent from %s to /dialer', (path) => {
    renderAt(path);
    expect(screen.getByTestId('where').textContent).toBe('/dialer');
  });

  it('is left on an /agency page, which knows its /dialer twin', () => {
    renderAt('/agency/reports/run-1');
    expect(screen.queryByTestId('where')).toBeNull();
    expect(screen.getByTestId('shell')).toBeTruthy();
    expect(screen.getByTestId('page')).toBeTruthy();
  });
});

describe('ConsoleShell — everyone else', () => {
  it.each(['/settings/team', '/app', '/agency/campaigns'])('gets the shell on %s', (path) => {
    mocks.role = 'viewer';
    renderAt(path);
    expect(screen.getByTestId('shell')).toBeTruthy();
    expect(screen.queryByTestId('where')).toBeNull();
  });
});
