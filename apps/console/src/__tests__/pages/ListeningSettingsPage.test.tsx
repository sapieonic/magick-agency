import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Settings → Live call listening (`docs/listening.md` §12, LS20 c): a read-only line from the two
 * client-exposed flags, whether listening is on and, when it is, whether calls that are not
 * recorded are included, and who changes it. No control: the platform's administrators set it.
 */

const mocks = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  status: 'ready' as 'ready' | 'loading' | 'error',
  reload: vi.fn(),
  role: 'account_admin' as string,
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 't-1', accountId: 'a-1', role: mocks.role }),
}));

vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({
    isEnabled: (f: string) => mocks.status === 'ready' && mocks.flags[f] === true,
    status: mocks.status,
    flags: mocks.flags,
    reload: mocks.reload,
  }),
}));

import ListeningSettingsPage from '../../pages/settings/ListeningSettingsPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <ListeningSettingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.flags = { agency_live_listen_enabled: true, agency_live_listen_unrecorded: true };
  mocks.status = 'ready';
  mocks.reload.mockReset();
  mocks.role = 'account_admin';
});

afterEach(cleanup);

describe('Settings → Live call listening', () => {
  it('On, with calls that are not recorded included, and who changes it', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Live call listening' })).toBeTruthy();
    expect(screen.getByTestId('listening-setting-state').textContent).toBe('Live call listening: On');
    expect(screen.getByTestId('listening-setting-unrecorded').textContent).toBe('Calls that are not recorded can be listened to as well.');
    expect(screen.getByTestId('listening-setting-change').textContent).toBe('Ask your account manager to change this.');
    // Read-only: nothing to press.
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('On, recorded calls only', () => {
    mocks.flags = { agency_live_listen_enabled: true, agency_live_listen_unrecorded: false };
    renderPage();
    expect(screen.getByTestId('listening-setting-unrecorded').textContent).toBe('Only calls that are recorded can be listened to.');
  });

  it('Off says only that, and who changes it', () => {
    mocks.flags = { agency_live_listen_enabled: false, agency_live_listen_unrecorded: true };
    renderPage();
    expect(screen.getByTestId('listening-setting-state').textContent).toBe('Live call listening: Off');
    expect(screen.queryByTestId('listening-setting-unrecorded')).toBeNull();
    expect(screen.getByTestId('listening-setting-change').textContent).toBe('Ask your account manager to change this.');
  });

  it('never says Off before the flags have been read, and offers Retry when they could not be', () => {
    mocks.status = 'loading';
    const view = renderPage();
    expect(screen.queryByText('Live call listening: Off')).toBeNull();
    expect(screen.getByTestId('listening-setting-state').textContent).toBe('Checking…');
    mocks.status = 'error';
    view.rerender(
      <MemoryRouter>
        <ListeningSettingsPage />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Live call listening: Off')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Could not check whether live call listening is on.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    expect(mocks.reload).toHaveBeenCalled();
  });

  it('is for supervisors', () => {
    mocks.role = 'operator';
    renderPage();
    expect(screen.queryByTestId('listening-setting-state')).toBeNull();
    expect(screen.getByText('Live call listening is for supervisors.')).toBeTruthy();
  });
});
