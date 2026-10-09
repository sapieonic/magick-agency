import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * NEW (magick-agency): the Sidebar's active state after cusui's `/app/calls`
 * special cases were deleted (PORTING §9.2, `Sidebar.tsx`). The `end` list
 * (`/app`, `/app/calls`, `/app/calls/softphone`) and the `/app/calls` override
 * never matched a console nav item, so every item now takes React Router's own
 * `isActive`: exactly the item on the current path is highlighted, and a nested
 * path keeps its parent highlighted (no item is `end`).
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

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderAt(path: string) {
  mocks.useTenant.mockReturnValue({ role: 'account_admin' });
  mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => true, flags: {}, status: 'ready' as const, reload: vi.fn() });
  mocks.useGovernance.mockReturnValue({ isEnabled: () => true, map: {}, loading: false, refresh: vi.fn() });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar />
    </MemoryRouter>,
  );
}

const isActive = (name: RegExp) =>
  /navItemActive/.test(screen.getByRole('link', { name }).getAttribute('class') ?? '');

describe('Sidebar active state', () => {
  it('highlights only the item on the current path', () => {
    renderAt('/app/notifications');
    expect(isActive(/Notifications/i)).toBe(true);
    expect(isActive(/^Team$/i)).toBe(false);
    expect(isActive(/Call Summaries/i)).toBe(false);
  });

  it('keeps an item highlighted on a nested path (no item is `end`)', () => {
    renderAt('/app/call-summaries/some-profile');
    expect(isActive(/Call Summaries/i)).toBe(true);
    expect(isActive(/Notifications/i)).toBe(false);
  });
});
