import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ApiError } from '../../api/client';
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * Break limits in campaign Settings › Agents (LF6, LF20, LF27), at the page: the built-ins for a
 * campaign with no list of its own, a limit typed and checked by the server's rule, what a save
 * sends (every other field of each reason kept, a cleared limit's key left out, nothing at all
 * when no limit changed), and the server's `break_reasons` refusal shown on the row it names.
 */

const mocks = vi.hoisted(() => ({
  transitionAgencyCampaign: vi.fn(),
  useTenant: vi.fn(),
  getAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
  showToast: vi.fn(),
  flag: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/agencyInsights', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/agencyInsights')>()),
  getInsightsAllocation: () => new Promise(() => {}),
}));
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
// Who calls (CS10): nobody on the campaign, nobody in the team; this file is not about staffing.
vi.mock('../../api/agency', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/agency')>()),
  listCampaignAgents: async () => ({ agents: [] }),
}));
vi.mock('../../api/tenants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/tenants')>()),
  listTenantMembers: async () => [],
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
  transitionAgencyCampaign: mocks.transitionAgencyCampaign,
  campaignLineage: async () => ({ root_campaign_id: 'camp-1', campaigns: [] }),
}));
vi.mock('../../hooks/useFeatureFlagEnabled', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useFeatureFlagEnabled')>()),
  useFeatureFlagEnabled: mocks.flag,
}));

import SettingsPage from '../../pages/agency/AgencyCampaignSettingsPage';
import { saveSettings } from '../helpers/settingsForm';

function campaign(over: Partial<AgencyCampaign> = {}): AgencyCampaign {
  return {
    id: 'camp-1',
    name: 'Collections',
    status: 'running',
    calling_window_start: '10:00',
    calling_window_end: '18:00',
    calling_days: [1, 2, 3],
    default_timezone: 'Asia/Kolkata',
    wrapup_seconds: 45,
    caller_ids: ['+912200000001'],
    disposition_catalog: [{ code: 'sale', label: 'Sale' }],
    retry_policy: {},
    break_reasons: [],
    ...over,
  };
}

const OWN = [
  { code: 'tea', label: 'Chai', is_paid: true, limit_minutes: 10 },
  { code: 'lunch', label: 'Lunch', is_paid: false, limit_minutes: 30 },
  { code: 'meeting', label: 'Team meeting' },
];

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
  // Contact assignment and inbound calls off: Agents is there for its break limits alone.
  mocks.flag.mockReturnValue(false);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'tenant_owner' });
  mocks.getAgencyCampaign.mockResolvedValue(campaign());
  mocks.updateAgencyCampaign.mockImplementation(async (_id, body) => campaign(body));
});

afterEach(() => cleanup());

const limit = (code: string) => screen.getByTestId(`break-limit-${code}`) as HTMLInputElement;
const type = (code: string, value: string) => fireEvent.change(limit(code), { target: { value } });
const sentBody = () => mocks.updateAgencyCampaign.mock.calls[0]![1] as Record<string, unknown>;

