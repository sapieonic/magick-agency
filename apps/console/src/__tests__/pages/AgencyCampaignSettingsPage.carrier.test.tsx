import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AgencyCampaign, AgencyCarrier } from '../../types/agency-campaign';

/**
 * Campaign settings: the carrier account a campaign dials on (decisions B18–B22).
 * Shown only when there is a choice, sent only when it moves, the caller IDs filtered by
 * it, and a carrier refusal said in words.
 */

const CRED_A = '11111111-1111-4111-8111-111111111111';
const CRED_OLD = '99999999-9999-4999-8999-999999999999';

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  useAgencyCarriers: vi.fn(),
  getAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
  showToast: vi.fn(),
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
vi.mock('../../hooks/useAgencyCarriers', () => ({ useAgencyCarriers: mocks.useAgencyCarriers }));
vi.mock('../../hooks/usePhoneNumbers', () => ({
  usePhoneNumbers: () => ({
    phoneNumbers: [
      {
        phone_number_id: 'pn-1',
        phone_number: '+912200000001',
        provider_name: 'voicelink',
        provider_display_name: 'VoiceLink',
        telephony_credential_id: null,
        label: null,
        is_default: true,
      },
      {
        phone_number_id: 'pn-2',
        phone_number: '+14155550102',
        provider_name: 'plivo',
        provider_display_name: 'Plivo',
        telephony_credential_id: CRED_A,
        label: 'Own 1',
        is_default: false,
      },
    ],
    loading: false,
    error: null,
    reload: vi.fn(),
    defaultNumber: '+912200000001',
  }),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
}));

import SettingsPage from '../../pages/agency/AgencyCampaignSettingsPage';

const SERVICE: AgencyCarrier = { telephony_provider: 'voicelink', telephony_credential_id: null, label: null, status: 'active' };
const OWN_A: AgencyCarrier = { telephony_provider: 'plivo', telephony_credential_id: CRED_A, label: 'Acme main', status: 'active' };

