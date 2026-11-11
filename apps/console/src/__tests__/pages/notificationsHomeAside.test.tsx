import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Email notifications points at Home (B28): what needs a supervisor now is Home's "Needs your
 * attention" list, not an email to switch on. Only for a reader Home is offered to (`HOME_GATE`),
 * so the link never lands on a page that sends them away.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string,
  flagsOn: true,
  capsOn: true,
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: () => ({ tenantId: 't-1', role: mocks.role }) }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: () => mocks.flagsOn, status: 'ready' }),
}));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => mocks.capsOn, loading: false }),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }),
}));
vi.mock('../../api/notifications', () => ({
  getNotificationPreferences: vi.fn().mockResolvedValue({ events: [] }),
  updateNotificationPreferences: vi.fn(),
  previewDigest: vi.fn(),
}));

import NotificationSettingsPage from '../../pages/settings/NotificationSettingsPage';

async function renderPage() {
  render(
    <MemoryRouter>
      <NotificationSettingsPage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('Email notifications')).toBeTruthy());
}

beforeEach(() => {
  mocks.role = 'account_admin';
  mocks.flagsOn = true;
  mocks.capsOn = true;
});
afterEach(() => cleanup());

describe('the pointer to Home', () => {
  it('tells a supervisor where what needs them is listed, with a link to Home', async () => {
    await renderPage();
    const aside = screen.getByTestId('notifications-home-aside');
    expect(aside.textContent).toContain(
      'Looking for what needs you right now? Paused campaigns, overdue callbacks and missed calls are listed on Home, under Needs your attention.',
    );
    expect(within(aside).getByRole('link', { name: 'Go to Home' }).getAttribute('href')).toBe('/agency/home');
  });

  it.each(['viewer', 'operator', 'agent'])('is not shown to a %s, who has no Home', async (role) => {
    mocks.role = role;
    await renderPage();
    expect(screen.queryByTestId('notifications-home-aside')).toBeNull();
  });

  it('is not shown without the dialer', async () => {
    mocks.flagsOn = false;
    await renderPage();
    expect(screen.queryByTestId('notifications-home-aside')).toBeNull();
    cleanup();
    mocks.flagsOn = true;
    mocks.capsOn = false;
    await renderPage();
    expect(screen.queryByTestId('notifications-home-aside')).toBeNull();
  });
});