describe('Settings › Agents: break limits', () => {
  it('is on every campaign’s page, flags off included', async () => {
    renderPage();
    const section = (await screen.findByTestId('break-limits')).closest('section, [id="agents"]');
    expect(section).not.toBeNull();
    expect(document.getElementById('agents')).not.toBeNull();
  });

  it('shows the built-ins, Tea 15 and Lunch 30, for a campaign with no list of its own', async () => {
    renderPage();
    await screen.findByTestId('break-limits');
    expect(limit('tea').value).toBe('15');
    expect(limit('lunch').value).toBe('30');
    expect(limit('break').value).toBe('');
    expect(limit('training').value).toBe('');
    expect(screen.getByTestId('break-limits').textContent).toMatch(/standard reasons/);
  });

  it('sends nothing about breaks when no limit changed, so the built-ins stay unwritten', async () => {
    renderPage();
    await screen.findByTestId('break-limits');
    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody()).not.toHaveProperty('break_reasons');
  });

  it('saves the built-ins whole once a limit is changed', async () => {
    renderPage();
    await screen.findByTestId('break-limits');
    type('tea', '20');
    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody()['break_reasons']).toEqual([
      { code: 'break', label: 'Break' },
      { code: 'tea', label: 'Tea', limit_minutes: 20 },
      { code: 'lunch', label: 'Lunch', limit_minutes: 30 },
      { code: 'meeting', label: 'Meeting' },
      { code: 'training', label: 'Training' },
      { code: 'technical_issue', label: 'Technical issue' },
      { code: 'admin', label: 'Admin time' },
    ]);
  });

  it('keeps every other field of each reason, and clears a limit by leaving its key out', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ break_reasons: OWN }));
    renderPage();
    await screen.findByTestId('break-limits');
    expect(limit('tea').value).toBe('10');
    type('tea', '12');
    type('lunch', '');
    type('meeting', '45');
    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const sent = sentBody()['break_reasons'] as Record<string, unknown>[];
    expect(sent).toEqual([
      { code: 'tea', label: 'Chai', is_paid: true, limit_minutes: 12 },
      { code: 'lunch', label: 'Lunch', is_paid: false },
      { code: 'meeting', label: 'Team meeting', limit_minutes: 45 },
    ]);
    expect('limit_minutes' in sent[1]!).toBe(false);
  });

  it('counts the limits as one unsaved change however many changed', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ break_reasons: OWN }));
    renderPage();
    await screen.findByTestId('break-limits');
    type('tea', '12');
    type('lunch', '25');
    expect((await screen.findAllByText(/^1 unsaved change$/)).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/2 unsaved changes/)).toHaveLength(0);
  });

  it.each(['0', '241', '7.5', 'ten'])('refuses %s as it is typed, on its row, and holds Save', async (bad) => {
    renderPage();
    await screen.findByTestId('break-limits');
    type('tea', bad);
    const row = screen.getByTestId('break-limit-row-tea');
    expect(within(row).getByText('Enter whole minutes from 1 to 240, or leave it empty for no limit.')).toBeTruthy();
    expect(limit('tea').getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
    // The other rows say nothing.
    expect(within(screen.getByTestId('break-limit-row-lunch')).queryByText(/whole minutes/)).toBeNull();
  });

  it('shows the server’s break_reasons refusal on the row it names', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ break_reasons: OWN }));
    const message = 'The limit for "lunch" must be a whole number of minutes from 1 to 240. Leave it out for no limit.';
    mocks.updateAgencyCampaign.mockRejectedValueOnce(new ApiError(400, { error: 'Validation Error', details: { break_reasons: message } }));
    renderPage();
    await screen.findByTestId('break-limits');
    type('tea', '12');
    saveSettings();
    const row = screen.getByTestId('break-limit-row-lunch');
    expect(await within(row).findByText(message)).toBeTruthy();
    expect(limit('lunch').getAttribute('aria-invalid')).toBe('true');
    expect(within(screen.getByTestId('break-limit-row-tea')).queryByText(message)).toBeNull();
  });

  it('shows a refusal that names no row under the list', async () => {
    const message = 'break_reasons may not list "soft_phone": it is reserved for the soft phone.';
    mocks.updateAgencyCampaign.mockRejectedValueOnce(new ApiError(400, { error: 'Validation Error', details: { break_reasons: message } }));
    renderPage();
    await screen.findByTestId('break-limits');
    type('tea', '12');
    saveSettings();
    expect(await within(screen.getByTestId('break-limits')).findByText(message)).toBeTruthy();
  });

  it('offers no limit on a reserved reason listed by hand, and leaves it out of a save', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ break_reasons: [...OWN, { code: 'soft_phone', label: 'Soft phone' }] }));
    renderPage();
    await screen.findByTestId('break-limits');
    const reserved = screen.getByTestId('break-limit-row-soft_phone');
    expect(within(reserved).queryByRole('textbox')).toBeNull();
    expect(reserved.textContent).toMatch(/Reserved/);
    type('tea', '12');
    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect((sentBody()['break_reasons'] as { code: string }[]).map((r) => r.code)).toEqual(['tea', 'lunch', 'meeting']);
  });

  it('is read-only for a viewer who cannot edit the campaign', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'supervisor' });
    renderPage();
    await screen.findByTestId('break-limits');
    expect(limit('tea').disabled).toBe(true);
  });
});