function campaign(over: Partial<AgencyCampaign> = {}): AgencyCampaign {
  return {
    id: 'camp-1',
    name: 'Collections — August',
    status: 'paused',
    calling_window_start: '10:00',
    calling_window_end: '18:00',
    calling_days: [1, 2, 3],
    default_timezone: 'Asia/Kolkata',
    wrapup_seconds: 45,
    wrapup_auto_return: false,
    caller_ids: ['+912200000001'],
    telephony_provider: 'voicelink',
    telephony_credential_id: null,
    disposition_catalog: [
      { code: 'voicemail', label: 'Voicemail' },
      { code: 'callback', label: 'Callback', requires_datetime: true },
      { code: 'do_not_call', label: 'Do not call', suppress: true },
    ],
    retry_policy: {},
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

const carrierSelect = () => screen.queryByLabelText(/^Carrier/) as HTMLSelectElement | null;
const numberBox = (phone: RegExp) => screen.queryByRole('checkbox', { name: phone }) as HTMLInputElement | null;
const saveButton = () => screen.getByRole('button', { name: /save settings/i });
const sentBody = () => mocks.updateAgencyCampaign.mock.calls[0]![1] as Record<string, unknown>;

/** Shaped like the `ApiError` the client throws. */
function apiError(statusCode: number, code: string) {
  return Object.assign(new Error('server words'), { statusCode, details: { error: 'Conflict', code, message: 'server words' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'tenant_owner' });
  mocks.useAgencyCarriers.mockReturnValue({ carriers: [SERVICE, OWN_A], error: null });
  mocks.getAgencyCampaign.mockResolvedValue(campaign());
  mocks.updateAgencyCampaign.mockImplementation(async (_id, body) => campaign(body));
});

describe('campaign settings — carrier', () => {
  it('is hidden with one carrier account, and an unchanged carrier is not re-sent', async () => {
    mocks.useAgencyCarriers.mockReturnValue({ carriers: [SERVICE], error: null });
    renderPage();
    await screen.findByRole('checkbox', { name: /\+912200000001/ });
    expect(carrierSelect()).toBeNull();

    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody()).not.toHaveProperty('telephony_provider');
    expect(sentBody()).not.toHaveProperty('telephony_credential_id');
  });

  it('is shown with more than one, on the campaign’s own carrier, named by alias and label', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({
      telephony_provider: 'plivo', telephony_credential_id: CRED_A, caller_ids: ['+14155550102'],
    }));
    renderPage();
    const select = (await screen.findByLabelText(/^Carrier/)) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Swar', 'Pravah (Acme main)']);
    expect(select.value).toBe(`plivo:${CRED_A}`);
    expect(document.body.textContent).not.toMatch(/plivo|voicelink/i);
    // Only that account's numbers, with the stored pool selected.
    expect(numberBox(/\+912200000001/)).toBeNull();
    expect(numberBox(/\+14155550102/)!.checked).toBe(true);
  });

  it('moves the campaign: clears the caller IDs not on the new account and sends carrier AND credential', async () => {
    renderPage();
    await screen.findByRole('checkbox', { name: /\+912200000001/ });
    fireEvent.change(carrierSelect()!, { target: { value: `plivo:${CRED_A}` } });

    expect(numberBox(/\+912200000001/)).toBeNull();
    // The old pool is cleared, so a save now is refused before the API is called.
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText(/needs at least one caller id/i)).toBeTruthy());
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();

    fireEvent.click(numberBox(/\+14155550102/)!);
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody()).toMatchObject({
      caller_ids: ['+14155550102'],
      telephony_provider: 'plivo',
      telephony_credential_id: CRED_A,
    });
  });

  it('moving back to the service’s account sends telephony_credential_id: null in the same save', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({
      telephony_provider: 'plivo', telephony_credential_id: CRED_A, caller_ids: ['+14155550102'],
    }));
    renderPage();
    await screen.findByRole('checkbox', { name: /\+14155550102/ });
    fireEvent.change(carrierSelect()!, { target: { value: 'voicelink:' } });
    fireEvent.click(numberBox(/\+912200000001/)!);
    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody()).toMatchObject({
      caller_ids: ['+912200000001'],
      telephony_provider: 'voicelink',
      telephony_credential_id: null,
    });
  });

  it('keeps a campaign on an account the list no longer offers, says so, and saves other edits without re-sending it', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({
      telephony_provider: 'plivo', telephony_credential_id: CRED_OLD, caller_ids: ['+14155550199'],
    }));
    renderPage();
    const select = (await screen.findByLabelText(/^Carrier/)) as HTMLSelectElement;
    expect(select.value).toBe(`plivo:${CRED_OLD}`);
    expect(Array.from(select.options).map((o) => o.textContent)).toContain('Pravah (your own account), not active');
    expect(screen.getByTestId('carrier-unavailable').textContent).toMatch(/no longer active/);

    fireEvent.click(saveButton());
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    // Naming the carrier would make the server re-check the account and refuse the save.
    expect(sentBody()).not.toHaveProperty('telephony_provider');
    expect(sentBody()).not.toHaveProperty('telephony_credential_id');
    expect(sentBody().caller_ids).toEqual(['+14155550199']);
  });

  it('is not offered to a viewer who cannot edit, whose numbers still follow the campaign’s carrier', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'viewer' });
    mocks.getAgencyCampaign.mockResolvedValue(campaign({
      telephony_provider: 'plivo', telephony_credential_id: CRED_A, caller_ids: ['+14155550102'],
    }));
    renderPage();
    await screen.findByRole('checkbox', { name: /\+14155550102/ });
    expect(carrierSelect()).toBeNull();
    expect(numberBox(/\+912200000001/)).toBeNull();
    expect(mocks.useAgencyCarriers).toHaveBeenCalledWith({ enabled: false });
  });

  it.each([
    ['telephony_credential_not_active', 409, /carrier account is not active/],
    ['telephony_credential_not_found', 404, /carrier account no longer exists/],
  ])('says what to do when the save is refused with %s', async (code, status, copy) => {
    mocks.updateAgencyCampaign.mockRejectedValue(apiError(status, code));
    renderPage();
    await screen.findByRole('checkbox', { name: /\+912200000001/ });
    fireEvent.change(carrierSelect()!, { target: { value: `plivo:${CRED_A}` } });
    fireEvent.click(numberBox(/\+14155550102/)!);
    fireEvent.click(saveButton());
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(screen.queryByText('server words')).toBeNull();
  });
});
