import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ApiError } from '../../api/client';
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * The campaign settings page's Assignment group and outcome overrides, at the
 * page level: what the operator can change on which status, and what each save
 * sends (all settings; all but the locked mode; nothing with the flag off).
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
  showToast: vi.fn(),
  flag: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => true, map: {}, loading: false, refresh: vi.fn() }),
}));
vi.mock('../../hooks/useCallAnalysisProfiles', () => ({
  useCallAnalysisProfiles: () => ({
    profiles: [], total: 0, defaultProfile: null, loading: false, error: null, reload: vi.fn(), remove: vi.fn(),
  }),
}));
vi.mock('../../hooks/usePhoneNumbers', () => ({
  usePhoneNumbers: () => ({
    phoneNumbers: [{
      phone_number_id: 'pn-1', phone_number: '+912200000001', provider_name: 'voicelink',
      provider_display_name: 'VoiceLink', label: null, is_default: true,
    }],
    loading: false, error: null, reload: vi.fn(), defaultNumber: '+912200000001',
  }),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
}));
vi.mock('../../hooks/useFeatureFlagEnabled', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useFeatureFlagEnabled')>()),
  useFeatureFlagEnabled: mocks.flag,
}));

import SettingsPage from '../../pages/agency/AgencyCampaignSettingsPage';

function campaign(over: Partial<AgencyCampaign> = {}): AgencyCampaign {
  return {
    id: 'camp-1',
    name: 'Collections',
    status: 'paused',
    calling_window_start: '10:00',
    calling_window_end: '18:00',
    calling_days: [1, 2, 3],
    default_timezone: 'Asia/Kolkata',
    wrapup_seconds: 45,
    caller_ids: ['+912200000001'],
    disposition_catalog: [
      { code: 'callback', label: 'Callback', requires_datetime: true },
      { code: 'do_not_call', label: 'Do not call', suppress: true },
    ],
    retry_policy: {},
    assignment_mode: 'pool',
    ...over,
  };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/agency/campaigns/camp-1/settings']}>
      <Routes>
        <Route path="/agency/campaigns/:id/settings" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flag.mockReturnValue(true);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'tenant_owner' });
  mocks.getAgencyCampaign.mockResolvedValue(campaign());
  mocks.updateAgencyCampaign.mockImplementation(async (_id, body) => campaign(body));
});

afterEach(() => cleanup());

function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
}

describe('the mode gate', () => {
  it('a paused campaign changes its mode, and the save sends every setting', async () => {
    renderPage();
    const mode = await screen.findByTestId('assignment-mode');
    expect((mode as HTMLFieldSetElement).disabled).toBe(false);
    fireEvent.click(within(mode).getByRole('radio', { name: /Own contacts only/ }));
    fireEvent.click(screen.getByTestId('allow-agent-retry'));
    fireEvent.change(screen.getByLabelText('Agent retry rounds per contact'), { target: { value: '3' } });
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1]).toMatchObject({
      assignment_mode: 'strict',
      allow_agent_retry: true,
      agent_retry_rounds: 3,
      on_unstaff: 'return_to_pool',
      callback_owner_grace_minutes: 30,
      callback_fallback: 'pool',
      agent_retry_cooldown_minutes: 30,
    });
  });

  it('a running campaign locks the mode with the reason, and its save leaves the mode out', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running', assignment_mode: 'preferred' }));
    renderPage();
    const mode = await screen.findByTestId('assignment-mode');
    expect((mode as HTMLFieldSetElement).disabled).toBe(true);
    expect(screen.getByTestId('assignment-mode-locked').textContent)
      .toBe('Pause the campaign to change how contacts are assigned.');
    expect((within(mode).getByRole('radio', { name: /Own contacts first/ }) as HTMLInputElement).checked).toBe(true);
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const body = mocks.updateAgencyCampaign.mock.calls[0]![1];
    expect(body).not.toHaveProperty('assignment_mode');
    expect(body.on_unstaff).toBe('return_to_pool');
  });

  it('says 409 mode_change_requires_pause on the field', async () => {
    mocks.updateAgencyCampaign.mockRejectedValueOnce(new ApiError(409, {
      error: 'Conflict', code: 'mode_change_requires_pause', message: 'Pause first.',
    }));
    renderPage();
    await screen.findByTestId('assignment-mode');
    save();
    expect(await screen.findByText('Pause the campaign before you change how contacts are assigned.')).toBeTruthy();
  });

  it('refuses an out-of-range value before saving', async () => {
    renderPage();
    await screen.findByTestId('assignment-mode');
    fireEvent.change(screen.getByLabelText('Minutes a due callback waits for its agent'), { target: { value: '20000' } });
    expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('outcome overrides', () => {
  it('offers "Allows override" on an outcome that keeps the contact, never on DNC, and saves it', async () => {
    renderPage();
    const group = await screen.findByTestId('override-group-0');
    expect(screen.queryByTestId('override-group-1')).toBeNull();
    expect(within(group).queryByText(/do not call/i)).toBeNull();
    fireEvent.click(within(group).getByLabelText('Extra attempts past the limit'));
    fireEvent.change(within(group).getByLabelText('Callback extra attempts'), { target: { value: '3' } });
    fireEvent.click(within(group).getByLabelText('May dial outside calling hours (needs a note)'));
    expect(screen.getByTestId('outcome-summary-0').textContent).toContain('The agent may then make 3 extra attempts');
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].disposition_catalog[0].override)
      .toEqual({ extra_attempts: 3, calling_hours: true });
  });
});

describe('with the flag off', () => {
  it('shows neither group and sends no assignment setting', async () => {
    mocks.flag.mockReturnValue(false);
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ assignment_mode: 'strict' }));
    renderPage();
    await screen.findByRole('button', { name: 'Save settings' });
    expect(screen.queryByTestId('assignment-mode')).toBeNull();
    expect(screen.queryByTestId('override-group-0')).toBeNull();
    save();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const body = mocks.updateAgencyCampaign.mock.calls[0]![1];
    expect(body).not.toHaveProperty('assignment_mode');
    expect(body).not.toHaveProperty('allow_agent_retry');
  });
});
