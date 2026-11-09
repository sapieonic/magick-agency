import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AGENCY_INBOUND_ROUTE_DEFAULTS, type AgencyInboundRoute } from '@magick-agency/contracts/api/agency/inbound';

/**
 * The route editor in the build that records voicemail (P2): what happens to a call nobody
 * answers is offered from `AGENCY_INBOUND_AVAILABLE_ACTIONS` (callback and voicemail), and the
 * route is checked as it is edited (`inboundRouteWarnings`): no opening hours, a call recorded
 * unannounced, a deployment that cannot put callers through. Each is said beside its field and
 * never blocks the save. A missing recording is no warning: our standard recording plays.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getInboundRoute: vi.fn(),
  updateInboundRoute: vi.fn(),
  listInboundNumbers: vi.fn(),
  listInboundClips: vi.fn(),
  listAgencyCampaigns: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({ useFeatureFlagEnabled: () => true }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }) }));
vi.mock('../../components/common/PageDescription', () => ({ PageDescription: () => null }));
vi.mock('../../hooks/useCallAnalysisProfiles', () => ({ useCallAnalysisProfiles: () => ({ profiles: [], loading: false }) }));
vi.mock('../../api/agencyCampaigns', () => ({ listAgencyCampaigns: mocks.listAgencyCampaigns }));
vi.mock('../../api/inbound', async () => {
  const actual = await vi.importActual<typeof import('../../api/inbound')>('../../api/inbound');
  return {
    ...actual,
    getInboundRoute: mocks.getInboundRoute,
    updateInboundRoute: mocks.updateInboundRoute,
    listInboundNumbers: mocks.listInboundNumbers,
    listInboundClips: mocks.listInboundClips,
  };
});

import InboundRouteEditorPage from '../../pages/settings/InboundRouteEditorPage';

const ROUTE: AgencyInboundRoute = {
  ...AGENCY_INBOUND_ROUTE_DEFAULTS,
  clips: { ...AGENCY_INBOUND_ROUTE_DEFAULTS.clips },
  weekly_hours: [{ day: 1, start: '09:00', end: '17:00' }],
  holidays: [],
  pool_campaign_ids: [],
  disposition_catalog: [],
  id: 'r-1', account_id: 'account-1', name: 'Main line', timezone: 'Europe/London',
  numbers: [{ phone_number_id: 'n-1', phone_number: '+441632960001', attached_at: '2026-11-01T00:00:00Z' }],
  created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({ role: 'account_admin', tenantId: 'tenant-1', accountId: 'account-1' });
  mocks.getInboundRoute.mockResolvedValue(ROUTE);
  mocks.listInboundNumbers.mockResolvedValue({
    numbers: [{ phone_number_id: 'n-1', phone_number: '+441632960001', linked: true, route_id: 'r-1', route_name: 'Main line', held_elsewhere: false }],
  });
  mocks.listInboundClips.mockResolvedValue({ clips: [], upload_available: true, connects_agents: true });
  mocks.listAgencyCampaigns.mockResolvedValue([]);
  mocks.updateInboundRoute.mockImplementation(async (_id: string, patch: object) => ({ ok: true, value: { ...ROUTE, ...patch } }));
});

describe('voicemail, once the server offers it', () => {
  it('offers both actions out of hours and when nobody can answer, and saves only the one changed', async () => {
    render(
      <MemoryRouter initialEntries={['/app/inbound/r-1']}>
        <Routes>
          <Route path="/app/inbound/:routeId" element={<InboundRouteEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {});

    expect(screen.queryByTestId('inbound-voicemail-note')).toBeNull();
    const afterHours = within(screen.getByTestId('inbound-after-hours-action'));
    const overflow = within(screen.getByTestId('inbound-overflow-action'));
    expect(screen.getByRole('group', { name: 'Out of hours' })).toBe(screen.getByTestId('inbound-after-hours-action'));
    expect(screen.getByRole('group', { name: 'When nobody can answer' })).toBe(screen.getByTestId('inbound-overflow-action'));
    expect((afterHours.getByRole('radio', { name: /call them back/i }) as HTMLInputElement).checked).toBe(true);
    expect(afterHours.getByRole('radio', { name: /take a voicemail/i })).toBeTruthy();

    fireEvent.click(overflow.getByRole('radio', { name: /take a voicemail/i }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('inbound-route-save'));
    });
    expect(mocks.updateInboundRoute).toHaveBeenCalledWith('r-1', { overflow_action: 'voicemail' }, 'tenant-1', 'account-1');
  });
});

describe('the route’s warnings, beside the field they are about', () => {
  const renderEditor = async () => {
    render(
      <MemoryRouter initialEntries={['/app/inbound/r-1']}>
        <Routes>
          <Route path="/app/inbound/:routeId" element={<InboundRouteEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {});
  };

  it('a route with hours and no recordings says nothing: every message has our standard recording', async () => {
    await renderEditor();
    expect(document.querySelector('[data-testid^="inbound-route-warning-"]')).toBeNull();
  });

  it('no opening hours: closed at all times, in the hours card, and the route still saves', async () => {
    await renderEditor();
    fireEvent.click(screen.getByRole('button', { name: /^Remove Mon/ }));
    const hours = within(screen.getByTestId('inbound-route-hours'));
    expect(hours.getByTestId('inbound-route-warning-no_opening_hours').textContent)
      .toBe('Closed at all times: callers always hear the closed message. Add opening hours to take calls.');
    await act(async () => {
      fireEvent.click(screen.getByTestId('inbound-route-save'));
    });
    expect(mocks.updateInboundRoute).toHaveBeenCalledWith('r-1', { weekly_hours: [] }, 'tenant-1', 'account-1');
  });

  it('a call recorded with the notice off is said in the recording card', async () => {
    await renderEditor();
    fireEvent.click(screen.getByTestId('inbound-record'));
    expect(screen.queryByTestId('inbound-route-warning-recording_without_notice')).toBeNull();
    fireEvent.click(screen.getByTestId('inbound-recording-notice'));
    const recording = within(screen.getByTestId('inbound-route-recording'));
    expect(recording.getByTestId('inbound-route-warning-recording_without_notice').textContent).toMatch(/recorded without telling callers/);
  });

  it('a deployment that cannot put callers through says so for the whole route', async () => {
    mocks.listInboundClips.mockResolvedValue({ clips: [], upload_available: true, connects_agents: false });
    await renderEditor();
    expect(screen.getByTestId('inbound-route-warning-connect_unavailable').textContent)
      .toBe('Calls can’t be put through to agents on this deployment, so callers hear the busy message: everyone is busy and we’ll call them back.');
  });
});
