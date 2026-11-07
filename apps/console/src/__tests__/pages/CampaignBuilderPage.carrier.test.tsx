import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgencyCarrier } from '../../types/agency-campaign';

/**
 * The builder's carrier choice (decisions B18–B22), at the page level: shown only when
 * the tenant has more than one carrier account, sent in full (carrier AND credential),
 * the caller IDs filtered by it, and a carrier refusal said in words.
 */

const CRED_A = '11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  useAgencyCarriers: vi.fn(),
  getIngestLimits: vi.fn(),
  createAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
  // The account's numbers; a test may drop the service's own to see the default move.
  phoneNumbers: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({ isEnabled: () => true, map: {}, loading: false, refresh: vi.fn() }),
}));
vi.mock('../../hooks/useAgencyCarriers', () => ({ useAgencyCarriers: mocks.useAgencyCarriers }));
const ALL_NUMBERS = [
  {
    phone_number_id: 'pn-1',
    phone_number: '+912200000001',
    provider_name: 'voicelink',
    provider_display_name: 'VoiceLink',
    telephony_credential_id: null,
    label: 'Outbound 1',
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
];
vi.mock('../../hooks/usePhoneNumbers', () => ({
  usePhoneNumbers: () => ({
    phoneNumbers: mocks.phoneNumbers,
    loading: false,
    error: null,
    reload: vi.fn(),
    defaultNumber: '+912200000001',
  }),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getIngestLimits: mocks.getIngestLimits,
  uploadRosterCsv: vi.fn(),
  analyzeRosterColumns: vi.fn(),
  startRosterIngest: vi.fn(),
  getIngestJob: vi.fn(),
  cancelIngestJob: vi.fn(),
  downloadRejectedRows: vi.fn(),
  createAgencyCampaign: mocks.createAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
}));

const SERVICE: AgencyCarrier = { telephony_provider: 'voicelink', telephony_credential_id: null, label: null, status: 'active' };
const OWN_A: AgencyCarrier = { telephony_provider: 'plivo', telephony_credential_id: CRED_A, label: 'Acme main', status: 'active' };

async function renderPage() {
  const { default: CampaignBuilderPage } = await import('../../pages/campaigns/agency/CampaignBuilderPage');
  return render(
    <MemoryRouter>
      <CampaignBuilderPage />
    </MemoryRouter>,
  );
}

const carrierSelect = () => screen.queryByLabelText(/^Carrier/) as HTMLSelectElement | null;
const numberBox = (phone: RegExp) => screen.queryByRole('checkbox', { name: phone }) as HTMLInputElement | null;

function save() {
  fireEvent.change(screen.getByLabelText(/Campaign name/), { target: { value: 'Collections' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save campaign' }));
}

/** Shaped like the `ApiError` the client throws. */
function apiError(statusCode: number, code: string) {
  return Object.assign(new Error('server words'), { statusCode, details: { error: 'Conflict', code, message: 'server words' } });
}

beforeEach(() => {
  mocks.phoneNumbers = ALL_NUMBERS;
  mocks.useTenant.mockReturnValue({ tenantId: 't1', accountId: 'a1' });
  mocks.useAgencyCarriers.mockReturnValue({ carriers: [SERVICE, OWN_A], error: null });
  mocks.getIngestLimits.mockRejectedValue(new Error('not needed here'));
  mocks.createAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
  mocks.updateAgencyCampaign.mockResolvedValue({ id: 'camp-1', name: 'Collections', status: 'draft' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the builder’s default carrier', () => {
  it('is the first carrier account with a number available to this account, not the service’s with none', async () => {
    mocks.phoneNumbers = ALL_NUMBERS.filter((n) => n.provider_name !== 'voicelink');
    await renderPage();
    expect(carrierSelect()!.value).toBe(`plivo:${CRED_A}`);
    fireEvent.click(numberBox(/\+14155550102/)!);
    save();
    await waitFor(() => expect(mocks.createAgencyCampaign).toHaveBeenCalled());
    expect(mocks.createAgencyCampaign.mock.calls[0]![0]).toMatchObject({
      caller_ids: ['+14155550102'], telephony_provider: 'plivo', telephony_credential_id: CRED_A,
    });
  });

  it('stays the first listed when it has numbers', async () => {
    await renderPage();
    expect(carrierSelect()!.value).toBe('voicelink:');
  });
});

describe('the builder’s carrier choice', () => {
  it('is not shown with one carrier account, and the campaign takes that one', async () => {
    mocks.useAgencyCarriers.mockReturnValue({ carriers: [SERVICE], error: null });
    await renderPage();
    expect(carrierSelect()).toBeNull();

    fireEvent.click(numberBox(/\+912200000001/)!);
    save();
    await waitFor(() => expect(mocks.createAgencyCampaign).toHaveBeenCalled());
    expect(mocks.createAgencyCampaign.mock.calls[0]![0]).toMatchObject({
      telephony_provider: 'voicelink',
      telephony_credential_id: null,
    });
  });

  it('sends the single carrier account it has, credential included, when that is a tenant’s own', async () => {
    mocks.useAgencyCarriers.mockReturnValue({ carriers: [OWN_A], error: null });
    await renderPage();
    expect(carrierSelect()).toBeNull();
    // Only that account's numbers are offered.
    expect(numberBox(/\+912200000001/)).toBeNull();

    fireEvent.click(numberBox(/\+14155550102/)!);
    save();
    await waitFor(() => expect(mocks.createAgencyCampaign).toHaveBeenCalled());
    expect(mocks.createAgencyCampaign.mock.calls[0]![0]).toMatchObject({
      caller_ids: ['+14155550102'],
      telephony_provider: 'plivo',
      telephony_credential_id: CRED_A,
    });
  });

  it('falls back to the service’s own account when the list cannot be read', async () => {
    mocks.useAgencyCarriers.mockReturnValue({ carriers: null, error: 'Could not load the carriers' });
    await renderPage();
    expect(carrierSelect()).toBeNull();
    fireEvent.click(numberBox(/\+912200000001/)!);
    save();
    await waitFor(() => expect(mocks.createAgencyCampaign).toHaveBeenCalled());
    expect(mocks.createAgencyCampaign.mock.calls[0]![0]).toMatchObject({
      telephony_provider: 'voicelink',
      telephony_credential_id: null,
    });
  });

  it('is shown with more than one, named by alias and label, never a vendor name', async () => {
    await renderPage();
    const select = carrierSelect()!;
    expect(select).toBeTruthy();
    const names = Array.from(select.options).map((o) => o.textContent);
    expect(names).toEqual(['Swar', 'Pravah (Acme main)']);
    expect(document.body.textContent).not.toMatch(/plivo|voicelink/i);
    // The service's own account is the default, and only its numbers are offered.
    expect(numberBox(/\+912200000001/)).toBeTruthy();
    expect(numberBox(/\+14155550102/)).toBeNull();
  });

  it('filters the caller IDs by the chosen account, clears the ones that no longer fit, and sends the choice', async () => {
    await renderPage();
    fireEvent.click(numberBox(/\+912200000001/)!);
    expect(screen.getByText(/1 selected/)).toBeTruthy();

    fireEvent.change(carrierSelect()!, { target: { value: `plivo:${CRED_A}` } });

    // The service number is gone from the list AND from the selection.
    expect(numberBox(/\+912200000001/)).toBeNull();
    const own = numberBox(/\+14155550102/)!;
    expect(own.checked).toBe(false);
    await waitFor(() => expect(screen.getByText(/Pick at least one number/)).toBeTruthy());

    fireEvent.click(own);
    save();
    await waitFor(() => expect(mocks.createAgencyCampaign).toHaveBeenCalled());
    expect(mocks.createAgencyCampaign.mock.calls[0]![0]).toMatchObject({
      caller_ids: ['+14155550102'],
      telephony_provider: 'plivo',
      telephony_credential_id: CRED_A,
    });
  });

  it('says why a create was refused for its carrier account, on the step that has the choice', async () => {
    mocks.createAgencyCampaign.mockRejectedValue(apiError(409, 'telephony_credential_not_active'));
    await renderPage();
    fireEvent.change(carrierSelect()!, { target: { value: `plivo:${CRED_A}` } });
    fireEvent.click(numberBox(/\+14155550102/)!);
    save();
    const alert = await screen.findByTestId('builder-error');
    expect(alert.textContent).toMatch(/carrier account is not active/);
    expect(alert.textContent).toMatch(/Ask your administrator to re-enable it/);
    expect(screen.getByTestId('builder-step').getAttribute('data-step')).toBe('basics');
  });
});
