import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The console's release version sits at the foot of BOTH shells' sidebars, in every state:
 * the platform shell expanded and collapsed to its icon rail, and the agency shell. It is
 * the console's own version (`apps/console/package.json`, written by release-please and
 * injected as `__APP_VERSION__` by vite.config.ts), so the test reads that file rather
 * than repeating a number.
 */
const mocks = vi.hoisted(() => ({
  useGovernance: vi.fn(),
  useTenant: vi.fn(),
  useFeatureFlags: vi.fn(),
}));

vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: mocks.useGovernance }));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: mocks.useFeatureFlags }));
vi.mock('../../components/common/Logo', () => ({ Logo: () => <span data-testid="logo" /> }));
vi.mock('../../brand', () => ({ brand: { name: 'TestBrand' } }));

import { Sidebar } from '../../components/layout/Sidebar';
import { AgencySidebar } from '../../components/layout/AgencySidebar';

const { version } = JSON.parse(
  readFileSync(resolve(__dirname, '../../../package.json'), 'utf-8'),
) as { version: string };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function withContexts(role: string) {
  mocks.useTenant.mockReturnValue({ role });
  mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => true, flags: {}, status: 'ready' as const, reload: vi.fn() });
  mocks.useGovernance.mockReturnValue({ isEnabled: () => true, map: {}, loading: false, refresh: vi.fn() });
}

const shownVersion = () => screen.getByTestId('app-version').textContent;

describe('the version at the foot of the sidebars', () => {
  it("is the console's package.json version", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(__APP_VERSION__).toBe(version);
  });

  it('shows in the expanded platform sidebar', () => {
    withContexts('account_admin');
    render(<MemoryRouter><Sidebar /></MemoryRouter>);
    expect(shownVersion()).toBe(`v${version}`);
  });

  it('still shows when the platform sidebar is collapsed to its icon rail', () => {
    withContexts('account_admin');
    render(<MemoryRouter><Sidebar collapsed /></MemoryRouter>);
    expect(shownVersion()).toBe(`v${version}`);
    expect(screen.getByTestId('app-version').parentElement?.className).toMatch(/compact/);
  });

  it('shows in the agency sidebar, for any role, with no destinations at all', () => {
    withContexts('agent');
    render(<MemoryRouter><AgencySidebar /></MemoryRouter>);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(shownVersion()).toBe(`v${version}`);
  });
});
