import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/*
 * Decision B17. `/app` is this console's own platform zone (Team,
 * Notifications, Call summaries), so the agency shell's exits stay and say where
 * they go; no exit mentions a parent product. These cases pin the label and destination.
 */

const mocks = vi.hoisted(() => ({ useTenant: vi.fn() }));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../analytics/useProductSurface', () => ({ useProductSurface: vi.fn() }));
vi.mock('../../components/layout/AgencySidebar', () => ({ AgencySidebar: () => <nav data-testid="sidebar" /> }));
vi.mock('../../components/layout/TenantSwitcher', () => ({ TenantSwitcher: () => null }));
vi.mock('../../components/layout/AccountSwitcher', () => ({ AccountSwitcher: () => null }));

import { AgencyLayout } from '../../components/layout/AgencyLayout';
import { WorkspaceExit } from '../../components/agency/WorkspaceExit';
import { PARENT_BRAND } from '../helpers/parentBrand';

afterEach(() => cleanup());

describe('platform-zone exits (B17)', () => {
  it('AgencyLayout links "Team and settings" to /app, and names no other product', () => {
    mocks.useTenant.mockReturnValue({ accountId: 'account-1', accounts: [{ id: 'account-1' }] });

    render(
      <MemoryRouter initialEntries={['/agency/campaigns']}>
        <AgencyLayout />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Team and settings' });
    expect(link.getAttribute('href')).toBe('/app');
    expect(link.textContent).toBe('Team & settings');
    expect(screen.queryByText(PARENT_BRAND)).toBeNull();
  });

  it('WorkspaceExit defaults to "Go to settings" → /app', () => {
    render(
      <MemoryRouter>
        <WorkspaceExit />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: 'Go to settings' });
    expect(link.getAttribute('href')).toBe('/app');
  });
});
