import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { AgencyCampaign, AgencyCarrier } from '../../types/agency-campaign';

/**
 * Campaign settings: the carrier account a campaign dials on (decisions B18–B22).
 * Shown only when there is a choice, sent only when it moves, the caller IDs filtered by
 * it, and a carrier refusal said in words.
 */

const CRED_A = '11111111-1111-4111-8111-111111111111';
const CRED_OLD = '99999999-9999-4999-8999-999999999999';
const CRED_VL = '44444444-4444-4444-8444-444444444444';

const mocks = vi.hoisted(() => ({
  transitionAgencyCampaign: vi.fn(),
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
      {
        // On the tenant's own VoiceLink account (added by hand, docs/carriers.md CR6).
        phone_number_id: 'pn-3',
        phone_number: '+912200000003',
        provider_name: 'voicelink',
        provider_display_name: 'VoiceLink',
        telephony_credential_id: CRED_VL,
        label: 'Own direct',
        is_default: false,
      },
    ],
    loading: false,
    error: null,
    reload: vi.fn(),
    defaultNumber: '+912200000001',
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
  // The campaign header above the form: its lifecycle controls and lineage strip.
  transitionAgencyCampaign: mocks.transitionAgencyCampaign,
  campaignLineage: async () => ({ root_campaign_id: 'camp-1', campaigns: [] }),
}));

import SettingsPage from '../../pages/agency/AgencyCampaignSettingsPage';
import { callerIdLocked, queryCallerIdBox, saveSettings } from '../helpers/settingsForm';

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
/** A caller ID's card, by its number (shown spaced on the card), or `null` when it is not offered. */
const numberBox = (e164: string) => queryCallerIdBox(e164);
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

describe('campaign settings — a stored caller ID no longer available', () => {
  beforeEach(() => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({
      telephony_provider: 'plivo', telephony_credential_id: CRED_A, caller_ids: ['+14155550102', '+14155550199'],
    }));
  });

  it('is shown as its own row, counted, and a save that does not touch the pool does not send it', async () => {
    renderPage();
    await waitFor(() => expect(numberBox('+14155550102')).not.toBeNull());
    const row = screen.getByTestId('caller-id-unavailable');
    expect(row.textContent).toMatch(/\+14155550199/);
    expect(row.textContent).toMatch(/No longer available/);
    // What is on screen is the pool: one ticked card, and one unavailable row. (The cards carry no
    // "2 selected." line; the list layout the page used to have did.)
    expect(numberBox('+14155550102')!.checked).toBe(true);
    expect(screen.getAllByTestId('caller-id-unavailable')).toHaveLength(1);

    fireEvent.change(screen.getByLabelText(/campaign name/i), { target: { value: 'Renamed' } });
    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody()).toMatchObject({ name: 'Renamed' });
    expect(sentBody()).not.toHaveProperty('caller_ids');
  });

  it('can be removed, and the save then sends the pool without it', async () => {
    renderPage();
    await waitFor(() => expect(numberBox('+14155550102')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Remove +14155550199' }));
    expect(screen.queryByTestId('caller-id-unavailable')).toBeNull();
    expect(numberBox('+14155550102')!.checked).toBe(true);
    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody().caller_ids).toEqual(['+14155550102']);
  });
});

describe('campaign settings — carrier', () => {
  it('is hidden with one carrier account, and an unchanged carrier is not re-sent', async () => {
    mocks.useAgencyCarriers.mockReturnValue({ carriers: [SERVICE], error: null });
    renderPage();
    await waitFor(() => expect(numberBox('+912200000001')).not.toBeNull());
    expect(carrierSelect()).toBeNull();

    saveSettings();
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
    expect(numberBox('+912200000001')).toBeNull();
    expect(numberBox('+14155550102')!.checked).toBe(true);
  });

  it('moves the campaign: clears the caller IDs not on the new account and sends carrier AND credential', async () => {
    renderPage();
    await waitFor(() => expect(numberBox('+912200000001')).not.toBeNull());
    fireEvent.change(carrierSelect()!, { target: { value: `plivo:${CRED_A}` } });

    expect(numberBox('+912200000001')).toBeNull();
    // The old pool is cleared, so a save now is refused before the API is called.
    saveSettings();
    await waitFor(() => expect(screen.getByText(/needs at least one caller id/i)).toBeTruthy());
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();

    fireEvent.click(numberBox('+14155550102')!);
    saveSettings();
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
    await waitFor(() => expect(numberBox('+14155550102')).not.toBeNull());
    fireEvent.change(carrierSelect()!, { target: { value: 'voicelink:' } });
    fireEvent.click(numberBox('+912200000001')!);
    saveSettings();
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
    expect(Array.from(select.options).map((o) => o.textContent)).toContain('Pravah (account no longer active)');
    expect(screen.getByTestId('carrier-unavailable').textContent).toMatch(/no longer active/);
    // Its numbers dropped out of the list with it: the caller-ID empty state names the
    // account as the cause, not a missing number assignment.
    expect(screen.getByText('This campaign’s Pravah carrier account is not active.')).toBeTruthy();
    expect(screen.queryByText(/are assigned to this account/)).toBeNull();

    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    // Naming the carrier would make the server re-check the account and refuse the save.
    expect(sentBody()).not.toHaveProperty('telephony_provider');
    expect(sentBody()).not.toHaveProperty('telephony_credential_id');
    // Nor the unchanged caller IDs: there is nothing to write.
    expect(sentBody()).not.toHaveProperty('caller_ids');
  });

  it('is not offered to a viewer who cannot edit, who is told the carrier instead; the numbers still follow it', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'viewer' });
    mocks.getAgencyCampaign.mockResolvedValue(campaign({
      telephony_provider: 'plivo', telephony_credential_id: CRED_A, caller_ids: ['+14155550102'],
    }));
    renderPage();
    await waitFor(() => expect(numberBox('+14155550102')).not.toBeNull());
    expect(carrierSelect()).toBeNull();
    expect(numberBox('+912200000001')).toBeNull();
    expect(callerIdLocked('+14155550102')).toBe(true);
    expect((screen.getByLabelText(/campaign name/i) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('campaign-carrier-readonly').textContent).toBe('Carrier: Pravah (Acme main)');
    expect(document.body.textContent).not.toMatch(/plivo|voicelink/i);
  });

  it('tells a viewer a service-carrier campaign’s carrier too, and says nothing with one carrier account', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'viewer' });
    const { unmount } = renderPage();
    await waitFor(() => expect(numberBox('+912200000001')).not.toBeNull());
    expect(screen.getByTestId('campaign-carrier-readonly').textContent).toBe('Carrier: Swar');
    unmount();

    mocks.useAgencyCarriers.mockReturnValue({ carriers: [SERVICE], error: null });
    renderPage();
    await waitFor(() => expect(numberBox('+912200000001')).not.toBeNull());
    expect(screen.queryByTestId('campaign-carrier-readonly')).toBeNull();
  });

  it('an editor gets the choice, not the read-only line', async () => {
    renderPage();
    await waitFor(() => expect(numberBox('+912200000001')).not.toBeNull());
    expect(carrierSelect()).not.toBeNull();
    expect(screen.queryByTestId('campaign-carrier-readonly')).toBeNull();
  });

  it.each([
    ['telephony_credential_not_active', 409, /carrier account is not active/],
    ['telephony_credential_not_found', 404, /carrier account no longer exists/],
  ])('says what to do when the save is refused with %s', async (code, status, copy) => {
    mocks.updateAgencyCampaign.mockRejectedValue(apiError(status, code));
    renderPage();
    await waitFor(() => expect(numberBox('+912200000001')).not.toBeNull());
    fireEvent.change(carrierSelect()!, { target: { value: `plivo:${CRED_A}` } });
    fireEvent.click(numberBox('+14155550102')!);
    saveSettings();
    expect(await screen.findByText(copy)).toBeTruthy();
    expect(screen.queryByText('server words')).toBeNull();
  });
});

