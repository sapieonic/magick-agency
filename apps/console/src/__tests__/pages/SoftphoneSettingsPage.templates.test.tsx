import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Settings → Soft phone with campaign templates on (CT11): the outcome list follows the account's
 * default campaign template, named, while the soft phone lists none of its own ("Follow campaign
 * template (<name>)", saved as the empty list), or is the soft phone's own ("Set for the soft
 * phone"). Without the template field in the read, it follows the built-in outcomes; with the flag
 * off, the page is as it was.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  read: vi.fn(),
  putSoftphoneSettings: vi.fn(),
  showToast: vi.fn(),
  flags: { agency_campaign_templates_enabled: true } as Record<string, boolean>,
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({ useFeatureFlagEnabled: (flag: string) => mocks.flags[flag] === true }));
vi.mock('../../api/softphone', () => ({
  readSoftphoneSettings: mocks.read,
  putSoftphoneSettings: mocks.putSoftphoneSettings,
}));
vi.mock('../../hooks/useCallAnalysisProfiles', () => ({ useCallAnalysisProfiles: () => ({ profiles: [], loading: false }) }));
vi.mock('../../hooks/usePhoneNumbers', () => ({ usePhoneNumbers: () => ({ phoneNumbers: [] }) }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));

import SoftphoneSettingsPage from '../../pages/settings/SoftphoneSettingsPage';
import type { AgencySoftphoneSettings } from '../../types/softphone';

const SAVED: AgencySoftphoneSettings = {
  disposition_catalog: [],
  call_fields: [],
  analysis_profile_id: null,
  record_calls: false,
  default_caller_id: null,
  updated_at: '2026-10-30T09:00:00Z',
};

const FOLLOWS = {
  template: { id: 'tp-1', name: 'Collections', version: 3, scope: 'account' as const },
  disposition_catalog: [
    { code: 'will_pay', label: 'Will pay' },
    { code: 'call_later', label: 'Call later' },
  ],
};

async function renderPage(outcomesTemplate: unknown = FOLLOWS, settings: AgencySoftphoneSettings = SAVED) {
  mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role: 'account_admin' });
  mocks.read.mockResolvedValue({ settings, outcomesTemplate });
  render(
    <MemoryRouter>
      <SoftphoneSettingsPage />
    </MemoryRouter>,
  );
  await act(async () => {});
}

beforeEach(() => {
  mocks.flags = { agency_campaign_templates_enabled: true };
  mocks.putSoftphoneSettings.mockImplementation(async (body: Record<string, unknown>) => ({ ok: true, value: { ...SAVED, ...body } }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Settings → Soft phone, with campaign templates', () => {
  it('follows the account’s default template while the soft phone lists no outcomes', async () => {
    await renderPage();
    const outcomes = screen.getByTestId('softphone-settings-outcomes');
    const group = within(outcomes).getByRole('radiogroup', { name: 'Where the outcomes come from' });
    expect((within(group).getByRole('radio', { name: 'Follow campaign template (Collections)' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('softphone-outcomes-following').textContent).toContain('Untagged calls use the outcomes of Collections');
    expect(within(outcomes).getByRole('list').textContent).toBe('1Will pay2Call later');
  });

  it('sets the soft phone’s own list from the followed one, and saves the empty list to follow again', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('radio', { name: 'Set for the soft phone' }));
    expect((screen.getByLabelText('Outcome 1 label') as HTMLInputElement).value).toBe('Will pay');
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-settings-save'));
    });
    expect(mocks.putSoftphoneSettings.mock.calls[0]![0].disposition_catalog.map((d: { code: string }) => d.code)).toEqual(['will_pay', 'call_later']);

    fireEvent.click(screen.getByRole('radio', { name: 'Follow campaign template (Collections)' }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-settings-save'));
    });
    expect(mocks.putSoftphoneSettings.mock.calls[1]![0].disposition_catalog).toEqual([]);
  });

  it('opens on “Set for the soft phone” when it has its own list', async () => {
    await renderPage(FOLLOWS, { ...SAVED, disposition_catalog: [{ code: 'sold', label: 'Sold' }] });
    expect((screen.getByRole('radio', { name: 'Set for the soft phone' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Outcome 1 label') as HTMLInputElement).value).toBe('Sold');
  });

  it('follows the built-in outcomes when the read names no template', async () => {
    await renderPage(null);
    expect(screen.getByRole('radio', { name: 'Follow the built-in outcomes' })).toBeTruthy();
    expect(screen.getByTestId('softphone-outcomes-following').textContent).toContain('Untagged calls use the built-in outcomes.');
  });

  it('is as it was with the flag off', async () => {
    mocks.flags = {};
    await renderPage();
    expect(screen.queryByRole('radiogroup', { name: 'Where the outcomes come from' })).toBeNull();
    expect(screen.getByTestId('softphone-settings-outcomes').textContent).toMatch(/The built-in outcomes are in use/);
  });
});