describe('campaign settings — one carrier offered twice (docs/carriers.md CR9, CR10)', () => {
  const OWN_VL: AgencyCarrier = { telephony_provider: 'voicelink', telephony_credential_id: CRED_VL, label: 'Acme direct', status: 'active' };

  beforeEach(() => {
    mocks.useAgencyCarriers.mockReturnValue({ carriers: [SERVICE, OWN_A, OWN_VL], error: null });
  });

  it('names the service’s account and the tenant’s own on the same carrier apart, with no vendor name', async () => {
    renderPage();
    const select = (await screen.findByLabelText(/^Carrier/)) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['Swar', 'Pravah (Acme main)', 'Swar (Acme direct)']);
    expect(select.value).toBe('voicelink:');
    expect(document.body.textContent).not.toMatch(/plivo|voicelink/i);
    // The service's account offers only its own numbers: the tenant's pinned VoiceLink number is not one.
    expect(numberBox('+912200000001')).not.toBeNull();
    expect(numberBox('+912200000003')).toBeNull();
  });

  it('moves to the tenant’s own account on the same carrier: its numbers only, carrier AND credential sent', async () => {
    renderPage();
    await waitFor(() => expect(numberBox('+912200000001')).not.toBeNull());
    fireEvent.change(carrierSelect()!, { target: { value: `voicelink:${CRED_VL}` } });
    expect(numberBox('+912200000001')).toBeNull();
    expect(numberBox('+14155550102')).toBeNull();
    fireEvent.click(numberBox('+912200000003')!);
    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody()).toMatchObject({
      caller_ids: ['+912200000003'],
      telephony_provider: 'voicelink',
      telephony_credential_id: CRED_VL,
    });
  });

  it('puts a caller-ID refusal (details.caller_ids) on the numbers, not in a banner', async () => {
    const said = 'a campaign on the service’s own carrier account cannot use a number of an organisation’s own carrier account; not: +912200000003';
    mocks.updateAgencyCampaign.mockRejectedValue(Object.assign(new Error('Invalid carrier account'), {
      statusCode: 400, details: { error: 'Bad Request', message: 'Invalid carrier account', details: { caller_ids: said } },
    }));
    renderPage();
    await waitFor(() => expect(numberBox('+912200000001')).not.toBeNull());
    fireEvent.change(screen.getByLabelText(/campaign name/i), { target: { value: 'Renamed' } });
    saveSettings();
    expect(await screen.findByText(said)).toBeTruthy();
  });
});

describe('campaign settings — a save after a Refresh', () => {
  it('does not move the campaign back to the carrier someone else moved it off', async () => {
    renderPage();
    await screen.findByLabelText(/campaign name/i);
    expect(carrierSelect()?.value).toContain('voicelink');

    // Someone else moves it to the tenant's own account; this person presses Refresh.
    mocks.getAgencyCampaign.mockResolvedValueOnce(campaign({
      telephony_provider: 'plivo', telephony_credential_id: CRED_A, caller_ids: ['+14155550102'],
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(mocks.getAgencyCampaign).toHaveBeenCalledTimes(2));
    await act(async () => undefined);

    fireEvent.change(screen.getByDisplayValue('10:00'), { target: { value: '11:00' } });
    fireEvent.click(await screen.findByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(sentBody()).not.toHaveProperty('telephony_provider');
    expect(sentBody()).not.toHaveProperty('telephony_credential_id');
    expect(sentBody()).not.toHaveProperty('caller_ids');
  });
});
